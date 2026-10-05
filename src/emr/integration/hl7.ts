import { randomUUID } from 'node:crypto';
import { SCHEDULING } from '../emr.constants';

/** A message that cannot be read as HL7 v2. `code` is stored with the message. */
export class Hl7ParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'Hl7ParseError';
  }
}

export type Hl7Segment = {
  name: string;
  /** Field `n` is at index `n`; index 0 is the segment name. */
  fields: string[];
};

export type Hl7Message = {
  segments: Hl7Segment[];
  separators: {
    field: string;
    component: string;
    repetition: string;
    escape: string;
    subcomponent: string;
  };
  /** MSH-3 / MSH-4 */
  sendingApplication: string;
  sendingFacility: string;
  /** `ORU^R01` (MSH-9.1 ^ MSH-9.2). */
  messageType: string;
  trigger: string;
  controlId: string;
  version: string;
};

const MAX_SEGMENTS = 2000;

/** Parses a pipe-delimited HL7 v2 message (segments separated by CR, LF or CRLF). */
export function parseHl7(raw: string): Hl7Message {
  const text = raw
    .replace(/^\uFEFF/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/^\u000b/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001c\r?$/, '');
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Hl7ParseError('EMPTY_MESSAGE', 'The message is empty');
  }
  if (lines.length > MAX_SEGMENTS) {
    throw new Hl7ParseError(
      'TOO_LARGE',
      `The message has more than ${MAX_SEGMENTS} segments`,
    );
  }
  if (!lines[0].startsWith('MSH') || lines[0].length < 8) {
    throw new Hl7ParseError(
      'NO_MSH',
      'The message does not start with an MSH segment',
    );
  }

  const field = lines[0][3];
  const encoding = lines[0].split(field)[1] ?? '';
  if (encoding.length < 4) {
    throw new Hl7ParseError(
      'BAD_ENCODING',
      'MSH-2 must carry four encoding characters',
    );
  }
  const [component, repetition, escape, subcomponent] = encoding;

  const segments = lines.map((line): Hl7Segment => {
    const parts = line.split(field);
    if (parts[0] === 'MSH') {
      // MSH-1 is the separator itself, so MSH-n sits at index n.
      return { name: 'MSH', fields: ['MSH', field, ...parts.slice(1)] };
    }
    return { name: parts[0], fields: parts };
  });

  const msh = segments[0];
  const type = (msh.fields[9] ?? '').split(component);
  const messageType =
    type[0] && type[1] ? `${type[0]}^${type[1]}` : (type[0] ?? '');
  const controlId = (msh.fields[10] ?? '').trim();
  if (!messageType) {
    throw new Hl7ParseError(
      'MISSING_MESSAGE_TYPE',
      'MSH-9 (message type) is empty',
    );
  }
  if (!controlId) {
    throw new Hl7ParseError(
      'MISSING_CONTROL_ID',
      'MSH-10 (message control id) is empty',
    );
  }

  return {
    segments,
    separators: { field, component, repetition, escape, subcomponent },
    sendingApplication: msh.fields[3] ?? '',
    sendingFacility: msh.fields[4] ?? '',
    messageType,
    trigger: type[1] ?? '',
    controlId,
    version: (msh.fields[12] ?? '').split(component)[0],
  };
}

export function segmentsOf(message: Hl7Message, name: string): Hl7Segment[] {
  return message.segments.filter((segment) => segment.name === name);
}

/** Component `index` (1-based) of a field, unescaped. */
export function componentOf(
  message: Hl7Message,
  value: string | undefined,
  index: number,
): string {
  const part = (value ?? '')
    .split(message.separators.repetition)[0]
    .split(message.separators.component)[index - 1];
  return unescapeHl7(message, part ?? '').trim();
}

/** The whole field, unescaped, first repetition. */
export function fieldText(
  message: Hl7Message,
  value: string | undefined,
): string {
  return componentOf(message, value, 1);
}

export function unescapeHl7(message: Hl7Message, value: string): string {
  const e = message.separators.escape;
  if (!value.includes(e)) return value;
  const map: Record<string, string> = {
    F: message.separators.field,
    S: message.separators.component,
    T: message.separators.subcomponent,
    R: message.separators.repetition,
    E: e,
    '.br': '\n',
  };
  return value.replace(
    new RegExp(
      `${escapeRegex(e)}([^${escapeRegex(e)}]*)${escapeRegex(e)}`,
      'g',
    ),
    (whole, code: string) => map[code] ?? whole,
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * HL7 timestamp (`YYYY[MM[DD[HH[MM[SS]]]]][+/-ZZZZ]`) to ISO 8601. Without a
 * zone the time is read as clinic-local. Returns `undefined` if it is not a
 * real date.
 */
export function hl7Timestamp(value: string | undefined): string | undefined {
  const match =
    /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.\d+)?([+-]\d{4})?$/.exec(
      (value ?? '').trim(),
    );
  if (!match) return undefined;
  const [
    ,
    year,
    month = '01',
    day = '01',
    hour = '00',
    minute = '00',
    second = '00',
    zone,
  ] = match;
  const offsetMinutes = zone
    ? (zone[0] === '-' ? -1 : 1) *
      (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)))
    : SCHEDULING.utcOffsetMinutes;
  const utc =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ) -
    offsetMinutes * 60_000;
  const date = new Date(utc);
  // Reject roll-over such as month 13 or Feb 30.
  const local = new Date(utc + offsetMinutes * 60_000);
  if (
    Number.isNaN(date.getTime()) ||
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() !== Number(month) - 1 ||
    local.getUTCDate() !== Number(day)
  ) {
    return undefined;
  }
  return date.toISOString();
}

export type AckCodeValue = 'AA' | 'AE' | 'AR';

/** Builds an HL7 ACK for `message` (or a bare one when it could not be parsed). */
export function buildAck(
  message: Hl7Message | undefined,
  code: AckCodeValue,
  detail: string,
  now = new Date(),
): string {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  const trigger = message?.trigger ?? '';
  const header = [
    'MSH',
    '^~\\&',
    'SUNBIRD',
    'EMR',
    message?.sendingApplication ?? '',
    message?.sendingFacility ?? '',
    stamp,
    '',
    trigger ? `ACK^${trigger}` : 'ACK',
    `ACK-${stamp}-${randomUUID().slice(0, 8)}`,
    'P',
    '2.5',
  ].join('|');
  const ack = [
    'MSA',
    code,
    message?.controlId ?? '',
    detail.replace(/\s*[|\r\n]+\s*/g, ' ').slice(0, 200),
  ].join('|');
  return `${header}\r${ack}\r`;
}
