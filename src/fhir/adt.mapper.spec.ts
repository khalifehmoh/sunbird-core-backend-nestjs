import type { Encounter } from '@medplum/fhirtypes';
import {
  applyDischarge,
  applyTransfer,
  toAdmitEncounter,
  toEncounterResponse,
  toPreadmitEncounter,
  toRegisterEncounter,
} from './adt.mapper';

describe('adt.mapper', () => {
  it('builds an inpatient admit Encounter (A01)', () => {
    const encounter = toAdmitEncounter(
      {
        patientId: 'p-1',
        admitType: 'routine',
        admitSource: 'phys-ref',
        bedLocationId: 'bed-1',
        attendingPractitionerId: 'prac-1',
        primaryDiagnosisCode: 'J18.9',
        primaryDiagnosisDisplay: 'Pneumonia',
        hospitalService: 'Medicine',
        admitDateTime: '2026-09-06T09:00:00.000Z',
      },
      'IP-2026-00001',
      'WARD-MED-A-RM-01-BED-A',
    );

    expect(encounter.status).toBe('in-progress');
    expect(encounter.class?.code).toBe('IMP');
    expect(encounter.meta?.tag?.[0]?.code).toBe('A01');
    expect(encounter.location?.[0]?.location?.reference).toBe('Location/bed-1');
    expect(encounter.hospitalization?.admitSource?.coding?.[0]?.code).toBe(
      'phys-ref',
    );
  });

  it('builds OPD and ED registration Encounters (A04)', () => {
    const opd = toRegisterEncounter(
      {
        patientId: 'p-1',
        patientClass: 'AMB',
        locationId: 'clinic-1',
        visitReason: 'Checkup',
      },
      'OP-2026-00001',
      'CLINIC-OPD01',
    );
    expect(opd.class?.code).toBe('AMB');
    expect(opd.status).toBe('in-progress');
    expect(opd.meta?.tag?.[0]?.code).toBe('A04');

    const ed = toRegisterEncounter(
      {
        patientId: 'p-1',
        patientClass: 'EMER',
        triageCategory: 'urgent',
        arrivalMode: 'ambulance',
      },
      'ED-2026-00001',
      undefined,
    );
    expect(ed.class?.code).toBe('EMER');
    expect(ed.status).toBe('arrived');
  });

  it('appends location history on transfer (A02)', () => {
    const existing: Encounter = {
      resourceType: 'Encounter',
      id: 'enc-1',
      status: 'in-progress',
      class: { code: 'IMP' },
      location: [
        {
          location: { reference: 'Location/bed-old', display: 'OLD' },
          status: 'active',
          period: { start: '2026-09-01T00:00:00.000Z' },
        },
      ],
    };

    const updated = applyTransfer(
      existing,
      {
        encounterId: 'enc-1',
        bedLocationId: 'bed-new',
        transferReason: 'Higher acuity',
        transferDateTime: '2026-09-06T12:00:00.000Z',
      },
      'NEW-BED',
    );

    expect(updated.meta?.tag?.find((t) => t.code === 'A02')).toBeTruthy();
    expect(updated.location).toHaveLength(2);
    expect(updated.location?.[0]?.status).toBe('completed');
    expect(updated.location?.[0]?.period?.end).toBe('2026-09-06T12:00:00.000Z');
    expect(updated.location?.[1]?.location?.reference).toBe('Location/bed-new');
    expect(updated.location?.[1]?.status).toBe('active');
  });

  it('closes the Encounter on discharge (A03)', () => {
    const existing: Encounter = {
      resourceType: 'Encounter',
      id: 'enc-1',
      status: 'in-progress',
      class: { code: 'IMP' },
      period: { start: '2026-09-01T00:00:00.000Z' },
      location: [
        {
          location: { reference: 'Location/bed-1' },
          status: 'active',
          period: { start: '2026-09-01T00:00:00.000Z' },
        },
      ],
    };

    const updated = applyDischarge(existing, {
      encounterId: 'enc-1',
      dischargeDateTime: '2026-09-06T15:00:00.000Z',
      dischargeDisposition: 'home',
      dischargeCondition: 'improved',
    });

    expect(updated.status).toBe('finished');
    expect(updated.period?.end).toBe('2026-09-06T15:00:00.000Z');
    expect(
      updated.hospitalization?.dischargeDisposition?.coding?.[0]?.code,
    ).toBe('home');
    expect(updated.location?.[0]?.status).toBe('completed');
    expect(
      toEncounterResponse(updated).lengthOfStayDays,
    ).toBeGreaterThanOrEqual(5);
  });

  it('builds a planned pre-admission Encounter (A05)', () => {
    const encounter = toPreadmitEncounter(
      {
        patientId: 'p-1',
        plannedStartDate: '2026-09-20',
        wardLocationId: 'ward-1',
        plannedProcedure: 'Elective cholecystectomy',
        status: 'pending',
      },
      'PA-2026-00001',
      'WARD-SURG-A',
    );

    expect(encounter.status).toBe('planned');
    expect(encounter.class?.code).toBe('IMP');
    expect(encounter.meta?.tag?.[0]?.code).toBe('A05');
    expect(encounter.location?.[0]?.status).toBe('planned');
  });
});
