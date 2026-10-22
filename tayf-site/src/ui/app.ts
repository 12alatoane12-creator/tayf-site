import { chemicals as chemicalCatalog, elements, library } from '../data/catalog';
import { defaultCircuitModel, inferResistanceFromMeasurements, migrateLegacyTopology, solveCircuit as solveCircuitEngine, type CircuitComponent, type CircuitResult, type CircuitWire, type TerminalRef, type TerminalSide } from '../engine/circuit';
import { combineStockAddition, deriveVisualEffects, quantityToSolution, solveAgClStoichiometry, solveConcentration, solveDilution, solveMoles, solveSolutionVolume, solveStrongAcidBase, solutionQuantityFromConcentration, sumSolutionVolumesMl, type SolutionQuantity } from '../engine/chem';
import { parseQuantity, type QuantityDimension } from '../engine/quantity';
import { createHistory } from '../state/history';
import { createProjectState, createStateId, type ProjectChemical, type ProjectState } from '../state/project';
import { escapeHtml } from '../security/escape-html';
import { clampComponentPosition, pointerToViewBox } from './geometry';
import { LocalStorageAdapter, StorageError, makeProjectExport, parseProjectImport, type SavedExperiment, type StorageAdapter } from '../storage/storage';

// DOM selectors are centralized here; all untrusted values inserted into HTML are escaped below.
type QueryElement = HTMLElement & SVGElement & HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement & HTMLDialogElement & HTMLFormElement;
const $ = (selector: string): QueryElement => document.querySelector(selector) as QueryElement;
const $$ = (selector: string): QueryElement[] => Array.from(document.querySelectorAll(selector)) as QueryElement[];

type AddedChemical = ProjectChemical;
type CircuitSnapshot = { components: CircuitComponent[]; wires: CircuitWire[]; referenceTerminal: string };
const initialModel = defaultCircuitModel();
const state: ProjectState = createProjectState(initialModel);
const history = createHistory<CircuitSnapshot>({ components: [], wires: [], referenceTerminal: '' });
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let pendingChemicalId: string | null = null;
let storage: StorageAdapter;
try { storage = new LocalStorageAdapter(); }
catch { storage = new LocalStorageAdapter(undefined); }

