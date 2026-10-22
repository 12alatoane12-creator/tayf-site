import type { CircuitComponent, CircuitModel, CircuitResult, CircuitWire, TerminalRef } from '../engine/circuit.js';
import type { ChemicalDefinition, LibraryItem } from '../data/catalog.js';

export type ProjectView = 'home' | 'physics' | 'chemistry' | 'saved';
export type EditorTool = 'select' | 'wire' | 'place';
export type ProjectChemical = ChemicalDefinition & { moles: number; volume: number };

/** Serializable project/UI state. DOM elements and calculation logic are deliberately excluded. */
export interface ProjectState {
  schemaVersion: 1;
  stateId: string;
  view: ProjectView;
  theme: 'dark' | 'light';
  components: CircuitComponent[];
  selected: string | null;
  tool: EditorTool;
  wireStart: TerminalRef | null;
  wires: CircuitWire[];
  referenceTerminal: string;
  chemicals: ProjectChemical[];
  chemistryMode: 'auto' | 'acidbase' | 'precipitation' | 'dilution';
  chemistryTemperatureInput: string;
  chemistrySampleVolumeInput: string;
  chemistryFinalVolumeInput: string;
  chemFilter: string;
  lastCircuit: CircuitResult | null;
  lastChem: Record<string, unknown> | null;
  pendingSave: 'physics' | 'chemistry' | null;
  pendingComponent: LibraryItem | null;
  storageError: string | null;
}

export function createStateId(): string {
  return `state-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createProjectState(initialModel: CircuitModel): ProjectState {
  return {
    schemaVersion: 1,
    stateId: createStateId(),
    view: 'home',
    theme: 'dark',
    components: structuredClone(initialModel.components),
    selected: initialModel.components[0]?.id ?? null,
    tool: 'select',
    wireStart: null,
    wires: structuredClone(initialModel.wires),
    referenceTerminal: initialModel.referenceTerminal,
    chemicals: [],
    chemistryMode: 'auto',
    chemistryTemperatureInput: '25',
    chemistrySampleVolumeInput: '25',
    chemistryFinalVolumeInput: '100',
    chemFilter: 'all',
    lastCircuit: null,
    lastChem: null,
    pendingSave: null,
    pendingComponent: null,
    storageError: null,
  };
}
