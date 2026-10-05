import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type {
  AllergyIntolerance,
  Observation,
  Patient,
} from '@medplum/fhirtypes';
import {
  IQAMA_SYSTEM,
  MRN_SYSTEM,
  NATIONAL_ID_SYSTEM,
} from '../../fhir/fhir.constants';
import { updateEntry } from '../../fhir/fhir-transaction';
import { AppointmentsService } from '../appointments/appointments.service';
import { DiagnosesService } from '../diagnoses/diagnoses.service';
import { EmrEventBus, type EmrEvent } from '../emr-events';
import { ENTRY_SOURCE_SYSTEM } from '../emr.constants';
import { OrdersService } from '../orders/orders.service';
import { ResultsService } from '../results/results.service';
import type { SequenceService } from '../sequence.service';
import { ACTOR, buildHarness, encounter } from '../testing/harness';
import { VitalsService } from '../vitals/vitals.service';
import type { RegisterPatientDto } from './patients.dto';
import { patientSearchParams, PatientsService } from './patients.service';
import { WardIndex } from './ward-index';

const NOW = new Date('2026-10-06T09:00:00.000Z');

function build(firstSequence = 3) {
  const harness = buildHarness();
  const bus = new EmrEventBus();
  const events: EmrEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  let counter = firstSequence - 1;
  const sequences = {
    next: jest.fn(() => Promise.resolve(++counter)),
  } as unknown as SequenceService;
  const service = new PatientsService(
    harness.fhir,
    sequences,
    new DiagnosesService(harness.fhir),
    new VitalsService(harness.fhir),
    new OrdersService(harness.fhir, sequences, bus),
    new ResultsService(harness.fhir, bus),
    new AppointmentsService(harness.fhir, bus),
    bus,
  );
  return { ...harness, service, sequences, events, bus };
}

const registration = (
  overrides: Partial<RegisterPatientDto> = {},
): RegisterPatientDto => ({
  firstName: 'Noura',
  lastName: 'Hassan',
  gender: 'female',
  birthDate: '1992-03-14',
  ...overrides,
});

describe('patientSearchParams', () => {
  it('reads the query as a phone number, an MRN or a name', () => {
    expect(patientSearchParams(undefined)).toEqual({});
    expect(patientSearchParams('  ')).toEqual({});
    expect(patientSearchParams('+966500000001')).toEqual({
      phone: '+966500000001',
    });
    expect(patientSearchParams('t1-00042')).toEqual({
      identifier: `${MRN_SYSTEM}|T1-00042`,
    });
    expect(patientSearchParams('Aisha')).toEqual({ name: 'Aisha' });
    expect(patientSearchParams('عائشة')).toEqual({ name: 'عائشة' });
  });
});

describe('WardIndex', () => {
  const location = (
    id: string,
    name: string,
    type: string,
    partOf?: string,
  ) => ({
    resourceType: 'Location' as const,
    id,
    name,
    physicalType: { coding: [{ code: type }] },
    ...(partOf ? { partOf: { reference: `Location/${partOf}` } } : {}),
  });

  it('walks from a bed up to its ward', () => {
    const index = new WardIndex([
      location('ward-1', 'Ward 2 North', 'wa'),
      location('room-1', 'Room 4', 'ro', 'ward-1'),
      location('bed-1', 'Bed 4A', 'bd', 'room-1'),
    ]);

    expect(index.wardOf('bed-1')).toBe('Ward 2 North');
    expect(index.wardOf('ward-1')).toBe('Ward 2 North');
    expect(index.wardOf('ghost')).toBeNull();
    expect(index.wardOf(null)).toBeNull();
  });

  it('falls back to the parent, then to the location itself', () => {
    const index = new WardIndex([
      location('unit', 'ICU', 'si'),
      location('bed-1', 'ICU-1', 'bd', 'unit'),
      location('lonely', 'Bed 9', 'bd'),
    ]);

    expect(index.wardOf('bed-1')).toBe('ICU');
    expect(index.wardOf('lonely')).toBe('Bed 9');
  });
});

