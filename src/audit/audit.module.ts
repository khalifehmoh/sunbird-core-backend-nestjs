import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SecurityController } from './security.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, User, Tenant, RefreshSession]),
  ],
  controllers: [AuditController, DashboardController, SecurityController],
  providers: [AuditService, DashboardService],
})
export class AuditModule {}
