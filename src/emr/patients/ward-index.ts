import type { Location } from '@medplum/fhirtypes';
import { idOfReference } from '../fhir-utils';

type Node = { id: string; name: string; type: string; parentId?: string };

const WARD_TYPES = new Set(['wa', 'ward']);

/**
 * Resolves the ward a bed, room or ward Location belongs to. An Encounter
 * points at the bed; clinicians and dashboards think in wards.
 */
export class WardIndex {
  private readonly nodes = new Map<string, Node>();

  constructor(locations: Location[]) {
    for (const location of locations) {
      if (!location.id) continue;
      this.nodes.set(location.id, {
        id: location.id,
        name: location.name ?? location.id,
        type: (
          location.physicalType?.coding?.[0]?.code ??
          location.physicalType?.text ??
          ''
        ).toLowerCase(),
        parentId: idOfReference(location.partOf?.reference, 'Location'),
      });
    }
  }

  /**
   * The nearest ancestor (or the location itself) that is a ward. Without a
   * typed ward, the bed's parent stands in; a location with no parent is its
   * own ward.
   */
  wardOf(locationId: string | null | undefined): string | null {
    if (!locationId) return null;
    const start = this.nodes.get(locationId);
    if (!start) return null;

    let node: Node | undefined = start;
    for (let depth = 0; node && depth < 8; depth += 1) {
      if (WARD_TYPES.has(node.type)) return node.name;
      node = node.parentId ? this.nodes.get(node.parentId) : undefined;
    }
    return (
      (start.parentId ? this.nodes.get(start.parentId)?.name : undefined) ??
      start.name
    );
  }

  nameOf(locationId: string | null | undefined): string | null {
    return locationId ? (this.nodes.get(locationId)?.name ?? null) : null;
  }
}
