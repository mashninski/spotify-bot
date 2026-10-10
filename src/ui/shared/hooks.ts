import { useEffect, useState } from 'preact/hooks';
import type { Store } from '../../core/store';

/** Падпіска кампанента на сховішча: перамалёўка пры кожнай змене. */
export function useStore<T>(store: Store<T>): T {
  const [value, setValue] = useState(store.get);
  useEffect(() => {
    setValue(store.get());
    return store.subscribe(setValue);
  }, [store]);
  return value;
}

/** Бягучы час, які абнаўляецца з зададзеным інтэрвалам (для «N с таму»). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
