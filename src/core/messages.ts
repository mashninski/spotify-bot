// Пратакол паведамленняў док → оверлей.
// Адно і тое ж паведамленне можа прыйсці некалькімі каналамі (obs-browser, BroadcastChannel, CustomEvent),
// таму ў кожным ёсць ідэнтыфікатар сесіі дока (`sid`) і нумар (`seq`) — паўторы адкідаюцца.

import type { OverlayState, OverlayTrack } from './types';

/** Назва падзеі для obs-browser `emit_event` і назва BroadcastChannel. */
export const CHANNEL_NAME = 'spotify-bot';
export const PROTOCOL_VERSION = 1;

export type OverlayMessage =
  | { type: 'state'; state: OverlayState }
  /** Узровень гуку 0…1 для waveline. */
  | { type: 'level'; level: number }
  /** Сігнал «док жывы» з часам дока (для дыягностыкі схаванага дока). */
  | { type: 'ping'; at: number };

export interface Envelope {
  app: typeof CHANNEL_NAME;
  v: typeof PROTOCOL_VERSION;
  sid: string;
  seq: number;
  msg: OverlayMessage;
}

export function createEnvelopeFactory(sid: string): (msg: OverlayMessage) => Envelope {
  let seq = 0;
  return (msg) => ({ app: CHANNEL_NAME, v: PROTOCOL_VERSION, sid, seq: ++seq, msg });
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isString = (x: unknown): x is string => typeof x === 'string';

function parseTrack(raw: unknown): OverlayTrack | null {
  if (!isObject(raw) || !isString(raw.key) || !isString(raw.title) || !isString(raw.artist)) return null;
  const t: OverlayTrack = { key: raw.key, title: raw.title, artist: raw.artist };
  if (isString(raw.requestedBy) && raw.requestedBy) t.requestedBy = raw.requestedBy;
  return t;
}

/**
 * Правярае і чытае стан. Цярпімы да пераўтварэнняў OBS: пры перадачы праз obs-browser даныя праходзяць
 * праз `obs_data`, які губляе `null` (поле знікае), таму адсутнае `current` — гэта «нічога не грае».
 */
function parseState(raw: unknown): OverlayState | null {
  if (!isObject(raw)) return null;
  const upcomingRaw = Array.isArray(raw.upcoming) ? raw.upcoming : [];
  return {
    current: raw.current === undefined || raw.current === null ? null : parseTrack(raw.current),
    isPlaying: raw.isPlaying === true,
    upcoming: upcomingRaw.map(parseTrack).filter((t): t is OverlayTrack => t !== null),
  };
}

function parseMessage(raw: unknown): OverlayMessage | null {
  if (!isObject(raw)) return null;
  switch (raw.type) {
    case 'state': {
      const state = parseState(raw.state);
      return state ? { type: 'state', state } : null;
    }
    case 'level':
      return typeof raw.level === 'number' && Number.isFinite(raw.level)
        ? { type: 'level', level: Math.min(1, Math.max(0, raw.level)) }
        : null;
    case 'ping':
      return typeof raw.at === 'number' ? { type: 'ping', at: raw.at } : null;
    default:
      return null;
  }
}

/** Чытае паведамленне з любога канала. Вяртае `null`, калі гэта не наша паведамленне ці яно сапсаванае. */
export function parseEnvelope(raw: unknown): Envelope | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isObject(value) || value.app !== CHANNEL_NAME || value.v !== PROTOCOL_VERSION) return null;
  if (!isString(value.sid) || typeof value.seq !== 'number') return null;
  const msg = parseMessage(value.msg);
  return msg ? { app: CHANNEL_NAME, v: PROTOCOL_VERSION, sid: value.sid, seq: value.seq, msg } : null;
}

/** Адкідае паўторы. Новы `sid` (док перазагрузіўся) пачынае адлік нанова. */
export class Deduper {
  private sid = '';
  private lastSeq = 0;

  accept(env: Envelope): boolean {
    if (env.sid !== this.sid) {
      this.sid = env.sid;
      this.lastSeq = env.seq;
      return true;
    }
    if (env.seq <= this.lastSeq) return false;
    this.lastSeq = env.seq;
    return true;
  }
}