function toast(message: string): void {
  const element = $('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

function safeFile(value: unknown): string {
  return String(value).replace(/[^a-z0-9\u0600-\u06ff-_]+/gi, '_').slice(0, 60) || 'tayf-experiment';
}
function nextId(): string {
  return `c${globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) ?? Math.random().toString(36).slice(2, 14)}`;
}
function fmt(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return value === Number.POSITIVE_INFINITY ? '∞' : '—';
  return Number(value.toPrecision(digits)).toLocaleString('en-US', { maximumFractionDigits: 8 });
}
function snapshotCircuit(): CircuitSnapshot {
  return structuredClone({ components: state.components, wires: state.wires, referenceTerminal: state.referenceTerminal });
}
function touchState(): void { state.stateId = createStateId(); }
function commitHistory(): void { touchState(); history.commit(snapshotCircuit()); updateHistoryButtons(); }
function updateHistoryButtons(): void {
  $('#undo-tool').disabled = !history.canUndo();
  $('#redo-tool').disabled = !history.canRedo();
}
function applySnapshot(snapshot: CircuitSnapshot): void {
  state.components = structuredClone(snapshot.components);
  state.wires = structuredClone(snapshot.wires);
  state.referenceTerminal = snapshot.referenceTerminal;
  touchState();
  state.selected = state.components[0]?.id ?? null;
  state.wireStart = null;
  solveCircuit(); renderCircuit(); renderInspector(); updateHistoryButtons();
}
function undoCircuit(): void {
  const previous = history.undo(snapshotCircuit());
  if (previous) { applySnapshot(previous); toast('تم التراجع عن آخر تعديل'); }
}
function redoCircuit(): void {
  const next = history.redo(snapshotCircuit());
  if (next) { applySnapshot(next); toast('تمت إعادة التعديل'); }
}

function setView(view: ProjectState['view']): void {
  state.view = view;
  touchState();
  $$('.view').forEach((element) => element.classList.toggle('active', element.id === `view-${view}`));
  $$('[data-view]').forEach((element) => element.classList.toggle('active', element.dataset.view === view));
  if (view === 'physics') { renderCircuit(); renderInspector(); }
  if (view === 'chemistry') { renderChemicalLibrary(); renderAddedChemicals(); updateBeaker(); }
  if (view === 'saved') renderSaved();
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
$$('[data-view]').forEach((button) => button.addEventListener('click', () => setView((button.dataset.view ?? 'home') as ProjectState['view'])));
$('#theme-toggle').addEventListener('click', () => {
  document.body.classList.toggle('light-theme');
  state.theme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
  touchState();
  toast(state.theme === 'light' ? 'تم تفعيل المظهر الفاتح' : 'تم تفعيل المظهر الداكن');
});

function defaultCircuit(): void {
  const model = defaultCircuitModel();
  state.components = model.components;
  state.wires = model.wires;
  state.referenceTerminal = model.referenceTerminal;
  touchState();
  state.selected = 'r1'; state.tool = 'select'; state.wireStart = null; state.pendingComponent = null;
  state.lastCircuit = solveCircuitEngine(model);
  history.clear(snapshotCircuit());
  renderCircuit(); renderInspector(); renderPhysicsResults(); renderPhysicsExplanation(); updateHistoryButtons();
}

function renderLibrary(): void {
  const query = ($('#component-search').value || '').toLowerCase();
  $('#component-library').innerHTML = library.filter((item) => `${item.name}${item.desc}${item.type}`.toLowerCase().includes(query)).map((item) => {
    const index = library.indexOf(item);
    return `<button class="component-item" data-lib-index="${index}"><span class="component-symbol">${escapeHtml(item.symbol)}</span><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.desc)}</small></span></button>`;
  }).join('');
  $$('[data-lib-index]').forEach((button) => {
    const item = library[Number(button.dataset.libIndex)];
    button.draggable = true;
    button.addEventListener('dragstart', (event) => {
      if (!item) return;
      setTool('place'); state.pendingComponent = item;
      event.dataTransfer?.setData('text/plain', item.type);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    });
    button.addEventListener('click', () => {
    if (!item) return;
    if (state.tool === 'place') {
      state.pendingComponent = item;
      $('#circuit-status').textContent = `اختر مكان وضع «${item.name}» ثم انقر مساحة الرسم أو اضغط Enter`;
      $('#circuit-svg').focus();
      toast(`تم اختيار ${item.name}. انقر مكان وضعه أو اضغط Enter لوضعه في الوسط.`);
    } else addComponent(item);
    });
  });
}

function addComponent(item: (typeof library)[number], x?: number, y?: number): void {
  const index = state.components.length;
  const component: CircuitComponent = {
    id: nextId(), type: item.type, name: item.name, value: item.value, unit: item.unit,
    x: Math.max(65, Math.min(690, x ?? 170 + (index % 3) * 180)),
    y: Math.max(55, Math.min(315, y ?? 100 + Math.floor(index / 3) * 85)),
  };
  state.components.push(component);
  state.selected = component.id;
  state.pendingComponent = null;
  commitHistory(); solveCircuit(); renderCircuit(); renderInspector();
  toast(item.type === 'source' || item.type === 'resistor' ? 'أضيف العنصر؛ اربط أطرافه بالأسلاك حتى يدخل في الحل.' : 'أضيف عنصر غير مدعوم حسابيًا؛ يظهر بوسم واضح ولا يدخل في الحل.');
}

function terminalPoint(component: CircuitComponent, side: TerminalSide): { x: number; y: number } {
  if (component.type === 'source') return { x: component.x, y: component.y + (side === 'a' ? -33 : 33) };
  const offset = ['resistor', 'capacitor'].includes(component.type) ? 49 : 38;
  return { x: component.x + (side === 'a' ? -offset : offset), y: component.y };
}
function wirePath(wire: CircuitWire): string {
  const fromComponent = state.components.find((component: CircuitComponent) => component.id === wire.from.componentId);
  const toComponent = state.components.find((component: CircuitComponent) => component.id === wire.to.componentId);
  if (!fromComponent || !toComponent) return '';
  const a = terminalPoint(fromComponent, wire.from.terminal);
  const b = terminalPoint(toComponent, wire.to.terminal);
  const middleX = Math.round((a.x + b.x) / 2);
  return `M ${a.x} ${a.y} L ${middleX} ${a.y} L ${middleX} ${b.y} L ${b.x} ${b.y}`;
}
function handleTerminalClick(ref: TerminalRef): void {
  if (state.tool !== 'wire') {
    state.selected = ref.componentId; renderCircuit(); renderInspector(); return;
  }
  if (!state.wireStart) {
    state.wireStart = ref; renderCircuit();
    toast('اختر الطرف الثاني لإكمال السلك.'); return;
  }
  const start = state.wireStart as TerminalRef;
  state.wireStart = null;
  if (start.componentId === ref.componentId && start.terminal === ref.terminal) { renderCircuit(); return; }
  const exists = state.wires.some((wire: CircuitWire) => (wire.from.componentId === start.componentId && wire.from.terminal === start.terminal && wire.to.componentId === ref.componentId && wire.to.terminal === ref.terminal)
    || (wire.to.componentId === start.componentId && wire.to.terminal === start.terminal && wire.from.componentId === ref.componentId && wire.from.terminal === ref.terminal));
  if (!exists) {
    state.wires.push({ id: nextId(), from: start, to: ref });
    commitHistory(); solveCircuit(); toast('تم توصيل الطرفين.');
  } else toast('يوجد سلك بين هذين الطرفين بالفعل.');
  renderCircuit(); renderInspector();
}
function placePendingAt(x: number, y: number): void {
  if (!state.pendingComponent) return;
  const item = state.pendingComponent;
  addComponent(item, x, y);
  state.tool = 'select'; setTool('select');
}

function renderCircuit(): void {
  const svg = $('#circuit-svg');
  if (!svg) return;
  const referenceParts = String(state.referenceTerminal).split(':');
  const referenceComponent = state.components.find((item: CircuitComponent) => item.id === referenceParts[0]) as CircuitComponent | undefined;
  const referencePoint = referenceComponent && (referenceParts[1] === 'a' || referenceParts[1] === 'b') ? terminalPoint(referenceComponent, referenceParts[1]) : null;
  const referenceMarkup = referencePoint ? `<text class="reference-label" x="${referencePoint.x + 10}" y="${referencePoint.y + 18}">0 V · مرجع</text>` : '';
  const wireMarkup = (state.wires as CircuitWire[]).map((wire) => {
    const selected = state.wireStart && (wire.from.componentId === state.wireStart.componentId || wire.to.componentId === state.wireStart.componentId);
    return `<path class="circuit-wire ${selected ? 'wire-pending' : ''}" data-wire="${escapeHtml(wire.id)}" d="${wirePath(wire)}" tabindex="0" role="button" aria-label="سلك؛ انقر مرتين لحذفه"/>`;
  }).join('');
  const components = (state.components as CircuitComponent[]).map((component) => {
    const selected = component.id === state.selected;
    let symbol = '';
    if (component.type === 'resistor') symbol = `<path class="symbol" d="M ${component.x - 49} ${component.y} l10 -10 12 20 12 -20 12 20 12 -20 12 20 10 -10"/>`;
    else if (component.type === 'source') symbol = `<path class="symbol" d="M ${component.x} ${component.y - 30}v17 M ${component.x - 17} ${component.y - 13}h34 M ${component.x - 10} ${component.y + 3}h20 M ${component.x} ${component.y + 3}v27"/><text x="${component.x + 15}" y="${component.y - 10}" font-size="10">+</text>`;
    else if (component.type === 'capacitor') symbol = `<path class="symbol" d="M ${component.x - 38} ${component.y}h25m0 -16v32m26 -32v32m0 -16h25"/>`;
    else symbol = `<path class="symbol" d="M ${component.x - 35} ${component.y}h70"/>`;
    const value = ['source', 'resistor'].includes(component.type) ? `${fmt(component.value)} ${component.unit ?? ''}` : 'غير مدعوم';
    return `<g class="component-g ${selected ? 'selected' : ''}" data-comp="${escapeHtml(component.id)}" tabindex="0" role="button" aria-label="${escapeHtml(component.name)}" transform="translate(0 0)">
      <rect class="hitbox" x="${component.x - 62}" y="${component.y - 39}" width="124" height="78" rx="10"/>
      <circle class="terminal ${state.wireStart?.componentId === component.id && state.wireStart.terminal === 'a' ? 'terminal-active' : ''} ${state.referenceTerminal === `${component.id}:a` ? 'reference-terminal' : ''}" data-terminal="${escapeHtml(component.id)}:a" cx="${terminalPoint(component, 'a').x}" cy="${terminalPoint(component, 'a').y}" r="5" tabindex="0" role="button" aria-label="${escapeHtml(component.name)} الطرف A ${state.referenceTerminal === `${component.id}:a` ? 'العقدة المرجعية 0 V' : ''}"/>
      <circle class="terminal ${state.wireStart?.componentId === component.id && state.wireStart.terminal === 'b' ? 'terminal-active' : ''} ${state.referenceTerminal === `${component.id}:b` ? 'reference-terminal' : ''}" data-terminal="${escapeHtml(component.id)}:b" cx="${terminalPoint(component, 'b').x}" cy="${terminalPoint(component, 'b').y}" r="5" tabindex="0" role="button" aria-label="${escapeHtml(component.name)} الطرف B ${state.referenceTerminal === `${component.id}:b` ? 'العقدة المرجعية 0 V' : ''}"/>
      ${symbol}<text x="${component.x}" y="${component.y + 51}" text-anchor="middle">${escapeHtml(component.name)}</text><text class="subtext" x="${component.x}" y="${component.y + 65}" text-anchor="middle">${escapeHtml(value)}</text></g>`;
  }).join('');
  svg.innerHTML = `<rect x="0" y="0" width="760" height="390" fill="transparent" data-placement-surface="true"/><g>${wireMarkup}</g>${components}${referenceMarkup}<text x="18" y="24" fill="currentColor" opacity=".45" font-size="10">WIRE-BASED DC MODEL · 0 V IS A REFERENCE NODE</text>`;
  $$('[data-comp]').forEach((group) => {
    group.addEventListener('click', () => { state.selected = group.dataset.comp ?? null; touchState(); renderCircuit(); renderInspector(); });
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); state.selected = group.dataset.comp ?? null; touchState(); renderCircuit(); renderInspector(); }
      const component = state.components.find((item: CircuitComponent) => item.id === group.dataset.comp) as CircuitComponent | undefined;
      if (!component || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') component.x -= 5;
      if (event.key === 'ArrowRight') component.x += 5;
      if (event.key === 'ArrowUp') component.y -= 5;
      if (event.key === 'ArrowDown') component.y += 5;
      component.x = Math.max(65, Math.min(690, component.x)); component.y = Math.max(55, Math.min(315, component.y));
      commitHistory(); solveCircuit(); renderCircuit(); renderInspector();
    });
    group.addEventListener('pointerdown', (event) => startDrag(event as PointerEvent, group.dataset.comp ?? ''));
  });
  $$('[data-terminal]').forEach((terminal) => {
    const [componentId, side] = (terminal.dataset.terminal ?? '').split(':');
    terminal.addEventListener('click', (event) => { event.stopPropagation(); handleTerminalClick({ componentId, terminal: side as TerminalSide }); });
    terminal.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); handleTerminalClick({ componentId, terminal: side as TerminalSide }); } });
  });
  $$('[data-wire]').forEach((wireElement) => {
    wireElement.addEventListener('dblclick', (event) => {
      event.stopPropagation(); state.wires = state.wires.filter((wire: CircuitWire) => wire.id !== wireElement.dataset.wire);
      commitHistory(); solveCircuit(); renderCircuit(); toast('حُذف السلك.');
    });
    wireElement.addEventListener('keydown', (event) => { if (event.key === 'Delete' || event.key === 'Backspace') { state.wires = state.wires.filter((wire: CircuitWire) => wire.id !== wireElement.dataset.wire); commitHistory(); solveCircuit(); renderCircuit(); } });
  });
  svg.onclick = (event) => {
    const target = event.target as Element;
    if (state.tool !== 'place' || !state.pendingComponent || !target.matches('[data-placement-surface]')) return;
    const point = pointerToViewBox(event.clientX, event.clientY, svg.getBoundingClientRect(), 760, 390);
    placePendingAt(point.x, point.y);
  };
  svg.ondragover = (event) => { if (state.tool === 'place' && state.pendingComponent) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; } };
  svg.ondrop = (event) => {
    if (state.tool !== 'place' || !state.pendingComponent) return;
    event.preventDefault();
    const point = pointerToViewBox(event.clientX, event.clientY, svg.getBoundingClientRect(), 760, 390);
    placePendingAt(point.x, point.y);
  };
  svg.onkeydown = (event) => {
    if (state.tool === 'place' && state.pendingComponent && event.key === 'Enter') { event.preventDefault(); placePendingAt(380, 195); }
  };
  $('#circuit-summary').textContent = `${state.components.length} مكونات · ${state.wires.length} أسلاك · نموذج تيار مستمر`;
  $('#circuit-status').textContent = state.lastCircuit?.status === 'solved' ? 'حُسبت الشبكة المتصلة الحالية' : state.lastCircuit?.message ?? 'عدّل الدائرة ثم أعد الحل';
}

