import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultCircuitModel, inferResistanceFromMeasurements, migrateLegacyTopology, solveCircuit } from '../.test-dist/engine/circuit.js';
import { combineStockAddition, deriveVisualEffects, quantityToSolution, solveAgClStoichiometry, solveConcentration, solveDilution, solveMoles, solveSolutionVolume, solveStrongAcidBase, solutionQuantityFromConcentration } from '../.test-dist/engine/chem.js';
import { parseQuantity } from '../.test-dist/engine/quantity.js';
import { escapeHtml } from '../.test-dist/security/escape-html.js';
import { clampComponentPosition, pointerToViewBox } from '../.test-dist/ui/geometry.js';
import { createHistory } from '../.test-dist/state/history.js';
import { createProjectState } from '../.test-dist/state/project.js';
import { LocalStorageAdapter, parseProjectImport, StorageError } from '../.test-dist/storage/storage.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('MNA reference series circuit matches resistance, current, voltage drops and powers', () => {
  const result = solveCircuit(defaultCircuitModel());
  assert.equal(result.status, 'solved'); close(result.totalR, 300); close(result.I, 0.04);
  close(result.drops[0].V, 4); close(result.drops[1].V, 8); close(result.drops[0].P, 0.16); close(result.drops[1].P, 0.32);
});
test('MNA reads real parallel topology instead of assuming series', () => {
  const model = defaultCircuitModel();
  model.wires = [
    { id: 'p1', from: { componentId: 'v1', terminal: 'a' }, to: { componentId: 'r1', terminal: 'a' } },
    { id: 'p2', from: { componentId: 'r1', terminal: 'b' }, to: { componentId: 'v1', terminal: 'b' } },
    { id: 'p3', from: { componentId: 'v1', terminal: 'a' }, to: { componentId: 'r2', terminal: 'a' } },
    { id: 'p4', from: { componentId: 'r2', terminal: 'b' }, to: { componentId: 'v1', terminal: 'b' } },
  ];
  const result = solveCircuit(model); assert.equal(result.status, 'solved'); close(result.totalR, 200 / 3); close(result.I, 0.18);
  close(result.drops[0].V, 12); close(result.drops[1].V, 12);
});
test('open, shorted, invalid and unsupported circuits are explicitly diagnosed', () => {
  const open = defaultCircuitModel(); open.wires = []; assert.equal(solveCircuit(open).status, 'open-circuit');
  const short = defaultCircuitModel(); short.wires.push({ id: 'short', from: { componentId: 'v1', terminal: 'a' }, to: { componentId: 'v1', terminal: 'b' } }); assert.equal(solveCircuit(short).status, 'short-circuit');
  const invalid = defaultCircuitModel(); invalid.components.find((component) => component.id === 'r1').value = 0; assert.equal(solveCircuit(invalid).status, 'invalid-input');
  const invalidSource = defaultCircuitModel(); invalidSource.components.find((component) => component.id === 'v1').value = Number.NaN; assert.equal(solveCircuit(invalidSource).status, 'invalid-input');
  const floating = defaultCircuitModel(); floating.components.push({ id: 'r3', type: 'resistor', name: 'Floating R', value: 50, x: 400, y: 300 }); assert.equal(solveCircuit(floating).status, 'floating-node');
  const conflicting = defaultCircuitModel(); conflicting.components.push({ id: 'v2', type: 'source', name: 'V2', value: 5, x: 200, y: 200 });
  conflicting.wires.push({ id: 'conflict-a', from: { componentId: 'v2', terminal: 'a' }, to: { componentId: 'v1', terminal: 'a' } }, { id: 'conflict-b', from: { componentId: 'v2', terminal: 'b' }, to: { componentId: 'v1', terminal: 'b' } });
  assert.equal(solveCircuit(conflicting).status, 'inconsistent-sources');
  const unsupported = defaultCircuitModel(); unsupported.components.push({ id: 'c1', type: 'capacitor', name: 'C1', value: 1, x: 200, y: 200 });
  assert.equal(solveCircuit(unsupported).status, 'solved'); assert.deepEqual(solveCircuit(unsupported).unsupported, ['c1']);
});
test('legacy n1/n2 topology migrates to explicit terminal wires', () => {
  const old = [{ id: 'v1', type: 'source', name: 'V', value: 12, x: 1, y: 1, n1: 0, n2: 1 }, { id: 'r1', type: 'resistor', name: 'R', value: 100, x: 2, y: 2, n1: 1, n2: 0 }];
  const migrated = migrateLegacyTopology(old); assert.equal(migrated.wires.length, 2); assert.equal(migrated.referenceTerminal, 'v1:b');
});
test('resistance from measurements and concentration/moles/volume are solved by the engine', () => {
  close(inferResistanceFromMeasurements(12, 0.2), 60);
  close(solveConcentration(0.02, 0.1), 0.2); close(solveMoles(0.2, 0.1), 0.02); close(solveSolutionVolume(0.02, 0.2), 0.1);
  close(quantityToSolution('moles', 0.1, 0.1, 0).moles, 0.1);
  assert.throws(() => quantityToSolution('mass', 5.844, 0.1, 58.44, false), /توثيق الكتلة المولية/);
});
test('unit parser handles 4.7k, 20mA and 10 μF and rejects mismatched units', () => {
  close(parseQuantity('4.7k', 'resistance').quantity.value, 4700); close(parseQuantity('20mA', 'current').quantity.value, 0.02);
  close(parseQuantity('10 μF', 'capacitance').quantity.value, 1e-5); assert.equal(parseQuantity('12V', 'resistance').ok, false);
});
test('strong acid/base uses actual total volume and does not clamp pH', () => {
  close(solveStrongAcidBase({ acidMoles: 0.0025, baseMoles: 0.0025, totalVolumeL: 0.05 }).pH, 7);
  const excess = solveStrongAcidBase({ acidMoles: 0.0025, baseMoles: 0.0035, totalVolumeL: 0.06 });
  close(excess.excessConcentration, 0.001 / 0.06); close(excess.pH, 12.2218487496, 1e-8);
  assert.ok(solveStrongAcidBase({ acidMoles: 1, baseMoles: 0, totalVolumeL: 0.1 }).pH < 0);
  assert.ok(solveStrongAcidBase({ acidMoles: 0, baseMoles: 1, totalVolumeL: 0.1 }).pH > 14);
});
test('duplicate stock addition keeps moles, concentration and volume consistent', () => {
  const combined = combineStockAddition(solutionQuantityFromConcentration(0.1, 50), 0.1, 50);
  close(combined.volumeMl, 100); close(combined.moles, 0.01); close(combined.concentration, 0.1);
  const mixed = combineStockAddition({ concentration: 0.5, moles: 0.025, volumeMl: 50 }, 0.1, 50); close(mixed.moles, 0.03); close(mixed.concentration, 0.3);
});
test('dilution and AgCl stoichiometry use input quantities', () => {
  const dilution = solveDilution(0.1, 25, 100); close(dilution.initialMoles, 0.0025); close(dilution.concentration, 0.025);
  assert.throws(() => solveDilution(0.1, 50, 25));
  const precipitate = solveAgClStoichiometry(0.003, 0.002); close(precipitate.moles, 0.002); close(precipitate.massGrams, 0.28664); assert.equal(precipitate.limitingReactant, 'NaCl');
});
test('visual effects require explicit supported evidence', () => {
  assert.equal(deriveVisualEffects({ gasModelSupported: false, gasMoles: 0.5 }).showBubbles, false);
  assert.equal(deriveVisualEffects({ gasModelSupported: true, gasMoles: 0.5 }).showBubbles, true);
  assert.equal(deriveVisualEffects({ gasModelSupported: false }).showPrecipitate, false);
  assert.equal(deriveVisualEffects({ gasModelSupported: false, ionicProductQ: 2, solubilityProductKsp: 1 }).showPrecipitate, true);
  assert.equal(deriveVisualEffects({ gasModelSupported: false }).solutionColor, null);
});
test('XSS escaping, responsive pointer coordinates, and drag bounds are correct', () => {
  assert.match(escapeHtml('<img src=x onerror=alert(1)>'), /&lt;img/);
  assert.deepEqual(pointerToViewBox(380, 195, { left: 0, top: 0, width: 380, height: 195 }, 760, 390), { x: 760, y: 390 });
  assert.deepEqual(clampComponentPosition(-100, 900), { x: 65, y: 315 });
});
test('chemical JSON catalog is versioned and marks unverified molar masses', () => {
  const catalog = JSON.parse(readFileSync('src/data/chemicals.json', 'utf8'));
  assert.equal(catalog.schemaVersion, '0.1'); assert.ok(catalog.chemicals.length >= 1);
  assert.ok(catalog.chemicals.every((chemical) => typeof chemical.source === 'string' && chemical.source.length > 0 && typeof chemical.version === 'string' && chemical.molarMassVerified === false));
  assert.ok(JSON.parse(readFileSync('src/data/chemicals.schema.json', 'utf8')).$schema.includes('json-schema.org'));
  assert.ok(JSON.parse(readFileSync('src/storage/project.schema.json', 'utf8')).$schema.includes('json-schema.org'));
});
test('project state is serializable and versioned', () => {
  const state = createProjectState(defaultCircuitModel()); assert.equal(state.schemaVersion, 1); assert.match(state.stateId, /^state-/); assert.equal(state.components.length, 3);
});
test('undo/redo works and storage failures are surfaced', () => {
  const history = createHistory({ x: 1 }); history.commit({ x: 2 }); history.commit({ x: 3 }); assert.deepEqual(history.undo({ x: 3 }), { x: 2 }); assert.deepEqual(history.redo({ x: 2 }), { x: 3 }); assert.deepEqual(history.undo({ x: 3 }), { x: 2 });
  const fake = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 };
  assert.throws(() => new LocalStorageAdapter(fake).save([]), StorageError);
});
test('legacy storage migrates and bad imports are rejected', () => {
  const legacy = { id: 'exp-1', name: 'Test', notes: '', type: 'physics', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', data: { components: [{ id: 'v1', type: 'source', name: 'Source', value: 12, x: 1, y: 2 }] } };
  const writes = []; const fake = { getItem: () => JSON.stringify([legacy]), setItem: (_key, value) => writes.push(value), removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 };
  assert.deepEqual(new LocalStorageAdapter(fake).load(), [legacy]); assert.equal(JSON.parse(writes[0]).schemaVersion, 1);
  assert.throws(() => parseProjectImport({ kind: 'tayf-project', schemaVersion: 99, exportedAt: '2026-10-22T00:00:00.000Z', experiments: [] }), StorageError);
  assert.throws(() => parseProjectImport({ kind: 'tayf-project', schemaVersion: 1, exportedAt: '2026-10-22T00:00:00.000Z', experiments: [], unexpected: true }), StorageError);
  assert.throws(() => parseProjectImport([{ id: 'bad', type: 'hacker' }]), StorageError);
  assert.deepEqual(parseProjectImport({ kind: 'tayf-project', schemaVersion: 1, exportedAt: '2026-10-22T00:00:00.000Z', experiments: [] }), []);
});
