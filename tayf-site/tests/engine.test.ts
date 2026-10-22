import { describe, expect, it } from 'vitest';
import { defaultCircuitModel, inferResistanceFromMeasurements, solveCircuit, type CircuitModel } from '../src/engine/circuit';
import { combineStockAddition, deriveVisualEffects, quantityToSolution, solveAgClStoichiometry, solveConcentration, solveDilution, solveMoles, solveSolutionVolume, solveStrongAcidBase, solutionQuantityFromConcentration } from '../src/engine/chem';
import { parseQuantity } from '../src/engine/quantity';
import { escapeHtml } from '../src/security/escape-html';
import { clampComponentPosition, pointerToViewBox } from '../src/ui/geometry';
import { createHistory } from '../src/state/history';
import { createProjectState } from '../src/state/project';
import { LocalStorageAdapter, parseProjectImport, StorageError, type SavedExperiment } from '../src/storage/storage';

const close = (actual: number | undefined, expected: number, tolerance = 1e-9) => expect(actual).toBeCloseTo(expected, Math.max(0, Math.ceil(-Math.log10(tolerance))));

function parallelCircuit(): CircuitModel {
  const model = defaultCircuitModel();
  model.wires = [
    { id: 'p1', from: { componentId: 'v1', terminal: 'a' }, to: { componentId: 'r1', terminal: 'a' } },
    { id: 'p2', from: { componentId: 'r1', terminal: 'b' }, to: { componentId: 'v1', terminal: 'b' } },
    { id: 'p3', from: { componentId: 'v1', terminal: 'a' }, to: { componentId: 'r2', terminal: 'a' } },
    { id: 'p4', from: { componentId: 'r2', terminal: 'b' }, to: { componentId: 'v1', terminal: 'b' } },
  ];
  return model;
}

describe('Circuit engine: topology, validation and MNA', () => {
  it('solves the documented 12 V / 100 Ω / 200 Ω series reference', () => {
    const result = solveCircuit(defaultCircuitModel());
    expect(result.status).toBe('solved');
    close(result.totalR, 300); close(result.I, 0.04);
    close(result.drops?.[0].V, 4); close(result.drops?.[1].V, 8);
    close(result.drops?.[0].P, 0.16); close(result.drops?.[1].P, 0.32);
  });
  it('uses actual wire topology for a parallel network, not a fixed series assumption', () => {
    const result = solveCircuit(parallelCircuit());
    expect(result.status).toBe('solved'); close(result.totalR, 200 / 3); close(result.I, 0.18);
    close(result.drops?.[0].V, 12); close(result.drops?.[1].V, 12);
  });
  it('reports an open circuit instead of returning fabricated numbers', () => {
    const model = defaultCircuitModel(); model.wires = [];
    expect(solveCircuit(model).status).toBe('open-circuit');
  });
  it('rejects an ideal voltage source shorted by a wire', () => {
    const model = defaultCircuitModel();
    model.wires.push({ id: 'short', from: { componentId: 'v1', terminal: 'a' }, to: { componentId: 'v1', terminal: 'b' } });
    expect(solveCircuit(model).status).toBe('short-circuit');
  });
  it('infers resistance only from entered voltage and current measurements', () => {
    close(inferResistanceFromMeasurements(12, 0.2), 60);
    expect(() => inferResistanceFromMeasurements(12, 0)).toThrow();
  });
  it('does not silently discard zero or invalid resistance', () => {
    const model = defaultCircuitModel(); model.components.find((component) => component.id === 'r1')!.value = 0;
    expect(solveCircuit(model).status).toBe('invalid-input');
  });
  it('rejects a non-finite source voltage rather than converting it to zero', () => {
    const model = defaultCircuitModel(); model.components.find((component) => component.id === 'v1')!.value = Number.NaN;
    expect(solveCircuit(model).status).toBe('invalid-input');
  });
  it('diagnoses floating nodes and conflicting ideal voltage sources', () => {
    const floating = defaultCircuitModel(); floating.components.push({ id: 'r3', type: 'resistor', name: 'Floating R', value: 50, x: 400, y: 300 });
    expect(solveCircuit(floating).status).toBe('floating-node');
    const conflicting = defaultCircuitModel(); conflicting.components.push({ id: 'v2', type: 'source', name: 'V2', value: 5, x: 200, y: 200 });
    conflicting.wires.push({ id: 'conflict-a', from: { componentId: 'v2', terminal: 'a' }, to: { componentId: 'v1', terminal: 'a' } }, { id: 'conflict-b', from: { componentId: 'v2', terminal: 'b' }, to: { componentId: 'v1', terminal: 'b' } });
    expect(solveCircuit(conflicting).status).toBe('inconsistent-sources');
  });
  it('marks unsupported components without including them in numerical results', () => {
    const model = defaultCircuitModel(); model.components.push({ id: 'c1', type: 'capacitor', name: '<svg>', value: 10, x: 200, y: 200 });
    const result = solveCircuit(model); expect(result.status).toBe('solved'); expect(result.unsupported).toContain('c1');
  });
});

