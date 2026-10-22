export type TerminalSide = 'a' | 'b';
export type CircuitStatus = 'solved' | 'incomplete' | 'invalid-input' | 'open-circuit' | 'short-circuit' | 'floating-node' | 'inconsistent-sources';

export interface CircuitComponent {
  id: string;
  type: string;
  name: string;
  value: number;
  unit?: string;
  x: number;
  y: number;
  n1?: number;
  n2?: number;
}

export interface TerminalRef { componentId: string; terminal: TerminalSide }
export interface CircuitWire { id: string; from: TerminalRef; to: TerminalRef }
export interface CircuitModel {
  components: CircuitComponent[];
  wires: CircuitWire[];
  referenceTerminal: string;
}
export interface ResistorResult {
  id: string; name: string; R: number; I: number; V: number; P: number;
  signedI: number; signedV: number; direction: string;
}
export interface CircuitResult {
  status: CircuitStatus;
  message: string;
  V?: number;
  totalR?: number;
  I?: number;
  source?: string;
  drops?: ResistorResult[];
  unsupported?: string[];
  nodeVoltages?: Record<string, number>;
  assumption?: string;
}

class UnionFind {
  private parent = new Map<string, string>();
  add(value: string): void { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value: string): string {
    this.add(value);
    const parent = this.parent.get(value)!;
    if (parent !== value) this.parent.set(value, this.find(parent));
    return this.parent.get(value)!;
  }
  union(a: string, b: string): void { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.parent.set(rb, ra); }
}

const terminalId = (ref: TerminalRef): string => `${ref.componentId}:${ref.terminal}`;
const componentTerminal = (component: CircuitComponent, terminal: TerminalSide): string => `${component.id}:${terminal}`;

