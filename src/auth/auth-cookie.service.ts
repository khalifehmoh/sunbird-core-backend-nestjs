import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CookieOptions, Response } from 'express';
import type { AuthSession } from './auth.service';

export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

@Injectable()
export class AuthCookieService {
  constructor(private readonly config: ConfigService) {}

  setSession(response: Response, session: AuthSession): void {
    response.setHeader('Cache-Control', 'no-store');
    response.cookie(ACCESS_TOKEN_COOKIE, session.accessToken, {
      ...this.baseOptions(),
      path: '/',
      maxAge: session.response.accessTokenExpiresIn,
    });
    response.cookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
      ...this.baseOptions(),
      path: '/api/v1/auth',
      maxAge: session.response.refreshTokenExpiresIn,
    });
  }

  clearSession(response: Response): void {
    response.clearCookie(ACCESS_TOKEN_COOKIE, {
      ...this.baseOptions(),
      path: '/',
    });
    response.clearCookie(REFRESH_TOKEN_COOKIE, {
      ...this.baseOptions(),
      path: '/api/v1/auth',
    });
  }

  private baseOptions(): CookieOptions {
    const domain = this.config.get<string>('cookie.domain');
    return {
      httpOnly: true,
      secure: this.config.getOrThrow<boolean>('cookie.secure'),
      sameSite: this.config.getOrThrow<'strict' | 'lax' | 'none'>(
        'cookie.sameSite',
      ),
      ...(domain ? { domain } : {}),
    };
  }
}
