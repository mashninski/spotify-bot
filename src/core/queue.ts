// Чыстыя функцыі для чаргі і плэера: атрымліваюць стан і вяртаюць новы, нічога не мяняючы на месцы.
// Так іх лёгка тэставаць, а пазней — сінхранізаваць са Spotify (ADR-007).

import type { OverlayState, OverlayTrack, PlayerState, QueueItem } from './types';

/** Колькі прайграных запісаў памятаем для «папярэдняй». */
export const HISTORY_LIMIT = 50;

/** Калі песня ідзе даўжэй за гэта, «папярэдняя» пачынае яе спачатку (як у Spotify). */
export const RESTART_THRESHOLD_MS = 3000;

export function emptyPlayerState(): PlayerState {
  return { current: null, isPlaying: false, progressMs: 0, requests: [], context: [], history: [] };
}

/** Наступныя `count` запісаў: спачатку заказы, потым кантэкст. */
export function upcoming(state: PlayerState, count: number): QueueItem[] {
  return [...state.requests, ...state.context].slice(0, count);
}

function pushHistory(history: QueueItem[], item: QueueItem | null): QueueItem[] {
  if (!item) return history;
  const next = [...history, item];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** Вяртае запіс на пачатак той чаргі, адкуль ён прыйшоў (заказ — у заказы, астатняе — у кантэкст). */
function returnToFront(state: PlayerState, item: QueueItem): Pick<PlayerState, 'requests' | 'context'> {
  return item.requestedBy
    ? { requests: [item, ...state.requests], context: state.context }
    : { requests: state.requests, context: [item, ...state.context] };
}

export function togglePlay(state: PlayerState): PlayerState {
  if (!state.current) return state;
  return { ...state, isPlaying: !state.isPlaying };
}

/** «Наступная»: першы заказ, а калі заказаў няма — першы трэк кантэксту. */
export function skipNext(state: PlayerState): PlayerState {
  const history = pushHistory(state.history, state.current);
  const [nextRequest, ...requests] = state.requests;
  if (nextRequest) {
    return { ...state, current: nextRequest, requests, history, progressMs: 0 };
  }
  const [nextContext, ...context] = state.context;
  if (nextContext) {
    return { ...state, current: nextContext, context, history, progressMs: 0 };
  }
  return { ...state, current: null, isPlaying: false, history, progressMs: 0 };
}

/** «Папярэдняя»: калі песня ідзе больш за 3 с — пачаць яе нанова, інакш вярнуць папярэднюю. */
export function skipPrevious(state: PlayerState): PlayerState {
  if (state.current && state.progressMs > RESTART_THRESHOLD_MS) {
    return { ...state, progressMs: 0 };
  }
  const previous = state.history[state.history.length - 1];
  if (!previous) return { ...state, progressMs: 0 };
  const history = state.history.slice(0, -1);
  const queues = state.current ? returnToFront(state, state.current) : { requests: state.requests, context: state.context };
  return { ...state, ...queues, current: previous, history, progressMs: 0 };
}

/** Выдаліць заказ з чаргі. Астатнія застаюцца ў тым жа парадку. */
export function removeRequest(state: PlayerState, key: string): PlayerState {
  if (!state.requests.some((r) => r.key === key)) return state;
  return { ...state, requests: state.requests.filter((r) => r.key !== key) };
}

/** «Прайграць зараз»: заказ адразу становіцца бягучым, астатняя чарга захоўвае парадак. */
export function playNow(state: PlayerState, key: string): PlayerState {
  const item = state.requests.find((r) => r.key === key);
  if (!item) return state;
  return {
    ...state,
    current: item,
    isPlaying: true,
    progressMs: 0,
    requests: state.requests.filter((r) => r.key !== key),
    history: pushHistory(state.history, state.current),
  };
}

/** Дадаць заказ у канец чаргі. Калі нічога не грае — ён адразу становіцца бягучым. */
export function addRequest(state: PlayerState, item: QueueItem): PlayerState {
  if (!state.current) {
    return { ...state, current: item, isPlaying: true, progressMs: 0 };
  }
  return { ...state, requests: [...state.requests, item] };
}

/** Дадаць трэкі ў канец кантэксту (напрыклад, калі крыніца аддала наступныя трэкі плэйліста). */
export function appendContext(state: PlayerState, items: QueueItem[]): PlayerState {
  if (items.length === 0) return state;
  return { ...state, context: [...state.context, ...items] };
}

/**
 * Ход часу, калі песні мяняе сам Spotify (ADR-016): толькі прасоўвае час паміж апытаннямі
 * і спыняецца ў канцы песні — наступную песню скажа Spotify.
 */
export function advanceProgress(state: PlayerState, deltaMs: number): PlayerState {
  if (!state.isPlaying || !state.current || deltaMs <= 0) return state;
  const progressMs = Math.min(state.progressMs + deltaMs, state.current.track.durationMs);
  return progressMs === state.progressMs ? state : { ...state, progressMs };
}

/** Ход часу: прасоўвае песню, а калі яна скончылася — пераходзіць да наступнай. */
export function tick(state: PlayerState, deltaMs: number): PlayerState {
  if (!state.isPlaying || !state.current || deltaMs <= 0) return state;
  const progressMs = state.progressMs + deltaMs;
  if (progressMs < state.current.track.durationMs) return { ...state, progressMs };
  const overflow = progressMs - state.current.track.durationMs;
  const next = skipNext(state);
  return next.current ? { ...next, progressMs: Math.min(overflow, next.current.track.durationMs) } : next;
}

function toOverlayTrack(item: QueueItem): OverlayTrack {
  const t: OverlayTrack = { key: item.key, title: item.track.title, artist: item.track.artist };
  if (item.requestedBy) t.requestedBy = item.requestedBy;
  if (item.track.source === 'youtube') t.source = 'youtube';
  return t;
}

/** Колькі наступных паказвае оверлэй (ADR-020: 5 замест 3). */
export const OVERLAY_UPCOMING = 5;

/** Мінімальны стан для оверлея: бягучая песня і 5 наступных. */
export function toOverlayState(state: PlayerState, upcomingCount = OVERLAY_UPCOMING): OverlayState {
  return {
    current: state.current ? toOverlayTrack(state.current) : null,
    isPlaying: state.isPlaying,
    upcoming: upcoming(state, upcomingCount).map(toOverlayTrack),
  };
}
