// Захаванне стану плэера і чаргі ў localStorage (ADR-015): новы лідар працягвае з таго ж месца,
// дзе спыніўся папярэдні (док зачынены, оверлей перазагружаны, OBS перазапушчаны).

import * as q from '../core/queue';
import type { PlayerState, QueueItem, SpotifyResume, Track, VideoState } from '../core/types';

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
  // Песні са Spotify мяняе сам Spotify (ADR-016), відэа — плэер оверлэя (ADR-020): толькі прасоўваем час.
  const advance = state.current?.track.uri || state.current?.track.source === 'youtube' ? q.advanceProgress : q.tick;
  return advance(state, Math.max(0, now - raw.savedAt));
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

function parseTrack(raw: unknown): Track | null {
  if (!isObject(raw)) return null;
  const { id, title, artist, durationMs, explicit } = raw;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof artist !== 'string') return null;
  if (typeof durationMs !== 'number' || !(durationMs > 0) || typeof explicit !== 'boolean') return null;
  const track: Track = { id, title, artist, durationMs, explicit };
  if (typeof raw.uri === 'string' && raw.uri) track.uri = raw.uri;
  // Відэа YouTube (ADR-020).
  if (raw.source === 'youtube' && typeof raw.videoId === 'string' && raw.videoId) {
    track.source = 'youtube';
    track.videoId = raw.videoId;
  }
  return track;
}

const RESUMES: SpotifyResume[] = ['next', 'restart', 'none'];

function parseVideo(raw: unknown, current: QueueItem | null): VideoState | null {
  if (!isObject(raw) || typeof raw.key !== 'string' || current?.key !== raw.key || current.track.source !== 'youtube') return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    key: raw.key,
    resume: RESUMES.includes(raw.resume) ? raw.resume : 'next',
    startedAt: num(raw.startedAt),
    reportAt: num(raw.reportAt),
    seek: num(raw.seek),
    spotifyPaused: raw.spotifyPaused === true,
    started: raw.started === true,
  };
}

function parseItem(raw: unknown): QueueItem | null {
  if (!isObject(raw) || typeof raw.key !== 'string') return null;
  const track = parseTrack(raw.track);
  if (!track) return null;
  const item: QueueItem = { key: raw.key, track };
  if (typeof raw.requestedBy === 'string' && raw.requestedBy) item.requestedBy = raw.requestedBy;
  // Адзнака «ужо ў Spotify» (ADR-017): без яе новы лідар адправіў бы заказ другі раз.
  if (typeof raw.sentAt === 'number' && Number.isFinite(raw.sentAt)) item.sentAt = raw.sentAt;
  // Сувязь з заказам Twitch (ADR-018): без яе новы лідар не ведаў бы, каму вярнуць баллы.
  if (typeof raw.redemptionId === 'string' && raw.redemptionId) item.redemptionId = raw.redemptionId;
  return item;
}

function parseSkip(raw: unknown): PlayerState['skip'] {
  return isObject(raw) && typeof raw.uri === 'string' && raw.uri && typeof raw.at === 'number' ? { uri: raw.uri, at: raw.at } : null;
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
  const skip = parseSkip(raw.skip);
  const video = parseVideo(raw.video, current);
  return {
    current,
    isPlaying: raw.isPlaying === true && current !== null,
    progressMs,
    requests,
    context,
    history,
    ...(skip ? { skip } : {}),
    ...(video ? { video } : {}),
  };
}
