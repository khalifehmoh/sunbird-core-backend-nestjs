import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Observation } from '@medplum/fhirtypes';
import { ENTRY_SOURCE_SYSTEM } from '../emr.constants';
import { ACTOR, buildHarness, encounter } from '../testing/harness';
import { VitalsService } from './vitals.service';
import { interpret, vitalByKey } from './vitals.rules';

const NOW = new Date('2026-10-06T09:00:00.000Z');

function build() {
  const harness = buildHarness();
  harness.store.seed(encounter('enc-1', 'patient-1'));
  harness.store.seed(encounter('enc-2', 'patient-2'));
  return { ...harness, service: new VitalsService(harness.fhir) };
}

describe('vitals rules', () => {
  it.each([
    ['HR', 72, 'N'],
    ['HR', 55, 'L'],
    ['HR', 110, 'H'],
    ['HR', 35, 'LL'],
    ['HR', 160, 'HH'],
    ['SPO2', 97, 'N'],
    ['SPO2', 92, 'L'],
    ['SPO2', 88, 'LL'],
    ['TEMP', 37.2, 'N'],
    ['TEMP', 38.5, 'H'],
    ['TEMP', 41, 'HH'],
    ['BP_SYS', 185, 'HH'],
  ])('%s %d reads as %s', (key, value, expected) => {
    expect(interpret(vitalByKey(key)!, value)).toBe(expected);
  });

  it('has no interpretation for vitals without a reference range', () => {
    expect(interpret(vitalByKey('WEIGHT')!, 70)).toBeUndefined();
  });

  it('is critical only at the LL / HH boundaries, not at the abnormal one', () => {
    expect(interpret(vitalByKey('HR')!, 40)).toBe('L');
    expect(interpret(vitalByKey('HR')!, 39.9)).toBe('LL');
    expect(interpret(vitalByKey('HR')!, 150)).toBe('H');
    expect(interpret(vitalByKey('HR')!, 150.1)).toBe('HH');
  });
});