/** Solve a linear DC network with ideal voltage sources and resistors using MNA and pivoted Gaussian elimination. */
export function solveCircuit(model: CircuitModel): CircuitResult {
  const supported = model.components.filter((component) => component.type === 'source' || component.type === 'resistor');
  const sources = supported.filter((component) => component.type === 'source');
  const resistors = supported.filter((component) => component.type === 'resistor');
  const unsupported = model.components.filter((component) => !['source', 'resistor'].includes(component.type)).map((component) => component.id);

  if (sources.length === 0 || resistors.length === 0) {
    return fail('incomplete', 'يلزم مصدر جهد مثالي ومقاومة واحدة على الأقل حتى يبدأ الحل.');
  }
  for (const component of sources) {
    if (!Number.isFinite(component.value)) return fail('invalid-input', `قيمة مصدر الجهد «${component.name}» غير صالحة؛ لم تُستبدل بصفر.`);
  }
  for (const component of resistors) {
    if (!Number.isFinite(component.value) || component.value <= 0) {
      return fail('invalid-input', `قيمة المقاومة «${component.name}» يجب أن تكون رقمًا محدودًا أكبر من صفر.`);
    }
  }

  const union = new UnionFind();
  for (const component of model.components) {
    union.add(componentTerminal(component, 'a'));
    union.add(componentTerminal(component, 'b'));
  }
  for (const wire of model.wires) {
    const from = terminalId(wire.from);
    const to = terminalId(wire.to);
    const componentIds = new Set(model.components.map((component) => component.id));
    if (!componentIds.has(wire.from.componentId) || !componentIds.has(wire.to.componentId)) {
      return fail('invalid-input', 'يوجد سلك يشير إلى مكوّن غير موجود في المشروع.');
    }
    if (from === to) continue;
    union.union(from, to);
  }

  const groundComponentId = model.referenceTerminal.split(':')[0];
  const groundTerminal = model.referenceTerminal.split(':')[1] as TerminalSide;
  const groundComponent = model.components.find((component) => component.id === groundComponentId);
  if (!groundComponent || !['a', 'b'].includes(groundTerminal)) {
    return fail('invalid-input', 'العقدة المرجعية 0 V غير محددة بصورة صحيحة.');
  }
  const ground = union.find(model.referenceTerminal);
  const nodeOf = (component: CircuitComponent, side: TerminalSide): string => union.find(componentTerminal(component, side));

  for (const source of sources) {
    if (nodeOf(source, 'a') === nodeOf(source, 'b') && Math.abs(source.value) > 1e-12) {
      return fail('short-circuit', `المصدر «${source.name}» موصول بقصر مثالي بين طرفيه؛ رُفض الحل بدل عرض تيار غير محدود.`);
    }
  }

  if (sources.length === 1 && !hasResistivePath(sources[0], resistors, nodeOf)) {
    return fail('open-circuit', 'الدائرة مفتوحة: لا يوجد مسار مقاومي مكتمل بين طرفي مصدر الجهد. افحص أطراف المكوّنات والأسلاك.');
  }

  const allNodes = new Set<string>();
  for (const component of supported) { allNodes.add(nodeOf(component, 'a')); allNodes.add(nodeOf(component, 'b')); }
  const nonGroundNodes = [...allNodes].filter((node) => node !== ground).sort();
  const nodeIndex = new Map(nonGroundNodes.map((node, index) => [node, index]));
  const sourceOffset = nonGroundNodes.length;
  const size = nonGroundNodes.length + sources.length;
  const matrix = Array.from({ length: size }, () => Array<number>(size).fill(0));
  const rhs = Array<number>(size).fill(0);
  const stampConductance = (a: string, b: string, conductance: number): void => {
    const ia = nodeIndex.get(a); const ib = nodeIndex.get(b);
    if (ia !== undefined) matrix[ia][ia] += conductance;
    if (ib !== undefined) matrix[ib][ib] += conductance;
    if (ia !== undefined && ib !== undefined) { matrix[ia][ib] -= conductance; matrix[ib][ia] -= conductance; }
  };
  const stampSource = (a: string, b: string, row: number, value: number): void => {
    const ia = nodeIndex.get(a); const ib = nodeIndex.get(b);
    if (ia !== undefined) { matrix[ia][row] += 1; matrix[row][ia] += 1; }
    if (ib !== undefined) { matrix[ib][row] -= 1; matrix[row][ib] -= 1; }
    rhs[row] = value;
  };

  for (const resistor of resistors) stampConductance(nodeOf(resistor, 'a'), nodeOf(resistor, 'b'), 1 / resistor.value);
  sources.forEach((source, index) => stampSource(nodeOf(source, 'a'), nodeOf(source, 'b'), sourceOffset + index, source.value));

  const solved = gaussianSolve(matrix, rhs);
  if (!solved) {
    return fail(sources.length > 1 ? 'inconsistent-sources' : 'floating-node', sources.length > 1
      ? 'تعذّر حل الدائرة؛ قد تكون مصادر الجهد المثالية متعارضة أو مكررة على عقد غير متوافقة.'
      : 'تعذّر حل الدائرة بسبب عقدة عائمة أو مصفوفة شاذة. اربط كل جزء بالعقدة المرجعية عبر شبكة مدعومة.');
  }

  const voltageOf = (node: string): number => node === ground ? 0 : solved[nodeIndex.get(node)!];
  const drops: ResistorResult[] = resistors.map((resistor) => {
    const signedV = voltageOf(nodeOf(resistor, 'a')) - voltageOf(nodeOf(resistor, 'b'));
    const signedI = signedV / resistor.value;
    return {
      id: resistor.id, name: resistor.name, R: resistor.value,
      I: Math.abs(signedI), V: Math.abs(signedV), P: signedV * signedI,
      signedI, signedV, direction: signedI >= 0 ? 'من الطرف A إلى الطرف B' : 'من الطرف B إلى الطرف A',
    };
  });
  const source = sources[0];
  const sourceCurrent = solved[sourceOffset];
  const equivalentCurrent = Math.abs(sourceCurrent);
  const equivalentResistance = equivalentCurrent > 1e-15 ? Math.abs(source.value) / equivalentCurrent : Number.POSITIVE_INFINITY;
  const nodeVoltages: Record<string, number> = {};
  const orderedNodes = [...allNodes].sort((left, right) => left === ground ? -1 : right === ground ? 1 : left.localeCompare(right));
  orderedNodes.forEach((node, index) => { nodeVoltages[node === ground ? '0' : `N${index}`] = voltageOf(node); });
  return {
    status: 'solved', message: 'حُسبت الدائرة من شبكة الأطراف والأسلاك الفعلية باستخدام تحليل العقد المعدّل (MNA).',
    V: Math.abs(source.value), I: equivalentCurrent, totalR: sources.length === 1 ? equivalentResistance : undefined,
    source: source.id, drops, unsupported,
    nodeVoltages,
    assumption: 'مصادر جهد مثالية ومقاومات خطية؛ العقدة المرجعية 0 V اختيار حسابي وليست أرضًا فيزيائية.',
  };
}

