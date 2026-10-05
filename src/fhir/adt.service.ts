import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Encounter,
  Location,
  Organization,
  Patient,
  Practitioner,
  Reference,
} from '@medplum/fhirtypes';
import { VISIT_NUMBER_SYSTEM } from './fhir.constants';
import {
  applyDischarge,
  applyTransfer,
  bedOperationalStatus,
  toAdmitEncounter,
  toEncounterResponse,
  toLocationNode,
  toPreadmitEncounter,
  toRegisterEncounter,
} from './adt.mapper';
import type {
  AdmitRequestDto,
  BedBoardResponseDto,
  DischargeRequestDto,
  EncounterResponseDto,
  PreadmitRequestDto,
  RegisterVisitRequestDto,
  TransferRequestDto,
} from './dto/adt.dto';
import { systemActor, type MedplumActor } from './medplum-actor';
import { MedplumRegistry } from './medplum-registry';
import { MedplumService } from './medplum.service';

/**
 * ADT workflows as FHIR Encounter / Location transitions.
 *
 * HL7 event codes (A01–A05) are recorded as tags for traceability; the
 * authoritative clinical state is the Encounter itself. Bed occupancy is
 * enforced here so two concurrent admits cannot claim the same bed.
 */
@Injectable()
export class AdtService {
  constructor(
    private readonly medplum: MedplumService,
    private readonly registry: MedplumRegistry,
  ) {}