describe('VitalsService', () => {
  describe('record', () => {
    it('stores one LOINC-coded Observation per reading in a single transaction', async () => {
      const { store, service } = build();

      const result = await service.record(
        {
          patientId: 'patient-1',
          encounterId: 'enc-1',
          readings: [
            { code: 'HR', value: 88 },
            { code: 'SPO2', value: 98 },
          ],
        },
        ACTOR,
        NOW,
      );

      expect(store.transactions).toHaveLength(1);
      const observations = store.all<Observation>('Observation');
      expect(observations).toHaveLength(2);
      const heartRate = observations.find(
        (o) => o.code?.coding?.[0]?.code === '8867-4',
      )!;
      expect(heartRate).toMatchObject({
        status: 'final',
        subject: { reference: 'Patient/patient-1' },
        encounter: { reference: 'Encounter/enc-1' },
        performer: [{ reference: 'Practitioner/prac-1' }],
        valueQuantity: { value: 88, unit: 'bpm', code: '/min' },
        effectiveDateTime: NOW.toISOString(),
      });
      expect(heartRate.meta?.tag).toContainEqual({
        system: ENTRY_SOURCE_SYSTEM,
        code: 'MANUAL',
      });
      expect(result.summary).toEqual({ total: 2, critical: 0, abnormal: 0 });
    });

    it('flags critical and abnormal readings', async () => {
      const { service } = build();

      const result = await service.record(
        {
          patientId: 'patient-1',
          readings: [
            { code: 'SPO2', value: 86 },
            { code: 'TEMP', value: 38.4 },
            { code: 'WEIGHT', value: 70 },
          ],
        },
        ACTOR,
        NOW,
      );

      const byCode = Object.fromEntries(
        result.items.map((row) => [row.code, row]),
      );
      expect(byCode.SPO2).toMatchObject({
        interpretation: 'LL',
        flag: 'critical',
      });
      expect(byCode.TEMP).toMatchObject({
        interpretation: 'H',
        flag: 'abnormal',
      });
      expect(byCode.WEIGHT).toMatchObject({
        interpretation: null,
        flag: 'unrated',
      });
      expect(result.summary).toEqual({ total: 3, critical: 1, abnormal: 1 });
    });

    it('records device entries with the DEVICE source', async () => {
      const { service } = build();
      const result = await service.record(
        {
          patientId: 'patient-1',
          source: 'DEVICE',
          readings: [{ code: 'HR', value: 70 }],
        },
        ACTOR,
        NOW,
      );
      expect(result.items[0].source).toBe('DEVICE');
    });

    it('rejects implausible values without writing anything', async () => {
      const { store, service } = build();
      await expect(
        service.record(
          {
            patientId: 'patient-1',
            readings: [
              { code: 'HR', value: 80 },
              { code: 'SPO2', value: 140 },
            ],
          },
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(store.transactions).toHaveLength(0);
      expect(store.all('Observation')).toHaveLength(0);
    });

    it('rejects the same vital entered twice', async () => {
      const { service } = build();
      await expect(
        service.record(
          {
            patientId: 'patient-1',
            readings: [
              { code: 'HR', value: 80 },
              { code: 'HR', value: 82 },
            ],
          },
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow('entered twice');
    });

    it('rejects a measurement time in the future', async () => {
      const { service } = build();
      await expect(
        service.record(
          {
            patientId: 'patient-1',
            measuredAt: '2026-10-06T12:00:00.000Z',
            readings: [{ code: 'HR', value: 80 }],
          },
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow('future');
    });

    it('rejects an encounter that belongs to another patient', async () => {
      const { service } = build();
      await expect(
        service.record(
          {
            patientId: 'patient-1',
            encounterId: 'enc-2',
            readings: [{ code: 'HR', value: 80 }],
          },
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow('does not belong');
    });

    it('treats a patient the caller cannot see as not found', async () => {
      const { store, service } = build();
      store.hide('Patient/patient-1');
      await expect(
        service.record(
          { patientId: 'patient-1', readings: [{ code: 'HR', value: 80 }] },
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(store.transactions).toHaveLength(0);
    });
  });

  describe('list', () => {
    async function seedVitals() {
      const harness = build();
      await harness.service.record(
        {
          patientId: 'patient-1',
          encounterId: 'enc-1',
          measuredAt: '2026-10-06T06:00:00.000Z',
          readings: [{ code: 'HR', value: 180 }],
        },
        ACTOR,
        NOW,
      );
      await harness.service.record(
        {
          patientId: 'patient-1',
          encounterId: 'enc-1',
          measuredAt: '2026-10-06T08:00:00.000Z',
          readings: [{ code: 'HR', value: 75 }],
        },
        ACTOR,
        NOW,
      );
      await harness.service.record(
        {
          patientId: 'patient-2',
          measuredAt: '2026-10-06T07:00:00.000Z',
          readings: [{ code: 'TEMP', value: 38.2 }],
        },
        ACTOR,
        NOW,
      );
      return harness;
    }

    it('returns a patient’s vitals newest first', async () => {
      const { service } = await seedVitals();
      const result = await service.list({ patientId: 'patient-1' }, ACTOR);
      expect(result.items.map((row) => row.value)).toEqual([75, 180]);
      expect(result.summary).toEqual({ total: 2, critical: 1, abnormal: 0 });
    });

    it('filters to critical readings', async () => {
      const { service } = await seedVitals();
      const result = await service.list(
        { patientId: 'patient-1', criticalOnly: true },
        ACTOR,
      );
      expect(result.items.map((row) => row.value)).toEqual([180]);
    });

    it('filters by encounter and date range', async () => {
      const { service } = await seedVitals();
      expect(
        (await service.list({ encounterId: 'enc-1' }, ACTOR)).items,
      ).toHaveLength(2);
      const windowed = await service.list(
        {
          patientId: 'patient-1',
          from: '2026-10-06T07:00:00.000Z',
          to: '2026-10-06T09:00:00.000Z',
        },
        ACTOR,
      );
      expect(windowed.items.map((row) => row.value)).toEqual([75]);
    });

    it('does not return another patient’s vitals', async () => {
      const { service } = await seedVitals();
      const result = await service.list({ patientId: 'patient-2' }, ACTOR);
      expect(result.items.map((row) => row.code)).toEqual(['TEMP']);
    });
  });
});
