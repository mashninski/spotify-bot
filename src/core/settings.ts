// Налады дока. Захоўваюцца ў localStorage браўзера OBS на кампутары стрымера (ADR-009).

import { DEFAULT_RULES, type RequestRules } from './rules';

/** Спецыяльнае значэнне крыніцы гуку: штучны ўзровень для праверкі без OBS. */
export const SIMULATED_AUDIO = '__simulated__';

export interface Settings {
  obs: {
    url: string;
    password: string;
    /** Падключацца аўтаматычна пры адкрыцці дока (уключаецца пасля першага ўдалага падключэння). */
    autoConnect: boolean;
  };
  /** Назва крыніцы OBS, па якой рэагуе waveline; пуста — не выбрана. */
  audioSource: string;
  rules: RequestRules;
  spotify: {
    /** Client ID прыкладання, якое стрымер стварыў у Spotify Dashboard (ADR-008, ADR-016). Не сакрэт. */
    clientId: string;
  };
  twitch: {
    /** Client ID нашага Twitch Application тыпу Public (ADR-004, ADR-018). Не сакрэт; на Этапе 5 будзе ўбудаваны. */
    clientId: string;
  };
}

export const SETTINGS_KEY = 'spotify-bot:settings:v1';

export function defaultSettings(): Settings {
  return {
    obs: { url: 'ws://127.0.0.1:4455', password: '', autoConnect: false },
    audioSource: '',
    rules: { ...DEFAULT_RULES },
    spotify: { clientId: '' },
    twitch: { clientId: '' },
  };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const pick = <T>(value: unknown, fallback: T): T => (typeof value === typeof fallback ? (value as T) : fallback);

/** Чытае налады. Сапсаваныя або адсутныя палі замяняюцца значэннямі па змаўчанні. */
export function loadSettings(storage: StorageLike | null): Settings {
  const d = defaultSettings();
  let raw: unknown;
  try {
    const text = storage?.getItem(SETTINGS_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, any>;
  const obs = typeof r.obs === 'object' && r.obs ? r.obs : {};
  const rules = typeof r.rules === 'object' && r.rules ? r.rules : {};
  const spotify = typeof r.spotify === 'object' && r.spotify ? r.spotify : {};
  const twitch = typeof r.twitch === 'object' && r.twitch ? r.twitch : {};
  return {
    obs: {
      url: pick(obs.url, d.obs.url) || d.obs.url,
      password: pick(obs.password, d.obs.password),
      autoConnect: pick(obs.autoConnect, d.obs.autoConnect),
    },
    audioSource: pick(r.audioSource, d.audioSource),
    rules: {
      price: positiveInt(rules.price, d.rules.price),
      maxDurationMin: positiveInt(rules.maxDurationMin, d.rules.maxDurationMin),
      maxPerUser: positiveInt(rules.maxPerUser, d.rules.maxPerUser),
      allowExplicit: pick(rules.allowExplicit, d.rules.allowExplicit),
    },
    spotify: {
      clientId: pick(spotify.clientId, d.spotify.clientId).trim(),
    },
    twitch: {
      clientId: pick(twitch.clientId, d.twitch.clientId).trim(),
    },
  };
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function saveSettings(storage: StorageLike | null, settings: Settings): boolean {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return Boolean(storage);
  } catch {
    return false;
  }
}

/** localStorage можа быць недаступны (забаронены або перапоўнены) — тады працуем без захавання. */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
