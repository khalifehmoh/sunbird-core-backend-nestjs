import {
  BadRequestException,
  ConflictException,
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
import { MedplumService } from './medplum.service';
import {
  applyTenantTag,
  belongsToTenant,
  tenantTagSearchValue,
} from './tenant-scope';

/**
 * ADT workflows as FHIR Encounter / Location transitions.
 *
 * HL7 event codes (A01–A05) are recorded as tags for traceability; the
 * authoritative clinical state is the Encounter itself. Bed occupancy is
 * enforced here so two concurrent admits cannot claim the same bed.
 */
@Injectable()
export class AdtService {
  constructor(private readonly medplum: MedplumService) {}

  async admit(
    dto: AdmitRequestDto,
    tenantId: string,
  ): Promise<EncounterResponseDto> {
    await this.readPatient(dto.patientId, tenantId);
    await this.assertNoActiveInpatient(dto.patientId, tenantId);
    const bed = await this.readBed(dto.bedLocationId, tenantId);
    await this.assertBedFree(bed, tenantId);

    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, tenantId);
    }

    const visitNumber =
      dto.visitNumber ?? (await this.nextVisitNumber(tenantId, 'IP'));
    const organization = await this.findTenantOrganization(tenantId);
    const encounter = toAdmitEncounter(
      dto,
      visitNumber,
      bed.name ?? bed.id ?? dto.bedLocationId,
      organization,
    );

    const client = await this.medplum.getClient();
    const created = await client.createResource(
      applyTenantTag(encounter, tenantId),
    );
    await this.setBedOccupancy(bed, true, tenantId);
    return toEncounterResponse(created);
  }

  async register(
    dto: RegisterVisitRequestDto,
    tenantId: string,
  ): Promise<EncounterResponseDto> {
    await this.readPatient(dto.patientId, tenantId);
    let locationDisplay: string | undefined;
    if (dto.locationId) {
      const location = await this.readLocation(dto.locationId, tenantId);
      locationDisplay = location.name ?? location.id;
    }
    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, tenantId);
    }

    const prefix = dto.patientClass === 'EMER' ? 'ED' : 'OP';
    const visitNumber =
      dto.visitNumber ?? (await this.nextVisitNumber(tenantId, prefix));
    const organization = await this.findTenantOrganization(tenantId);
    const encounter = toRegisterEncounter(
      dto,
      visitNumber,
      locationDisplay,
      organization,
    );

    const client = await this.medplum.getClient();
    const created = await client.createResource(
      applyTenantTag(encounter, tenantId),
    );
    return toEncounterResponse(created);
  }

  async transfer(
    dto: TransferRequestDto,
    tenantId: string,
  ): Promise<EncounterResponseDto> {
    const encounter = await this.readEncounter(dto.encounterId, tenantId);
    if (encounter.status !== 'in-progress' || encounter.class?.code !== 'IMP') {
      throw new BadRequestException(
        'Only an active inpatient encounter can be transferred',
      );
    }

    const bed = await this.readBed(dto.bedLocationId, tenantId);
    await this.assertBedFree(bed, tenantId, encounter.id);

    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, tenantId);
    }

    const previousBedId = this.activeLocationId(encounter);
    const updated = applyTransfer(
      encounter,
      dto,
      bed.name ?? bed.id ?? dto.bedLocationId,
    );

    const client = await this.medplum.getClient();
    const saved = await client.updateResource(
      applyTenantTag(updated, tenantId),
    );

    if (previousBedId && previousBedId !== dto.bedLocationId) {
      const previous = await this.readLocation(previousBedId, tenantId);
      await this.setBedOccupancy(previous, false, tenantId);
    }
    await this.setBedOccupancy(bed, true, tenantId);
    return toEncounterResponse(saved);
  }

  async discharge(
    dto: DischargeRequestDto,
    tenantId: string,
  ): Promise<EncounterResponseDto> {
    const encounter = await this.readEncounter(dto.encounterId, tenantId);
    if (encounter.status === 'finished' || encounter.status === 'cancelled') {
      throw new BadRequestException('Encounter is already closed');
    }
    if (encounter.class?.code !== 'IMP') {
      throw new BadRequestException(
        'Discharge (A03) applies to inpatient encounters; finish OPD/ED via status update',
      );
    }

    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, tenantId);
    }

    const bedId = this.activeLocationId(encounter);
    const updated = applyDischarge(encounter, dto);
    const client = await this.medplum.getClient();
    const saved = await client.updateResource(
      applyTenantTag(updated, tenantId),
    );

    if (bedId) {
      const bed = await this.readLocation(bedId, tenantId);
      if (this.isBed(bed)) {
        await this.setBedOccupancy(bed, false, tenantId);
      }
    }
    return toEncounterResponse(saved);
  }

  async preadmit(
    dto: PreadmitRequestDto,
    tenantId: string,
  ): Promise<EncounterResponseDto> {
    await this.readPatient(dto.patientId, tenantId);
    let wardDisplay: string | undefined;
    if (dto.wardLocationId) {
      const ward = await this.readLocation(dto.wardLocationId, tenantId);
      wardDisplay = ward.name ?? ward.id;
    }
    if (dto.attendingPractitionerId) {
      await this.readPractitioner(dto.attendingPractitionerId, tenantId);
    }

    const visitNumber =
      dto.visitNumber ?? (await this.nextVisitNumber(tenantId, 'PA'));
    const organization = await this.findTenantOrganization(tenantId);
    const encounter = toPreadmitEncounter(
      dto,
      visitNumber,
      wardDisplay,
      organization,
    );

    const client = await this.medplum.getClient();
    const created = await client.createResource(
      applyTenantTag(encounter, tenantId),
    );
    return toEncounterResponse(created);
  }

  async convertPreadmitToAdmit(
    encounterId: string,
    dto: Omit<AdmitRequestDto, 'patientId'>,
    tenantId: string,
  ): Promise<EncounterResponseDto> {
    const planned = await this.readEncounter(encounterId, tenantId);
    if (planned.status !== 'planned' || planned.class?.code !== 'IMP') {
      throw new BadRequestException(
        'Only a planned inpatient pre-admission can convert to A01',
      );
    }
    const patientId = planned.subject?.reference?.replace(/^Patient\//, '');
    if (!patientId) {
      throw new BadRequestException('Pre-admission has no patient');
    }

    const admitted = await this.admit({ ...dto, patientId }, tenantId);
    const client = await this.medplum.getClient();
    await client.updateResource(
      applyTenantTag({ ...planned, status: 'cancelled' as const }, tenantId),
    );
    return admitted;
  }

  async getEncounter(
    id: string,
    tenantId: string,
  ): Promise<EncounterResponseDto> {
    return toEncounterResponse(await this.readEncounter(id, tenantId));
  }

  async bedBoard(tenantId: string): Promise<BedBoardResponseDto> {
    const client = await this.medplum.getClient();
    const bundle = await client.search(
      'Location',
      new URLSearchParams({
        _tag: tenantTagSearchValue(tenantId),
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
        _tag: tenantTagSearchValue(tenantId),
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

  private async assertNoActiveInpatient(
    patientId: string,
    tenantId: string,
  ): Promise<void> {
    const client = await this.medplum.getClient();
    const bundle = await client.search(
      'Encounter',
      new URLSearchParams({
        _tag: tenantTagSearchValue(tenantId),
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
    tenantId: string,
    ignoreEncounterId?: string,
  ): Promise<void> {
    if (bed.operationalStatus?.code === 'O') {
      const client = await this.medplum.getClient();
      const bundle = await client.search(
        'Encounter',
        new URLSearchParams({
          _tag: tenantTagSearchValue(tenantId),
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
    tenantId: string,
  ): Promise<void> {
    const client = await this.medplum.getClient();
    await client.updateResource(
      applyTenantTag(
        { ...bed, operationalStatus: bedOperationalStatus(occupied) },
        tenantId,
      ),
    );
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

  private async readPatient(id: string, tenantId: string): Promise<Patient> {
    const client = await this.medplum.getClient();
    try {
      const patient = await client.readResource('Patient', id);
      if (!belongsToTenant(patient, tenantId)) {
        throw new NotFoundException(`Patient ${id} not found`);
      }
      return patient;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new NotFoundException(`Patient ${id} not found`);
    }
  }

  private async readEncounter(
    id: string,
    tenantId: string,
  ): Promise<Encounter> {
    const client = await this.medplum.getClient();
    try {
      const encounter = await client.readResource('Encounter', id);
      if (!belongsToTenant(encounter, tenantId)) {
        throw new NotFoundException(`Encounter ${id} not found`);
      }
      return encounter;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new NotFoundException(`Encounter ${id} not found`);
    }
  }

  private async readLocation(id: string, tenantId: string): Promise<Location> {
    const client = await this.medplum.getClient();
    try {
      const location = await client.readResource('Location', id);
      if (!belongsToTenant(location, tenantId)) {
        throw new NotFoundException(`Location ${id} not found`);
      }
      return location;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new NotFoundException(`Location ${id} not found`);
    }
  }

  private async readBed(id: string, tenantId: string): Promise<Location> {
    const location = await this.readLocation(id, tenantId);
    if (!this.isBed(location)) {
      throw new BadRequestException('Selected location is not a bed');
    }
    return location;
  }

  private async readPractitioner(
    id: string,
    tenantId: string,
  ): Promise<Practitioner> {
    const client = await this.medplum.getClient();
    try {
      const practitioner = await client.readResource('Practitioner', id);
      if (!belongsToTenant(practitioner, tenantId)) {
        throw new NotFoundException(`Practitioner ${id} not found`);
      }
      return practitioner;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new NotFoundException(`Practitioner ${id} not found`);
    }
  }

  private async findTenantOrganization(
    tenantId: string,
  ): Promise<Reference<Organization> | undefined> {
    const client = await this.medplum.getClient();
    const bundle = await client.search(
      'Organization',
      new URLSearchParams({
        _tag: tenantTagSearchValue(tenantId),
        _count: '1',
      }).toString(),
    );
    const organization = bundle.entry?.[0]?.resource as
      Organization | undefined;
    if (!organization?.id) return undefined;
    return {
      reference: `Organization/${organization.id}`,
      display: organization.name,
    };
  }

  private async nextVisitNumber(
    tenantId: string,
    prefix: string,
  ): Promise<string> {
    const client = await this.medplum.getClient();
    const year = new Date().getFullYear();
    const bundle = await client.search(
      'Encounter',
      new URLSearchParams({
        _tag: tenantTagSearchValue(tenantId),
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
