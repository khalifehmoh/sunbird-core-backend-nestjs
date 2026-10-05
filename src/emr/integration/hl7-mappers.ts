import { ProcessingError } from '../common/processing-error';
import type { InboundObservation } from '../results/results.dto';
import {
  componentOf,
  fieldText,
  hl7Timestamp,
  segmentsOf,
  type Hl7Message,
  type Hl7Segment,
} from './hl7';

/** What an inbound message asks the EMR to do, independent of HL7 syntax. */

export type ParsedResultGroup = {
  controlId: string;
  orderNumber?: string;
  code: string;
  display: string;
  type: 'LAB' | 'RAD';
  issuedAt?: string;
  conclusion?: string;
  observations: InboundObservation[];
};

export type ParsedOru = { mrn: string; groups: ParsedResultGroup[] };

export type ParsedOrder = {
  mrn: string;
  control: 'NW' | 'CA' | 'DC';
  orderNumber?: string;
  code: string;
  display: string;
  type: 'LAB' | 'RAD';
  priority: 'ROUTINE' | 'URGENT' | 'STAT';
  reason?: string;
};

export type ParsedAppointment = {
  externalId: string;
  mrn: string;
  practitionerId: string;
  start: string;
  durationMinutes: number;
  reason?: string;
};

export type ParsedCancellation = { externalId: string; reason: string };

/** The patient's MRN from PID-3 (the `MR` identifier, else the first one). */
export function mrnFrom(message: Hl7Message): string {
  const pid = segmentsOf(message, 'PID')[0];
  if (!pid) {
    throw new ProcessingError('MISSING_PID', 'The message has no PID segment');
  }
  const repetitions = (pid.fields[3] ?? '')
    .split(message.separators.repetition)
    .filter(Boolean);
  const chosen =
    repetitions.find(
      (value) => componentOf(message, value, 5).toUpperCase() === 'MR',
    ) ?? repetitions[0];
  const mrn = chosen ? componentOf(message, chosen, 1) : '';
  if (!mrn) {
    throw new ProcessingError(
      'MISSING_MRN',
      'PID-3 carries no patient identifier',
    );
  }
  return mrn;
}

function serviceFrom(message: Hl7Message, obr: Hl7Segment) {
  const code = componentOf(message, obr.fields[4], 1);
  if (!code) {
    throw new ProcessingError(
      'MISSING_SERVICE',
      'OBR-4 (universal service id) is empty',
    );
  }
  return {
    code,
    display: componentOf(message, obr.fields[4], 2) || code,
    type:
      fieldText(message, obr.fields[24]).toUpperCase() === 'RAD'
        ? ('RAD' as const)
        : ('LAB' as const),
  };
}

export function mapOru(message: Hl7Message): ParsedOru {
  const mrn = mrnFrom(message);
  const groups: ParsedResultGroup[] = [];
  let current: ParsedResultGroup | undefined;
  const notes: string[] = [];
  const closeGroup = () => {
    if (current && notes.length > 0) current.conclusion = notes.join('\n');
    notes.length = 0;
  };

  for (const segment of message.segments) {
    if (segment.name === 'OBR') {
      closeGroup();
      const service = serviceFrom(message, segment);
      current = {
        controlId:
          groups.length === 0
            ? message.controlId
            : `${message.controlId}#${groups.length + 1}`,
        orderNumber: componentOf(message, segment.fields[2], 1) || undefined,
        ...service,
        issuedAt:
          hl7Timestamp(fieldText(message, segment.fields[22])) ??
          hl7Timestamp(fieldText(message, segment.fields[7])),
        observations: [],
      };
      groups.push(current);
    } else if (segment.name === 'OBX' && current) {
      const code = componentOf(message, segment.fields[3], 1);
      if (!code) {
        throw new ProcessingError(
          'MISSING_OBSERVATION_ID',
          'An OBX segment has no observation identifier (OBX-3)',
        );
      }
      current.observations.push({
        code,
        display: componentOf(message, segment.fields[3], 2) || code,
        value: fieldText(message, segment.fields[5]),
        unit: componentOf(message, segment.fields[6], 1) || undefined,
        referenceRange: fieldText(message, segment.fields[7]) || undefined,
        flag: fieldText(message, segment.fields[8]) || undefined,
        status: fieldText(message, segment.fields[11]) || undefined,
        observedAt: hl7Timestamp(fieldText(message, segment.fields[14])),
      });
    } else if (segment.name === 'NTE' && current) {
      const note = fieldText(message, segment.fields[3]);
      if (note) notes.push(note);
    }
  }
  closeGroup();

  if (groups.length === 0) {
    throw new ProcessingError(
      'NO_OBR',
      'The result message has no OBR segment',
    );
  }
  return { mrn, groups };
}

