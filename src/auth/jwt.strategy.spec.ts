import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { User } from '../database/entities/user.entity';
import { JwtStrategy } from './jwt.strategy';
import { UserStatus } from './user-status.enum';

describe('JwtStrategy', () => {
  const config = {
    getOrThrow: jest
      .fn()
      .mockReturnValue('test-secret-at-least-thirty-two-characters'),
  } as unknown as ConfigService;
  let refreshSessions: jest.Mocked<Repository<RefreshSession>>;
  let strategy: JwtStrategy;

  beforeEach(() => {
    refreshSessions = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<RefreshSession>>;
    strategy = new JwtStrategy(config, refreshSessions);
  });

  it('accepts an access token bound to an active session', async () => {
    const user = {
      username: 'active',
      status: UserStatus.ACTIVE,
      isDeleted: false,
    } as User;
    refreshSessions.findOne.mockResolvedValue({
      sessionId: 'session-1',
      isActive: true,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 60_000),
      user,
    } as RefreshSession);

    await expect(
      strategy.validate({
        sub: 'active',
        tokenType: 'access',
        sid: 'session-1',
      }),
    ).resolves.toBe(user);
  });

  it('rejects access tokens without a session id', async () => {
    await expect(
      strategy.validate({ sub: 'active', tokenType: 'access' }),
    ).rejects.toThrow('Unauthorized');
  });

  it('rejects tokens whose session was terminated', async () => {
    refreshSessions.findOne.mockResolvedValue(null);
    await expect(
      strategy.validate({
        sub: 'active',
        tokenType: 'access',
        sid: 'revoked-session',
      }),
    ).rejects.toThrow('Unauthorized');
  });

  it('rejects refresh tokens as API credentials', async () => {
    await expect(
      strategy.validate({
        sub: 'active',
        tokenType: 'refresh',
        sid: 'session-1',
      }),
    ).rejects.toThrow('Unauthorized');
  });
});
