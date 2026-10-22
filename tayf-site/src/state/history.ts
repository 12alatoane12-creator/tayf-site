export interface VersionedSnapshot<T> { id: string; value: T }
export interface History<T> {
  commit(value: T): void;
  undo(current: T): T | null;
  redo(current: T): T | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(initial?: T): void;
}

const clone = <T>(value: T): T => structuredClone(value);
const snapshot = <T>(value: T): VersionedSnapshot<T> => ({ id: `state-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, value: clone(value) });

export function createHistory<T>(initial: T, limit = 100): History<T> {
  const past: VersionedSnapshot<T>[] = [snapshot(initial)];
  const future: VersionedSnapshot<T>[] = [];
  return {
    commit(value) {
      past.push(snapshot(value));
      if (past.length > limit) past.shift();
      future.length = 0;
    },
    undo(current) {
      if (past.length <= 1) return null;
      future.push(snapshot(current));
      past.pop();
      return clone(past[past.length - 1].value);
    },
    redo(_current) {
      const next = future.pop();
      if (!next) return null;
      past.push(snapshot(next.value));
      return clone(next.value);
    },
    canUndo: () => past.length > 1,
    canRedo: () => future.length > 0,
    clear(initialValue) { past.length = 0; future.length = 0; if (initialValue !== undefined) past.push(snapshot(initialValue)); },
  };
}