let drag: { id: string; startX: number; startY: number; initialX: number; initialY: number; component: CircuitComponent } | null = null;
function startDrag(event: PointerEvent, id: string): void {
  if (state.tool !== 'select' || (event.target as Element).matches('[data-terminal]')) return;
  const component = state.components.find((item: CircuitComponent) => item.id === id) as CircuitComponent | undefined;
  if (!component) return;
  drag = { id, startX: event.clientX, startY: event.clientY, initialX: component.x, initialY: component.y, component };
  const svg = $('#circuit-svg');
  try { svg.setPointerCapture(event.pointerId); } catch { /* Some browsers do not expose pointer capture on SVG. */ }
  const move = (pointerEvent: PointerEvent) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width > 0 ? 760 / rect.width : 1;
    const scaleY = rect.height > 0 ? 390 / rect.height : 1;
    const point = clampComponentPosition(drag.initialX + (pointerEvent.clientX - drag.startX) * scaleX, drag.initialY + (pointerEvent.clientY - drag.startY) * scaleY);
    drag.component.x = point.x; drag.component.y = point.y; touchState();
    solveCircuit(); renderCircuit();
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); drag = null;
    commitHistory(); solveCircuit(); renderCircuit(); renderInspector();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
}

function solveCircuit(): CircuitResult {
  const result = solveCircuitEngine({ components: state.components as CircuitComponent[], wires: state.wires as CircuitWire[], referenceTerminal: state.referenceTerminal });
  state.lastCircuit = result;
  renderPhysicsResults(); renderPhysicsExplanation();
  return result;
}
function renderPhysicsResults(): void {
  const result = state.lastCircuit as CircuitResult | null;
  if (!result || result.status !== 'solved') {
    $('#physics-result-status').textContent = result ? 'لا توجد نتائج عددية' : 'بانتظار الحل';
    const message = escapeHtml(result?.message ?? 'أضف مصدرًا ومقاومة واحدة على الأقل.');
    $('#physics-results').innerHTML = `<div class="metric metric-wide"><small>حالة الحل</small><b>لا توجد نتائج عددية</b><span>${message}</span></div>`;
    $('#voltage-chart').innerHTML = `<span class="muted">${message}</span>`;
    return;
  }
  $('#physics-result-status').textContent = result.unsupported?.length ? 'حل ضمن النموذج؛ بعض العناصر غير مدعومة' : 'محسوب ضمن النموذج';
  $('#physics-results').innerHTML = `<div class="metric"><small>${result.totalR === undefined ? 'جهد المصدر الأول' : 'جهد المصدر'}</small><b>${fmt(result.V ?? Number.NaN)}</b><span>V</span></div><div class="metric"><small>${result.totalR === undefined ? 'تيار المصدر الأول' : 'تيار المصدر'}</small><b>${fmt((result.I ?? Number.NaN) * 1000)}</b><span>mA</span></div><div class="metric"><small>المقاومة المكافئة</small><b>${result.totalR === undefined ? '—' : fmt(result.totalR)}</b><span>Ω</span></div>`;
  const referenceVoltage = Math.abs(result.V ?? Number.NaN);
  $('#voltage-chart').innerHTML = (result.drops ?? []).map((drop) => { const width = Number.isFinite(referenceVoltage) && referenceVoltage > 0 ? Math.max(2, Math.min(100, 100 * drop.V / referenceVoltage)) : 2; return `<div class="voltage-row"><span>${escapeHtml(drop.name)}</span><div class="voltage-track"><i style="width:${width}%"></i></div><b>${fmt(drop.V)} V</b></div>`; }).join('');
  if (!result.drops?.length) $('#voltage-chart').textContent = 'لا توجد مقاومات مدعومة.';
}
function renderPhysicsExplanation(): void {
  const result = state.lastCircuit as CircuitResult | null;
  if (!result || result.status !== 'solved') {
    $('#physics-explanation').innerHTML = `<div class="explanation-item"><b>تشخيص المحرك</b><p>${escapeHtml(result?.message ?? 'لا توجد نتيجة بعد.')}</p></div>`;
    return;
  }
  const drops = result.drops ?? [];
  const unsupportedText = result.unsupported?.length ? `<p>مكونات غير مدعومة ومستبعدة من الحساب: ${result.unsupported.length}.</p>` : '';
  $('#physics-explanation').innerHTML = `<div class="explanation-item"><span class="explanation-index">01</span><div><b>المقاومات والاتصالات</b><p>استُخدمت شبكة الأطراف والأسلاك الفعلية؛ لم يُفترض التوالي من عدد المقاومات.</p><span class="formula">Rₑq = ${result.totalR === undefined ? 'غير معرّفة مع تعدد مصادر الجهد' : `|Vsource / Isource| = ${fmt(result.totalR)} Ω`}</span></div></div><div class="explanation-item"><span class="explanation-index">02</span><div><b>تحليل العقد المعدّل (MNA)</b><p>حُلّت معادلات العقد ومصادر الجهد باستخدام حذف غاوسي مع اختيار المحور.</p><span class="formula">I = ${fmt(result.I ?? Number.NaN)} A</span></div></div><div class="explanation-item"><span class="explanation-index">03</span><div><b>جهد وقدرة كل مقاومة</b><p>${drops.map((drop) => `${escapeHtml(drop.name)}: ΔV = ${fmt(drop.V)} V، I = ${fmt(drop.I)} A، P = ${fmt(drop.P)} W (${escapeHtml(drop.direction)}).`).join('<br>')}</p></div></div>${unsupportedText}<div class="explanation-item"><b>جهود العقد بالنسبة إلى المرجع</b><p>${Object.entries(result.nodeVoltages ?? {}).map(([node, voltage]) => `${escapeHtml(node)} = ${fmt(voltage)} V`).join(' · ')}</p></div><p class="muted">${escapeHtml(result.assumption ?? '')}</p>`;
}

