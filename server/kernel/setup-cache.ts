import { AsyncLocalStorage } from "node:async_hooks";

// The company's setup (People, the time zone, every current capability file) read once per withWorkspace call
// instead of once per kernel function: a table page asked for it 6–7 times, the morning job 200 times (M12,
// docs/kernel-study.md). Forgotten whenever the setup may have changed: right after a write to capabilities,
// People or the workspace, on every Audit entry, and when a savepoint fails (its changes are gone).
type Store = { loaded?: Promise<unknown> };
const store = new AsyncLocalStorage<Store>();

export const withSetupCache = <T>(fn: () => Promise<T>): Promise<T> => store.run({}, fn);

export function forgetSetup(): void {
  const s = store.getStore();
  if (s) s.loaded = undefined;
}

export function cachedSetup<T>(read: () => Promise<T>): Promise<T> {
  const s = store.getStore();
  if (!s) return read();
  if (!s.loaded) {
    const p = read();
    s.loaded = p;
    p.catch(() => (s.loaded === p ? (s.loaded = undefined) : undefined));
  }
  return s.loaded as Promise<T>;
}