describe('Quantity parser', () => {
  it('parses 4.7k as 4700 ohms', () => { const result = parseQuantity('4.7k', 'resistance'); expect(result.ok).toBe(true); if (result.ok) close(result.quantity.value, 4700); });
  it('parses 20mA as 0.02 A', () => { const result = parseQuantity('20mA', 'current'); expect(result.ok).toBe(true); if (result.ok) close(result.quantity.value, 0.02); });
  it('parses 10 μF as 10 microfarads', () => { const result = parseQuantity('10 μF', 'capacitance'); expect(result.ok).toBe(true); if (result.ok) close(result.quantity.value, 1e-5); });
  it('rejects a unit from the wrong dimension and empty input', () => { expect(parseQuantity('12V', 'resistance').ok).toBe(false); expect(parseQuantity('', 'voltage').ok).toBe(false); });
});

describe('Chemistry engine: mass balance and declared model limits', () => {
  it('calculates equal strong acid and base at pH 7 under the 25 °C pKw assumption', () => {
    const result = solveStrongAcidBase({ acidMoles: 0.0025, baseMoles: 0.0025, totalVolumeL: 0.05 });
    close(result.pH, 7); close(result.reactedMoles, 0.0025);
  });
  it('calculates excess hydroxide using the actual combined volume', () => {
    const result = solveStrongAcidBase({ acidMoles: 0.0025, baseMoles: 0.0035, totalVolumeL: 0.06 });
    close(result.excessConcentration, 0.001 / 0.06); close(result.pH, 12.2218487496, 1e-8);
  });
  it('does not clamp mathematically modeled pH to 0–14', () => {
    const acidic = solveStrongAcidBase({ acidMoles: 1, baseMoles: 0, totalVolumeL: 0.1 });
    const basic = solveStrongAcidBase({ acidMoles: 0, baseMoles: 1, totalVolumeL: 0.1 });
    expect(acidic.pH).toBeLessThan(0); expect(basic.pH).toBeGreaterThan(14);
  });
  it('keeps moles and volume consistent when a stock solution is added twice', () => {
    const initial = solutionQuantityFromConcentration(0.1, 50);
    const combined = combineStockAddition(initial, 0.1, 50);
    close(combined.volumeMl, 100); close(combined.moles, 0.01); close(combined.concentration, 0.1);
    const dilutedMix = combineStockAddition({ concentration: 0.5, moles: 0.025, volumeMl: 50 }, 0.1, 50);
    close(dilutedMix.moles, 0.03); close(dilutedMix.concentration, 0.3);
  });
  it('does not emit bubbles or precipitate visuals without supported evidence', () => {
    expect(deriveVisualEffects({ gasModelSupported: false, gasMoles: 0.1 }).showBubbles).toBe(false);
    expect(deriveVisualEffects({ gasModelSupported: true, gasMoles: 0.1 }).showBubbles).toBe(true);
    expect(deriveVisualEffects({ gasModelSupported: false }).showPrecipitate).toBe(false);
    expect(deriveVisualEffects({ gasModelSupported: false, ionicProductQ: 2, solubilityProductKsp: 1 }).showPrecipitate).toBe(true);
    expect(deriveVisualEffects({ gasModelSupported: false }).solutionColor).toBeNull();
  });
  it('solves concentration, moles and volume with the reference example', () => {
    close(solveConcentration(0.02, 0.1), 0.2); close(solveMoles(0.2, 0.1), 0.02); close(solveSolutionVolume(0.02, 0.2), 0.1);
    close(quantityToSolution('moles', 0.1, 0.1, 0).moles, 0.1);
    expect(() => quantityToSolution('mass', 5.844, 0.1, 58.44, false)).toThrow('توثيق الكتلة المولية');
  });
  it('calculates dilution from both initial and final volumes', () => {
    const result = solveDilution(0.1, 25, 100); close(result.initialMoles, 0.0025); close(result.concentration, 0.025);
  });
  it('rejects dilution where final volume is smaller than sample volume', () => { expect(() => solveDilution(0.1, 50, 25)).toThrow(); });
  it('calculates the AgCl stoichiometric limit and limiting reactant', () => {
    const result = solveAgClStoichiometry(0.003, 0.002); close(result.moles, 0.002); close(result.massGrams, 0.28664); expect(result.limitingReactant).toBe('NaCl');
  });
});