function dimensionFor(component: CircuitComponent): QuantityDimension | null {
  if (component.type === 'source') return 'voltage';
  if (component.type === 'resistor') return 'resistance';
  return null;
}
function formatComponentValue(component: CircuitComponent): string { return `${component.value} ${component.unit ?? ''}`.trim(); }
function renderInspector(): void {
  const component = state.components.find((item: CircuitComponent) => item.id === state.selected) as CircuitComponent | undefined;
  const box = $('#component-inspector');
  if (!component) { box.innerHTML = '<div class="empty-inspector">اختر عنصرًا من الرسم لعرض خصائصه وتعديل قيمته.</div>'; return; }
  const dimension = dimensionFor(component);
  box.innerHTML = `<div class="inspector-name">${escapeHtml(component.name)}</div><div class="inspector-sub">${component.type === 'source' ? 'مصدر جهد مثالي' : component.type === 'resistor' ? 'عنصر مقاومي' : 'مكوّن غير مدعوم حسابيًا'}</div>
    <label class="property-field">اسم العنصر<input id="prop-name" value="${escapeHtml(component.name)}" maxlength="100"></label>
    <label class="property-field">القيمة (${escapeHtml(component.unit || 'بدون وحدة')})<input id="prop-value" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(formatComponentValue(component))}" ${dimension ? '' : 'disabled'} aria-describedby="prop-value-feedback"></label>
    <small id="prop-value-feedback" class="quantity-feedback" aria-live="polite">${dimension ? 'يمكن إدخال وحدة مثل 4.7kΩ أو 20mA.' : 'هذا المكوّن غير مدعوم في الحساب العددي.'}</small>
    <label class="property-field">موضع الرسم<div class="unit-wrap"><input id="prop-x" type="number" min="65" max="690" value="${Math.round(component.x)}" aria-label="الموضع الأفقي"><input id="prop-y" type="number" min="55" max="315" value="${Math.round(component.y)}" aria-label="الموضع العمودي"></div></label>
    <button class="btn secondary full" id="apply-props">تطبيق التغييرات</button><button class="delete-component" id="delete-comp">حذف العنصر</button>
    ${!dimension ? '<div class="safety-note"><b>غير مدعوم حسابيًا</b><p>يظهر هذا المكوّن في الرسم فقط؛ لا يدخل في حل الدائرة.</p></div>' : ''}`;
  const valueInput = $('#prop-value');
  const feedback = $('#prop-value-feedback');
  const showQuantity = () => {
    if (!dimension) return;
    const parsed = parseQuantity(valueInput.value, dimension);
    feedback.textContent = parsed.ok ? parsed.quantity.display : parsed.error;
    feedback.classList.toggle('error', !parsed.ok);
    valueInput.setAttribute('aria-invalid', String(!parsed.ok));
  };
  valueInput.addEventListener('input', showQuantity);
  $('#apply-props').onclick = () => {
    const name = $('#prop-name').value.trim();
    if (!name) { toast('اسم العنصر لا يمكن أن يكون فارغًا.'); return; }
    let newValue = component.value;
    if (dimension) {
      const parsed = parseQuantity(valueInput.value, dimension);
      if (!parsed.ok || (component.type === 'resistor' && parsed.quantity.value <= 0)) {
        feedback.textContent = parsed.ok ? 'يجب أن تكون المقاومة أكبر من صفر.' : parsed.error;
        feedback.classList.add('error'); valueInput.setAttribute('aria-invalid', 'true'); return;
      }
      newValue = parsed.quantity.value;
    }
    const x = Number($('#prop-x').value); const y = Number($('#prop-y').value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { toast('إحداثيات العنصر يجب أن تكون أرقامًا صالحة.'); return; }
    component.name = name; component.value = newValue;
    component.x = Math.max(65, Math.min(690, x)); component.y = Math.max(55, Math.min(315, y));
    commitHistory(); solveCircuit(); renderCircuit(); renderInspector(); toast('تم تطبيق خصائص العنصر.');
  };
  $('#delete-comp').onclick = () => {
    state.components = state.components.filter((item: CircuitComponent) => item.id !== component.id);
    state.wires = state.wires.filter((wire: CircuitWire) => wire.from.componentId !== component.id && wire.to.componentId !== component.id);
    state.selected = state.components[0]?.id ?? null;
    commitHistory(); solveCircuit(); renderCircuit(); renderInspector(); toast('حُذف العنصر والأسلاك المتصلة به.');
  };
}

function setTool(tool: ProjectState['tool']): void {
  state.tool = tool; state.stateId = createStateId();
  if (tool !== 'wire') state.wireStart = null;
  $$('.toolbar-actions .tool-button').forEach((button) => button.classList.remove('active'));
  const ids: Record<string, string> = { select: '#select-tool', wire: '#wire-tool', place: '#place-tool' };
  if (ids[tool]) $(ids[tool]).classList.add('active');
  renderCircuit();
}
$('#component-search').addEventListener('input', renderLibrary);
$('#select-tool').onclick = () => setTool('select');
$('#place-tool').onclick = () => { setTool('place'); toast('اختر عنصرًا من المكتبة ثم انقر مكان وضعه في مساحة الدائرة.'); };
$('#wire-tool').onclick = () => { setTool('wire'); toast('انقر الطرف الأول ثم الطرف الثاني لرسم سلك حقيقي.'); };
$('#unknown-tool').onclick = () => { setTool('select'); $('#unknown-kind').focus(); toast('اختر المقدار المطلوب، وحدد مقاومة لتيار الفرع أو فرق الجهد. لاستنتاج مقاومة أدخل قياسَي V وI.'); };
$('#solve-circuit').onclick = () => { const result = solveCircuit(); renderCircuit(); toast(result.status === 'solved' ? 'اكتمل حل شبكة الدائرة.' : result.message); };
$('#physics-reset').onclick = () => { defaultCircuit(); toast('أعيدت الدائرة الافتراضية.'); };
$('#add-example').onclick = () => { defaultCircuit(); toast('تم تحميل مثال 12V.'); };
$('#undo-tool').onclick = undoCircuit;
$('#redo-tool').onclick = redoCircuit;
document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
  if (typing) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); undoCircuit(); }
  else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) { event.preventDefault(); redoCircuit(); }
  else if (event.key === 'Delete' && state.selected) {
    state.components = state.components.filter((component: CircuitComponent) => component.id !== state.selected);
    state.wires = state.wires.filter((wire: CircuitWire) => wire.from.componentId !== state.selected && wire.to.componentId !== state.selected);
    state.selected = state.components[0]?.id ?? null; commitHistory(); solveCircuit(); renderCircuit(); renderInspector();
  }
});
function syncUnknownFields(): void {
  $('#unknown-measurements').hidden = $('#unknown-kind').value !== 'resistance';
  if ($('#unknown-kind').value === 'resistance') $('#unknown-solution').textContent = 'أدخل فرق الجهد والتيار المقاسين؛ لن تُستخدم قيمة المقاومة المخزنة كأنها مجهولة.';
}
$('#unknown-kind').addEventListener('change', syncUnknownFields);
$('#solve-unknown').onclick = () => {
  const kind = $('#unknown-kind').value;
  if (kind === 'resistance') {
    const selected = state.components.find((component: CircuitComponent) => component.id === state.selected) as CircuitComponent | undefined;
    if (!selected || selected.type !== 'resistor') { $('#unknown-solution').textContent = 'اختر مقاومة من الرسم أولًا؛ أدخل قياس الجهد والتيار عبر هذه المقاومة.'; return; }
    const voltage = parseQuantity($('#unknown-measured-v').value, 'voltage');
    const current = parseQuantity($('#unknown-measured-i').value, 'current');
    if (!voltage.ok || !current.ok) {
      $('#unknown-solution').textContent = !voltage.ok ? voltage.error : !current.ok ? current.error : 'تحقق من القياسات المدخلة.'; return;
    }
    if (current.quantity.value <= 0) { $('#unknown-solution').textContent = 'التيار المقاس يجب أن يكون أكبر من صفر لاستنتاج مقاومة محددة.'; return; }
    let resistance: number;
    try { resistance = inferResistanceFromMeasurements(voltage.quantity.value, current.quantity.value); }
    catch (error) { $('#unknown-solution').textContent = error instanceof Error ? error.message : 'القياسات لا تنتج مقاومة موجبة محددة.'; return; }
    $('#unknown-solution').innerHTML = `<b>القانون المناسب</b><span class="formula">R = |V / I|</span><b>التعويض والنتيجة</b><span class="formula">R = |${fmt(voltage.quantity.value)} / ${fmt(current.quantity.value)}| = ${fmt(resistance)} Ω</span><p>القيمة استُنتجت من القياسات التي أدخلتها، لا من قيمة المقاومة المخزنة.</p><small class="muted">هذه النتيجة لا تستبدل قيمة المقاومة في نموذج الدائرة؛ عدّل المكوّن يدويًا بعد مراجعة القياسات.</small>`;
    return;
  }

  const result = state.lastCircuit as CircuitResult | null;
  if (!result || result.status !== 'solved') { $('#unknown-solution').textContent = result?.message ?? 'لا توجد دائرة قابلة للحل.'; return; }
  const selected = state.components.find((component: CircuitComponent) => component.id === state.selected) as CircuitComponent | undefined;
  const drop = (result.drops ?? []).find((item) => item.id === state.selected);
  let formula = ''; let calculation = ''; let steps = '';
  if (kind === 'current') {
    if (drop) { formula = 'I = |ΔV / R|'; calculation = `I = |${fmt(drop.signedV)} / ${fmt(drop.R)}| = ${fmt(drop.I)} A`; steps = `تيار الفرع المحسوب للمقاومة ${drop.name} من حل الشبكة هو ${fmt(drop.I)} A.`; }
    else { formula = 'تيار المصدر من حل MNA'; calculation = `I = ${fmt(result.I ?? Number.NaN)} A`; steps = `تيار المصدر ${result.source ?? ''} مأخوذ من حل شبكة الدائرة الحالية.`; }
  } else {
    if (selected?.type === 'source') { formula = 'Vsource'; calculation = `V = ${fmt(result.V ?? Number.NaN)} V`; steps = 'جهد المصدر هو قيمة الإدخال المعلنة للمصدر المثالي.'; }
    else if (drop) { formula = 'ΔV = I × R'; calculation = `ΔV = ${fmt(drop.I)} × ${fmt(drop.R)} = ${fmt(drop.V)} V`; steps = `فرق الجهد المحسوب على المقاومة ${drop.name} هو ${fmt(drop.V)} V.`; }
    else { $('#unknown-solution').textContent = 'اختر مصدر جهد أو مقاومة مدعومة من الرسم لعرض مقدار الجهد.'; return; }
  }
  $('#unknown-solution').innerHTML = `<b>القانون المناسب</b><span class="formula">${formula}</span><b>التعويض والنتيجة</b><span class="formula">${calculation}</span><p>${escapeHtml(steps)}</p><small class="muted">النتيجة من حل شبكة DC الخطية الحالية؛ لم يُستخدم مقدار مجهول مخفي كمدخل.</small>`;
};


