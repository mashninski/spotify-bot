// Заказы гледачоў і чарга Spotify (ADR-007, ADR-017). Чыстыя функцыі: атрымліваюць стан і вяртаюць новы.
// Наша чарга заказаў — галоўная. У Spotify трапляе толькі першы заказ і толькі незадоўга да канца бягучай песні:
// з чаргі Spotify нічога нельга выдаліць або пераставіць, а так «выдаліць» і «прайграць зараз» застаюцца ў нас.

import { HISTORY_LIMIT } from './queue';
import type { PlayerState, QueueItem } from './types';

/** За колькі да канца бягучай песні адпраўляць наступны заказ у Spotify. */
export const SEND_BEFORE_MS = 15_000;
/** Колькі чакаць пасля адпраўкі, перш чым лічыць, што заказ знік з чаргі Spotify (Spotify паказвае яго не адразу). */
export const LOST_GRACE_MS = 10_000;

/** Запіс без адзнакі адпраўкі (калі ён стаў бягучым або яго трэба адправіць нанова). */
export function withoutSent(item: QueueItem): QueueItem {
  if (item.sentAt === undefined) return item;
  const { sentAt: _, ...rest } = item;
  return rest;
}

/** Новы заказ — у канец нашай чаргі. Бягучай песняй ён не становіцца: песні мяняе Spotify. */
export function appendRequest(state: PlayerState, item: QueueItem): PlayerState {
  return { ...state, requests: [...state.requests, item] };
}

/** Заказ, які пара адправіць у Spotify: першы ў чарзе, яшчэ не адпраўлены, а песня ў Spotify хутка скончыцца. */
export function requestToSend(state: PlayerState): QueueItem | null {
  const first = state.requests[0];
  if (!first?.track.uri || first.sentAt !== undefined || !state.current?.track.uri || !state.isPlaying) return null;
  return state.current.track.durationMs - state.progressMs <= SEND_BEFORE_MS ? first : null;
}

/** Адзначыць заказ адпраўленым — да самога запыту, каб новы лідар не адправіў яго другі раз. */
export function markSent(state: PlayerState, key: string, at: number): PlayerState {
  if (!state.requests.some((r) => r.key === key)) return state;
  return { ...state, requests: state.requests.map((r) => (r.key === key ? { ...r, sentAt: at } : r)) };
}

/** Spotify не прыняў заказ — зняць адзнаку (толькі тую, што паставілі для гэтага запыту). */
export function unmarkSent(state: PlayerState, key: string, at: number): PlayerState {
  if (!state.requests.some((r) => r.key === key && r.sentAt === at)) return state;
  return { ...state, requests: state.requests.map((r) => (r.key === key ? withoutSent(r) : r)) };
}

/**
 * Заказ пачынае граць зараз («прайграць зараз» або «Наступная», калі першы заказ ужо ў Spotify).
 * Астатнія заказы захоўваюць парадак. Адзнака адпраўкі з іх здымаецца: бот пройдзе праз іх у Spotify
 * па дарозе да патрэбнага, таму іх трэба будзе адправіць нанова.
 */
export function startRequest(state: PlayerState, key: string): PlayerState {
  const item = state.requests.find((r) => r.key === key);
  if (!item) return state;
  const history = state.current ? [...state.history, state.current].slice(-HISTORY_LIMIT) : state.history;
  return {
    ...state,
    current: withoutSent(item),
    isPlaying: true,
    progressMs: 0,
    requests: state.requests.filter((r) => r.key !== key).map(withoutSent),
    history,
  };
}

/** Колькі разоў націснуць «наступная» ў Spotify пасля дадання заказу ў чаргу, каб ён зайграў. */
export function skipsToReach(state: PlayerState, key: string): number {
  const first = state.requests[0];
  return first && first.key !== key && first.sentAt !== undefined ? 2 : 1;
}

/**
 * Выдаліць заказ. Калі ён ужо ў чарзе Spotify (адтуль выдаліць нельга) — запомніць яго:
 * калі ён пачне граць, бот адразу пераключыць на наступную.
 */
export function removeRequest(state: PlayerState, key: string): PlayerState {
  const item = state.requests.find((r) => r.key === key);
  if (!item) return state;
  const requests = state.requests.filter((r) => r.key !== key);
  if (item.sentAt !== undefined && item.track.uri) return { ...state, requests, skip: { uri: item.track.uri, at: item.sentAt } };
  return { ...state, requests };
}

/**
 * Зверка з чаргой Spotify пасля яе чытання (`queueUris` — «Далей у чарзе» Spotify, `playingUri` — што грае).
 * - Адпраўлены заказ знік з чаргі Spotify і не грае (Spotify перазапусцілі, чаргу ачысцілі) — адправім нанова.
 *   Заказ за баллы лепш прайграць другі раз, чым згубіць.
 * - Неадпраўлены першы заказ ужо першы ў чарзе Spotify (Spotify аднавіў чаргу пасля перазапуску, або
 *   лідар паспеў адправіць, але не паспеў захаваць адзнаку) — лічым адпраўленым, каб не задвоіць.
 * - Выдалены адпраўлены заказ знік з чаргі і не грае — забываем пра яго.
 */
export function reconcileQueue(state: PlayerState, playingUri: string, queueUris: string[], now: number): PlayerState {
  let requests = state.requests;
  let skip = state.skip ?? null;
  const first = requests[0];
  if (first?.track.uri) {
    const uri = first.track.uri;
    if (first.sentAt !== undefined) {
      if (!queueUris.includes(uri) && playingUri !== uri && now - first.sentAt >= LOST_GRACE_MS) {
        requests = [withoutSent(first), ...requests.slice(1)];
      }
    } else if (queueUris[0] === uri) {
      requests = [{ ...first, sentAt: now }, ...requests.slice(1)];
    }
  }
  if (skip && !queueUris.includes(skip.uri) && playingUri !== skip.uri && now - skip.at >= LOST_GRACE_MS) skip = null;
  return requests === state.requests && skip === (state.skip ?? null) ? state : { ...state, requests, skip };
}

/** Схаваць з «Далей у Spotify» адпраўлены заказ і выдалены заказ: першы ўжо паказаны ў заказах з нікам, другі бот прапусціць. */
export function hideSent<T extends { track: { uri?: string } }>(context: T[], state: Pick<PlayerState, 'requests' | 'skip'>): T[] {
  const hidden = state.requests.filter((r) => r.sentAt !== undefined && r.track.uri).map((r) => r.track.uri!);
  if (state.skip) hidden.push(state.skip.uri);
  if (hidden.length === 0) return context;
  return context.filter((item) => {
    const i = item.track.uri ? hidden.indexOf(item.track.uri) : -1;
    if (i < 0) return true;
    hidden.splice(i, 1); // хаваем толькі адзін раз: тая ж песня можа быць і ў плэйлісце далей
    return false;
  });
}
