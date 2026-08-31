import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import {
  ACCESS_TOKEN_COOKIE,
  AuthCookieService,
  REFRESH_TOKEN_COOKIE,
} from './auth-cookie.service';
import { UserRole } from './user-role.enum';

describe('AuthCookieService', () => {
  const config = {
    get: jest.fn().mockReturnValue(undefined),
    getOrThrow: jest.fn((key: string) =>
      key === 'cookie.secure' ? false : 'lax',
    ),
  } as unknown as ConfigService;
  const service = new AuthCookieService(config);

  it('writes access and refresh tokens as scoped HttpOnly cookies', () => {
    const response = {
      cookie: jest.fn(),
      setHeader: jest.fn(),
    } as unknown as Response;

    service.setSession(response, {
      accessToken: 'access',
      refreshToken: 'refresh',
      response: {
        accessTokenExpiresIn: 900000,
        refreshTokenExpiresIn: 604800000,
        username: 'user',
        email: 'user@example.com',
        role: UserRole.USER,
        tenantId: null,
        requirePasswordChange: false,
        mfaEnabled: false,
        permissions: [],
      },
    });

    const cookie = (response.cookie as jest.Mock).mock.calls;
    expect((response.setHeader as jest.Mock).mock.calls[0]).toEqual([
      'Cache-Control',
      'no-store',
    ]);
    expect(cookie[0]).toEqual([
      ACCESS_TOKEN_COOKIE,
      'access',
      expect.objectContaining({
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
        maxAge: 900000,
      }),
    ]);
    expect(cookie[1]).toEqual([
      REFRESH_TOKEN_COOKIE,
      'refresh',
      expect.objectContaining({
        httpOnly: true,
        path: '/api/v1/auth',
        maxAge: 604800000,
      }),
    ]);
  });
});
