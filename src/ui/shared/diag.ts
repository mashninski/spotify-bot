// Агульныя ключы і функцыі дыягностыкі для дока і debug-оверлэя.

/** Док адзначае, што ён загрузіўся: debug-оверлэй па гэтай адзнацы бачыць, ці агульны ў іх localStorage. */
export const DIAG_MARKER_KEY = 'spotify-bot:diag:dock-marker';

export function readJson<T>(storage: Storage | null, key: string): T | null {
  try {
    const text = storage?.getItem(key);
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(storage: Storage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Без localStorage дыягностыка проста не захоўваецца.
  }
}

/** Ці адкрыта старонка ўнутры OBS (obs-browser дадае `window.obsstudio`). */
export function obsBrowserInfo(): { inObs: boolean; version: string } {
  const info = (window as unknown as { obsstudio?: { pluginVersion?: string } }).obsstudio;
  return { inObs: Boolean(info), version: info?.pluginVersion ?? '' };
}

export { randomId } from '../../core/id';
