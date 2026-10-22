export type QuantityDimension = 'voltage' | 'current' | 'resistance' | 'capacitance';

export interface ParsedQuantity {
  value: number;
  unit: 'V' | 'A' | 'Ω' | 'F';
  enteredUnit: string;
  display: string;
}

export type QuantityParseResult =
  | { ok: true; quantity: ParsedQuantity }
  | { ok: false; error: string };

const BASE_UNITS: Record<QuantityDimension, ParsedQuantity['unit']> = { voltage: 'V', current: 'A', resistance: 'Ω', capacitance: 'F' };
const DEFAULT_UNITS: Record<QuantityDimension, string> = { voltage: 'V', current: 'A', resistance: 'Ω', capacitance: 'F' };
const PREFIXES: Record<string, number> = { m: 1e-3, k: 1e3, M: 1e6, u: 1e-6, μ: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12 };

function unitMultiplier(suffix: string, dimension: QuantityDimension): number | undefined {
  const normalized = suffix.replace(/Ω/g, 'Ω');
  if (!normalized) return 1;
  const lower = normalized.toLowerCase();
  if (dimension === 'voltage') {
    const units: Record<string, number> = { v: 1, mv: 1e-3, kv: 1e3 };
    if (units[lower] !== undefined) return units[lower];
    if (normalized === 'k') return 1e3;
    if (normalized === 'm') return 1e-3;
  }
  if (dimension === 'current') {
    const units: Record<string, number> = { a: 1, ma: 1e-3, ua: 1e-6, 'μa': 1e-6, 'µa': 1e-6, ka: 1e3 };
    if (units[lower] !== undefined) return units[lower];
    if (['m', 'u', 'μ', 'µ', 'k'].includes(normalized)) return PREFIXES[normalized];
  }
  if (dimension === 'resistance') {
    if (['Ω', 'ohm', 'ohms'].includes(normalized) || ['ohm', 'ohms'].includes(lower)) return 1;
    if (normalized === 'MΩ' || normalized === 'M') return 1e6;
    if (normalized === 'kΩ' || normalized === 'k') return 1e3;
    if (normalized === 'mΩ' || normalized === 'm') return 1e-3;
    if (lower === 'kohm') return 1e3;
    if (lower === 'mohm') return 1e-3;
    if (lower === 'megaohm' || lower === 'megohm') return 1e6;
  }
  if (dimension === 'capacitance') {
    const units: Record<string, number> = { f: 1, mf: 1e-3, uf: 1e-6, 'μf': 1e-6, 'µf': 1e-6, nf: 1e-9, pf: 1e-12 };
    if (units[lower] !== undefined) return units[lower];
    if (['m', 'u', 'μ', 'µ', 'n', 'p'].includes(normalized)) return PREFIXES[normalized];
  }
  return undefined;
}

/** Parse a quantity into SI base units. A bare prefix such as "4.7k" uses the expected dimension. */
export function parseQuantity(input: string | number, dimension: QuantityDimension): QuantityParseResult {
  const raw = String(input).trim().replace(/\u00a0/g, ' ');
  if (!raw) return { ok: false, error: 'أدخل قيمة ووحدة صالحتين.' };

  const match = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-zA-ZΩΩμµ]*)$/i);
  if (!match) return { ok: false, error: 'صيغة القيمة غير مفهومة. مثال: 4.7kΩ أو 20mA.' };

  const magnitude = Number(match[1]);
  const suffix = match[2];
  if (!Number.isFinite(magnitude)) return { ok: false, error: 'يجب أن تكون القيمة رقمًا محدودًا.' };

  const multiplier = unitMultiplier(suffix, dimension);
  const enteredUnit = suffix || DEFAULT_UNITS[dimension];
  if (multiplier === undefined) {
    return { ok: false, error: `الوحدة «${suffix}» لا تناسب المقدار ${dimensionLabel(dimension)}.` };
  }

  const value = magnitude * multiplier;
  if (!Number.isFinite(value)) return { ok: false, error: 'القيمة خارج النطاق العددي المسموح.' };
  const display = `= ${format(value)} ${BASE_UNITS[dimension]}`;
  return { ok: true, quantity: { value, unit: BASE_UNITS[dimension], enteredUnit, display } };
}

function dimensionLabel(dimension: QuantityDimension): string {
  return ({ voltage: 'الجهد', current: 'التيار', resistance: 'المقاومة', capacitance: 'السعة' })[dimension];
}

function format(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 }).format(value);
}
