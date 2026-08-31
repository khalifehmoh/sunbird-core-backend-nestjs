import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationError } from 'class-validator';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  const allowedOrigins = config
    .getOrThrow<string>('CORS_ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      // Same-origin / non-browser tools omit Origin.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Explicit headers: `*` is rejected by browsers when credentials=true.
    allowedHeaders: [
      'Accept',
      'Authorization',
      'Content-Type',
      'Origin',
      'X-Requested-With',
    ],
    exposedHeaders: ['Set-Cookie'],
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
      exceptionFactory: (errors: ValidationError[]) => {
        const validationErrors = Object.fromEntries(
          errors.map((error) => [
            error.property,
            Object.values(error.constraints ?? {})[0] ?? 'Invalid value',
          ]),
        );
        return { validationErrors };
      },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  const openApiConfig = new DocumentBuilder()
    .setTitle('Sunbird Core X API')
    .setVersion('1.0')
    .addCookieAuth(
      'access_token',
      { type: 'apiKey', in: 'cookie' },
      'cookieAuth',
    )
    .addSecurityRequirements('cookieAuth')
    .build();
  const document = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('swagger-ui.html', app, document, {
    jsonDocumentUrl: '/api-docs',
  });

  await app.listen(config.getOrThrow<number>('PORT'));
}
void bootstrap();
