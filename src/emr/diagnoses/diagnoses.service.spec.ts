import { NotFoundException } from '@nestjs/common';
import type { Condition } from '@medplum/fhirtypes';
import { DIAGNOSIS_TYPE_SYSTEM } from '../emr.constants';
import { ACTOR, buildHarness, encounter } from '../testing/harness';
import { DiagnosesService } from './diagnoses.service';

const NOW = new Date('2026-10-06T09:00:00.000Z');

function build() {
  const harness = buildHarness();
  harness.store.seed(encounter('enc-1', 'patient-1'));
  harness.store.seed(encounter('enc-2', 'patient-2'));
  return { ...harness, service: new DiagnosesService(harness.fhir) };
}

describe('DiagnosesService', () => {
  it('stores an encounter diagnosis as a coded Condition', async () => {
    const { store, service } = build();

    const row = await service.create(
      {
        patientId: 'patient-1',
        encounterId: 'enc-1',
        type: 'PRIMARY',
        code: 'j18.9',
        display: 'Pneumonia, unspecified',
        notes: 'Right lower lobe',
      },
      ACTOR,
      NOW,
    );

    expect(row).toMatchObject({
      type: 'PRIMARY',
      code: 'J18.9',
      display: 'Pneumonia, unspecified',
      verification: 'confirmed',
      notes: 'Right lower lobe',
      patientId: 'patient-1',
      encounterId: 'enc-1',
      recordedAt: NOW.toISOString(),
    });
    const [condition] = store.all<Condition>('Condition');
    expect(condition.recorder).toEqual({ reference: 'Practitioner/prac-1' });
    expect(condition.category?.[1].coding?.[0]).toEqual({
      system: DIAGNOSIS_TYPE_SYSTEM,
      code: 'PRIMARY',
    });
  });

  it.each([
    ['WORKING', 'provisional'],
    ['ADMITTING', 'provisional'],
    ['SECONDARY', 'confirmed'],
    ['DISCHARGE', 'confirmed'],
  ] as const)('a %s diagnosis is %s', async (type, verification) => {
    const { service } = build();
    const row = await service.create(
      {
        patientId: 'patient-1',
        encounterId: 'enc-1',
        type,
        code: 'I10',
        display: 'Hypertension',
      },
      ACTOR,
      NOW,
    );
    expect(row.verification).toBe(verification);
  });

  it('rejects an encounter that belongs to another patient', async () => {
    const { store, service } = build();
    await expect(
      service.create(
        {
          patientId: 'patient-1',
          encounterId: 'enc-2',
          type: 'PRIMARY',
          code: 'I10',
          display: 'Hypertension',
        },
        ACTOR,
        NOW,
      ),
    ).rejects.toThrow('does not belong');
    expect(store.all('Condition')).toHaveLength(0);
  });

  it('treats an invisible patient as not found', async () => {
    const { store, service } = build();
    store.hide('Patient/patient-1');
    await expect(
      service.create(
        {
          patientId: 'patient-1',
          encounterId: 'enc-1',
          type: 'PRIMARY',
          code: 'I10',
          display: 'Hypertension',
        },
        ACTOR,
        NOW,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  describe('list', () => {
    async function seed() {
      const harness = build();
      const base = {
        patientId: 'patient-1',
        encounterId: 'enc-1',
        display: 'Dx',
      };
      await harness.service.create(
        { ...base, type: 'PRIMARY', code: 'J18.9' },
        ACTOR,
        NOW,
      );
      await harness.service.create(
        { ...base, type: 'SECONDARY', code: 'I10' },
        ACTOR,
        NOW,
      );
      await harness.service.create(
        {
          patientId: 'patient-2',
          encounterId: 'enc-2',
          display: 'Dx',
          type: 'PRIMARY',
          code: 'E11.9',
        },
        ACTOR,
        NOW,
      );
      return harness;
    }

    it('lists an encounter’s diagnoses only', async () => {
      const { service } = await seed();
      const { items } = await service.list({ encounterId: 'enc-1' }, ACTOR);
      expect(items.map((row) => row.code).sort()).toEqual(['I10', 'J18.9']);
    });

    it('filters by type', async () => {
      const { service } = await seed();
      const { items } = await service.list(
        { patientId: 'patient-1', type: 'SECONDARY' },
        ACTOR,
      );
      expect(items.map((row) => row.code)).toEqual(['I10']);
    });
  });
});
