import type {
  Appointment,
  Observation,
  ServiceRequest,
} from '@medplum/fhirtypes';
import { AppointmentsService } from '../appointments/appointments.service';
import { DiagnosesService } from '../diagnoses/diagnoses.service';
import { IntegrationService } from '../integration/integration.service';
import { OrdersService } from '../orders/orders.service';
import { PatientsService } from '../patients/patients.service';
import { ResultsService } from '../results/results.service';
import type { SequenceService } from '../sequence.service';
import { ACTOR, buildHarness, encounter } from '../testing/harness';
import { InMemoryMessageStore } from '../testing/in-memory-message-store';
import { VitalsService } from '../vitals/vitals.service';
import { DashboardService } from './dashboard.service';

// 12:00 local (UTC+3) on Tuesday 2026-10-06. The fake store stamps resources
// in January, so "today" for lastUpdated-based figures is set separately.
const NOW = new Date('2026-10-06T09:00:00.000Z');

function build() {
  const harness = buildHarness();
  const sequences = {
    next: () => Promise.resolve(1),
  } as unknown as SequenceService;
  const results = new ResultsService(harness.fhir);
  const orders = new OrdersService(harness.fhir, sequences);
  const appointments = new AppointmentsService(harness.fhir);
  const messages = new InMemoryMessageStore();
  const integration = new IntegrationService(
    messages,
    harness.fhir,
    results,
    orders,
    appointments,
  );
  const patients = new PatientsService(
    harness.fhir,
    sequences,
    new DiagnosesService(harness.fhir),
    new VitalsService(harness.fhir),
    orders,
    results,
    appointments,
  );
  return {
    ...harness,
    messages,
    integration,
    service: new DashboardService(harness.fhir, patients, results, integration),
  };
}

// Local midnight 2026-10-06 is 2026-10-05T21:00:00Z.
const TODAY_AM = '2026-10-06T05:00:00.000Z';

