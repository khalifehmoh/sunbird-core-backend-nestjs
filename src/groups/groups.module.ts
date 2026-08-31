import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { Group } from '../database/entities/group.entity';
import { GroupMember } from '../database/entities/group-member.entity';
import { GroupRole } from '../database/entities/group-role.entity';
import { Role } from '../database/entities/role.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Group,
      GroupMember,
      GroupRole,
      Role,
      User,
      Tenant,
      AuditLog,
    ]),
  ],
  controllers: [GroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
