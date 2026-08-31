import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { User } from '../database/entities/user.entity';
import { ACCESS_TOKEN_COOKIE } from './auth-cookie.service';
import { UserStatus } from './user-status.enum';

type JwtPayload = {
  sub: string;
  role?: string;
  tokenType: 'access' | 'refresh';
  sid?: string;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectRepository(RefreshSession)
    private readonly refreshSessions: Repository<RefreshSession>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: { cookies?: Record<string, string | undefined> }) =>
          request.cookies?.[ACCESS_TOKEN_COOKIE] ?? null,
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.secret'),
    });
  }

  async validate(payload: JwtPayload): Promise<User> {
    if (payload.tokenType !== 'access' || !payload.sid) {
      throw new UnauthorizedException('Unauthorized');
    }

    const session = await this.refreshSessions.findOne({
      where: {
        sessionId: payload.sid,
        isRevoked: false,
        isActive: true,
      },
      relations: { user: { tenant: true } },
    });
    if (!session || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Unauthorized');
    }

    const user = session.user;
    if (
      !user ||
      user.isDeleted ||
      user.status !== UserStatus.ACTIVE ||
      user.username !== payload.sub
    ) {
      throw new UnauthorizedException('Unauthorized');
    }

    user.role = payload.role ?? null;
    return user;
  }
}