describe('DashboardService', () => {
  it("counts today's registration activity and charts the week", async () => {
    const { store, service } = build();
    store.seed(
      encounter('e-admit', 'patient-1', {
        class: { code: 'IMP' },
        period: { start: TODAY_AM },
      }),
    );
    store.seed(
      encounter('e-opd-1', 'patient-2', {
        class: { code: 'AMB' },
        status: 'finished',
        period: { start: TODAY_AM, end: '2026-10-06T06:00:00.000Z' },
      }),
    );
    store.seed(
      encounter('e-opd-2', 'patient-1', {
        class: { code: 'AMB' },
        status: 'finished',
        period: {
          start: '2026-10-04T05:00:00.000Z',
          end: '2026-10-04T06:00:00.000Z',
        },
      }),
    );
    store.seed(
      encounter('e-disch', 'patient-2', {
        class: { code: 'IMP' },
        status: 'finished',
        period: { start: TODAY_AM, end: '2026-10-06T07:30:00.000Z' },
      }),
    );

    const summary = await service.summary(ACTOR, NOW);

    expect(summary.date).toBe('2026-10-06');
    expect(summary.kpis).toMatchObject({
      activeInpatients: 1,
      opdVisitsToday: 1,
      admissionsToday: 2,
      dischargesToday: 1,
    });
    expect(summary.activity).toHaveLength(7);
    expect(summary.activity.map((d) => d.date)).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ]);
    expect(summary.activity[4]).toMatchObject({
      date: '2026-10-04',
      opdVisits: 1,
    });
    expect(summary.activity[6]).toMatchObject({ opdVisits: 1, admissions: 2 });
    expect(summary.truncated).toBe(false);
  });

  it('counts orders, vitals, critical results and appointments for today', async () => {
    const { store, service } = build();
    store.seed<ServiceRequest>({
      resourceType: 'ServiceRequest',
      id: 'sr-1',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/patient-1' },
      authoredOn: TODAY_AM,
    });
    store.seed<ServiceRequest>({
      resourceType: 'ServiceRequest',
      id: 'sr-2',
      status: 'completed',
      intent: 'order',
      subject: { reference: 'Patient/patient-1' },
      authoredOn: '2026-10-01T05:00:00.000Z',
    });
    store.seed<Observation>({
      resourceType: 'Observation',
      id: 'o-crit',
      status: 'final',
      category: [{ coding: [{ code: 'laboratory' }] }],
      code: { coding: [{ code: '777-3' }] },
      subject: { reference: 'Patient/patient-1' },
      interpretation: [{ coding: [{ code: 'HH' }] }],
      effectiveDateTime: TODAY_AM,
    });
    store.seed<Observation>({
      resourceType: 'Observation',
      id: 'o-vital',
      status: 'final',
      category: [{ coding: [{ code: 'vital-signs' }] }],
      code: { coding: [{ code: '8867-4' }] },
      subject: { reference: 'Patient/patient-1' },
      effectiveDateTime: TODAY_AM,
    });
    store.seed<Appointment>({
      resourceType: 'Appointment',
      id: 'a-1',
      status: 'booked',
      start: '2026-10-06T10:00:00.000Z',
      participant: [
        { actor: { reference: 'Patient/patient-1' }, status: 'accepted' },
      ],
    });
    store.seed<Appointment>({
      resourceType: 'Appointment',
      id: 'a-2',
      status: 'cancelled',
      start: '2026-10-06T11:00:00.000Z',
      participant: [
        { actor: { reference: 'Patient/patient-2' }, status: 'declined' },
      ],
    });
    store.seed<Appointment>({
      resourceType: 'Appointment',
      id: 'a-3',
      status: 'noshow',
      start: '2026-10-06T06:00:00.000Z',
      participant: [
        { actor: { reference: 'Patient/patient-2' }, status: 'accepted' },
      ],
    });

    const summary = await service.summary(ACTOR, NOW);
    const clinical = await service.clinical(ACTOR, NOW);
    const registration = await service.registration(ACTOR, NOW);

    expect(summary.kpis).toMatchObject({
      pendingOrders: 1,
      criticalResultsToday: 1,
      vitalsRecordedToday: 1,
      appointmentsToday: 1,
    });
    expect(summary.criticalAlerts).toHaveLength(1);
    expect(clinical.kpis).toMatchObject({
      ordersToday: 1,
      pendingOrders: 1,
      criticalResultsToday: 1,
      vitalsRecordedToday: 1,
    });
    expect(registration.kpis).toMatchObject({ appointments: 1, noShows: 1 });
  });

  it('breaks inpatients down by ward and averages the length of stay', async () => {
    const { store, service } = build();
    store.seed({
      resourceType: 'Location',
      id: 'ward-a',
      name: 'Ward A',
      status: 'active',
      physicalType: { coding: [{ code: 'wa' }] },
    });
    store.seed({
      resourceType: 'Location',
      id: 'ward-b',
      name: 'Ward B',
      status: 'active',
      physicalType: { coding: [{ code: 'wa' }] },
    });
    for (const [id, bed, ward] of [
      ['bed-a1', 'A1', 'ward-a'],
      ['bed-a2', 'A2', 'ward-a'],
      ['bed-b1', 'B1', 'ward-b'],
    ]) {
      store.seed({
        resourceType: 'Location',
        id,
        name: `Bed ${bed}`,
        status: 'active',
        physicalType: { coding: [{ code: 'bd' }] },
        partOf: { reference: `Location/${ward}` },
      });
    }
    const admit = (id: string, patientId: string, bed: string, start: string) =>
      store.seed(
        encounter(id, patientId, {
          class: { code: 'IMP' },
          period: { start },
          location: [
            { status: 'active', location: { reference: `Location/${bed}` } },
          ],
        }),
      );
    admit('e1', 'patient-1', 'bed-a1', '2026-10-04T09:00:00.000Z'); // 2 days
    admit('e2', 'patient-2', 'bed-a2', '2026-10-05T09:00:00.000Z'); // 1 day
    store.seed({ resourceType: 'Patient', id: 'patient-3' });
    admit('e3', 'patient-3', 'bed-b1', '2026-10-03T09:00:00.000Z'); // 3 days
    store.seed(
      encounter('e4', 'patient-1', {
        class: { code: 'IMP' },
        period: { start: NOW.toISOString() },
      }),
    );

    const { inpatientsByWard, kpis } = await service.clinical(ACTOR, NOW);

    expect(inpatientsByWard).toEqual([
      { ward: 'Ward A', count: 2 },
      { ward: 'Unassigned', count: 1 },
      { ward: 'Ward B', count: 1 },
    ]);
    expect(kpis.activeInpatients).toBe(4);
    expect(kpis.averageLengthOfStayDays).toBe(1.5);
  });

  it('has no average length of stay with nobody admitted', async () => {
    const { service } = build();

    const { kpis, inpatientsByWard } = await service.clinical(ACTOR, NOW);

    expect(kpis.averageLengthOfStayDays).toBeNull();
    expect(inpatientsByWard).toEqual([]);
  });

  it("lists today's registration events, newest first, with patient names", async () => {
    const { store, service } = build();
    store.seed(
      encounter('e-admit', 'patient-1', {
        class: { code: 'IMP' },
        period: { start: '2026-10-06T05:00:00.000Z' },
      }),
    );
    store.seed(
      encounter('e-ed', 'patient-2', {
        class: { code: 'EMER' },
        period: { start: '2026-10-06T07:00:00.000Z' },
      }),
    );

    const { events } = await service.registration(ACTOR, NOW);

    expect(events.map((e) => e.event)).toEqual(['A04', 'A01']);
    expect(events[0]).toMatchObject({
      description: 'Registered (ED)',
      patientName: 'Omar Said',
      mrn: 'T1-00002',
    });
    expect(events[1]).toMatchObject({ patientName: 'Aisha Rahman' });
  });

  it('reports integration traffic for IT', async () => {
    const { service, integration } = build();
    // The in-memory store dates messages 2026-10-06 09:00 UTC.
    await integration.ingest(ACTOR.tenantId, 'garbage', 'HL7', NOW);

    const stats = await service.integrationStats(ACTOR, NOW);

    expect(stats).toMatchObject({
      received: 1,
      failed: 1,
      failureRatePercent: 100,
    });
  });
});
