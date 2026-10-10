// Агульныя ключы і функцыі дыягностыкі для дока, оверлея і старонкі вяртання.

export const DIAG_MARKER_KEY = 'spotify-bot:diag:dock-marker';
export const REDIRECT_PENDING_KEY = 'spotify-bot:diag:redirect-pending';
export const REDIRECT_RESULT_KEY = 'spotify-bot:diag:redirect-result';

/** Знешні https-сэрвіс, які адразу перанакіроўвае назад (імітацыя ўваходу ў Spotify/Twitch). */
export const REDIRECT_SERVICE = 'https://httpbin.org/redirect-to';

export interface RedirectResult {
  ok: boolean;
  storageKept: boolean;
  at: number;
  via: string;
}

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

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