function hasResistivePath(
  source: CircuitComponent,
  resistors: CircuitComponent[],
  nodeOf: (component: CircuitComponent, side: TerminalSide) => string,
): boolean {
  const start = nodeOf(source, 'a'); const target = nodeOf(source, 'b');
  if (start === target) return true;
  const graph = new Map<string, string[]>();
  for (const resistor of resistors) {
    const a = nodeOf(resistor, 'a'); const b = nodeOf(resistor, 'b');
    graph.set(a, [...(graph.get(a) ?? []), b]); graph.set(b, [...(graph.get(b) ?? []), a]);
  }
  const queue = [start]; const seen = new Set(queue);
  while (queue.length) {
    const node = queue.shift()!;
    if (node === target) return true;
    for (const next of graph.get(node) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return false;
}

function gaussianSolve(input: number[][], values: number[]): number[] | null {
  const n = input.length;
  if (n === 0) return [];
  const a = input.map((row, index) => [...row, values[index]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  const result = a.map((row) => row[n]);
  return result.every(Number.isFinite) ? result : null;
}

function fail(status: CircuitStatus, message: string): CircuitResult { return { status, message }; }


export function inferResistanceFromMeasurements(voltage: number, current: number): number {
  if (![voltage, current].every(Number.isFinite) || current <= 0) throw new Error('يلزم فرق جهد محدود وتيار مقاس أكبر من صفر.');
  const resistance = Math.abs(voltage / current);
  if (!Number.isFinite(resistance) || resistance <= 0) throw new Error('القياسات لا تنتج مقاومة موجبة محددة.');
  return resistance;
}

export function defaultCircuitModel(): CircuitModel {
  const components: CircuitComponent[] = [
    { id: 'v1', type: 'source', name: 'بطارية 12V', value: 12, unit: 'V', x: 115, y: 188 },
    { id: 'r1', type: 'resistor', name: 'مقاومة R₁', value: 100, unit: 'Ω', x: 340, y: 95 },
    { id: 'r2', type: 'resistor', name: 'مقاومة R₂', value: 200, unit: 'Ω', x: 560, y: 188 },
  ];
  const wires: CircuitWire[] = [
    { id: 'w1', from: { componentId: 'v1', terminal: 'a' }, to: { componentId: 'r1', terminal: 'a' } },
    { id: 'w2', from: { componentId: 'r1', terminal: 'b' }, to: { componentId: 'r2', terminal: 'a' } },
    { id: 'w3', from: { componentId: 'r2', terminal: 'b' }, to: { componentId: 'v1', terminal: 'b' } },
  ];
  return { components, wires, referenceTerminal: 'v1:b' };
}

/** Convert the old n1/n2 topology to explicit terminal wires. */
export function migrateLegacyTopology(components: CircuitComponent[]): { wires: CircuitWire[]; referenceTerminal: string } {
  const groups = new Map<number, TerminalRef[]>();
  for (const component of components) {
    if (!Number.isInteger(component.n1) || !Number.isInteger(component.n2)) continue;
    const aNode = component.type === 'source' ? component.n2! : component.n1!;
    const bNode = component.type === 'source' ? component.n1! : component.n2!;
    groups.set(aNode, [...(groups.get(aNode) ?? []), { componentId: component.id, terminal: 'a' }]);
    groups.set(bNode, [...(groups.get(bNode) ?? []), { componentId: component.id, terminal: 'b' }]);
  }
  const wires: CircuitWire[] = [];
  for (const refs of groups.values()) {
    for (let index = 1; index < refs.length; index += 1) wires.push({ id: `migrated-${wires.length + 1}`, from: refs[0], to: refs[index] });
  }
  const source = components.find((component) => component.type === 'source');
  return { wires, referenceTerminal: source ? `${source.id}:b` : '' };
}
