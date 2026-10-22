export const STORAGE_KEY = 'tayf-experiments';
export const SCHEMA_VERSION = 1;
export interface SavedExperiment {
  id: string; name: string; notes: string; type: 'physics' | 'chemistry';
  created: string; updated: string; data: Record<string, unknown>;
}
export interface ProjectExport { kind: 'tayf-project'; schemaVersion: 1; exportedAt: string; experiments: SavedExperiment[] }
export interface StorageAdapter {
  load(): SavedExperiment[];
  save(experiments: SavedExperiment[]): void;
}

export class StorageError extends Error { constructor(message: string) { super(message); this.name = 'StorageError'; } }

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly providedStorage?: Storage) {}
  private getStorage(): Storage {
    if (this.providedStorage) return this.providedStorage;
    try { return window.localStorage; }
    catch { throw new StorageError('التخزين المحلي محجوب في إعدادات هذا المتصفح.'); }
  }
  load(): SavedExperiment[] {
    let raw: string | null;
    try { raw = this.getStorage().getItem(STORAGE_KEY); }
    catch (error) { if (error instanceof StorageError) throw error; throw new StorageError('تعذرت قراءة التخزين المحلي في هذا المتصفح.'); }
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new StorageError('ملف التجارب المحلي تالف ولا يمكن قراءته.'); }
    if (Array.isArray(parsed)) {
      if (parsed.length > 1000) throw new StorageError('يحتوي سجل التجارب على عدد يتجاوز الحد المسموح.');
      const legacy = parsed.filter((experiment) => isSavedExperiment(experiment));
      if (legacy.length !== parsed.length) throw new StorageError('بعض التجارب القديمة غير صالحة؛ لم تُحمّل لتجنب نتائج غير موثوقة.');
      this.save(legacy);
      return legacy;
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.experiments) || parsed.experiments.length > 1000 || !parsed.experiments.every((experiment) => isSavedExperiment(experiment))) {
      throw new StorageError('مخطط سجل التجارب غير معروف أو تالف. صدّر نسخة احتياطية قبل استبداله.');
    }
    if (new Set(parsed.experiments.map((experiment: SavedExperiment) => experiment.id)).size !== parsed.experiments.length) throw new StorageError('سجل التجارب المحلي يحتوي معرّفات مكررة.');
    return parsed.experiments;
  }
  save(experiments: SavedExperiment[]): void {
    if (!Array.isArray(experiments) || experiments.length > 1000 || !experiments.every((experiment) => isSavedExperiment(experiment))) throw new StorageError('لم يُحفظ السجل لأن إحدى التجارب لا تطابق مخطط البيانات.');
    if (new Set(experiments.map((experiment) => experiment.id)).size !== experiments.length) throw new StorageError('لم يُحفظ السجل لوجود معرّفات تجارب مكررة.');
    const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, experiments });
    try { this.getStorage().setItem(STORAGE_KEY, payload); }
    catch { throw new StorageError('تعذر الحفظ: قد تكون مساحة التخزين ممتلئة أو محجوبة في إعدادات المتصفح. صدّر تجاربك واحذف بيانات غير لازمة.'); }
  }
}

export function isSavedExperiment(value: unknown, strict = false): value is SavedExperiment {
  if (!isRecord(value)) return false;
  if (strict && !hasOnlyKeys(value, ['id', 'name', 'notes', 'type', 'created', 'updated', 'data'])) return false;
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id)) return false;
  if (typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.length > 90) return false;
  if (typeof value.notes !== 'string' || value.notes.length > 10000) return false;
  if (value.type !== 'physics' && value.type !== 'chemistry') return false;
  if (typeof value.created !== 'string' || typeof value.updated !== 'string' || !Number.isFinite(Date.parse(value.created)) || !Number.isFinite(Date.parse(value.updated)) || !isRecord(value.data)) return false;
  if (strict) {
    const allowedData = value.type === 'physics' ? ['stateId', 'components', 'wires', 'referenceTerminal', 'lastCircuit'] : ['stateId', 'chemicals', 'volume', 'sampleVolume', 'temperature', 'mode', 'lastChem'];
    if (!hasOnlyKeys(value.data, allowedData) || typeof value.data.stateId !== 'string') return false;
  }
  if (value.type === 'chemistry' && value.data.mode !== undefined && !['auto', 'acidbase', 'precipitation', 'dilution'].includes(String(value.data.mode))) return false;
  if (value.type === 'physics') {
    const components = value.data.components;
    if (!Array.isArray(components) || components.length > 200 || !components.every((component) => isComponent(component, strict))) return false;
    const componentIds = components.map((component) => (component as Record<string, unknown>).id);
    if (new Set(componentIds).size !== componentIds.length) return false;
    const wires = value.data.wires;
    if (strict && !Array.isArray(wires)) return false;
    if (wires !== undefined && (!Array.isArray(wires) || wires.length > 1000 || !wires.every((wire) => isWire(wire, components, strict)))) return false;
    if (Array.isArray(wires) && new Set(wires.map((wire) => (wire as Record<string, unknown>).id)).size !== wires.length) return false;
    if (strict && typeof value.data.referenceTerminal !== 'string') return false;
    if (value.data.referenceTerminal !== undefined && typeof value.data.referenceTerminal !== 'string') return false;
    if (strict && value.data.lastCircuit !== undefined && value.data.lastCircuit !== null && !isRecord(value.data.lastCircuit)) return false;
  } else {
    const chemicals = value.data.chemicals;
    if (!Array.isArray(chemicals) || chemicals.length > 100 || !chemicals.every((chemical) => isChemicalRecord(chemical, strict))) return false;
    if (new Set(chemicals.map((chemical) => (chemical as Record<string, unknown>).id)).size !== chemicals.length) return false;
    if (strict && (typeof value.data.mode !== 'string' || !['auto', 'acidbase', 'precipitation', 'dilution'].includes(value.data.mode) || typeof value.data.volume !== 'string' && typeof value.data.volume !== 'number' || typeof value.data.sampleVolume !== 'string' && typeof value.data.sampleVolume !== 'number' || typeof value.data.temperature !== 'string' && typeof value.data.temperature !== 'number')) return false;
    if (strict && value.data.lastChem !== undefined && value.data.lastChem !== null && !isRecord(value.data.lastChem)) return false;
    for (const key of ['volume', 'temperature', 'sampleVolume']) {
      const field = value.data[key];
      if (field !== undefined && typeof field !== 'string' && (typeof field !== 'number' || !Number.isFinite(field))) return false;
      if (typeof field === 'string' && field.trim() !== '' && !Number.isFinite(Number(field))) return false;
    }
    if (value.data.mode !== undefined && !['auto', 'acidbase', 'precipitation', 'dilution'].includes(String(value.data.mode))) return false;
  }
  return true;
}