function renderChemicalLibrary(): void {
  const query = ($('#chemical-search').value || '').toLowerCase();
  $('#chemical-library').innerHTML = chemicalCatalog.filter((chemical) => (state.chemFilter === 'all' || chemical.cat === state.chemFilter) && `${chemical.name}${chemical.formula}`.toLowerCase().includes(query)).map((chemical) => `<div class="chemical-item"><span class="chem-symbol" style="--chem-color:${escapeHtml(chemical.color)}">${escapeHtml(chemical.formula)}</span><span><b>${escapeHtml(chemical.name)}</b><small>${escapeHtml(chemical.formula)} · ${chemical.conc ? `${chemical.conc} mol/L` : escapeHtml(chemical.phase)}</small></span><button data-add-chem="${escapeHtml(chemical.id)}">إضافة</button></div>`).join('');
  $$('[data-add-chem]').forEach((button) => button.addEventListener('click', () => openChemicalAdd(button.dataset.addChem ?? '')));
}
function invalidateChemResult(): void {
  touchState();
  if (!state.lastChem) return;
  state.lastChem = null;
  $('#reaction-result').innerHTML = '<div class="empty-result">تغيّرت المدخلات؛ أعد تشغيل النموذج للحصول على نتيجة محدثة.</div>';
  $('#reaction-badge').textContent = 'بانتظار إعادة الحساب';
}
function totalVolumeMl(): number { return sumSolutionVolumesMl((state.chemicals as AddedChemical[]).map((chemical) => chemical.volume)); }
function syncChemistryInputsFromDom(): void {
  state.chemistryMode = $('#chem-mode').value as ProjectState['chemistryMode'];
  state.chemistryFinalVolumeInput = $('#chem-volume').value;
  state.chemistrySampleVolumeInput = $('#chem-sample-volume').value;
  state.chemistryTemperatureInput = $('#chem-temperature').value;
}
function syncChemVolumeField(): void {
  const field = $('#chem-volume');
  field.disabled = state.chemistryMode !== 'dilution';
  if (state.chemistryMode !== 'dilution') state.chemistryFinalVolumeInput = String(Number(totalVolumeMl().toFixed(6)));
  field.value = state.chemistryFinalVolumeInput;
}
function openChemicalAdd(id: string): void {
  const definition = chemicalCatalog.find((chemical) => chemical.id === id);
  if (!definition) return;
  pendingChemicalId = id;
  $('#chem-add-title').textContent = `إضافة ${definition.name}`;
  $('#chem-add-description').textContent = `${definition.formula} · ${definition.phase}. راجع الكمية والتركيز قبل الإضافة.`;
  $('#chem-add-quantity-kind').value = 'volume';
  $('#chem-add-quantity').value = '50';
  $('#chem-add-concentration').value = String(definition.conc);
  $('#chem-add-quantity-kind').disabled = definition.id === 'water';
  $('#chem-add-concentration').disabled = definition.id === 'water';
  syncChemicalQuantityMode();
  $('#chemical-add-dialog').showModal();
}
function syncChemicalQuantityMode(): void {
  const kind = $('#chem-add-quantity-kind').value;
  const definition = chemicalCatalog.find((chemical) => chemical.id === pendingChemicalId);
  const massOption = $('#chem-add-quantity-kind').querySelector('option[value="mass"]') as HTMLOptionElement | null;
  if (massOption) massOption.disabled = !definition?.molarMassVerified;
  if (kind === 'mass' && !definition?.molarMassVerified) $('#chem-add-quantity-kind').value = 'volume';
  const selectedKind = $('#chem-add-quantity-kind').value;
  const caption = selectedKind === 'volume' ? 'حجم المحلول (mL)' : selectedKind === 'moles' ? 'كمية المادة (mol)' : 'كتلة المذاب (g)';
  $('#chem-add-quantity-caption').textContent = caption;
  const help = selectedKind === 'volume'
    ? 'تُحسب المولات من التركيز × حجم المحلول. هذا هو الخيار الأنسب للمحاليل الجاهزة.'
    : selectedKind === 'moles'
      ? 'يُحسب حجم المحلول المكافئ من عدد المولات والتركيز.'
      : 'تحويل الكتلة غير متاح حتى توثيق الكتلة المولية بمصدر علمي.';
  $('#chem-add-help').textContent = help;
}
function addChemical(id: string, portion: SolutionQuantity): void {
  invalidateChemResult();
  const definition = chemicalCatalog.find((chemical) => chemical.id === id);
  if (!definition) return;
  const existing = (state.chemicals as AddedChemical[]).find((chemical) => chemical.id === id);
  if (existing) {
    const combined = combineStockAddition({ concentration: existing.conc, moles: existing.moles, volumeMl: existing.volume }, portion.concentration, portion.volumeMl);
    existing.moles = combined.moles; existing.volume = combined.volumeMl; existing.conc = combined.concentration;
  } else {
    state.chemicals.push({ ...definition, conc: portion.concentration, moles: portion.moles, volume: portion.volumeMl });
  }
  touchState();
  renderAddedChemicals(); updateBeaker();
  toast(`أضيفت ${definition.name}: ${fmt(portion.volumeMl, 5)} mL، و${fmt(portion.moles, 6)} mol.`);
}
$('#chem-add-quantity-kind').addEventListener('change', syncChemicalQuantityMode);
$('#confirm-chem-add').addEventListener('click', (event) => {
  event.preventDefault();
  const id = pendingChemicalId;
  const definition = chemicalCatalog.find((chemical) => chemical.id === id);
  const quantityText = $('#chem-add-quantity').value.trim();
  const concentrationText = $('#chem-add-concentration').value.trim();
  const quantity = Number(quantityText); const concentration = Number(concentrationText);
  if (!definition || !quantityText || !concentrationText || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(concentration) || concentration < 0) {
    toast('أدخل كمية موجبة وتركيزًا غير سالب؛ الحقول الفارغة ليست صفرًا.'); return;
  }
  const kind = $('#chem-add-quantity-kind').value as 'volume' | 'moles' | 'mass';
  let portion: SolutionQuantity;
  try { portion = quantityToSolution(kind, quantity, concentration, definition.molar, definition.molarMassVerified); }
  catch (error) { toast(error instanceof Error ? error.message : 'تعذر تحويل الكمية إلى محلول.'); return; }
  addChemical(id!, portion);
  $('#chemical-add-dialog').close(); pendingChemicalId = null;
});
function renderAddedChemicals(): void {
  const box = $('#chem-additions');
  if (!(state.chemicals as AddedChemical[]).length) {
    box.innerHTML = '<div class="empty-additions">أضف مادة من المكتبة لبدء التجربة. الأحجام والمولات تُحسب من المدخلات.</div>';
    syncChemVolumeField(); updateBeaker(); return;
  }
  box.innerHTML = (state.chemicals as AddedChemical[]).map((chemical, index) => `<div class="added-chemical"><span class="chem-symbol" style="--chem-color:${escapeHtml(chemical.color)}">${escapeHtml(chemical.formula)}</span><span class="added-chemical-name">${escapeHtml(chemical.name)}<small style="display:block;color:var(--muted)">${escapeHtml(chemical.formula)} · ${fmt(chemical.moles, 5)} mol</small></span><label>التركيز<input data-chem-conc="${index}" type="number" min="0" step="any" value="${chemical.conc}" aria-label="تركيز ${escapeHtml(chemical.name)}"> M</label><label>الحجم<input data-chem-volume="${index}" type="number" min="0.01" step="any" value="${chemical.volume}" aria-label="حجم ${escapeHtml(chemical.name)}"> mL</label><button data-remove-chem="${index}" aria-label="حذف ${escapeHtml(chemical.name)}">×</button></div>`).join('');
  $$('[data-chem-conc]').forEach((input) => input.addEventListener('change', () => {
    const chemical = (state.chemicals as AddedChemical[])[Number(input.dataset.chemConc)];
    const value = Number(input.value);
    if (!chemical || input.value.trim() === '' || !Number.isFinite(value) || value < 0) { toast('أدخل تركيزًا صالحًا غير سالب.'); renderAddedChemicals(); return; }
    const quantity = solutionQuantityFromConcentration(value, chemical.volume);
    chemical.conc = quantity.concentration; chemical.moles = quantity.moles;
    invalidateChemResult();
    renderAddedChemicals(); updateBeaker();
  }));
  $$('[data-chem-volume]').forEach((input) => input.addEventListener('change', () => {
    const chemical = (state.chemicals as AddedChemical[])[Number(input.dataset.chemVolume)];
    const value = Number(input.value);
    if (!chemical || input.value.trim() === '' || !Number.isFinite(value) || value <= 0) { toast('حجم المادة يجب أن يكون أكبر من صفر.'); renderAddedChemicals(); return; }
    const quantity = solutionQuantityFromConcentration(chemical.conc, value);
    chemical.volume = quantity.volumeMl; chemical.moles = quantity.moles;
    invalidateChemResult();
    renderAddedChemicals(); updateBeaker();
  }));
  $$('[data-remove-chem]').forEach((button) => button.addEventListener('click', () => {
    state.chemicals.splice(Number(button.dataset.removeChem), 1); invalidateChemResult(); renderAddedChemicals(); updateBeaker();
  }));
  syncChemVolumeField();
}
function updateBeaker(): void {
  const fill = $('#liquid-fill');
  const bubbles = $('#bubbles');
  const list = state.chemicals as AddedChemical[];
  const visuals = deriveVisualEffects({ gasModelSupported: false, gasMoles: 0, solutionColor: null });
  bubbles.replaceChildren(); // No supported gas model currently produces bubbles.
  if (!list.length) {
    fill.setAttribute('fill', '#c7d8df'); fill.setAttribute('y', '250'); fill.setAttribute('height', '20'); fill.setAttribute('opacity', '0.28');
    $('#beaker-label').textContent = 'وعاء فارغ'; $('#chem-status').textContent = 'لا يوجد محلول'; return;
  }
  fill.setAttribute('fill', visuals.solutionColor ?? '#c7d8df'); fill.setAttribute('y', '175'); fill.setAttribute('height', '100'); fill.setAttribute('opacity', visuals.solutionColor ? '0.5' : '0.32');
  $('#beaker-label').textContent = `${list.map((chemical) => chemical.formula).join(' + ')} · اللون غير محسوب`;
  $('#chem-status').textContent = `الحجم الفعلي المضاف: ${fmt(totalVolumeMl(), 5)} mL · اللون والغاز غير محسوبين`;
}
$$('#chemical-filters button').forEach((button) => button.addEventListener('click', () => {
  state.chemFilter = button.dataset.filter ?? 'all';
  $$('#chemical-filters button').forEach((item) => item.classList.toggle('active', item === button)); renderChemicalLibrary();
}));
$('#chemical-search').addEventListener('input', renderChemicalLibrary);
$('#chem-mode').addEventListener('change', () => { state.chemistryMode = $('#chem-mode').value as ProjectState['chemistryMode']; invalidateChemResult(); syncChemVolumeField(); $('#chem-sample-volume').disabled = state.chemistryMode !== 'dilution'; });
$('#chem-volume').addEventListener('change', () => { state.chemistryFinalVolumeInput = $('#chem-volume').value; invalidateChemResult(); });
$('#chem-sample-volume').addEventListener('change', () => { state.chemistrySampleVolumeInput = $('#chem-sample-volume').value; invalidateChemResult(); });
$('#chem-temperature').addEventListener('change', () => { state.chemistryTemperatureInput = $('#chem-temperature').value; invalidateChemResult(); });
$('#chem-mix').onclick = () => {
  if (!(state.chemicals as AddedChemical[]).length) { toast('أضف مادة أولًا.'); return; }
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('#chem-atmosphere').classList.add('active'); setTimeout(() => $('#chem-atmosphere').classList.remove('active'), 1200);
  }
  toast('حركة الوعاء مؤثر بصري فقط وليست قياسًا أو دليلًا على تفاعل.');
};
$('#chem-heat').onclick = () => { const input = $('#chem-temperature'); const value = Number(input.value); if (Number.isFinite(value)) input.value = String(Math.min(200, value + 10)); state.chemistryTemperatureInput = input.value; invalidateChemResult(); toast('تم تعديل درجة الحرارة المدخلة؛ لا يوجد نموذج حراري لهذه النسخة.'); };
$('#chem-cool').onclick = () => { const input = $('#chem-temperature'); const value = Number(input.value); if (Number.isFinite(value)) input.value = String(Math.max(-20, value - 10)); state.chemistryTemperatureInput = input.value; invalidateChemResult(); toast('تم تعديل درجة الحرارة المدخلة؛ لا يوجد نموذج حراري لهذه النسخة.'); };
function reactionCallout(title: string, text: string, warning = false): string {
  return `<div class="reaction-callout ${warning ? 'warn' : ''}"><b>${escapeHtml(title)}</b><p>${escapeHtml(text)}</p></div>`;
}
function runReaction(): void {
  syncChemistryInputsFromDom();
  touchState();
  const temperatureText = state.chemistryTemperatureInput.trim();
  const temperatureValue = Number(temperatureText);
  if (!temperatureText || !Number.isFinite(temperatureValue) || temperatureValue < -20 || temperatureValue > 200) {
    $('#reaction-result').innerHTML = reactionCallout('مدخلات غير صالحة', 'أدخل درجة حرارة عددية بين -20 و200 °C. لن تُستبدل القيمة الفارغة بصفر.', true);
    $('#reaction-badge').textContent = 'مدخلات غير صالحة'; return;
  }
  const list = state.chemicals as AddedChemical[];
  const ids = list.map((chemical) => chemical.id);
  const mode = state.chemistryMode;
  if (mode === 'dilution') {
    if (list.length !== 1) {
      $('#reaction-result').innerHTML = reactionCallout('خارج نطاق المحاكاة', 'نموذج التخفيف الحالي يتطلب محلولًا واحدًا فقط حتى لا يخلط أنواعًا متعددة.', true);
      $('#reaction-badge').textContent = 'خارج نطاق المحاكاة'; return;
    }
    const chemical = list[0]; const sampleVolume = Number($('#chem-sample-volume').value); const finalVolume = Number($('#chem-volume').value);
    if (sampleVolume > chemical.volume) {
      $('#reaction-result').innerHTML = reactionCallout('مدخلات غير صالحة', 'حجم العينة الابتدائية أكبر من حجم المحلول المتاح في الوعاء.', true); $('#reaction-badge').textContent = 'مدخلات غير صالحة'; return;
    }
    try {
      const result = solveDilution(chemical.conc, sampleVolume, finalVolume);
      $('#reaction-result').innerHTML = `<div class="reaction-equation">C₁V₁ = C₂V₂</div><b>نتيجة تخفيف محسوبة ضمن النموذج</b><p>المادة: ${escapeHtml(chemical.name)} (${escapeHtml(chemical.formula)})</p><p>المعطيات: C₁ = ${fmt(chemical.conc)} mol/L، V₁ = ${fmt(sampleVolume)} mL، V₂ = ${fmt(finalVolume)} mL</p><p>n = C₁ × V₁ = ${fmt(result.initialMoles, 6)} mol</p><p><strong>C₂ = ${fmt(result.concentration, 6)} mol/L</strong></p>${reactionCallout('الافتراضات', 'ثبات كمية المذاب وجمع الحجوم؛ يجب أن يكون الحجم النهائي مساويًا لحجم العينة أو أكبر منه.')}`;
      $('#reaction-badge').textContent = 'محسوب ضمن النموذج';
      state.lastChem = { ids, mode, temperature: Number($('#chem-temperature').value), volume: finalVolume, sampleVolume, status: 'محسوب ضمن النموذج' };
    } catch (error) {
      $('#reaction-result').innerHTML = reactionCallout('مدخلات غير صالحة', error instanceof Error ? error.message : 'تعذر حساب التخفيف.', true);
      $('#reaction-badge').textContent = 'مدخلات غير صالحة';
    }
    updateBeaker(); return;
  }

  if (list.length === 2 && ids.includes('hcl') && ids.includes('naoh') && (mode === 'auto' || mode === 'acidbase')) {
    const acid = list.find((chemical) => chemical.id === 'hcl')!; const base = list.find((chemical) => chemical.id === 'naoh')!;
    const totalVolumeL = totalVolumeMl() / 1000;
    try {
      const result = solveStrongAcidBase({ acidMoles: acid.moles, baseMoles: base.moles, totalVolumeL, pKw: 14 });
      const temperature = Number($('#chem-temperature').value);
      const temperatureNote = temperature === 25 ? 'درجة الحرارة المفترضة 25 °C.' : `درجة الحرارة المدخلة ${fmt(temperature)} °C لم تُطبّق؛ لا تتوفر بيانات Kw موثقة لها، فاستُخدم افتراض 25 °C.`;
      const excessLine = result.excessSpecies === 'none' ? 'لا يوجد فائض مولاري من الحمض أو القاعدة ضمن موازنة النموذج.' : `تركيز الفائض [${result.excessSpecies}] = ${fmt(result.excessConcentration, 6)} mol/L.`;
      $('#reaction-result').innerHTML = `<div class="reaction-equation">HCl + NaOH → NaCl + H₂O</div><b>تعادل حمض قوي وقاعدة قوية بنسبة مولية 1:1</b><p>مولات HCl: ${fmt(acid.moles, 6)} mol</p><p>مولات NaOH: ${fmt(base.moles, 6)} mol</p><p>المولات المتعادلة: ${fmt(result.reactedMoles, 6)} mol</p><p>${escapeHtml(excessLine)}</p><p>الحجم الكلي الفعلي المضاف: ${fmt(totalVolumeMl(), 5)} mL</p><p>pH التقريبي ضمن النموذج: <strong>${fmt(result.pH, 4)}</strong></p>${reactionCallout('افتراضات النموذج', `${result.assumptions.join(' ')} ${temperatureNote}`)}`;
      $('#reaction-badge').textContent = 'محسوب ضمن النموذج';
      state.lastChem = { ids, mode, temperature, volume: totalVolumeMl(), pH: result.pH, status: 'محسوب ضمن النموذج' };
    } catch (error) {
      $('#reaction-result').innerHTML = reactionCallout('مدخلات غير صالحة', error instanceof Error ? error.message : 'تعذر الحساب.', true);
      $('#reaction-badge').textContent = 'مدخلات غير صالحة';
    }
    updateBeaker(); return;
  }

  if (list.length === 2 && ids.includes('agno3') && ids.includes('nacl') && (mode === 'auto' || mode === 'precipitation')) {
    const silver = list.find((chemical) => chemical.id === 'agno3')!; const chloride = list.find((chemical) => chemical.id === 'nacl')!;
    const result = solveAgClStoichiometry(silver.moles, chloride.moles);
    const limiting = result.limitingReactant === 'equal' ? 'الكميتان متساويتان مولاريًا.' : `المتفاعل المحدِّد في موازنة 1:1 هو ${result.limitingReactant}.`;
    $('#reaction-result').innerHTML = `<div class="reaction-equation">AgNO₃ + NaCl → AgCl + NaNO₃</div><b>موازنة مولية نظرية 1:1</b><p>مولات AgNO₃: ${fmt(silver.moles, 6)} mol</p><p>مولات NaCl: ${fmt(chloride.moles, 6)} mol</p><p>${escapeHtml(limiting)}</p><p>الحد النظري الأقصى لـ AgCl بافتراض التحول الكامل: ${fmt(result.moles, 6)} mol (${fmt(result.massGrams, 6)} g).</p>${reactionCallout('حدود النتيجة', 'لا تُعرض كمية راسب اتزانية أو رسمة راسب لأن قيمة Ksp وبيانات الاتزان غير موثقة في كتالوج هذه النسخة. الرقم حد ستوكيومتري نظري فقط.')}`;
    $('#reaction-badge').textContent = 'محسوب ضمن النموذج';
    state.lastChem = { ids, mode, temperature: Number($('#chem-temperature').value), volume: totalVolumeMl(), theoreticalAgClMoles: result.moles, status: 'محسوب ضمن النموذج' };
    updateBeaker(); return;
  }

  const materialList = list.map((chemical) => `${chemical.formula} (${chemical.name})`).join(' + ') || 'لا توجد مواد';
  $('#reaction-result').innerHTML = reactionCallout('خارج نطاق المحاكاة', `لا توجد معادلة مدعومة ومتحقق منها لهذه المجموعة: ${materialList}. نقص البيانات لا يعني أن المواد لا تتفاعل.`, true);
  $('#reaction-badge').textContent = 'خارج نطاق المحاكاة';
  state.lastChem = { ids, mode, temperature: Number($('#chem-temperature').value), volume: totalVolumeMl(), status: 'خارج نطاق المحاكاة' };
  updateBeaker();
}
$('#run-reaction').onclick = runReaction;
$('#chem-reset').onclick = () => {
  state.chemicals = []; state.lastChem = null; touchState(); renderAddedChemicals(); updateBeaker();
  $('#reaction-result').innerHTML = '<div class="empty-result">ستظهر هنا النتيجة المدعومة، والمعادلة الموزونة إن توفرت.</div>';
  $('#reaction-badge').textContent = 'بانتظار التشغيل'; toast('أعيد وعاء الكيمياء إلى الحالة الفارغة.');
};
function syncChemUnknownFields(): void {
  const kind = $('#chem-unknown-kind').value;
  $('#chem-known-field').hidden = kind === 'concentration';
  $('#chem-volume-field').hidden = kind === 'volume';
  $('#chem-moles-field').hidden = kind === 'moles';
  $('#chem-known-value-caption').textContent = 'التركيز المعروف C (mol/L)';
  $('#chem-unknown-volume-caption').textContent = 'حجم المحلول V (L)';
  $('#chem-unknown-moles-caption').textContent = 'عدد المولات n (mol)';
}
$('#chem-unknown-kind').addEventListener('change', syncChemUnknownFields);
$('#solve-chem-unknown').onclick = () => {
  const kind = $('#chem-unknown-kind').value;
  const rawMoles = $('#chem-unknown-moles').value.trim();
  const rawVolume = $('#chem-unknown-volume').value.trim();
  const rawKnown = $('#chem-known-value').value.trim();
  let formula = ''; let result = ''; let explanation = '';
  if (kind === 'concentration') {
    if (!rawMoles || !rawVolume) { $('#chem-solution').textContent = 'أدخل عدد المولات والحجم؛ الحقول الفارغة ليست صفرًا.'; return; }
    const moles = Number(rawMoles); const volume = Number(rawVolume);
    if (![moles, volume].every(Number.isFinite) || moles < 0 || volume <= 0) { $('#chem-solution').textContent = 'المولات يجب أن تكون غير سالبة والحجم موجبًا.'; return; }
    const concentration = solveConcentration(moles, volume); formula = 'C = n / V'; result = `C = ${fmt(moles)} / ${fmt(volume)} = ${fmt(concentration)} mol/L`; explanation = 'التركيز بوحدة mol/L والحجم النهائي للمحلول باللتر.';
  } else if (kind === 'moles') {
    if (!rawKnown || !rawVolume) { $('#chem-solution').textContent = 'أدخل التركيز المعروف والحجم؛ الحقول الفارغة ليست صفرًا.'; return; }
    const concentration = Number(rawKnown); const volume = Number(rawVolume);
    if (![concentration, volume].every(Number.isFinite) || concentration < 0 || volume <= 0) { $('#chem-solution').textContent = 'التركيز يجب أن يكون غير سالب والحجم موجبًا.'; return; }
    const moles = solveMoles(concentration, volume); formula = 'n = C × V'; result = `n = ${fmt(concentration)} × ${fmt(volume)} = ${fmt(moles)} mol`; explanation = 'التركيز بوحدة mol/L والحجم النهائي باللتر.';
  } else {
    if (!rawMoles || !rawKnown) { $('#chem-solution').textContent = 'أدخل عدد المولات والتركيز المعروف؛ الحقول الفارغة ليست صفرًا.'; return; }
    const moles = Number(rawMoles); const concentration = Number(rawKnown);
    if (![moles, concentration].every(Number.isFinite) || moles <= 0 || concentration <= 0) { $('#chem-solution').textContent = 'لاستنتاج حجم موجب محدد يلزم عدد مولات وتركيز موجبان.'; return; }
    const volume = solveSolutionVolume(moles, concentration); formula = 'V = n / C'; result = `V = ${fmt(moles)} / ${fmt(concentration)} = ${fmt(volume)} L`; explanation = 'الحجم النهائي للمحلول، وليس بالضرورة حجم المذيب المضاف.';
  }
  $('#chem-solution').innerHTML = `<b>العلاقة المستخدمة</b><span class="formula">${formula}</span><b>التعويض</b><span class="formula">${result}</span><p>${escapeHtml(explanation)}</p>`;
};


