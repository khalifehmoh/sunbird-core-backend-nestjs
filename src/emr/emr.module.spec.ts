import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { MedplumRegistry } from '../fhir/medplum-registry';
import { MedplumService } from '../fhir/medplum.service';
import { EmrModule } from './emr.module';
import { IntegrationService } from './integration/integration.service';
import { DashboardService } from './dashboard/dashboard.service';
import { PatientsService } from './patients/patients.service';
import { NotificationListener } from './notifications/notification.listener';

const fakeDataSource = {
  entityMetadatas: [],
  getRepository: () => ({}),
  options: { type: 'postgres' },
} as unknown as DataSource;

/** Stands in for TypeOrmModule.forRoot, which needs a database. */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: fakeDataSource }],
  exports: [DataSource],
})
class FakeDatabaseModule {}

/**
 * Catches wiring mistakes (a provider missing from the module, a circular
 * dependency) that unit specs, which construct services by hand, cannot.
 */
describe('EmrModule', () => {
  it('resolves every provider and controller', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ integration: { apiKey: 'k'.repeat(32) } })],
        }),
        FakeDatabaseModule,
        EmrModule,
      ],
    })
      .overrideProvider(MedplumService)
      .useValue({})
      .overrideProvider(MedplumRegistry)
      .useValue({})
      .compile();

    expect(moduleRef.get(IntegrationService)).toBeDefined();
    expect(moduleRef.get(DashboardService)).toBeDefined();
    expect(moduleRef.get(PatientsService)).toBeDefined();
    expect(moduleRef.get(NotificationListener)).toBeDefined();
    await moduleRef.close();
  });
});
