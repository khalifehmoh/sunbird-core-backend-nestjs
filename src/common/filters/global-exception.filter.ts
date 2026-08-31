import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

type ValidationPayload = { validationErrors: Record<string, string> };

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const timestamp = new Date().toISOString().replace('Z', '');

    if (this.isValidationPayload(exception)) {
      response.status(HttpStatus.BAD_REQUEST).json({
        timestamp,
        status: HttpStatus.BAD_REQUEST,
        error: 'Validation Failed',
        errors: exception.validationErrors,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const details =
        typeof payload === 'object' && payload !== null
          ? Object.fromEntries(
              Object.entries(payload as Record<string, unknown>).filter(
                ([key]) =>
                  !['statusCode', 'status', 'error', 'message'].includes(key),
              ),
            )
          : {};
      const message =
        typeof payload === 'string'
          ? payload
          : this.extractMessage(payload as Record<string, unknown>);

      response.status(status).json({
        timestamp,
        status,
        error: this.reasonPhrase(status),
        message,
        ...details,
      });
      return;
    }

    this.logger.error(
      `Unhandled exception for ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      timestamp,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
  }

  private isValidationPayload(value: unknown): value is ValidationPayload {
    return (
      typeof value === 'object' && value !== null && 'validationErrors' in value
    );
  }

  private extractMessage(payload: Record<string, unknown>): string {
    const message = payload.message;
    if (Array.isArray(message)) return String(message[0]);
    return typeof message === 'string'
      ? message
      : 'An unexpected error occurred';
  }

  private reasonPhrase(status: number): string {
    const names: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      423: 'Locked',
      500: 'Internal Server Error',
    };
    return names[status] ?? 'Error';
  }
}
