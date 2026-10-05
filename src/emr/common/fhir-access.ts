import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Bundle,
  BundleEntry,
  Encounter,
  Patient,
  Practitioner,
  Reference,
  Resource,
} from '@medplum/fhirtypes';
import type { MedplumClient } from '@medplum/core';
import { MRN_SYSTEM } from '../../fhir/fhir.constants';
import { isConcurrentModification } from '../../fhir/fhir-transaction';
import { systemActor, type MedplumActor } from '../../fhir/medplum-actor';
import { MedplumRegistry } from '../../fhir/medplum-registry';
import { MedplumService } from '../../fhir/medplum.service';
import { idOfReference } from '../fhir-utils';

/**
 * Shared FHIR access for the EMR services: delegated reads, atomic writes and
 * the error mapping the controllers expose. Every call is made for an actor
 * (the signed-in user, or the tenant's `system` member for background work).
 */
@Injectable()
export class FhirAccess {
  constructor(
    private readonly medplum: MedplumService,
    private readonly registry: MedplumRegistry,
  ) {}

  client(actor: MedplumActor): MedplumClient {
    return this.medplum.getClient(actor);
  }

  /** Sees the whole tenant, not one branch. For integrity checks and counts. */
  tenantWide(actor: MedplumActor): MedplumClient {
    return this.medplum.getClient(systemActor(actor.tenantId));
  }

  /**
   * Reads as the caller. A resource outside their tenant or branch is
   * invisible to them, so Medplum answers 404 and so do we.
   */
  async read<T extends Resource>(
    resourceType: T['resourceType'],
    id: string,
    actor: MedplumActor,
  ): Promise<T> {
    try {
      return (await this.client(actor).readResource(
        resourceType as 'Patient',
        id,
      )) as unknown as T;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new NotFoundException(`${resourceType} ${id} not found`);
    }
  }

  readPatient(id: string, actor: MedplumActor): Promise<Patient> {
    return this.read<Patient>('Patient', id, actor);
  }

  /** The Encounter, which must belong to `patientId` when one is given. */
  async readEncounterOf(
    encounterId: string,
    patientId: string | undefined,
    actor: MedplumActor,
  ): Promise<Encounter> {
    const encounter = await this.read<Encounter>(
      'Encounter',
      encounterId,
      actor,
    );
    if (
      patientId &&
      idOfReference(encounter.subject?.reference, 'Patient') !== patientId
    ) {
      throw new BadRequestException(
        'The encounter does not belong to this patient',
      );
    }
    return encounter;
  }

  /**
   * The patient with this MRN anywhere in the tenant. Used when a message
   * names a patient by MRN and no user (so no branch) is involved.
   */
  async findPatientIdByMrn(
    mrn: string,
    tenantId: string,
  ): Promise<string | undefined> {
    const bundle = await this.client(systemActor(tenantId)).search(
      'Patient',
      new URLSearchParams({
        identifier: `${MRN_SYSTEM}|${mrn}`,
        _count: '2',
      }).toString(),
    );
    const matches = (bundle.entry ?? []).flatMap((entry) =>
      entry.resource?.id ? [entry.resource.id] : [],
    );
    if (matches.length > 1) {
      throw new ConflictException(`More than one patient has MRN ${mrn}`);
    }
    return matches[0];
  }

  /** The Practitioner the user acts as in Medplum, when they have one. */
  performerOf(actor: MedplumActor): Reference<Practitioner> | undefined {
    const practitionerId = this.registry.tenant(actor.tenantId)?.members[
      actor.userId
    ]?.practitionerId;
    return practitionerId
      ? { reference: `Practitioner/${practitionerId}` }
      : undefined;
  }

  tenantCode(actor: MedplumActor): string {
    return this.registry.tenant(actor.tenantId)?.tenantCode ?? 'SB';
  }

  /**
   * One FHIR transaction as the caller: all entries apply or none do. A
   * guarded (`If-Match`) resource that changed since it was read becomes a
   * 409 so the client reloads instead of overwriting.
   */
  async commit(
    actor: MedplumActor,
    entries: BundleEntry[],
    conflictMessage = 'The record changed while this request was being processed. Reload and try again.',
  ): Promise<Bundle> {
    try {
      return await this.client(actor).executeBatch({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: entries,
      });
    } catch (error) {
      if (isConcurrentModification(error)) {
        throw new ConflictException(conflictMessage);
      }
      throw error;
    }
  }
}
