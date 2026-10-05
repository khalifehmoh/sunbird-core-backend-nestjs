import { LOINC_SYSTEM, UCUM_SYSTEM } from '../emr.constants';

export type Range = { low?: number; high?: number };

export type VitalDefinition = {
  key: string;
  loinc: string;
  display: string;
  displayAr: string;
  /** Unit as shown to users. */
  unit: string;
  /** UCUM code for the same unit. */
  ucum: string;
  /** Adult reference range; outside it the reading is abnormal. */
  normal?: Range;
  /** Outside this range the reading is critical (HL7 `LL` / `HH`). */
  critical?: Range;
  /** Values outside this range are rejected as entry mistakes. */
  plausible: Required<Range>;
};

/**
 * The vital signs the entry form records, LOINC coded. Ranges are adult
 * triage thresholds and apply to every patient until age-banded ranges are
 * specified; paediatric patients need their own table before this is used on
 * a children's ward.
 */
export const VITALS: readonly VitalDefinition[] = [
  {
    key: 'HR',
    loinc: '8867-4',
    display: 'Heart rate',
    displayAr: 'معدل النبض',
    unit: 'bpm',
    ucum: '/min',
    normal: { low: 60, high: 100 },
    critical: { low: 40, high: 150 },
    plausible: { low: 0, high: 300 },
  },
  {
    key: 'RR',
    loinc: '9279-1',
    display: 'Respiratory rate',
    displayAr: 'معدل التنفس',
    unit: 'breaths/min',
    ucum: '/min',
    normal: { low: 12, high: 20 },
    critical: { low: 8, high: 30 },
    plausible: { low: 0, high: 80 },
  },
  {
    key: 'SPO2',
    loinc: '2708-6',
    display: 'Oxygen saturation',
    displayAr: 'تشبع الأكسجين',
    unit: '%',
    ucum: '%',
    normal: { low: 95, high: 100 },
    critical: { low: 90 },
    plausible: { low: 0, high: 100 },
  },
  {
    key: 'TEMP',
    loinc: '8310-5',
    display: 'Body temperature',
    displayAr: 'درجة الحرارة',
    unit: '°C',
    ucum: 'Cel',
    normal: { low: 36.1, high: 37.8 },
    critical: { low: 35, high: 40 },
    plausible: { low: 25, high: 45 },
  },
  {
    key: 'BP_SYS',
    loinc: '8480-6',
    display: 'Systolic blood pressure',
    displayAr: 'الضغط الانقباضي',
    unit: 'mmHg',
    ucum: 'mm[Hg]',
    normal: { low: 90, high: 140 },
    critical: { low: 70, high: 180 },
    plausible: { low: 20, high: 300 },
  },
  {
    key: 'BP_DIA',
    loinc: '8462-4',
    display: 'Diastolic blood pressure',
    displayAr: 'الضغط الانبساطي',
    unit: 'mmHg',
    ucum: 'mm[Hg]',
    normal: { low: 60, high: 90 },
    critical: { low: 40, high: 120 },
    plausible: { low: 10, high: 200 },
  },
  {
    key: 'GLUCOSE',
    loinc: '2339-0',
    display: 'Blood glucose',
    displayAr: 'سكر الدم',
    unit: 'mg/dL',
    ucum: 'mg/dL',
    normal: { low: 70, high: 140 },
    critical: { low: 50, high: 400 },
    plausible: { low: 5, high: 1500 },
  },
  {
    key: 'WEIGHT',
    loinc: '29463-7',
    display: 'Body weight',
    displayAr: 'الوزن',
    unit: 'kg',
    ucum: 'kg',
    plausible: { low: 0.3, high: 500 },
  },
  {
    key: 'HEIGHT',
    loinc: '8302-2',
    display: 'Body height',
    displayAr: 'الطول',
    unit: 'cm',
    ucum: 'cm',
    plausible: { low: 20, high: 260 },
  },
  {
    key: 'PAIN',
    loinc: '72514-3',
    display: 'Pain severity (0-10)',
    displayAr: 'شدة الألم',
    unit: 'score',
    ucum: '{score}',
    plausible: { low: 0, high: 10 },
  },
];

export const VITAL_KEYS = VITALS.map((vital) => vital.key);

const BY_KEY = new Map(VITALS.map((vital) => [vital.key, vital]));
const BY_LOINC = new Map(VITALS.map((vital) => [vital.loinc, vital]));

export function vitalByKey(key: string): VitalDefinition | undefined {
  return BY_KEY.get(key);
}

export function vitalByLoinc(
  code: string | undefined,
): VitalDefinition | undefined {
  return code ? BY_LOINC.get(code) : undefined;
}

/** HL7 v3 ObservationInterpretation codes this module assigns. */
export type Interpretation = 'LL' | 'L' | 'N' | 'H' | 'HH';

export const CRITICAL_INTERPRETATIONS: readonly string[] = ['LL', 'HH', 'AA'];

/** `undefined` for vitals with no reference range (weight, height, pain). */
export function interpret(
  vital: VitalDefinition,
  value: number,
): Interpretation | undefined {
  if (!vital.normal && !vital.critical) return undefined;
  const { critical, normal } = vital;
  if (critical?.low !== undefined && value < critical.low) return 'LL';
  if (critical?.high !== undefined && value > critical.high) return 'HH';
  if (normal?.low !== undefined && value < normal.low) return 'L';
  if (normal?.high !== undefined && value > normal.high) return 'H';
  return 'N';
}

export function isCriticalInterpretation(code: string | undefined): boolean {
  return code !== undefined && CRITICAL_INTERPRETATIONS.includes(code);
}

export type VitalFlag = 'critical' | 'abnormal' | 'normal' | 'unrated';

export function flagOf(interpretation: string | undefined): VitalFlag {
  if (!interpretation) return 'unrated';
  if (isCriticalInterpretation(interpretation)) return 'critical';
  return interpretation === 'N' ? 'normal' : 'abnormal';
}

export function quantityFor(vital: VitalDefinition, value: number) {
  return { value, unit: vital.unit, system: UCUM_SYSTEM, code: vital.ucum };
}

export function codingFor(vital: VitalDefinition) {
  return { system: LOINC_SYSTEM, code: vital.loinc, display: vital.display };
}