function renderPeriodic(): void {
  const table = $('#periodic-table');
  table.innerHTML = elements.map((element) => `<button class="element-cell" title="${escapeHtml(element.name)} · العدد الذري ${element.atomicNumber}" data-element="${escapeHtml(element.symbol)}"><b>${escapeHtml(element.symbol)}</b><small>${element.atomicNumber}</small></button>`).join('') + '<p class="periodic-note" style="grid-column:1/-1">هذه مجموعة مختارة فقط، وليست الجدول الدوري الكامل؛ بيانات الخواص التفصيلية غير متاحة في هذه النسخة.</p>';
  $$('[data-element]').forEach((button) => button.addEventListener('click', () => {
    const element = elements.find((item) => item.symbol === button.dataset.element);
    if (element) toast(`${element.name} (${element.symbol}) · العدد الذري ${element.atomicNumber}`);
  }));
}
function openSave(type: 'physics' | 'chemistry'): void {
  state.pendingSave = type;
  $('#experiment-name').value = type === 'physics' ? 'تجربة دائرة كهربائية' : 'تجربة كيمياء';
  $('#experiment-notes').value = '';
  $('#save-dialog').showModal();
}
$('#physics-save').onclick = () => openSave('physics');
$('#chem-save').onclick = () => openSave('chemistry');
function loadSaved(): SavedExperiment[] {
  try { state.storageError = null; return storage.load(); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'تعذر قراءة سجل التجارب.';
    if (state.storageError !== message) toast(message);
    state.storageError = message; return [];
  }
}
function saveSaved(experiments: SavedExperiment[]): boolean {
  try { storage.save(experiments); state.storageError = null; return true; }
  catch (error) { toast(error instanceof Error ? error.message : 'تعذر حفظ التجارب.'); return false; }
}
function updateSavedCount(): void { $('#saved-count').textContent = String(loadSaved().length); }
$('#confirm-save').addEventListener('click', (event) => {
  event.preventDefault();
  const name = $('#experiment-name').value.trim();
  if (!name) { toast('اكتب اسم التجربة.'); return; }
  const type = state.pendingSave as 'physics' | 'chemistry' | null;
  if (!type) { toast('اختر مختبرًا قبل الحفظ.'); return; }
  const data: Record<string, unknown> = type === 'physics'
    ? { stateId: state.stateId, components: structuredClone(state.components), wires: structuredClone(state.wires), referenceTerminal: state.referenceTerminal }
    : { stateId: state.stateId, chemicals: structuredClone(state.chemicals), volume: state.chemistryFinalVolumeInput, sampleVolume: state.chemistrySampleVolumeInput, temperature: state.chemistryTemperatureInput, mode: state.chemistryMode };
  const now = new Date().toISOString();
  const experiment: SavedExperiment = { id: nextId(), name, notes: $('#experiment-notes').value, type, created: now, updated: now, data };
  const all = loadSaved(); all.unshift(experiment);
  if (!saveSaved(all)) return;
  $('#save-dialog').close(); updateSavedCount(); toast('حُفظت التجربة محليًا على هذا الجهاز.');
});
function renderSaved(): void {
  const query = ($('#saved-search').value || '').toLowerCase();
  const all = loadSaved().filter((experiment) => `${experiment.name}${experiment.notes}${experiment.type}`.toLowerCase().includes(query));
  const box = $('#saved-list');
  if (!all.length) { box.innerHTML = '<div class="empty-saved"><b>لا توجد تجارب مطابقة بعد</b>احفظ تجربة من مختبر الفيزياء أو الكيمياء، وستظهر هنا على هذا الجهاز.</div>'; return; }
  box.innerHTML = all.map((experiment) => `<article class="saved-card"><div class="saved-card-top"><span class="saved-type">${experiment.type === 'physics' ? 'PHYSICS' : 'CHEMISTRY'}</span><span class="soft-badge">محلي</span></div><h3>${escapeHtml(experiment.name)}</h3><p>${escapeHtml(experiment.notes || 'لا توجد ملاحظات مضافة.')}</p><div class="saved-meta">آخر حفظ: ${escapeHtml(new Date(experiment.updated).toLocaleString('ar'))}</div><div class="saved-actions"><button data-open-exp="${escapeHtml(experiment.id)}">فتح التجربة</button><button data-export-exp="${escapeHtml(experiment.id)}">تصدير</button><button class="danger" data-delete-exp="${escapeHtml(experiment.id)}">حذف</button></div></article>`).join('');
  $$('[data-open-exp]').forEach((button) => button.addEventListener('click', () => openExperiment(button.dataset.openExp ?? '')));
  $$('[data-export-exp]').forEach((button) => button.addEventListener('click', () => {
    const experiment = loadSaved().find((item) => item.id === button.dataset.exportExp);
    if (experiment) downloadJSON(makeProjectExport([experiment]), `${safeFile(experiment.name)}.json`);
  }));
  $$('[data-delete-exp]').forEach((button) => button.addEventListener('click', () => {
    if (!confirm('هل تريد حذف هذه التجربة من هذا المتصفح؟')) return;
    const updated = loadSaved().filter((item) => item.id !== button.dataset.deleteExp);
    if (saveSaved(updated)) { renderSaved(); updateSavedCount(); toast('حُذفت التجربة.'); }
  }));
}
$('#saved-search').addEventListener('input', renderSaved);
function openExperiment(id: string): void {
  const experiment = loadSaved().find((item) => item.id === id);
  if (!experiment) { toast('لم يتم العثور على التجربة.'); return; }
  if (experiment.type === 'physics') {
    touchState();
    state.components = structuredClone(experiment.data.components as CircuitComponent[]);
    if (Array.isArray(experiment.data.wires)) {
      state.wires = structuredClone(experiment.data.wires as CircuitWire[]);
      state.referenceTerminal = typeof experiment.data.referenceTerminal === 'string' ? experiment.data.referenceTerminal : `${state.components.find((component: CircuitComponent) => component.type === 'source')?.id ?? ''}:b`;
    } else {
      const migrated = migrateLegacyTopology(state.components);
      state.wires = migrated.wires; state.referenceTerminal = migrated.referenceTerminal;
    }
    state.selected = state.components[0]?.id ?? null; history.clear(snapshotCircuit()); solveCircuit(); renderCircuit(); renderInspector(); setView('physics');
  } else {
    const storedChemicals = experiment.data.chemicals as Array<Record<string, unknown>>;
    const restored: AddedChemical[] = [];
    for (const stored of storedChemicals) {
      const definition = chemicalCatalog.find((chemical) => chemical.id === stored.id);
      if (!definition) { toast('تحتوي التجربة على مادة غير موجودة في كتالوج هذه النسخة؛ لم تُفتح.'); return; }
      restored.push({ ...definition, conc: Number(stored.conc), moles: Number(stored.moles), volume: Number(stored.volume) });
    }
    state.chemicals = restored; touchState();
    $('#chem-volume').value = experiment.data.volume === undefined ? '' : String(experiment.data.volume);
    $('#chem-sample-volume').value = experiment.data.sampleVolume === undefined ? '' : String(experiment.data.sampleVolume);
    $('#chem-temperature').value = experiment.data.temperature === undefined ? '' : String(experiment.data.temperature);
    $('#chem-mode').value = String(experiment.data.mode ?? 'auto');
    state.lastChem = null;
    renderAddedChemicals(); updateBeaker();
    $('#reaction-result').innerHTML = '<div class="empty-result">أعد تشغيل النموذج لإعادة حساب النتيجة وفق المحرك الحالي.</div>';
    $('#reaction-badge').textContent = 'بانتظار التشغيل'; setView('chemistry');
  }
  toast('تم فتح نسخة التجربة المحفوظة.');
}
function downloadJSON(data: unknown, name: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
$('#export-all').onclick = () => downloadJSON(makeProjectExport(loadSaved()), 'tayf-experiments.json');
$('#import-project').onclick = () => $('#import-project-file').click();
$('#import-project-file').addEventListener('change', async () => {
  const file = $('#import-project-file').files?.[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new StorageError('حجم ملف الاستيراد أكبر من 5 MB.');
    const parsed: unknown = JSON.parse(await file.text());
    const imported = parseProjectImport(parsed);
    for (const experiment of imported) {
      if (experiment.type === 'chemistry') {
        const ids = (experiment.data.chemicals as Array<Record<string, unknown>>).map((chemical) => chemical.id);
        if (ids.some((id) => !chemicalCatalog.some((chemical) => chemical.id === id))) throw new StorageError('يحتوي الملف على مادة غير معروفة في كتالوج هذه النسخة.');
      }
    }
    const current = loadSaved();
    const seen = new Set(current.map((experiment) => experiment.id));
    const accepted = imported.map((experiment) => {
      if (seen.has(experiment.id)) { const copy = { ...experiment, id: nextId() }; seen.add(copy.id); return copy; }
      seen.add(experiment.id); return experiment;
    });
    if (saveSaved([...accepted, ...current])) { renderSaved(); updateSavedCount(); toast(`تم استيراد ${accepted.length} تجربة بعد التحقق من مخطط الملف.`); }
  } catch (error) {
    toast(error instanceof Error ? error.message : 'تعذر استيراد الملف.');
  } finally { $('#import-project-file').value = ''; }
});

renderLibrary();
defaultCircuit();
renderChemicalLibrary();
renderPeriodic();
$('#chem-mode').value = state.chemistryMode;
$('#chem-temperature').value = state.chemistryTemperatureInput;
$('#chem-sample-volume').value = state.chemistrySampleVolumeInput;
$('#chem-volume').value = state.chemistryFinalVolumeInput;
renderAddedChemicals();
syncUnknownFields();
syncChemUnknownFields();
updateBeaker();
updateSavedCount();
$('#chem-sample-volume').disabled = $('#chem-mode').value !== 'dilution';
