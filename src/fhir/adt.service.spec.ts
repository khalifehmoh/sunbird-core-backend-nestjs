import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Encounter, Location } from '@medplum/fhirtypes';
import {
  bedOperationalStatus,
  locationEntry,
  physicalTypeCoding,
  visitIdentifier,
} from './adt.mapper';
import { AdtService } from './adt.service';
import type { AdmitRequestDto } from './dto/adt.dto';
import type { MedplumActor } from './medplum-actor';
import type { MedplumRegistry } from './medplum-registry';
import type { MedplumService } from './medplum.service';
import { FakeFhirStore } from './testing/fake-fhir-store';

const ACTOR: MedplumActor = { tenantId: 'tenant-1', userId: 'user-1' };
const YEAR = new Date().getFullYear();

function build() {
  const fhir = new FakeFhirStore();
  const medplum = {
    getClient: (actor: MedplumActor) => fhir.client(actor),
  } as unknown as MedplumService;
  const registry = {
    organizationForMember: () => 'org-1',
  } as unknown as MedplumRegistry;
  const service = new AdtService(medplum, registry);

  fhir.seed({ resourceType: 'Organization', id: 'org-1', name: 'Olaya' });
  for (const id of ['patient-1', 'patient-2', 'patient-3']) {
    fhir.seed({ resourceType: 'Patient', id });
  }
  fhir.seed({ resourceType: 'Practitioner', id: 'prac-1' });
  fhir.seed({
    resourceType: 'Location',
    id: 'room-1',
    name: 'Room 1',
    status: 'active',
    physicalType: physicalTypeCoding('ro', 'Room'),
  });
  for (const id of ['bed-1', 'bed-2', 'bed-3']) {
    fhir.seed(bed(id));
  }

  return { fhir, service };
}

function bed(id: string, occupied = false): Location {
  return {
    resourceType: 'Location',
    id,
    name: id.toUpperCase(),
    status: 'active',
    physicalType: physicalTypeCoding('bd', 'Bed'),
    operationalStatus: bedOperationalStatus(occupied),
  };
}

/** An in-progress inpatient stay in `bedId`, with the bed flagged occupied. */
function seedStay(
  fhir: FakeFhirStore,
  options: { id: string; patientId: string; bedId: string },
) {
  fhir.seed(bed(options.bedId, true));
  return fhir.seed<Encounter>({
    resourceType: 'Encounter',
    id: options.id,
    identifier: [visitIdentifier(`IP-${YEAR}-9${options.id.slice(-4)}`)],
    status: 'in-progress',
    class: { code: 'IMP' },
    subject: { reference: `Patient/${options.patientId}` },
    period: { start: '2026-09-01T00:00:00.000Z' },
    location: [
      locationEntry(
        options.bedId,
        options.bedId.toUpperCase(),
        'active',
        '2026-09-01T00:00:00.000Z',
      ),
    ],
  });
}

const admitDto = (
  patientId: string,
  bedLocationId: string,
): AdmitRequestDto => ({
  patientId,
  bedLocationId,
  admitType: 'routine',
});

const occupancyOf = (fhir: FakeFhirStore, id: string) =>
  fhir.get<Location>(`Location/${id}`).operationalStatus?.code;

