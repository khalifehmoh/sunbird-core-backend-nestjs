import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import {
  AuthResponseDto,
  ChangePasswordResponseDto,
  LoginRequestDto,
  RegisterRequestDto,
  ChangePasswordRequestDto,
  SessionResponseDto,
} from './dto/auth.dto';
import { ACTIVE_ROLE_SOURCES_SQL } from './effective-access.query';
import { UserStatus } from './user-status.enum';

type TokenPayload = {
  sub: string;
  tokenType: 'access' | 'refresh';
  jti?: string;
  sid?: string;
  role?: string | null;
  tenantId?: string | null;
  permissions?: string[];
  rememberMe?: boolean;
};

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  response: AuthResponseDto;
};

@Injectable()
export class AuthService {
  private static readonly MAX_FAILED_ATTEMPTS = 5;
  private static readonly LOCKOUT_DURATION_MS = 30 * 60 * 1000;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
    @InjectRepository(RefreshSession)
    private readonly refreshSessions: Repository<RefreshSession>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(request: RegisterRequestDto): Promise<AuthSession> {
    if (
      await this.users.exists({
        where: { username: request.username, isDeleted: false },
      })
    ) {
      throw new ConflictException(
        `Username already taken: ${request.username}`,
      );
    }
    if (
      await this.users.exists({
        where: { email: request.email, isDeleted: false },
      })
    ) {
      throw new ConflictException(`Email already registered: ${request.email}`);
    }

    let tenant: Tenant | null = null;
    if (request.tenantCode?.trim()) {
      tenant = await this.tenants.findOne({
        where: { tenantCode: request.tenantCode, isDeleted: false },
      });
      if (!tenant) {
        throw new NotFoundException(`Tenant not found: ${request.tenantCode}`);
      }
    }

    const firstName =
      request.firstName?.trim() ||
      request.fullName?.trim().split(/\s+/)[0] ||
      request.username;
    const lastName =
      request.lastName?.trim() ||
      request.fullName?.trim().split(/\s+/).slice(1).join(' ') ||
      '';

    const user = await this.users.save(
      this.users.create({
        username: request.username,
        email: request.email,
        passwordHash: await bcrypt.hash(request.password, 10),
        firstName,
        lastName,
        firstNameAr: request.firstNameAr ?? request.fullNameAr ?? null,
        lastNameAr: request.lastNameAr ?? null,
        tenant,
        status: UserStatus.ACTIVE,
        isDeleted: false,
        requirePasswordChange: true,
        failedLoginAttempts: 0,
        mfaEnabled: false,
      }),
    );
    return this.buildSession(user);
  }

