import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EmrEventBus } from '../emr/emr-events';
import type {
  Bundle,
  BundleEntry,
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
import {
  createEntry,
  isConcurrentModification,
  resultAt,
  updateEntry,
} from './fhir-transaction';
import { KeyedMutex } from './keyed-mutex';
import { systemActor, type MedplumActor } from './medplum-actor';
import { MedplumRegistry } from './medplum-registry';
import { MedplumService } from './medplum.service';

/**
 * ADT workflows as FHIR Encounter / Location transitions.
 *
 * HL7 event codes (A01–A05) are recorded as tags for traceability; the
 * authoritative clinical state is the Encounter itself. Bed occupancy is
 * enforced here so two concurrent admits cannot claim the same bed.
 *
 * Every action that touches more than one resource (the Encounter and the
 * bed Location, or a pre-admission and its replacement) is sent as a single
 * FHIR transaction, so a failure leaves nothing half-written. The resources
 * are guarded with the versions that were read (`If-Match`), and the
 * check-then-write section runs one request at a time per tenant.
 */
@Injectable()
export class AdtService {
  private readonly writers = new KeyedMutex();

  constructor(
    private readonly medplum: MedplumService,
    private readonly registry: MedplumRegistry,
    @Optional() private readonly bus?: EmrEventBus,
  ) {}

  admit(
    dto: AdmitRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.announce('A01', actor, this.doAdmit(dto, actor));
  }

  register(
    dto: RegisterVisitRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.announce('A04', actor, this.doRegister(dto, actor));
  }

  transfer(
    dto: TransferRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.announce('A02', actor, this.doTransfer(dto, actor));
  }

  discharge(
    dto: DischargeRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.announce('A03', actor, this.doDischarge(dto, actor));
  }

  preadmit(
    dto: PreadmitRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.announce('A05', actor, this.doPreadmit(dto, actor));
  }

  convertPreadmitToAdmit(
    encounterId: string,
    dto: Omit<AdmitRequestDto, 'patientId'>,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.announce(
      'A01',
      actor,
      this.doConvertPreadmit(encounterId, dto, actor),
    );
  }

  /** Publishes the HL7 event once the action has committed; never before. */
  private async announce(
    event: string,
    actor: MedplumActor,
    action: Promise<EncounterResponseDto>,
  ): Promise<EncounterResponseDto> {
    const result = await action;
    this.bus?.publish({
      channel: 'emr.adt',
      event,
      tenantId: actor.tenantId,
      actor,
      patientId: result.patientId ?? undefined,
      resource: `Encounter/${result.id}`,
      data: {
        visitNumber: result.visitNumber,
        patientClass: result.patientClass,
        location: result.locationDisplay,
        periodStart: result.periodStart,
        periodEnd: result.periodEnd,
        lengthOfStayDays: result.lengthOfStayDays,
      },
    });
    return result;
  }

  private async doAdmit(
    dto: AdmitRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.serialized(actor, async () => {
      const entries = await this.planAdmit(dto, actor);
      const result = await this.commit(actor, entries);
      return toEncounterResponse(await this.resource(result, 0, actor));
    });
  }

  private async doRegister(
    dto: RegisterVisitRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.serialized(actor, async () => {
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
    });
  }

  private async doTransfer(
    dto: TransferRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.serialized(actor, async () => {
      const encounter = await this.readEncounter(dto.encounterId, actor);
      if (
        encounter.status !== 'in-progress' ||
        encounter.class?.code !== 'IMP'
      ) {
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
      const previousBed =
        previousBedId && previousBedId !== bed.id
          ? await this.findBed(previousBedId, actor)
          : undefined;
      const updated = applyTransfer(
        encounter,
        dto,
        bed.name ?? bed.id ?? dto.bedLocationId,
      );

      const entries: BundleEntry[] = [updateEntry(updated)];
      if (previousBed) {
        entries.push(updateEntry(this.withOccupancy(previousBed, false)));
      }
      entries.push(updateEntry(this.withOccupancy(bed, true)));

      const result = await this.commit(actor, entries);
      return toEncounterResponse(await this.resource(result, 0, actor));
    });
  }

  private async doDischarge(
    dto: DischargeRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.serialized(actor, async () => {
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
      const bed = bedId ? await this.findBed(bedId, actor) : undefined;
      const updated = applyDischarge(encounter, dto);

      const entries: BundleEntry[] = [updateEntry(updated)];
      if (bed) {
        entries.push(updateEntry(this.withOccupancy(bed, false)));
      }

      const result = await this.commit(actor, entries);
      return toEncounterResponse(await this.resource(result, 0, actor));
    });
  }

  private async doPreadmit(
    dto: PreadmitRequestDto,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.serialized(actor, async () => {
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
    });
  }

  private async doConvertPreadmit(
    encounterId: string,
    dto: Omit<AdmitRequestDto, 'patientId'>,
    actor: MedplumActor,
  ): Promise<EncounterResponseDto> {
    return this.serialized(actor, async () => {
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

      // One transaction: the admission is created, the bed is taken and the
      // pre-admission is cancelled together, or none of it happens.
      const entries = await this.planAdmit({ ...dto, patientId }, actor);
      entries.push(updateEntry({ ...planned, status: 'cancelled' as const }));

      const result = await this.commit(actor, entries);
      return toEncounterResponse(await this.resource(result, 0, actor));
    });
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
   * Validates an A01 and returns its transaction entries: the new inpatient
   * Encounter (always index 0) and the bed it occupies. Callers add whatever
   * else must commit with it and send the lot through {@link commit}.
   */
  private async planAdmit(
    dto: AdmitRequestDto,
    actor: MedplumActor,
  ): Promise<BundleEntry[]> {
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

    return [createEntry(encounter), updateEntry(this.withOccupancy(bed, true))];
  }

  /**
   * One ADT action at a time per tenant. The checks (bed free, no active
   * stay, next visit number) and the write that depends on them must not
   * interleave with another request doing the same.
   */
  private serialized<T>(
    actor: MedplumActor,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.writers.run(actor.tenantId, task);
  }

  /**
   * Sends the entries as one FHIR transaction as the caller. Medplum applies
   * all of them or none. A guarded resource that changed since it was read
   * (someone else took the bed, or already discharged the stay) surfaces as
   * a 409 so the client can reload instead of overwriting.
   */
  private async commit(
    actor: MedplumActor,
    entries: BundleEntry[],
  ): Promise<Bundle> {
    try {
      return await this.medplum.getClient(actor).executeBatch({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: entries,
      });
    } catch (error) {
      if (isConcurrentModification(error)) {
        throw new ConflictException(
          'The bed or encounter changed while this request was being processed. Reload and try again.',
        );
      }
      throw error;
    }
  }

  /** The Encounter at `index` of a transaction response. */
  private async resource(
    result: Bundle,
    index: number,
    actor: MedplumActor,
  ): Promise<Encounter> {
    const inline = resultAt<Encounter>(result, index);
    if (inline) return inline;

    const id =
      result.entry?.[index]?.response?.location?.match(
        /Encounter\/([^/]+)/,
      )?.[1];
    if (!id) {
      throw new Error('FHIR transaction did not return the Encounter');
    }
    return this.readEncounter(id, actor);
  }

  private withOccupancy(bed: Location, occupied: boolean): Location {
    return { ...bed, operationalStatus: bedOperationalStatus(occupied) };
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

  /**
   * The bed an encounter is leaving, if the caller can still see it. A stay
   * must remain closable or transferable when its previous bed has been
   * retired or moved out of the caller's branch, so a missing bed means
   * "nothing to free" rather than a failure.
   */
  private async findBed(
    id: string,
    actor: MedplumActor,
  ): Promise<Location | undefined> {
    try {
      const location = await this.readLocation(id, actor);
      return this.isBed(location) ? location : undefined;
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
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
