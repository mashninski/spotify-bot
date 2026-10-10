// Захаванне стану плэера і чаргі ў localStorage (ADR-015): новы лідар працягвае з таго ж месца,
// дзе спыніўся папярэдні (док зачынены, оверлей перазагружаны, OBS перазапушчаны).

import * as q from '../core/queue';
import type { PlayerState, QueueItem, Track } from '../core/types';

export const PLAYER_KEY = 'spotify-bot:player:v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

interface Persisted {
  savedAt: number;
  state: PlayerState;
}

export function savePlayer(storage: StorageLike | null, state: PlayerState, now = Date.now()): boolean {
  try {
    storage?.setItem(PLAYER_KEY, JSON.stringify({ savedAt: now, state } satisfies Persisted));
    return Boolean(storage);
  } catch {
    return false;
  }
}

/**
 * Чытае захаваны стан. Калі песня грала, прасоўвае яе на час, які прайшоў з моманту захавання.
 * Сапсаваныя даныя — `null` (тады лідар пачынае з пачатку).
 */
export function loadPlayer(storage: StorageLike | null, now = Date.now()): PlayerState | null {
  let raw: unknown;
  try {
    const text = storage?.getItem(PLAYER_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (!isObject(raw) || typeof raw.savedAt !== 'number') return null;
  const state = parseState(raw.state);
  if (!state) return null;
  return q.tick(state, Math.max(0, now - raw.savedAt));
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

function parseTrack(raw: unknown): Track | null {
  if (!isObject(raw)) return null;
  const { id, title, artist, durationMs, explicit } = raw;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof artist !== 'string') return null;
  if (typeof durationMs !== 'number' || !(durationMs > 0) || typeof explicit !== 'boolean') return null;
  return { id, title, artist, durationMs, explicit };
}

function parseItem(raw: unknown): QueueItem | null {
  if (!isObject(raw) || typeof raw.key !== 'string') return null;
  const track = parseTrack(raw.track);
  if (!track) return null;
  return typeof raw.requestedBy === 'string' && raw.requestedBy
    ? { key: raw.key, track, requestedBy: raw.requestedBy }
    : { key: raw.key, track };
}

function parseItems(raw: unknown): QueueItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw.map(parseItem);
  return items.every((i): i is QueueItem => i !== null) ? items : null;
}

function parseState(raw: unknown): PlayerState | null {
  if (!isObject(raw)) return null;
  const current = raw.current === null ? null : parseItem(raw.current);
  if (raw.current !== null && !current) return null;
  const requests = parseItems(raw.requests);
  const context = parseItems(raw.context);
  const history = parseItems(raw.history);
  if (!requests || !context || !history) return null;
  const progressMs = typeof raw.progressMs === 'number' && raw.progressMs >= 0 ? raw.progressMs : 0;
  return { current, isPlaying: raw.isPlaying === true && current !== null, progressMs, requests, context, history };
}