  async login(
    request: LoginRequestDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthSession> {
    const user = await this.users.findOne({
      where: { username: request.username, isDeleted: false },
      relations: { tenant: true },
    });

    if (
      user?.accountLockedUntil &&
      user.accountLockedUntil.getTime() > Date.now()
    ) {
      await this.writeAudit(
        'FAILED_LOGIN',
        user,
        ipAddress,
        userAgent,
        false,
        `Account locked until ${user.accountLockedUntil.toISOString()}`,
        request.username,
      );
      this.throwAccountLocked(user.accountLockedUntil);
    }

    const permitted =
      user?.status === UserStatus.ACTIVE &&
      (await bcrypt.compare(request.password, user.passwordHash));
    if (!user || !permitted) {
      if (user) {
        user.failedLoginAttempts = (user.failedLoginAttempts ?? 0) + 1;
        if (user.failedLoginAttempts >= AuthService.MAX_FAILED_ATTEMPTS) {
          user.accountLockedUntil = new Date(
            Date.now() + AuthService.LOCKOUT_DURATION_MS,
          );
        }
        await this.users.save(user);
      }
      await this.writeAudit(
        'FAILED_LOGIN',
        user,
        ipAddress,
        userAgent,
        false,
        'Invalid username or password',
        request.username,
      );
      if (user?.accountLockedUntil) {
        this.throwAccountLocked(user.accountLockedUntil);
      }
      throw new UnauthorizedException('Invalid username or password');
    }

    user.failedLoginAttempts = 0;
    user.accountLockedUntil = null;
    user.lastLoginAt = new Date();
    user.lastLoginIp = ipAddress ?? null;
    await this.users.save(user);
    await this.writeAudit('LOGIN', user, ipAddress, userAgent, true);
    return this.buildSession(user, request.rememberMe, ipAddress, userAgent);
  }

  async refresh(
    refreshToken: string | undefined,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthSession> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.tokenType !== 'refresh' || !payload.jti) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const session = await this.refreshSessions.findOne({
      where: {
        tokenHash: this.hashToken(refreshToken),
        isRevoked: false,
        isActive: true,
      },
      relations: { user: { tenant: true } },
    });
    const user = session?.user;
    if (!user || user.isDeleted || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (user.username !== payload.sub || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.sid && payload.sid !== session.sessionId) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    const rotation = await this.refreshSessions.update(
      { sessionId: session.sessionId, isRevoked: false, isActive: true },
      { isRevoked: true, isActive: false, logoutAt: new Date() },
    );
    if (rotation.affected !== 1) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    return this.buildSession(
      user,
      payload.rememberMe ?? false,
      ipAddress,
      userAgent,
    );
  }

  async logout(
    refreshToken: string | undefined,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    if (!refreshToken) return;
    const session = await this.refreshSessions.findOne({
      where: {
        tokenHash: this.hashToken(refreshToken),
        isRevoked: false,
      },
      relations: { user: { tenant: true } },
    });
    if (!session) return;
    session.isRevoked = true;
    session.isActive = false;
    session.logoutAt = new Date();
    await this.refreshSessions.save(session);
    await this.writeAudit('LOGOUT', session.user, ipAddress, userAgent, true);
  }

  async changePassword(
    user: User,
    request: ChangePasswordRequestDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<ChangePasswordResponseDto> {
    const permitted = await bcrypt.compare(
      request.currentPassword,
      user.passwordHash,
    );
    if (!permitted) {
      await this.writeAudit(
        'UPDATE',
        user,
        ipAddress,
        userAgent,
        false,
        'Current password is incorrect',
      );
      throw new BadRequestException('Current password is incorrect');
    }
    const complexityViolation = this.passwordComplexityViolation(
      request.newPassword,
    );
    if (complexityViolation) {
      throw new BadRequestException(complexityViolation);
    }
    if (await bcrypt.compare(request.newPassword, user.passwordHash)) {
      throw new BadRequestException(
        'New password must be different from the current password',
      );
    }
    user.passwordHash = await bcrypt.hash(request.newPassword, 10);
    user.requirePasswordChange = false;
    user.passwordLastChangedAt = new Date();
    await this.users.save(user);
    await this.refreshSessions
      .createQueryBuilder()
      .update(RefreshSession)
      .set({ isRevoked: true, isActive: false, logoutAt: new Date() })
      .where('user_id = :userId AND is_active = true', {
        userId: user.userId,
      })
      .execute();
    await this.writeAudit('UPDATE', user, ipAddress, userAgent, true);
    return {
      message: 'Password changed successfully',
      requirePasswordChange: false,
    };
  }

  async getSessionProfile(user: User): Promise<SessionResponseDto> {
    const [role, permissions] = await Promise.all([
      this.resolveRole(user.userId),
      this.resolvePermissions(user.userId),
    ]);
    return {
      username: user.username,
      email: user.email,
      role,
      tenantId: user.tenant?.tenantId ?? null,
      requirePasswordChange: user.requirePasswordChange ?? false,
      mfaEnabled: user.mfaEnabled ?? false,
      permissions,
    };
  }

  private async resolveRole(userId: string): Promise<string | null> {
    const rows = await this.users.query<Array<{ role_code: string }>>(
      `SELECT DISTINCT r.role_code
         FROM (${ACTIVE_ROLE_SOURCES_SQL}) src
         JOIN core.roles r ON r.role_id = src.role_id
        ORDER BY r.role_code`,
      [userId],
    );
    return rows.length ? rows.map((row) => row.role_code).join(',') : null;
  }

  private async resolvePermissions(userId: string): Promise<string[]> {
    const rows = await this.users.query<Array<{ permission_code: string }>>(
      `SELECT DISTINCT p.permission_code
         FROM (${ACTIVE_ROLE_SOURCES_SQL}) src
         JOIN core.role_permissions rp
           ON rp.role_id = src.role_id AND rp.is_deleted = false
         JOIN core.permissions p
           ON p.permission_id = rp.permission_id AND p.is_deleted = false
        ORDER BY p.permission_code`,
      [userId],
    );
    return rows.map((row) => row.permission_code);
  }

  private async writeAudit(
    actionType: string,
    user: User | null,
    ipAddress: string | undefined,
    userAgent: string | undefined,
    success: boolean,
    errorMessage?: string,
    attemptedUsername?: string,
  ): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        tenantId: user?.tenant?.tenantId ?? null,
        userId: user?.userId ?? null,
        actionType,
        entityType: 'USER',
        entityId: user?.userId ?? null,
        entityName: user?.username ?? attemptedUsername ?? null,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
        success,
        errorMessage: errorMessage ?? null,
      }),
    );
  }

  private passwordComplexityViolation(password: string): string | null {
    const problems: string[] = [];
    if (password.length < 8) problems.push('at least 8 characters');
    if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
    if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
    if (!/[0-9]/.test(password)) problems.push('a digit');
    if (!/[^A-Za-z0-9]/.test(password)) problems.push('a special character');
    return problems.length
      ? `Password must contain ${problems.join(', ')}`
      : null;
  }

  private throwAccountLocked(lockedUntil: Date): never {
    throw new HttpException(
      {
        message: `Account is locked until ${lockedUntil.toISOString()}`,
        lockedUntil: lockedUntil.toISOString(),
      },
      423,
    );
  }

  private async buildSession(
    user: User,
    rememberMe = false,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthSession> {
    const accessTokenExpiresIn =
      this.config.getOrThrow<number>('jwt.accessExpiryMs');
    const refreshTokenExpiresIn = rememberMe
      ? this.config.getOrThrow<number>('jwt.rememberMeRefreshExpiryMs')
      : this.config.getOrThrow<number>('jwt.refreshExpiryMs');
    const [role, permissions] = await Promise.all([
      this.resolveRole(user.userId),
      this.resolvePermissions(user.userId),
    ]);
    const tenantId = user.tenant?.tenantId ?? null;
    const sessionId = randomUUID();
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        {
          role,
          tenantId,
          permissions,
          tokenType: 'access',
          sid: sessionId,
        },
        { subject: user.username, expiresIn: accessTokenExpiresIn / 1000 },
      ),
      this.jwt.signAsync(
        {
          role,
          tenantId,
          permissions,
          tokenType: 'refresh',
          jti: sessionId,
          sid: sessionId,
          rememberMe,
        },
        { subject: user.username, expiresIn: refreshTokenExpiresIn / 1000 },
      ),
    ]);
    await this.refreshSessions.save(
      this.refreshSessions.create({
        sessionId,
        user,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshTokenExpiresIn),
        isRevoked: false,
        isActive: true,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
        lastActivityAt: new Date(),
        logoutAt: null,
      }),
    );
    return {
      accessToken,
      refreshToken,
      response: {
        accessTokenExpiresIn,
        refreshTokenExpiresIn,
        username: user.username,
        email: user.email,
        role,
        tenantId,
        requirePasswordChange: user.requirePasswordChange ?? false,
        mfaEnabled: user.mfaEnabled ?? false,
        permissions,
      },
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