describe('AdtService', () => {
  describe('admit (A01)', () => {
    it('creates the stay and takes the bed in one transaction', async () => {
      const { fhir, service } = build();

      const result = await service.admit(
        {
          ...admitDto('patient-1', 'bed-1'),
          attendingPractitionerId: 'prac-1',
        },
        ACTOR,
      );

      expect(fhir.transactions).toHaveLength(1);
      expect(fhir.transactions[0].entry).toHaveLength(2);
      expect(fhir.standaloneCreates).toHaveLength(0);
      expect(result).toMatchObject({
        status: 'in-progress',
        patientClass: 'IMP',
        visitNumber: `IP-${YEAR}-00001`,
        locationId: 'bed-1',
        lastAdtEvent: 'A01',
      });
      expect(occupancyOf(fhir, 'bed-1')).toBe('O');
      expect(
        fhir.get<Encounter>(`Encounter/${result.id}`).serviceProvider,
      ).toEqual({ reference: 'Organization/org-1', display: 'Olaya' });
    });

    it('guards the bed with the version it read', async () => {
      const { fhir, service } = build();

      await service.admit(admitDto('patient-1', 'bed-1'), ACTOR);

      const bedEntry = fhir.transactions[0].entry?.find(
        (entry) => entry.request?.url === 'Location/bed-1',
      );
      expect(bedEntry?.request?.ifMatch).toBe('W/"1"');
    });

    it('refuses a patient who already has an active inpatient stay', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-2',
      });

      await expect(
        service.admit(admitDto('patient-1', 'bed-1'), ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(fhir.transactions).toHaveLength(0);
      expect(occupancyOf(fhir, 'bed-1')).toBe('U');
    });

    it('refuses a bed that another stay holds', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-2',
        bedId: 'bed-1',
      });

      await expect(
        service.admit(admitDto('patient-1', 'bed-1'), ACTOR),
      ).rejects.toThrow('Bed BED-1 is already occupied');

      expect(fhir.transactions).toHaveLength(0);
    });

    it('reuses a bed that is flagged occupied but has no active stay', async () => {
      const { fhir, service } = build();
      fhir.seed(bed('bed-1', true));

      await expect(
        service.admit(admitDto('patient-1', 'bed-1'), ACTOR),
      ).resolves.toMatchObject({ locationId: 'bed-1' });
    });

    it('refuses a location that is not a bed', async () => {
      const { fhir, service } = build();

      await expect(
        service.admit(admitDto('patient-1', 'room-1'), ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fhir.transactions).toHaveLength(0);
    });

    it('answers 404 for a patient the caller cannot see', async () => {
      const { fhir, service } = build();
      fhir.hide('Patient/patient-1');

      await expect(
        service.admit(admitDto('patient-1', 'bed-1'), ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(fhir.transactions).toHaveLength(0);
    });

    it('writes nothing when the bed changed after it was read', async () => {
      const { fhir, service } = build();
      // Another writer commits to the bed between our read and our write.
      fhir.beforeNextTransaction = () => fhir.touch('Location/bed-1');

      await expect(
        service.admit(admitDto('patient-1', 'bed-1'), ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(fhir.all('Encounter')).toHaveLength(0);
      expect(occupancyOf(fhir, 'bed-1')).toBe('U');
    });

    it('lets exactly one of two simultaneous admits take the same bed', async () => {
      const { fhir, service } = build();

      const outcomes = await Promise.allSettled([
        service.admit(admitDto('patient-1', 'bed-1'), ACTOR),
        service.admit(admitDto('patient-2', 'bed-1'), ACTOR),
      ]);

      expect(outcomes.map((o) => o.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      const rejected = outcomes.find((o) => o.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
      expect(fhir.all<Encounter>('Encounter')).toHaveLength(1);
    });

    it('gives simultaneous admits different visit numbers', async () => {
      const { service } = build();

      const [first, second] = await Promise.all([
        service.admit(admitDto('patient-1', 'bed-1'), ACTOR),
        service.admit(admitDto('patient-2', 'bed-2'), ACTOR),
      ]);

      expect([first.visitNumber, second.visitNumber].sort()).toEqual([
        `IP-${YEAR}-00001`,
        `IP-${YEAR}-00002`,
      ]);
    });
  });

  describe('register (A04)', () => {
    it('registers OPD and ED visits with their own visit number prefix', async () => {
      const { fhir, service } = build();

      const opd = await service.register(
        { patientId: 'patient-1', patientClass: 'AMB', locationId: 'room-1' },
        ACTOR,
      );
      const ed = await service.register(
        { patientId: 'patient-2', patientClass: 'EMER' },
        ACTOR,
      );

      expect(opd).toMatchObject({
        patientClass: 'AMB',
        status: 'in-progress',
        visitNumber: `OP-${YEAR}-00001`,
        locationId: 'room-1',
      });
      expect(ed).toMatchObject({
        patientClass: 'EMER',
        status: 'arrived',
        visitNumber: `ED-${YEAR}-00002`,
      });
      expect(fhir.transactions).toHaveLength(0);
    });

    it('answers 404 for a patient the caller cannot see', async () => {
      const { fhir, service } = build();
      fhir.hide('Patient/patient-1');

      await expect(
        service.register(
          { patientId: 'patient-1', patientClass: 'AMB' },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('transfer (A02)', () => {
    const transferDto = (encounterId: string, bedLocationId: string) => ({
      encounterId,
      bedLocationId,
      transferReason: 'Higher acuity',
    });

    it('moves the stay and swaps both beds in one transaction', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });

      const result = await service.transfer(
        transferDto('enc-0001', 'bed-2'),
        ACTOR,
      );

      expect(fhir.transactions).toHaveLength(1);
      expect(fhir.transactions[0].entry).toHaveLength(3);
      expect(result).toMatchObject({
        locationId: 'bed-2',
        lastAdtEvent: 'A02',
      });
      expect(occupancyOf(fhir, 'bed-1')).toBe('U');
      expect(occupancyOf(fhir, 'bed-2')).toBe('O');

      const stored = fhir.get<Encounter>('Encounter/enc-0001');
      expect(stored.location?.map((l) => l.status)).toEqual([
        'completed',
        'active',
      ]);
    });

    it('refuses a destination bed that another stay holds', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });
      seedStay(fhir, {
        id: 'enc-0002',
        patientId: 'patient-2',
        bedId: 'bed-2',
      });

      await expect(
        service.transfer(transferDto('enc-0001', 'bed-2'), ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(fhir.transactions).toHaveLength(0);
      expect(occupancyOf(fhir, 'bed-1')).toBe('O');
    });

    it('refuses an encounter that is not an active inpatient stay', async () => {
      const { fhir, service } = build();
      fhir.seed<Encounter>({
        resourceType: 'Encounter',
        id: 'enc-opd',
        status: 'in-progress',
        class: { code: 'AMB' },
      });

      await expect(
        service.transfer(transferDto('enc-opd', 'bed-2'), ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still transfers when the previous bed is no longer visible', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });
      fhir.hide('Location/bed-1');

      await expect(
        service.transfer(transferDto('enc-0001', 'bed-2'), ACTOR),
      ).resolves.toMatchObject({ locationId: 'bed-2' });

      expect(fhir.transactions[0].entry).toHaveLength(2);
    });

    it('writes nothing when the stay changed after it was read', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });
      fhir.beforeNextTransaction = () => fhir.touch('Encounter/enc-0001');

      await expect(
        service.transfer(transferDto('enc-0001', 'bed-2'), ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(occupancyOf(fhir, 'bed-1')).toBe('O');
      expect(occupancyOf(fhir, 'bed-2')).toBe('U');
      expect(fhir.get<Encounter>('Encounter/enc-0001').location).toHaveLength(
        1,
      );
    });

    it('writes nothing when the destination bed was taken after it was read', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });
      fhir.beforeNextTransaction = () => fhir.touch('Location/bed-2');

      await expect(
        service.transfer(transferDto('enc-0001', 'bed-2'), ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(occupancyOf(fhir, 'bed-1')).toBe('O');
      expect(fhir.get<Encounter>('Encounter/enc-0001').location).toHaveLength(
        1,
      );
    });
  });

  describe('discharge (A03)', () => {
    const dischargeDto = (encounterId: string) => ({
      encounterId,
      dischargeDateTime: '2026-09-06T15:00:00.000Z',
      dischargeDisposition: 'home' as const,
      dischargeCondition: 'improved' as const,
    });

    it('closes the stay and frees the bed in one transaction', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });

      const result = await service.discharge(dischargeDto('enc-0001'), ACTOR);

      expect(fhir.transactions).toHaveLength(1);
      expect(fhir.transactions[0].entry).toHaveLength(2);
      expect(result).toMatchObject({
        status: 'finished',
        lastAdtEvent: 'A03',
        periodEnd: '2026-09-06T15:00:00.000Z',
      });
      expect(occupancyOf(fhir, 'bed-1')).toBe('U');
    });

    it('refuses an encounter that is already closed', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });
      await service.discharge(dischargeDto('enc-0001'), ACTOR);

      await expect(
        service.discharge(dischargeDto('enc-0001'), ACTOR),
      ).rejects.toThrow('already closed');
      expect(fhir.transactions).toHaveLength(1);
    });

    it('refuses an OPD or ED encounter', async () => {
      const { fhir, service } = build();
      fhir.seed<Encounter>({
        resourceType: 'Encounter',
        id: 'enc-opd',
        status: 'in-progress',
        class: { code: 'AMB' },
      });

      await expect(
        service.discharge(dischargeDto('enc-opd'), ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still closes the stay when its bed is no longer visible', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });
      fhir.hide('Location/bed-1');

      await expect(
        service.discharge(dischargeDto('enc-0001'), ACTOR),
      ).resolves.toMatchObject({ status: 'finished' });

      expect(fhir.transactions[0].entry).toHaveLength(1);
    });

    it('lets only one of two simultaneous discharges win', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });

      const outcomes = await Promise.allSettled([
        service.discharge(dischargeDto('enc-0001'), ACTOR),
        service.discharge(dischargeDto('enc-0001'), ACTOR),
      ]);

      expect(outcomes.map((o) => o.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(fhir.transactions).toHaveLength(1);
    });

    it('leaves the stay open when the bed changed after it was read', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });
      fhir.beforeNextTransaction = () => fhir.touch('Location/bed-1');

      await expect(
        service.discharge(dischargeDto('enc-0001'), ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(fhir.get<Encounter>('Encounter/enc-0001').status).toBe(
        'in-progress',
      );
      expect(occupancyOf(fhir, 'bed-1')).toBe('O');
    });
  });

  describe('pre-admission (A05)', () => {
    const preadmitDto = {
      patientId: 'patient-1',
      plannedStartDate: '2026-09-20',
      wardLocationId: 'room-1',
    };

    it('plans a future inpatient stay without touching any bed', async () => {
      const { fhir, service } = build();

      const result = await service.preadmit(preadmitDto, ACTOR);

      expect(result).toMatchObject({
        status: 'planned',
        patientClass: 'IMP',
        visitNumber: `PA-${YEAR}-00001`,
        lastAdtEvent: 'A05',
      });
      expect(fhir.transactions).toHaveLength(0);
      expect(occupancyOf(fhir, 'bed-1')).toBe('U');
    });

    it('converts to an admission, takes the bed and cancels the plan together', async () => {
      const { fhir, service } = build();
      const planned = await service.preadmit(preadmitDto, ACTOR);

      const admitted = await service.convertPreadmitToAdmit(
        planned.id,
        { bedLocationId: 'bed-1', admitType: 'elective' },
        ACTOR,
      );

      expect(fhir.transactions).toHaveLength(1);
      expect(fhir.transactions[0].entry).toHaveLength(3);
      expect(admitted).toMatchObject({
        status: 'in-progress',
        patientId: 'patient-1',
        locationId: 'bed-1',
        lastAdtEvent: 'A01',
      });
      expect(fhir.get<Encounter>(`Encounter/${planned.id}`).status).toBe(
        'cancelled',
      );
      expect(occupancyOf(fhir, 'bed-1')).toBe('O');
    });

    it('keeps the plan and creates no stay when the bed is taken', async () => {
      const { fhir, service } = build();
      const planned = await service.preadmit(preadmitDto, ACTOR);
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-2',
        bedId: 'bed-1',
      });

      await expect(
        service.convertPreadmitToAdmit(
          planned.id,
          { bedLocationId: 'bed-1', admitType: 'elective' },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(fhir.get<Encounter>(`Encounter/${planned.id}`).status).toBe(
        'planned',
      );
      expect(
        fhir
          .all<Encounter>('Encounter')
          .filter((e) => e.status === 'in-progress'),
      ).toHaveLength(1);
    });

    it('keeps the plan when the bed changes after it was read', async () => {
      const { fhir, service } = build();
      const planned = await service.preadmit(preadmitDto, ACTOR);
      fhir.beforeNextTransaction = () => fhir.touch('Location/bed-1');

      await expect(
        service.convertPreadmitToAdmit(
          planned.id,
          { bedLocationId: 'bed-1', admitType: 'elective' },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(fhir.get<Encounter>(`Encounter/${planned.id}`).status).toBe(
        'planned',
      );
      expect(fhir.all('Encounter')).toHaveLength(1);
    });

    it('only converts a planned inpatient pre-admission', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });

      await expect(
        service.convertPreadmitToAdmit(
          'enc-0001',
          { bedLocationId: 'bed-2', admitType: 'elective' },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('reads', () => {
    it('answers 404 for an encounter the caller cannot see', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });
      fhir.hide('Encounter/enc-0001');

      await expect(
        service.getEncounter('enc-0001', ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('shows which stay occupies each bed on the bed board', async () => {
      const { fhir, service } = build();
      seedStay(fhir, {
        id: 'enc-0001',
        patientId: 'patient-1',
        bedId: 'bed-1',
      });

      const board = await service.bedBoard(ACTOR);
      const byId = new Map(board.locations.map((l) => [l.id, l]));

      expect(byId.get('bed-1')?.occupiedByEncounterId).toBe('enc-0001');
      expect(byId.get('bed-2')?.occupiedByEncounterId).toBeNull();
    });
  });
});
