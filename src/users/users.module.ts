import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { GroupMember } from '../database/entities/group-member.entity';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { Role } from '../database/entities/role.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { UserRoleAssignment } from '../database/entities/user-role.entity';
import { SessionsController } from './sessions.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Tenant,
      RefreshSession,
      AuditLog,
      UserRoleAssignment,
      Role,
      GroupMember,
    ]),
  ],
  controllers: [UsersController, SessionsController],
  providers: [UsersService],
})
export class UsersModule {}
