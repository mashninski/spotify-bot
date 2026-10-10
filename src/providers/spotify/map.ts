// Пераўтварэнне адказаў Spotify Web API ў нашы тыпы (ADR-016). Чыстыя функцыі — лёгка тэставаць.

import type { PlayerState, Track } from '../../core/types';

/** Тое, што бот ведае пра плэер Spotify пасля аднаго апытання. */
export interface SpotifyPlayback {
  isPlaying: boolean;
  progressMs: number;
  /** `null` — нічога не грае або грае рэклама. */
  track: Track | null;
  /** Назва прылады, на якой адкрыты Spotify. */
  device: string;
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Трэк або эпізод падкаста. Лакальныя файлы таксама падтрымліваюцца (у іх няма id). */
export function parseItem(raw: unknown): Track | null {
  if (!isObject(raw) || typeof raw.uri !== 'string' || typeof raw.name !== 'string') return null;
  const artist =
    raw.type === 'episode'
      ? isObject(raw.show) && typeof raw.show.name === 'string'
        ? raw.show.name
        : ''
      : Array.isArray(raw.artists)
        ? raw.artists
            .map((a: unknown) => (isObject(a) && typeof a.name === 'string' ? a.name : ''))
            .filter(Boolean)
            .join(', ')
        : '';
  const durationMs = typeof raw.duration_ms === 'number' && raw.duration_ms > 0 ? raw.duration_ms : 1;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : raw.uri,
    title: raw.name,
    artist,
    durationMs,
    explicit: raw.explicit === true,
    uri: raw.uri,
  };
}

/** Адказ `GET /me/player`. `null` (204, Spotify нідзе не адкрыты) — `null`. */
export function parsePlayback(raw: unknown): SpotifyPlayback | null {
  if (!isObject(raw)) return null;
  const track = raw.currently_playing_type === 'ad' ? null : parseItem(raw.item);
  const progress = typeof raw.progress_ms === 'number' && raw.progress_ms >= 0 ? raw.progress_ms : 0;
  return {
    isPlaying: raw.is_playing === true && track !== null,
    progressMs: track ? Math.min(progress, track.durationMs) : 0,
    track,
    device: isObject(raw.device) && typeof raw.device.name === 'string' ? raw.device.name : '',
  };
}

/** Адказ `GET /me/player/queue`: наступныя трэкі (без бягучага). */
export function parseQueue(raw: unknown): Track[] {
  if (!isObject(raw) || !Array.isArray(raw.queue)) return [];
  return raw.queue.map(parseItem).filter((t): t is Track => t !== null);
}

/** Ці можна дадаць трэк у «Любімыя трэкі» (лакальныя файлы — нельга). */
export function canSave(track: Track | null | undefined): boolean {
  return Boolean(track?.uri && /^spotify:(track|episode):/.test(track.uri));
}

/** Колькі наступных трэкаў з чаргі Spotify трымаем (оверлей паказвае 3, док — 5). */
export const CONTEXT_LIMIT = 10;

/**
 * Пераносіць вынік апытання Spotify у стан плэера. Заказы гледачоў (`requests`) не кранае.
 * `queue: null` — чарга не перачытвалася: калі песня змянілася на першую з чаргі, яна проста здымаецца з чаргі.
 */
export function applyPlayback(state: PlayerState, playback: SpotifyPlayback | null, queue: Track[] | null): PlayerState {
  const track = playback?.track ?? null;
  if (!playback || !track) {
    return { ...state, current: null, isPlaying: false, progressMs: 0, context: queue ? [] : state.context };
  }
  const same = state.current?.track.uri === track.uri;
  const current = same && state.current ? { ...state.current, track } : { key: `sp:${track.uri}`, track };
  let context = state.context;
  if (queue) context = queue.slice(0, CONTEXT_LIMIT).map((t, i) => ({ key: `sp:${t.uri}:${i}`, track: t }));
  else if (!same && context[0]?.track.uri === track.uri) context = context.slice(1);
  return { ...state, current, isPlaying: playback.isPlaying, progressMs: playback.progressMs, context };
}
