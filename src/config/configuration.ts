import * as Joi from 'joi';

export const configuration = () => ({
  port: Number(process.env.PORT ?? 8080),
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    name: process.env.DB_NAME ?? 'sunbird_core_db',
    username: process.env.DB_USERNAME ?? 'sunbird_app',
    password: process.env.DB_PASSWORD,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    accessExpiryMs: Number(process.env.JWT_ACCESS_TOKEN_EXPIRY_MS ?? 900000),
    refreshExpiryMs: Number(
      process.env.JWT_REFRESH_TOKEN_EXPIRY_MS ?? 604800000,
    ),
    rememberMeRefreshExpiryMs: Number(
      process.env.JWT_REMEMBER_ME_REFRESH_TOKEN_EXPIRY_MS ?? 2592000000,
    ),
  },
  cookie: {
    secure:
      process.env.COOKIE_SECURE !== undefined
        ? process.env.COOKIE_SECURE === 'true'
        : process.env.NODE_ENV === 'production',
    sameSite: process.env.COOKIE_SAME_SITE ?? 'lax',
    domain: process.env.COOKIE_DOMAIN || undefined,
  },
});

export const environmentSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(8080),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().port().default(5432),
  DB_NAME: Joi.string().default('sunbird_core_db'),
  DB_USERNAME: Joi.string().default('sunbird_app'),
  DB_PASSWORD: Joi.string().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TOKEN_EXPIRY_MS: Joi.number().integer().positive().default(900000),
  JWT_REFRESH_TOKEN_EXPIRY_MS: Joi.number()
    .integer()
    .positive()
    .default(604800000),
  JWT_REMEMBER_ME_REFRESH_TOKEN_EXPIRY_MS: Joi.number()
    .integer()
    .positive()
    .default(2592000000),
  COOKIE_SECURE: Joi.boolean(),
  COOKIE_SAME_SITE: Joi.string().valid('strict', 'lax', 'none').default('lax'),
  COOKIE_DOMAIN: Joi.string().allow('').optional(),
  CORS_ALLOWED_ORIGINS: Joi.string().default(
    [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ].join(','),
  ),
});