  async admit(
    dto: AdmitRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    await this.readPatient(dto.patientId, actor);
    await this.assertNoActiveInpatient(dto.patientId, actor);
    const bed = await this.readBed(dto.bedLocationId, actor);
    await this.assertBedFree(bed, actor);

    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, actor);
    }

    const visitNumber =
      dto.visitNumber ?? (await this.nextVisitNumber(actor, 'IP'));
    const organization = await this.findServiceProvider(actor);
    const encounter = toAdmitEncounter(
      dto,
      visitNumber,
      bed.name ?? bed.id ?? dto.bedLocationId,
      organization,
    );

    const client = this.medplum.getClient(actor);
    const created = await client.createResource(encounter);
    await this.setBedOccupancy(bed, true, actor);
    return toEncounterResponse(created);
  }

  async register(
    dto: RegisterVisitRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    await this.readPatient(dto.patientId, actor);
    let locationDisplay: string | undefined;
    if (dto.locationId) {
      const location = await this.readLocation(dto.locationId, actor);
      locationDisplay = location.name ?? location.id;
    }
    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, actor);
    }

    const prefix = dto.patientClass === 'EMER' ? 'ED' : 'OP';
    const visitNumber =
      dto.visitNumber ?? (await this.nextVisitNumber(actor, prefix));
    const organization = await this.findServiceProvider(actor);
    const encounter = toRegisterEncounter(
      dto,
      visitNumber,
      locationDisplay,
      organization,
    );

    const client = this.medplum.getClient(actor);
    const created = await client.createResource(encounter);
    return toEncounterResponse(created);
  }

  async transfer(
    dto: TransferRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    const encounter = await this.readEncounter(dto.encounterId, actor);
    if (encounter.status !== 'in-progress' || encounter.class?.code !== 'IMP') {
      throw new BadRequestException(
        'Only an active inpatient encounter can be transferred',
      );
    }

    const bed = await this.readBed(dto.bedLocationId, actor);
    await this.assertBedFree(bed, actor, encounter.id);

    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, actor);
    }

    const previousBedId = this.activeLocationId(encounter);
    const updated = applyTransfer(
      encounter,
      dto,
      bed.name ?? bed.id ?? dto.bedLocationId,
    );

    const client = this.medplum.getClient(actor);
    const saved = await client.updateResource(updated);

    if (previousBedId && previousBedId !== dto.bedLocationId) {
      const previous = await this.readLocation(previousBedId, actor);
      await this.setBedOccupancy(previous, false, actor);
    }
    await this.setBedOccupancy(bed, true, actor);
    return toEncounterResponse(saved);
  }

  async discharge(
    dto: DischargeRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    const encounter = await this.readEncounter(dto.encounterId, actor);
    if (encounter.status === 'finished' || encounter.status === 'cancelled') {
      throw new BadRequestException('Encounter is already closed');
    }
    if (encounter.class?.code !== 'IMP') {
      throw new BadRequestException(
        'Discharge (A03) applies to inpatient encounters; finish OPD/ED via status update',
      );
    }

    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, actor);
    }

    const bedId = this.activeLocationId(encounter);
    const updated = applyDischarge(encounter, dto);
    const client = this.medplum.getClient(actor);
    const saved = await client.updateResource(updated);

    if (bedId) {
      const bed = await this.readLocation(bedId, actor);
      if (this.isBed(bed)) {
        await this.setBedOccupancy(bed, false, actor);
      }
    }
    return toEncounterResponse(saved);
  }

  async preadmit(
    dto: PreadmitRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    await this.readPatient(dto.patientId, actor);
    let wardDisplay: string | undefined;
    if (dto.wardLocationId) {
      const ward = await this.readLocation(dto.wardLocationId, actor);
      wardDisplay = ward.name ?? ward.id;
    }
    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, actor);
    }

    const visitNumber =
      dto.visitNumber ?? (await this.nextVisitNumber(actor, 'PA'));
    const organization = await this.findServiceProvider(actor);
    const encounter = toPreadmitEncounter(
      dto,
      visitNumber,
      wardDisplay,
      organization,
    );

    const client = this.medplum.getClient(actor);
    const created = await client.createResource(encounter);
    return toEncounterResponse(created);
  }

  async convertPreadmitToAdmit(
    encounterId: string,
    dto: Omit<AdmitRequestDto, 'patientId'>,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    const planned = await this.readEncounter(encounterId, actor);
    if (planned.status !== 'planned' || planned.class?.code !== 'IMP') {
      throw new BadRequestException(
        'Only a planned inpatient pre-admission can convert to A01',
      );
    }
    const patientId = planned.subject?.reference?.replace(/^Patient\//, '');
    if (!patientId) {
      throw new BadRequestException('Pre-admission has no patient');
    }

    const admitted = await this.admit({ ...dto, patientId }, actor);
    const client = this.medplum.getClient(actor);
    await client.updateResource({ ...planned, status: 'cancelled' as const });
    return admitted;
  }

  async getEncounter(
    id: string,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return toEncounterResponse(await this.readEncounter(id, actor));
  }

  async bedBoard(actor: MedplumActor): Promise<BedBoardResponseDto> {
    const client = this.medplum.getClient(actor);
    const bundle = await client.search(
      'Location',
      new URLSearchParams({
        _count: '200',
        status: 'active',
      }).toString(),
    );
    const locations = (bundle.entry ?? [])
      .flatMap((entry) => (entry.resource ? [entry.resource as Location] : []))
      .map((location) => toLocationNode(location));

    const active = await client.search(
      'Encounter',
      new URLSearchParams({
        class: 'IMP',
        status: 'in-progress',
        _count: '100',
      }).toString(),
    );

    const occupancy = new Map<string, string>();
    for (const entry of active.entry ?? []) {
      const encounter = entry.resource as Encounter | undefined;
      if (!encounter?.id) continue;
      const bedId = this.activeLocationId(encounter);
      if (bedId) occupancy.set(bedId, encounter.id);
    }

    return {
      locations: locations.map((node) => ({
        ...node,
        occupiedByEncounterId: occupancy.get(node.id) ?? null,
      })),
    };
  }

  /**
   * Integrity checks (one active inpatient stay, one patient per bed, visit
   * number sequence) must see the whole tenant, not just the caller's branch,
   * so they read as the tenant's `system` member. Authorization for the
   * resources involved is still established earlier by reading them as the
   * caller.
   */
  private tenantWideClient(actor: MedplumActor) {
    return this.medplum.getClient(systemActor(actor.tenantId));
  }

  private async assertNoActiveInpatient(
    patientId: string,
    actor: MedplumActor,
  ): Promise<void> {
    const client = this.tenantWideClient(actor);
    const bundle = await client.search(
      'Encounter',
      new URLSearchParams({
        subject: `Patient/${patientId}`,
        class: 'IMP',
        status: 'in-progress',
        _count: '1',
      }).toString(),
    );
    if ((bundle.entry?.length ?? 0) > 0) {
      throw new ConflictException(
        'Patient already has an active inpatient encounter',
      );
    }
  }

  private async assertBedFree(
    bed: Location,
    actor: MedplumActor,
    ignoreEncounterId?: string,
  ): Promise<void> {
    if (bed.operationalStatus?.code === 'O') {
      const client = this.tenantWideClient(actor);
      const bundle = await client.search(
        'Encounter',
        new URLSearchParams({
          location: `Location/${bed.id}`,
          status: 'in-progress',
          _count: '5',
        }).toString(),
      );
      const conflict = (bundle.entry ?? []).find(
        (entry) => entry.resource?.id !== ignoreEncounterId,
      );
      if (conflict) {
        throw new ConflictException(
          `Bed ${bed.name ?? bed.id} is already occupied`,
        );
      }
    }
  }

  private async setBedOccupancy(
    bed: Location,
    occupied: boolean,
    actor: MedplumActor,
  ): Promise<void> {
    const client = this.medplum.getClient(actor);
    await client.updateResource({
      ...bed,
      operationalStatus: bedOperationalStatus(occupied),
    });
  }

  private activeLocationId(encounter: Encounter): string | undefined {
    const active = encounter.location?.find(
      (entry) => entry.status === 'active',
    );
    return active?.location?.reference?.replace(/^Location\//, '');
  }

  private isBed(location: Location): boolean {
    return location.physicalType?.coding?.[0]?.code === 'bd';
  }

  /**
   * Reads a resource as the caller. A resource outside their tenant or branch
   * is invisible to them, so Medplum answers 404 and so do we; no tag check is
   * needed here.
   */
  private async readVisible<
    T extends 'Patient' | 'Encounter' | 'Location' | 'Practitioner',
  >(resourceType: T, id: string, actor: MedplumActor) {
    try {
      return await this.medplum.getClient(actor).readResource(resourceType, id);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new NotFoundException(`${resourceType} ${id} not found`);
    }
  }

  private readPatient(id: string, actor: MedplumActor): Promise<Patient> {
    return this.readVisible('Patient', id, actor);
  }

  private readEncounter(id: string, actor: MedplumActor): Promise<Encounter> {
    return this.readVisible('Encounter', id, actor);
  }

  private readLocation(id: string, actor: MedplumActor): Promise<Location> {
    return this.readVisible('Location', id, actor);
  }

  private readPractitioner(
    id: string,
    actor: MedplumActor,
  ): Promise<Practitioner> {
    return this.readVisible('Practitioner', id, actor);
  }

  private async readBed(id: string, actor: MedplumActor): Promise<Location> {
    const location = await this.readLocation(id, actor);
    if (!this.isBed(location)) {
      throw new BadRequestException('Selected location is not a bed');
    }
    return location;
  }

  /** The caller's branch `Organization` (or the tenant root) as `serviceProvider`. */
  private async findServiceProvider(
    actor: MedplumActor,
  ): Promise<Reference<Organization> | undefined> {
    const organizationId = this.registry.organizationForMember(actor);
    if (!organizationId) return undefined;
    try {
      const organization = await this.medplum
        .getClient(actor)
        .readResource('Organization', organizationId);
      return {
        reference: `Organization/${organization.id}`,
        display: organization.name,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return undefined;
    }
  }

  private async nextVisitNumber(
    actor: MedplumActor,
    prefix: string,
  ): Promise<string> {
    const client = this.tenantWideClient(actor);
    const year = new Date().getFullYear();
    const bundle = await client.search(
      'Encounter',
      new URLSearchParams({
        _count: '1',
        _sort: '-_lastUpdated',
        identifier: `${VISIT_NUMBER_SYSTEM}|`,
      }).toString(),
    );
    const latest = bundle.entry?.[0]?.resource as Encounter | undefined;
    const last = latest?.identifier?.find(
      (id) => id.system === VISIT_NUMBER_SYSTEM,
    )?.value;
    const match = last?.match(/(\d+)$/);
    const next = (match ? Number(match[1]) : 0) + 1;
    return `${prefix}-${year}-${String(next).padStart(5, '0')}`;
  }
}