describe('Security, persistence and state helpers', () => {
  it('escapes HTML and attribute injection payloads', () => { expect(escapeHtml(`"><img src=x onerror=alert(1)>`)).toBe('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'); });
  it('uses the current rendered size to map pointer coordinates', () => { expect(pointerToViewBox(380, 195, { left: 0, top: 0, width: 380, height: 195 }, 760, 390)).toEqual({ x: 760, y: 390 }); });
  it('clamps dragged components inside the work area', () => { expect(clampComponentPosition(-100, 900)).toEqual({ x: 65, y: 315 }); });
  it('creates a serializable project state with a state id and schema version', () => {
    const state = createProjectState(defaultCircuitModel());
    expect(state.schemaVersion).toBe(1); expect(state.stateId).toMatch(/^state-/); expect(state.components).toHaveLength(3);
  });
  it('supports undo and redo snapshots', () => {
    const history = createHistory({ x: 1 }); history.commit({ x: 2 }); history.commit({ x: 3 }); expect(history.undo({ x: 3 })).toEqual({ x: 2 }); expect(history.redo({ x: 2 })).toEqual({ x: 3 }); expect(history.undo({ x: 3 })).toEqual({ x: 2 });
  });
  it('migrates a valid legacy array to the versioned local storage schema', () => {
    const writes: string[] = [];
    const legacy: SavedExperiment = { id: 'exp-1', name: 'Test', notes: '', type: 'physics', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', data: { components: [{ id: 'v1', type: 'source', name: 'Source', value: 12, x: 1, y: 2 }] } };
    const fake = { getItem: () => JSON.stringify([legacy]), setItem: (_key: string, value: string) => writes.push(value), removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 } as unknown as Storage;
    expect(new LocalStorageAdapter(fake).load()).toEqual([legacy]);
    expect(JSON.parse(writes[0]).schemaVersion).toBe(1);
  });
  it('catches quota and privacy errors from local storage', () => {
    const failingStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 } as unknown as Storage;
    expect(() => new LocalStorageAdapter(failingStorage).save([])).toThrow(StorageError);
  });
  it('rejects malformed imports and unsupported schema versions', () => {
    expect(() => parseProjectImport({ kind: 'tayf-project', schemaVersion: 999, exportedAt: '2026-10-22T00:00:00.000Z', experiments: [] })).toThrow(StorageError);
    expect(() => parseProjectImport({ kind: 'tayf-project', schemaVersion: 1, exportedAt: '2026-10-22T00:00:00.000Z', experiments: [], unexpected: true })).toThrow(StorageError);
    expect(() => parseProjectImport([{ id: 'bad', type: 'hacker' }])).toThrow(StorageError);
  });
  it('accepts a versioned empty project export', () => { expect(parseProjectImport({ kind: 'tayf-project', schemaVersion: 1, exportedAt: '2026-10-22T00:00:00.000Z', experiments: [] })).toEqual([]); });
});
