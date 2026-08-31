import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Branch } from '../database/entities/branch.entity';
import { BranchesService } from './branches.service';
import { BranchesController } from './branches.controller';
import { AuditLog } from '../database/entities/audit-log.entity';
import { Tenant } from '../database/entities/tenant.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Branch, Tenant, AuditLog])],
  controllers: [BranchesController],
  providers: [BranchesService],
})
export class BranchesModule {}
