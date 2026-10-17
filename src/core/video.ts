// Відэа YouTube у агульнай чарзе (ADR-020). Чыстыя функцыі: атрымліваюць стан і вяртаюць новы.
// Відэа грае ў оверлэі (плэер паведамляе лідару пра ход), Spotify у гэты час на паўзе.

import { HISTORY_LIMIT } from './queue';
import { withoutSent } from './requests';
import { isVideo, type PlayerState, type QueueItem, type SpotifyResume } from './types';

/** За колькі да канца песні ў Spotify ставіць паўзу і пачынаць відэа (апошнія долі секунды песні — звычайна цішыня). */
export const VIDEO_SWITCH_BEFORE_MS = 1200;
/** Плэер оверлэя так доўга маўчыць — відэа паказаць не атрымалася (оверлэя няма, плэер упаў). */
export const PLAYER_SILENCE_MS = 12_000;
/**
 * Плэер жывы, але відэа так доўга не пачынаецца (YouTube не аддае відэа, браўзер не дае ўключыць) — паказаць не атрымалася.
 * З запасам на рэкламу перад відэа, падчас якой час відэа не ідзе.
 */
export const VIDEO_START_TIMEOUT_MS = 60_000;

/** Што паведамляе плэер оверлэя. */
export type VideoPlayerState = 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error' | 'idle';

export interface VideoReport {
  /** Ключ запісу чаргі (`''` для `idle` — плэер жывы, але нічога не паказвае). */
  key: string;
  state: VideoPlayerState;
  positionMs: number;
  /** Код памылкі YouTube (для `error`). */
  code?: number;
}

/** Бягучае відэа, калі яно ёсць. */
export function currentVideo(state: PlayerState): QueueItem | null {
  return state.current && isVideo(state.current.track) && state.video?.key === state.current.key ? state.current : null;
}

/** Відэа, якое пара пачаць: першае ў чарзе — відэа, а песня ў Spotify вось-вось скончыцца. */
export function videoToStart(state: PlayerState): QueueItem | null {
  const first = state.requests[0];
  if (!first || !isVideo(first.track) || currentVideo(state)) return null;
  if (!state.current?.track.uri || !state.isPlaying) return null;
  return state.current.track.durationMs - state.progressMs <= VIDEO_SWITCH_BEFORE_MS ? first : null;
}

/**
 * Spotify сам перайшоў да наступнай песні сваёй чаргі, а першае ў нашай чарзе — відэа (перамотка ў канец,
 * «наступная» ў самім Spotify, бот не паспеў паставіць паўзу). Тады відэа пачынаецца адразу, а новая песня
 * пасля яго пойдзе з пачатку. Калі стрымер сам выбраў іншую песню — не перабіваем.
 */
export function missedVideo(before: PlayerState, after: PlayerState): QueueItem | null {
  const first = after.requests[0];
  if (!first || !isVideo(first.track) || before.requests[0]?.key !== first.key || currentVideo(after)) return null;
  const was = before.current;
  const now = after.current;
  if (!was?.track.uri || !now?.track.uri || now.track.uri === was.track.uri || now.requestedBy) return null;
  return before.context[0]?.track.uri === now.track.uri ? first : null;
}

/**
 * Відэа становіцца бягучым. Песня, якая грала, ідзе ў гісторыю, а пры `restart` (Spotify ужо пачаў новую песню) —
 * назад на пачатак чаргі: яна зайграе пасля відэа.
 */
export function startVideo(state: PlayerState, key: string, resume: SpotifyResume, now: number): PlayerState {
  const item = state.requests.find((r) => r.key === key);
  if (!item || !isVideo(item.track)) return state;
  let { history, context } = state;
  if (state.current) {
    if (resume === 'restart' && !state.current.requestedBy && !isVideo(state.current.track)) context = [state.current, ...context];
    else history = [...history, state.current].slice(-HISTORY_LIMIT);
  }
  return {
    ...state,
    current: withoutSent(item),
    isPlaying: true,
    progressMs: 0,
    requests: state.requests.filter((r) => r.key !== key),
    history,
    context,
    video: { key, resume, startedAt: now, reportAt: 0, seek: 0, spotifyPaused: false, started: false },
  };
}