const PRIORITY: Record<string, ParsedOrder['priority']> = {
  S: 'STAT',
  A: 'URGENT',
  T: 'URGENT',
};

export function mapOrm(message: Hl7Message): ParsedOrder {
  const mrn = mrnFrom(message);
  const orc = segmentsOf(message, 'ORC')[0];
  const obr = segmentsOf(message, 'OBR')[0];
  if (!orc)
    throw new ProcessingError(
      'MISSING_ORC',
      'The order message has no ORC segment',
    );
  if (!obr)
    throw new ProcessingError('NO_OBR', 'The order message has no OBR segment');

  const control = fieldText(message, orc.fields[1]).toUpperCase();
  if (control !== 'NW' && control !== 'CA' && control !== 'DC') {
    throw new ProcessingError(
      'UNSUPPORTED_ORDER_CONTROL',
      `Order control ${control || '(empty)'} is not supported; use NW, CA or DC`,
    );
  }
  const orderNumber =
    componentOf(message, orc.fields[2], 1) ||
    componentOf(message, obr.fields[2], 1) ||
    undefined;
  if (control !== 'NW' && !orderNumber) {
    throw new ProcessingError(
      'MISSING_ORDER_NUMBER',
      'A cancellation needs the placer order number (ORC-2)',
    );
  }
  return {
    mrn,
    control,
    orderNumber,
    ...serviceFrom(message, obr),
    priority:
      PRIORITY[fieldText(message, obr.fields[5]).toUpperCase()] ?? 'ROUTINE',
    reason: componentOf(message, orc.fields[16], 2) || undefined,
  };
}

function externalIdFrom(message: Hl7Message, sch: Hl7Segment): string {
  const id =
    componentOf(message, sch.fields[1], 1) ||
    componentOf(message, sch.fields[2], 1);
  if (!id) {
    throw new ProcessingError(
      'MISSING_APPOINTMENT_ID',
      'SCH-1 / SCH-2 (appointment id) is empty',
    );
  }
  return id;
}

export function mapSiuBooking(message: Hl7Message): ParsedAppointment {
  const mrn = mrnFrom(message);
  const sch = segmentsOf(message, 'SCH')[0];
  if (!sch)
    throw new ProcessingError(
      'MISSING_SCH',
      'The scheduling message has no SCH segment',
    );
  const aip = segmentsOf(message, 'AIP')[0];
  const ais = segmentsOf(message, 'AIS')[0];

  const practitionerId = aip ? componentOf(message, aip.fields[3], 1) : '';
  if (!practitionerId) {
    throw new ProcessingError(
      'MISSING_PROVIDER',
      'AIP-3 (personnel resource id) is empty',
    );
  }
  const start =
    hl7Timestamp(componentOf(message, sch.fields[11], 4)) ??
    (ais ? hl7Timestamp(fieldText(message, ais.fields[4])) : undefined);
  if (!start) {
    throw new ProcessingError(
      'MISSING_START',
      'No valid start time in SCH-11.4 or AIS-4',
    );
  }
  const duration = Number(fieldText(message, sch.fields[9]));
  return {
    externalId: externalIdFrom(message, sch),
    mrn,
    practitionerId,
    start,
    durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : 30,
    reason:
      componentOf(message, sch.fields[7], 2) ||
      componentOf(message, sch.fields[7], 1) ||
      undefined,
  };
}

export function mapSiuCancellation(message: Hl7Message): ParsedCancellation {
  const sch = segmentsOf(message, 'SCH')[0];
  if (!sch)
    throw new ProcessingError(
      'MISSING_SCH',
      'The scheduling message has no SCH segment',
    );
  return {
    externalId: externalIdFrom(message, sch),
    reason:
      componentOf(message, sch.fields[6], 2) ||
      componentOf(message, sch.fields[6], 1) ||
      'Cancelled by the scheduling system',
  };
}
