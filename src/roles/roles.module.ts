import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { GroupRole } from '../database/entities/group-role.entity';
import { Permission } from '../database/entities/permission.entity';
import { Role } from '../database/entities/role.entity';
import { RolePermission } from '../database/entities/role-permission.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { UserRoleAssignment } from '../database/entities/user-role.entity';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Role,
      RolePermission,
      Permission,
      UserRoleAssignment,
      GroupRole,
      Tenant,
      AuditLog,
    ]),
  ],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
