// Пераўтварэнне адказаў Spotify Web API ў нашы тыпы (ADR-016). Чыстыя функцыі — лёгка тэставаць.

import { HISTORY_LIMIT, RESTART_THRESHOLD_MS } from '../../core/queue';
import { hideSent, reconcileQueue, withoutSent } from '../../core/requests';
import type { PlayerState, QueueItem, Track } from '../../core/types';

/** Тое, што бот ведае пра плэер Spotify пасля аднаго апытання. */
export interface SpotifyPlayback {
  isPlaying: boolean;
  progressMs: number;
  /** `null` — нічога не грае або грае рэклама. */
  track: Track | null;
  /** Назва прылады, на якой адкрыты Spotify. */
  device: string;
  /** Гучнасць прылады 0…100 (`null` — невядома). */
  volume: number | null;
  /** Ці дазваляе прылада мяняць гучнасць праз API. */
  supportsVolume: boolean;
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
  const device = isObject(raw.device) ? raw.device : {};
  const volume = typeof device.volume_percent === 'number' ? Math.max(0, Math.min(100, Math.round(device.volume_percent))) : null;
  return {
    isPlaying: raw.is_playing === true && track !== null,
    progressMs: track ? Math.min(progress, track.durationMs) : 0,
    track,
    device: typeof device.name === 'string' ? device.name : '',
    volume,
    supportsVolume: volume !== null && device.supports_volume !== false,
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
 * Пераносіць вынік апытання Spotify у стан плэера.
 * `queue: null` — чарга не перачытвалася: калі песня змянілася на першую з чаргі, яна проста здымаецца з чаргі.
 * Заказы гледачоў (ADR-017): калі зайграў адпраўлены ў Spotify заказ, ён становіцца бягучым з нікам гледача;
 * у «Далей у Spotify» ён не паказваецца другі раз; пасля чытання чаргі — зверка (`reconcileQueue`).
 */
export function applyPlayback(
  state: PlayerState,
  playback: SpotifyPlayback | null,
  queue: Track[] | null,
  now = Date.now(),
): PlayerState {
  const track = playback?.track ?? null;
  if (!playback || !track) {
    return { ...state, current: null, isPlaying: false, progressMs: 0, context: queue ? [] : state.context };
  }
  const same = state.current?.track.uri === track.uri;
  let requests = state.requests;
  let current: QueueItem;
  if (same && state.current) current = { ...state.current, track };
  else if (requests[0]?.sentAt !== undefined && requests[0].track.uri === track.uri) {
    current = { ...withoutSent(requests[0]), track };
    requests = requests.slice(1);
  } else current = { key: `sp:${track.uri}`, track };
  let context = state.context;
  if (!queue && !same && context[0]?.track.uri === track.uri) context = context.slice(1);
  // Прайграныя песні патрэбны, каб «Папярэдняя» паказала вынік адразу, яшчэ да адказу Spotify.
  let history = state.history;
  if (!same && state.current) history = [...history, state.current].slice(-HISTORY_LIMIT);
  const next = { ...state, current, isPlaying: playback.isPlaying, progressMs: playback.progressMs, context, history, requests };
  if (!queue) return next;
  const checked = reconcileQueue(next, track.uri ?? '', queue.map((t) => t.uri ?? ''), now);
  return { ...checked, context: hideSent(contextItems(queue), checked).slice(0, CONTEXT_LIMIT) };
}

/**
 * Ключы трэкаў чаргі не залежаць ад месца ў чарзе: калі чарга зрушылася на адну песню,
 * астатнія застаюцца тымі ж элементамі (без лішняй анімацыі ў доку і оверлеі).
 */
function contextItems(tracks: Track[]): QueueItem[] {
  const seen = new Map<string, number>();
  return tracks.map((t) => {
    const id = t.uri ?? t.id;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return { key: `sp:${id}#${n}`, track: t };
  });
}

/**
 * Што паказаць адразу пасля кнопкі, не чакаючы Spotify. «Наступная» — першая песня з чаргі;
 * «Папярэдняя» — як у Spotify: пасля 3 с песня пачынаецца нанова, інакш — папярэдняя з гісторыі.
 * Адказ Spotify праз долі секунды пацвердзіць або выправіць гэта.
 */
export function optimisticSkip(state: PlayerState, direction: 'next' | 'previous'): PlayerState {
  if (direction === 'next') {
    // «Наступная» з заказамі робіць мозг: першы заказ пачынае граць (`startRequest`).
    const [next, ...context] = state.context;
    if (!next) return state;
    const history = state.current ? [...state.history, state.current].slice(-HISTORY_LIMIT) : state.history;
    return { ...state, current: next, context, history, progressMs: 0 };
  }
  if (state.current && state.progressMs > RESTART_THRESHOLD_MS) return { ...state, progressMs: 0 };
  const previous = state.history[state.history.length - 1];
  if (!previous) return { ...state, progressMs: 0 };
  return {
    ...state,
    current: previous,
    history: state.history.slice(0, -1),
    context: state.current ? [state.current, ...state.context] : state.context,
    progressMs: 0,
  };
}