export function parseProjectImport(value: unknown): SavedExperiment[] {
  if (Array.isArray(value)) {
    if (!value.every((experiment) => isSavedExperiment(experiment))) throw new StorageError('ملف JSON قديم: توجد تجربة غير صالحة.');
    if (new Set(value.map((experiment) => experiment.id)).size !== value.length) throw new StorageError('ملف JSON يحتوي معرّفات تجارب مكررة.');
    return value;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'schemaVersion', 'exportedAt', 'experiments']) || value.kind !== 'tayf-project' || value.schemaVersion !== SCHEMA_VERSION || typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt)) || !Array.isArray(value.experiments) || value.experiments.length > 1000 || !value.experiments.every((experiment) => isSavedExperiment(experiment, true))) {
    throw new StorageError('ملف المشروع غير صالح أو أن إصدار المخطط غير مدعوم.');
  }
  if (new Set(value.experiments.map((experiment: SavedExperiment) => experiment.id)).size !== value.experiments.length) throw new StorageError('ملف المشروع يحتوي معرّفات تجارب مكررة.');
  return value.experiments;
}

export function makeProjectExport(experiments: SavedExperiment[]): ProjectExport {
  return { kind: 'tayf-project', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), experiments };
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function hasOnlyKeys(value: Record<string, any>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function isComponent(value: unknown, strict = false): boolean {
  if (!isRecord(value) || (strict && !hasOnlyKeys(value, ['id', 'type', 'name', 'value', 'x', 'y', 'unit', 'n1', 'n2', 'desc', 'symbol']))) return false;
  return typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.id)
    && typeof value.type === 'string' && ['source', 'resistor', 'switch', 'capacitor', 'inductor', 'ammeter', 'voltmeter', 'diode'].includes(value.type)
    && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 100
    && typeof value.value === 'number' && Number.isFinite(value.value)
    && typeof value.x === 'number' && Number.isFinite(value.x) && value.x >= 0 && value.x <= 760
    && typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0 && value.y <= 390
    && (value.unit === undefined || typeof value.unit === 'string')
    && (value.desc === undefined || typeof value.desc === 'string')
    && (value.symbol === undefined || typeof value.symbol === 'string')
    && (value.n1 === undefined || typeof value.n1 === 'number' && Number.isFinite(value.n1))
    && (value.n2 === undefined || typeof value.n2 === 'number' && Number.isFinite(value.n2));
}
function isWire(value: unknown, components: unknown[], strict = false): boolean {
  if (!isRecord(value) || (strict && (!hasOnlyKeys(value, ['id', 'from', 'to']) || !isRecord(value.from) || !isRecord(value.to) || !hasOnlyKeys(value.from, ['componentId', 'terminal']) || !hasOnlyKeys(value.to, ['componentId', 'terminal']))) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id) || !isRecord(value.from) || !isRecord(value.to)) return false;
  const ids = new Set(components.filter((item): item is Record<string, any> => isComponent(item)).map((component) => component.id));
  const validRef = (ref: Record<string, any>) => typeof ref.componentId === 'string' && ids.has(ref.componentId) && (ref.terminal === 'a' || ref.terminal === 'b');
  return validRef(value.from) && validRef(value.to);
}
function isChemicalRecord(value: unknown, strict = false): boolean {
  if (!isRecord(value) || (strict && !hasOnlyKeys(value, ['id', 'name', 'formula', 'cat', 'color', 'conc', 'molar', 'phase', 'kind', 'safety', 'source', 'version', 'molarMassVerified', 'moles', 'volume']))) return false;
  const baseValid = typeof value.id === 'string' && /^[a-z0-9_-]{1,50}$/.test(value.id)
    && typeof value.name === 'string' && value.name.trim().length > 0 && typeof value.formula === 'string' && value.formula.trim().length > 0
    && ['conc', 'moles', 'volume'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);
  if (!baseValid || !strict) return baseValid;
  return ['acid', 'base', 'salt', 'indicator'].includes(String(value.cat))
    && typeof value.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.color)
    && typeof value.molar === 'number' && Number.isFinite(value.molar) && value.molar > 0
    && typeof value.phase === 'string' && typeof value.kind === 'string' && typeof value.safety === 'string'
    && typeof value.source === 'string' && typeof value.version === 'string' && typeof value.molarMassVerified === 'boolean';
}
