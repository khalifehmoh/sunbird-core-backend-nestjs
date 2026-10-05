import {
  buildAck,
  componentOf,
  fieldText,
  hl7Timestamp,
  Hl7ParseError,
  parseHl7,
  segmentsOf,
} from './hl7';

const ORU = [
  'MSH|^~\\&|LAB|CENTRAL|SUNBIRD|EMR|20261006120000||ORU^R01|CTRL-1|P|2.5',
  'PID|1||T1-00001^^^HOSP^MR||Rahman^Aisha',
  'OBR|1|ORD-2026-00001||58410-2^CBC panel^LN|||20261006113000',
  'OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|12.0-16.0|N|||F',
].join('\r');

describe('parseHl7', () => {
  it('reads the header and addresses fields by their HL7 number', () => {
    const message = parseHl7(ORU);

    expect(message.messageType).toBe('ORU^R01');
    expect(message.trigger).toBe('R01');
    expect(message.controlId).toBe('CTRL-1');
    expect(message.sendingApplication).toBe('LAB');
    expect(message.sendingFacility).toBe('CENTRAL');
    expect(message.version).toBe('2.5');
    const obx = segmentsOf(message, 'OBX')[0];
    expect(fieldText(message, obx.fields[5])).toBe('13.2');
    expect(componentOf(message, obx.fields[3], 2)).toBe('Hemoglobin');
  });

  it('accepts LF and CRLF segment separators and a leading MLLP frame', () => {
    const lf = parseHl7(ORU.replace(/\r/g, '\n'));
    const crlf = parseHl7(ORU.replace(/\r/g, '\r\n'));
    const framed = parseHl7(`\u000b${ORU}\u001c\r`);

    expect(lf.segments).toHaveLength(4);
    expect(crlf.segments).toHaveLength(4);
    expect(framed.controlId).toBe('CTRL-1');
  });

  it('honours the separators declared in MSH-2', () => {
    const message = parseHl7(
      ['MSH#@~\\&#A#B#C#D#20261006##ADT@A01#X1#P#2.5', 'PID#1##M1'].join('\r'),
    );

    expect(message.messageType).toBe('ADT@A01'.replace('@', '^'));
    expect(message.controlId).toBe('X1');
  });

  it('un-escapes HL7 escape sequences in text', () => {
    const message = parseHl7(
      [
        'MSH|^~\\&|A|B|C|D|20261006||ORU^R01|X2|P|2.5',
        'NTE|1||Line one\\.br\\Line two \\F\\ end',
      ].join('\r'),
    );

    expect(fieldText(message, segmentsOf(message, 'NTE')[0].fields[3])).toBe(
      'Line one\nLine two | end',
    );
  });

  it.each([
    ['', 'EMPTY_MESSAGE'],
    ['   \r\n', 'EMPTY_MESSAGE'],
    ['PID|1||X', 'NO_MSH'],
    ['MSH|^~', 'NO_MSH'],
    ['MSH|^|A|B|C|D|20261006||ORU^R01|X|P|2.5', 'BAD_ENCODING'],
  ])('rejects %j with %s', (raw, code) => {
    expect(() => parseHl7(raw)).toThrow(Hl7ParseError);
    try {
      parseHl7(raw);
    } catch (error) {
      expect((error as Hl7ParseError).code).toBe(code);
    }
  });

  it('rejects a message with no control id or type', () => {
    expect(() => parseHl7('MSH|^~\\&|A|B|C|D|20261006|||P|2.5')).toThrow(
      Hl7ParseError,
    );
  });
});

describe('hl7Timestamp', () => {
  it('reads a zoneless timestamp as clinic-local time (UTC+3)', () => {
    expect(hl7Timestamp('20261006120000')).toBe('2026-10-06T09:00:00.000Z');
  });

  it('honours an explicit zone', () => {
    expect(hl7Timestamp('20261006120000+0000')).toBe(
      '2026-10-06T12:00:00.000Z',
    );
    expect(hl7Timestamp('20261006120000-0500')).toBe(
      '2026-10-06T17:00:00.000Z',
    );
  });

  it('accepts date-only and minute precision', () => {
    expect(hl7Timestamp('20261006')).toBe('2026-10-05T21:00:00.000Z');
    expect(hl7Timestamp('202610061230')).toBe('2026-10-06T09:30:00.000Z');
  });

  it.each(['', 'abc', '20261306', '20260230', undefined])(
    'returns undefined for %j',
    (value) => {
      expect(hl7Timestamp(value)).toBeUndefined();
    },
  );
});

describe('buildAck', () => {
  const NOW = new Date('2026-10-06T09:00:00.000Z');

  it('echoes the control id and sender back to the sender', () => {
    const ack = buildAck(parseHl7(ORU), 'AA', 'stored', NOW);
    const [msh, msa] = ack.split('\r');

    expect(msh).toMatch(
      /^MSH\|\^~\\&\|SUNBIRD\|EMR\|LAB\|CENTRAL\|20261006090000\|\|ACK\^R01\|/,
    );
    expect(msh.endsWith('|P|2.5')).toBe(true);
    expect(msa).toBe('MSA|AA|CTRL-1|stored');
  });

  it('can acknowledge a message that could not be parsed', () => {
    const ack = buildAck(undefined, 'AR', 'not HL7', NOW);

    expect(ack).toContain('|ACK|');
    expect(ack).toContain('MSA|AR||not HL7');
  });

  it('keeps delimiters and newlines out of the free-text detail', () => {
    const ack = buildAck(
      parseHl7(ORU),
      'AE',
      'bad | value\r\nsecond line',
      NOW,
    );

    expect(ack.split('\r')[1]).toBe('MSA|AE|CTRL-1|bad value second line');
  });

  it('round-trips through the parser', () => {
    const ack = parseHl7(buildAck(parseHl7(ORU), 'AA', 'ok', NOW));

    expect(ack.messageType).toBe('ACK^R01');
    expect(segmentsOf(ack, 'MSA')[0].fields[1]).toBe('AA');
  });
});