describe('PatientsService', () => {
  describe('register', () => {
    it('assigns the next free MRN, skipping numbers already in use', async () => {
      // The harness already holds T1-00001 and T1-00002.
      const { service, sequences, store } = build(1);

      const created = await service.register(registration(), ACTOR, NOW);

      expect(created.mrn).toBe('T1-00003');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(sequences.next).toHaveBeenCalledTimes(3);
      expect(created.entrySource).toBe('MANUAL');
      const stored = store.get<Patient>(`Patient/${created.id}`);
      expect(stored.identifier?.[0]).toMatchObject({
        system: MRN_SYSTEM,
        value: 'T1-00003',
      });
      expect(
        store
          .all<Patient>('Patient')
          .filter((p) => p.identifier?.some((i) => i.value === 'T1-00003')),
      ).toHaveLength(1);
    });

    it('stores bilingual names, contact details and the entry source', async () => {
      const { service, store } = build(10);

      const created = await service.register(
        registration({
          firstNameAr: 'نورة',
          lastNameAr: 'حسن',
          nationalId: '1012345678',
          mobile: '+966500000009',
          email: 'noura@example.com',
          preferredLanguage: 'ar',
          emergencyContact: {
            name: 'Hassan Ali',
            relationship: 'Father',
            phone: '+966500000010',
          },
        }),
        ACTOR,
        NOW,
      );

      expect(created).toMatchObject({
        name: 'Noura Hassan',
        nameAr: 'نورة حسن',
      });
      const stored = store.get<Patient>(`Patient/${created.id}`);
      expect(
        stored.identifier?.find((i) => i.system === NATIONAL_ID_SYSTEM)?.value,
      ).toBe('1012345678');
      expect(stored.telecom).toEqual([
        { system: 'phone', use: 'mobile', value: '+966500000009' },
        { system: 'email', value: 'noura@example.com' },
      ]);
      expect(stored.communication?.[0]).toMatchObject({
        preferred: true,
        language: { coding: [{ code: 'ar' }] },
      });
      expect(stored.contact?.[0]).toMatchObject({
        relationship: [{ text: 'Father' }],
        name: { text: 'Hassan Ali' },
      });
      expect(stored.meta?.tag).toContainEqual({
        system: ENTRY_SOURCE_SYSTEM,
        code: 'MANUAL',
      });
    });

    it('files an iqama under its own identifier system', async () => {
      const { service, store } = build(10);

      const created = await service.register(
        registration({ nationalId: '2098765432' }),
        ACTOR,
        NOW,
      );

      const stored = store.get<Patient>(`Patient/${created.id}`);
      expect(stored.identifier?.some((i) => i.system === IQAMA_SYSTEM)).toBe(
        true,
      );
      expect(
        stored.identifier?.some((i) => i.system === NATIONAL_ID_SYSTEM),
      ).toBe(false);
    });

    it('announces A28 so the welcome message can go out', async () => {
      const { service, events } = build(10);

      const created = await service.register(registration(), ACTOR, NOW);

      expect(events).toEqual([
        expect.objectContaining({
          channel: 'emr.adt',
          event: 'A28',
          patientId: created.id,
          data: { mrn: 'T1-00010' },
        }),
      ]);
    });

    it('refuses a second patient with the same national id', async () => {
      const { service } = build(10);
      await service.register(
        registration({ nationalId: '1012345678' }),
        ACTOR,
        NOW,
      );

      await expect(
        service.register(
          registration({ firstName: 'Other', nationalId: '1012345678' }),
          ACTOR,
          NOW,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      ['a future birth date', { birthDate: '2027-01-01' }],
      ['an impossible date', { birthDate: '2026-02-30' }],
      ['an implausibly early date', { birthDate: '1850-01-01' }],
      ['a blank name', { firstName: '   ' }],
      ['only one Arabic name', { firstNameAr: 'نورة' }],
    ])('rejects %s', async (_label, overrides) => {
      const { service, store } = build(10);
      const before = store.all('Patient').length;

      await expect(
        service.register(registration(overrides), ACTOR, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.all('Patient')).toHaveLength(before);
    });
  });

  describe('list', () => {
    function seedClinicalData(ctx: ReturnType<typeof build>) {
      ctx.store.seed({
        resourceType: 'Location',
        id: 'ward-a',
        name: 'Ward A',
        status: 'active',
        physicalType: { coding: [{ code: 'wa' }] },
      });
      ctx.store.seed({
        resourceType: 'Location',
        id: 'bed-a1',
        name: 'Bed A1',
        status: 'active',
        physicalType: { coding: [{ code: 'bd' }] },
        partOf: { reference: 'Location/ward-a' },
      });
      ctx.store.seed(
        encounter('enc-ipd', 'patient-1', {
          class: { code: 'IMP' },
          location: [
            {
              status: 'active',
              location: { reference: 'Location/bed-a1', display: 'Bed A1' },
            },
          ],
          period: { start: '2026-10-05T08:00:00.000Z' },
        }),
      );
      ctx.store.seed(
        encounter('enc-opd', 'patient-2', {
          class: { code: 'AMB' },
          period: { start: '2026-10-06T07:00:00.000Z' },
        }),
      );
      ctx.store.seed<AllergyIntolerance>({
        resourceType: 'AllergyIntolerance',
        id: 'allergy-1',
        patient: { reference: 'Patient/patient-1' },
        clinicalStatus: { coding: [{ code: 'active' }] },
        code: { text: 'Penicillin' },
      });
      ctx.store.seed<Observation>({
        resourceType: 'Observation',
        id: 'obs-crit',
        status: 'final',
        category: [{ coding: [{ code: 'laboratory' }] }],
        code: { coding: [{ code: '777-3' }] },
        subject: { reference: 'Patient/patient-1' },
        interpretation: [{ coding: [{ code: 'LL' }] }],
        effectiveDateTime: '2026-10-05T10:00:00.000Z',
      });
    }

    it('lists patients with class, ward and the critical / allergy flags', async () => {
      const ctx = build();
      seedClinicalData(ctx);

      const { items } = await ctx.service.list({}, ACTOR, NOW);

      const aisha = items.find((i) => i.mrn === 'T1-00001');
      expect(aisha).toMatchObject({
        name: 'Aisha Rahman',
        nameAr: 'عائشة رحمن',
        patientClass: 'IMP',
        ward: 'Ward A',
        location: 'Bed A1',
        critical: true,
        hasAllergy: true,
        ageYears: 36,
      });
      const omar = items.find((i) => i.mrn === 'T1-00002');
      expect(omar).toMatchObject({
        patientClass: 'AMB',
        ward: null,
        critical: false,
        hasAllergy: false,
      });
    });

    it('filters by care setting', async () => {
      const ctx = build();
      seedClinicalData(ctx);

      expect(
        (await ctx.service.list({ filter: 'inpatient' }, ACTOR, NOW)).items.map(
          (i) => i.mrn,
        ),
      ).toEqual(['T1-00001']);
      expect(
        (await ctx.service.list({ filter: 'opd' }, ACTOR, NOW)).items.map(
          (i) => i.mrn,
        ),
      ).toEqual(['T1-00002']);
      expect(
        (await ctx.service.list({ filter: 'ed' }, ACTOR, NOW)).items,
      ).toEqual([]);
    });

    it('filters to patients with a recent critical result', async () => {
      const ctx = build();
      seedClinicalData(ctx);

      const { items } = await ctx.service.list(
        { filter: 'critical' },
        ACTOR,
        NOW,
      );

      expect(items.map((i) => i.mrn)).toEqual(['T1-00001']);
      expect(items[0].patientClass).toBe('IMP');
    });

    it('ignores critical results older than a week', async () => {
      const ctx = build();
      seedClinicalData(ctx);

      const { items } = await ctx.service.list(
        { filter: 'critical' },
        ACTOR,
        new Date('2026-10-20T09:00:00.000Z'),
      );

      expect(items).toEqual([]);
    });

    it('searches by name, Arabic name and MRN', async () => {
      const ctx = build();
      seedClinicalData(ctx);

      const names = async (q: string) =>
        (await ctx.service.list({ q }, ACTOR, NOW)).items.map((i) => i.mrn);

      expect(await names('omar')).toEqual(['T1-00002']);
      expect(await names('T1-00001')).toEqual(['T1-00001']);
      expect(await names('nobody')).toEqual([]);
      expect(
        (
          await ctx.service.list(
            { q: 'Rahman', filter: 'inpatient' },
            ACTOR,
            NOW,
          )
        ).items,
      ).toHaveLength(1);
      expect(
        (await ctx.service.list({ q: 'Rahman', filter: 'opd' }, ACTOR, NOW))
          .items,
      ).toHaveLength(0);
    });

    it('prefers the inpatient encounter when a patient has several open', async () => {
      const ctx = build();
      seedClinicalData(ctx);
      ctx.store.seed(
        encounter('enc-opd-2', 'patient-1', {
          class: { code: 'AMB' },
          period: { start: '2026-10-06T08:00:00.000Z' },
        }),
      );

      const { items } = await ctx.service.list({}, ACTOR, NOW);

      expect(items.find((i) => i.mrn === 'T1-00001')?.patientClass).toBe('IMP');
    });

    it('returns chip counts', async () => {
      const ctx = build();
      seedClinicalData(ctx);

      const { counts } = await ctx.service.list({}, ACTOR, NOW);

      expect(counts).toEqual({
        all: 2,
        inpatient: 1,
        opd: 1,
        ed: 0,
        critical: 1,
      });
    });

    it('does not show patients the caller cannot see', async () => {
      const ctx = build();
      ctx.store.hide('Patient/patient-2');

      const { items } = await ctx.service.list({}, ACTOR, NOW);

      expect(items.map((i) => i.mrn)).toEqual(['T1-00001']);
    });
  });

  describe('overview', () => {
    it('gathers the chart summary: counts, latest vitals, diagnoses, activity', async () => {
      const ctx = build();
      ctx.store.seed(
        encounter('enc-1', 'patient-1', {
          class: { code: 'IMP' },
          period: { start: '2026-10-05T08:00:00.000Z' },
        }),
      );
      const vitals = new VitalsService(ctx.fhir);
      await vitals.record(
        {
          patientId: 'patient-1',
          readings: [{ code: 'HR', value: 80 }],
          measuredAt: '2026-10-06T06:00:00.000Z',
        },
        ACTOR,
        NOW,
      );
      await vitals.record(
        {
          patientId: 'patient-1',
          readings: [
            { code: 'HR', value: 135 },
            { code: 'SPO2', value: 97 },
          ],
          measuredAt: '2026-10-06T08:00:00.000Z',
        },
        ACTOR,
        NOW,
      );
      await new DiagnosesService(ctx.fhir).create(
        {
          patientId: 'patient-1',
          encounterId: 'enc-1',
          type: 'PRIMARY',
          code: 'J18.9',
          display: 'Pneumonia',
        },
        ACTOR,
        NOW,
      );
      ctx.store.seed<AllergyIntolerance>({
        resourceType: 'AllergyIntolerance',
        id: 'allergy-1',
        patient: { reference: 'Patient/patient-1' },
        clinicalStatus: { coding: [{ code: 'active' }] },
        code: { text: 'Penicillin' },
      });

      const overview = await ctx.service.overview('patient-1', ACTOR, NOW);

      expect(overview.patient).toMatchObject({
        mrn: 'T1-00001',
        name: 'Aisha Rahman',
        allergies: ['Penicillin'],
        preferredLanguage: 'en',
        ageYears: 36,
      });
      expect(overview.activeEncounter).toMatchObject({
        id: 'enc-1',
        patientClass: 'IMP',
      });
      expect(overview.counts).toMatchObject({
        encounters: 1,
        vitals: 3,
        diagnoses: 1,
        orders: 0,
      });
      const hr = overview.latestVitals.find((v) => v.code === 'HR');
      expect(hr?.value).toBe(135);
      expect(overview.latestVitals.filter((v) => v.code === 'HR')).toHaveLength(
        1,
      );
      expect(overview.diagnoses[0]).toMatchObject({ code: 'J18.9' });
      expect(overview.recentActivity.length).toBeGreaterThan(0);
      const times = overview.recentActivity.map((a) => a.at);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('is not found for a patient the caller cannot see', async () => {
      const ctx = build();
      ctx.store.hide('Patient/patient-1');

      await expect(
        ctx.service.overview('patient-1', ACTOR, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('audit', () => {
    it('lists versions newest first with what changed in each', async () => {
      const ctx = build();
      const current = ctx.store.get<Patient>('Patient/patient-1');
      await ctx.fhir.commit(ACTOR, [
        updateEntry({ ...current, birthDate: '1991-05-01' }),
      ]);

      const { versions, patient } = await ctx.service.audit('patient-1', ACTOR);

      expect(patient).toMatchObject({ mrn: 'T1-00001', name: 'Aisha Rahman' });
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({ kind: 'updated', versionId: '2' });
      expect(versions[0].changes).toEqual([
        { path: 'birthDate', before: '1990-05-01', after: '1991-05-01' },
      ]);
      expect(versions[1]).toMatchObject({ kind: 'created', versionId: '1' });
      expect(versions[1].changes.length).toBeGreaterThan(3);
    });

    it('is not found for a patient the caller cannot see', async () => {
      const ctx = build();
      ctx.store.hide('Patient/patient-1');

      await expect(
        ctx.service.audit('patient-1', ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
