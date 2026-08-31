import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import { AuthService } from './auth.service';
import { UserRole } from './user-role.enum';
import { UserStatus } from './user-status.enum';

describe('AuthService', () => {
  let users: jest.Mocked<Repository<User>>;
  let tenants: jest.Mocked<Repository<Tenant>>;
  let refreshSessions: jest.Mocked<Repository<RefreshSession>>;
  let auditLogs: jest.Mocked<Repository<AuditLog>>;
  let jwt: jest.Mocked<JwtService>;
  let service: AuthService;

  beforeEach(() => {
    users = {
      exists: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((value) => value as User),
      save: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<User>>;
    tenants = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Tenant>>;
    refreshSessions = {
      create: jest.fn((value) => value as RefreshSession),
      save: jest.fn((value) => Promise.resolve(value as RefreshSession)),
      findOne: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<Repository<RefreshSession>>;
    auditLogs = {
      create: jest.fn((value) => value as AuditLog),
      save: jest.fn((value) => Promise.resolve(value as AuditLog)),
    } as unknown as jest.Mocked<Repository<AuditLog>>;
    jwt = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('access-token')
        .mockResolvedValueOnce('refresh-token'),
      verifyAsync: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'jwt.accessExpiryMs') return 900000;
        if (key === 'jwt.rememberMeRefreshExpiryMs') return 2592000000;
        return 604800000;
      }),
    } as unknown as ConfigService;
    service = new AuthService(
      users,
      tenants,
      refreshSessions,
      auditLogs,
      jwt,
      config,
    );
  });

  it('registers an active USER and issues both tokens', async () => {
    users.exists.mockResolvedValue(false);
    users.save.mockImplementation((user) => Promise.resolve(user as User));

    const response = await service.register({
      username: 'new-user',
      email: 'new@example.com',
      password: 'password123',
    });

    expect(response).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      response: {
        role: null,
        accessTokenExpiresIn: 900000,
      },
    });
    expect(users.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        status: UserStatus.ACTIVE,
      }),
    );
  });

  it('rejects invalid login credentials', async () => {
    users.findOne.mockResolvedValue(null);
    await expect(
      service.login({ username: 'missing', password: 'wrong' }),
    ).rejects.toThrow('Invalid username or password');
  });

  it('logs in an active user with a BCrypt password', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    users.findOne.mockResolvedValue({
      userId: 'user-id',
      username: 'user',
      email: 'user@example.com',
      passwordHash,
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
    } as User);

    const response = await service.login({
      username: 'user',
      password: 'password123',
    });

    expect(response.response.username).toBe('user');
    expect(response.response.permissions).toEqual([]);
    expect(users.query).toHaveBeenCalled();
    const sql = String(users.query.mock.calls[0][0]);
    expect(sql).toContain('group_members');
    expect(sql).toContain("status = 'ACTIVE'");
  });

  it('returns live permission codes on the session profile', async () => {
    users.query
      .mockResolvedValueOnce([{ role_code: 'LAB_TECHNICIAN' }])
      .mockResolvedValueOnce([
        { permission_code: 'LABORATORY_READ' },
        { permission_code: 'SETTINGS_READ' },
      ]);

    const profile = await service.getSessionProfile({
      userId: 'user-id',
      username: 'abdullah',
      email: 'abdullah@example.com',
      requirePasswordChange: false,
      mfaEnabled: false,
      tenant: null,
    } as unknown as User);

    expect(profile).toMatchObject({
      username: 'abdullah',
      role: 'LAB_TECHNICIAN',
      permissions: ['LABORATORY_READ', 'SETTINGS_READ'],
    });
  });

  it('uses the extended refresh expiry when remember-me is selected', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    users.findOne.mockResolvedValue({
      userId: 'user-id',
      username: 'user',
      email: 'user@example.com',
      passwordHash,
      status: UserStatus.ACTIVE,
      failedLoginAttempts: 0,
    } as User);

    const response = await service.login({
      username: 'user',
      password: 'password123',
      rememberMe: true,
    });

    expect(response.response.refreshTokenExpiresIn).toBe(2592000000);
  });

  it('locks the account for 30 minutes after the fifth failed login', async () => {
    users.findOne.mockResolvedValue({
      userId: 'user-id',
      username: 'user',
      email: 'user@example.com',
      passwordHash: await bcrypt.hash('correct-password', 4),
      status: UserStatus.ACTIVE,
      failedLoginAttempts: 4,
    } as User);
    users.save.mockImplementation((user) => Promise.resolve(user as User));

    await expect(
      service.login({ username: 'user', password: 'wrong-password' }),
    ).rejects.toMatchObject({ status: 423 });
    expect(
      (users.save.mock.calls[0][0] as User).accountLockedUntil,
    ).toBeInstanceOf(Date);
  });

  it('rejects an incorrect current password during password change', async () => {
    const user = {
      passwordHash: await bcrypt.hash('CurrentPassword1!', 4),
    } as User;
    await expect(
      service.changePassword(user, {
        currentPassword: 'WrongPassword1!',
        newPassword: 'NewPassword2@',
      }),
    ).rejects.toThrow('Current password is incorrect');
  });

  it('enforces password complexity during password change', async () => {
    const user = {
      passwordHash: await bcrypt.hash('CurrentPassword1!', 4),
    } as User;
    await expect(
      service.changePassword(user, {
        currentPassword: 'CurrentPassword1!',
        newPassword: 'weakpass',
      }),
    ).rejects.toThrow(
      'Password must contain an uppercase letter, a digit, a special character',
    );
  });

  it('rotates a valid refresh token for an active user', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'user',
      tokenType: 'refresh',
      jti: 'token-id',
    });
    refreshSessions.findOne.mockResolvedValue({
      sessionId: 'session-id',
      user: {
        username: 'user',
        email: 'user@example.com',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
      } as User,
      expiresAt: new Date(Date.now() + 60_000),
    } as RefreshSession);
    refreshSessions.update.mockResolvedValue({
      affected: 1,
      generatedMaps: [],
      raw: [],
    });

    const session = await service.refresh('old-refresh-token');

    expect(session.refreshToken).toBe('refresh-token');
    expect(session.response.username).toBe('user');
  });

  it('rejects access tokens at the refresh endpoint', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'user',
      tokenType: 'access',
    });
    await expect(service.refresh('access-token')).rejects.toThrow(
      'Invalid or expired refresh token',
    );
  });
});