/** Што рабіць пасля відэа. */
export type AfterVideo =
  /** Наступнае ў чарзе — зноў відэа: Spotify застаецца на паўзе. */
  | { kind: 'video'; key: string; resume: SpotifyResume }
  /** Замова песні: у чаргу Spotify і ўключыць. */
  | { kind: 'request'; key: string; resume: SpotifyResume }
  /** Музыка стрымера: «наступная» або тая ж песня з пачатку. */
  | { kind: 'context'; resume: SpotifyResume };

/** Відэа скончылася (або яго спынілі): у гісторыю, бягучага няма, пакуль Spotify не пацвердзіць наступнае. */
export function endVideo(state: PlayerState): { state: PlayerState; next: AfterVideo } | null {
  const video = currentVideo(state);
  if (!video || !state.video) return null;
  const { resume } = state.video;
  const next: PlayerState = {
    ...state,
    current: null,
    isPlaying: false,
    progressMs: 0,
    history: [...state.history, video].slice(-HISTORY_LIMIT),
    video: null,
  };
  const first = next.requests[0];
  if (first && isVideo(first.track)) return { state: next, next: { kind: 'video', key: first.key, resume } };
  if (first?.track.uri && resume !== 'none') return { state: next, next: { kind: 'request', key: first.key, resume } };
  return { state: next, next: { kind: 'context', resume } };
}

/** Пасля відэа — музыка стрымера: адразу паказваем песню, якую ўключыць Spotify (першую ў чарзе). */
export function resumeContext(state: PlayerState): PlayerState {
  const [next, ...context] = state.context;
  if (!next) return state;
  return { ...state, current: next, context, isPlaying: true, progressMs: 0 };
}

/** Паведамленне плэера пра бягучае відэа. `ended` / `failed` — відэа скончылася або паказаць яго нельга. */
export function applyReport(state: PlayerState, report: VideoReport, now: number): { state: PlayerState; ended: boolean; failed: boolean } {
  const video = currentVideo(state);
  if (!video || !state.video || report.key !== video.key) return { state, ended: false, failed: false };
  const started = state.video.started || (report.state === 'playing' && report.positionMs > 0);
  const progressMs =
    report.state === 'ended'
      ? video.track.durationMs
      : Number.isFinite(report.positionMs) && report.positionMs >= 0
        ? Math.min(report.positionMs, video.track.durationMs)
        : state.progressMs;
  return {
    state: { ...state, progressMs, video: { ...state.video, reportAt: now, started } },
    ended: report.state === 'ended',
    failed: report.state === 'error',
  };
}

/** Плэер оверлэя даўно маўчыць — відэа не паказваецца. */
export function videoStalled(state: PlayerState, now: number, silenceMs = PLAYER_SILENCE_MS): boolean {
  if (!currentVideo(state) || !state.video) return false;
  return now - Math.max(state.video.startedAt, state.video.reportAt) >= silenceMs;
}

/** Відэа даўно бягучае, а плэер так і не пачаў яго паказваць. */
export function videoNotStarting(state: PlayerState, now: number, timeoutMs = VIDEO_START_TIMEOUT_MS): boolean {
  if (!currentVideo(state) || !state.video || state.video.started || !state.isPlaying) return false;
  return now - state.video.startedAt >= timeoutMs;
}

/** «Папярэдняя» падчас відэа: відэа з пачатку. */
export function restartVideo(state: PlayerState): PlayerState {
  if (!currentVideo(state) || !state.video) return state;
  return { ...state, progressMs: 0, video: { ...state.video, seek: state.video.seek + 1 } };
}
