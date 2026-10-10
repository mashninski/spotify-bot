// Сінхранізацыя з плэерам Spotify (ADR-016): ашчаднае апытанне, кнопкі плэера, «Любімыя трэкі».
// Працуе толькі ў лідары. Час кіруецца звонку праз `tick(now)` — ад таймера мозгу, які не запавольваецца ў схаваным доку.

import type { Track } from '../../core/types';
import { SpotifyApiError, type SpotifyApi } from './api';
import { canSave, parsePlayback, parseQueue, type SpotifyPlayback } from './map';

/** Інтэрвалы апытання, мс (ADR-016). Квота Development Mode не апублікавана — не апытваць часцей. */
export const POLL = {
  /** Калі музыка грае: ручное пераключэнне ў Spotify будзе відаць не пазней, чым праз гэты час. */
  playing: 6000,
  paused: 15_000,
  /** Spotify нідзе не адкрыты. */
  idle: 30_000,
  /** Пасля канца песні — каб пераход на наступную быў відаць амаль адразу. */
  endGrace: 500,
  min: 1000,
  afterCommand: 700,
  /** Як часта перачытваць чаргу Spotify, калі песня не мяняецца (стрымер мог змяніць чаргу або shuffle). */
  queueRefresh: 120_000,
  network: 10_000,
  other: 15_000,
  forbidden: 60_000,
} as const;

/** Калі апытаць зноў пасля такога стану плэера. */
export function pollDelay(playback: SpotifyPlayback | null): number {
  if (!playback?.track) return POLL.idle;
  if (!playback.isPlaying) return POLL.paused;
  const remaining = playback.track.durationMs - playback.progressMs;
  return Math.max(POLL.min, Math.min(POLL.playing, remaining + POLL.endGrace));
}

export type SpotifyStatus =
  /** Spotify не падключаны. */
  | 'off'
  | 'connecting'
  | 'ok'
  /** Уваход састарэў (6 месяцаў) — трэба падключыць нанова. */
  | 'login'
  /** Spotify часова абмежаваў запыты (квота). */
  | 'limited'
  | 'error';

export type SpotifyProblem = '' | 'not-allowed' | 'network' | 'other';

export interface SpotifyInfo {
  status: SpotifyStatus;
  /** Імя акаўнта Spotify. */
  user: string;
  /** Прылада, на якой грае Spotify ('' — нідзе не адкрыты). */
  device: string;
  problem: SpotifyProblem;
  /** Да якога часу Spotify абмежаваў запыты. */
  limitedUntil: number;
  /** Ці ёсць бягучая песня ў «Любімых трэках» (`saved: null` — яшчэ невядома). */
  liked: { uri: string; saved: boolean | null; busy: boolean } | null;
  /** Колькі запытаў да Spotify зроблена сёння (для «Праверкі»). */
  requestsToday: number;
}

export function initialSpotifyInfo(status: SpotifyStatus = 'off'): SpotifyInfo {
  return { status, user: '', device: '', problem: '', limitedUntil: 0, liked: null, requestsToday: 0 };
}

export type SpotifyNotice = 'no-device' | 'failed' | 'saved' | 'limited';
export type PlayerCommand = 'play' | 'pause' | 'next' | 'previous';

export interface SpotifySyncOptions {
  api: SpotifyApi;
  now?: () => number;
  /** Новы стан плэера. `queue: null` — чарга не перачытвалася. */
  onPlayback(playback: SpotifyPlayback | null, queue: Track[] | null): void;
  onInfo(patch: Partial<SpotifyInfo>): void;
  onNotice(notice: SpotifyNotice, kind: 'ok' | 'error'): void;
  /** Уваход састарэў або адкліканы — трэба падключыць Spotify нанова. */
  onLoggedOut(): void;
}

export function createSpotifySync(options: SpotifySyncOptions) {
  const { api } = options;
  const now = options.now ?? Date.now;

  let active = false;
  let busy = false;
  let nextPollAt = 0;
  let limitedUntil = 0;
  let userLoaded = false;
  let lastUri = '';
  let lastQueueAt = 0;
  let liked: SpotifyInfo['liked'] = null;
  /** Павялічваецца пры кожнай кнопцы: вынік апытання, пачатага да кнопкі, ужо састарэлы. */
  let generation = 0;

  function setLiked(next: SpotifyInfo['liked']): void {
    liked = next;
    options.onInfo({ liked });
  }

  function pollSoon(delay: number = POLL.afterCommand): void {
    nextPollAt = Math.min(nextPollAt, now() + delay);
  }

  function handleError(e: unknown, fromCommand: boolean): void {
    const err = e instanceof SpotifyApiError ? e : new SpotifyApiError('other');
    switch (err.kind) {
      case 'auth':
        active = false;
        options.onLoggedOut();
        return;
      case 'quota':
        limitedUntil = now() + err.retryAfterMs;
        nextPollAt = limitedUntil;
        options.onInfo({ status: 'limited', limitedUntil });
        if (fromCommand) options.onNotice('limited', 'error');
        return;
      case 'rate':
        nextPollAt = Math.max(nextPollAt, now() + err.retryAfterMs);
        if (fromCommand) options.onNotice('failed', 'error');
        return;
      case 'no-device':
        if (fromCommand) options.onNotice('no-device', 'error');
        return;
      case 'forbidden':
        if (fromCommand) options.onNotice('failed', 'error');
        else {
          // Чытаць стан забаронена: акаўнт не дададзены ў User Management або няма Premium.
          options.onInfo({ status: 'error', problem: 'not-allowed' });
          nextPollAt = now() + POLL.forbidden;
        }
        return;
      case 'network':
        if (fromCommand) options.onNotice('failed', 'error');
        else {
          options.onInfo({ problem: 'network' });
          nextPollAt = now() + POLL.network;
        }
        return;
      default:
        if (fromCommand) options.onNotice('failed', 'error');
        else {
          options.onInfo({ problem: 'other' });
          nextPollAt = now() + POLL.other;
        }
    }
  }

  async function poll(): Promise<void> {
    busy = true;
    const startedGeneration = generation;
    try {
      if (!userLoaded) {
        const me = await api.me();
        userLoaded = true;
        options.onInfo({ user: me.name });
      }
      const playback = parsePlayback(await api.playback());
      if (!active) return;
      if (generation !== startedGeneration) return; // пакуль чакалі адказ, націснулі кнопку — апытаем яшчэ раз
      const uri = playback?.track?.uri ?? '';
      const changed = uri !== lastUri;
      let queue: Track[] | null = null;
      if (!uri) queue = [];
      else if (changed || now() - lastQueueAt >= POLL.queueRefresh) {
        queue = parseQueue(await api.queue());
        lastQueueAt = now();
        if (!active || generation !== startedGeneration) return;
      }
      lastUri = uri;
      limitedUntil = 0;
      options.onPlayback(playback, queue);
      options.onInfo({ status: 'ok', problem: '', device: playback?.device ?? '', limitedUntil: 0 });
      nextPollAt = now() + pollDelay(playback);
      if (changed) {
        const track = playback?.track;
        if (track && canSave(track)) {
          setLiked({ uri, saved: null, busy: false });
          const [saved] = await api.libraryContains([uri]);
          if (active && liked?.uri === uri && liked.saved === null) setLiked({ uri, saved: saved === true, busy: liked.busy });
        } else setLiked(null);
      }
    } catch (e) {
      if (active) handleError(e, false);
    } finally {
      busy = false;
      if (generation !== startedGeneration) pollSoon();
    }
  }

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    if (!active) return false;
    if (now() < limitedUntil) {
      options.onNotice('limited', 'error');
      return false;
    }
    generation++;
    try {
      await action();
      return true;
    } catch (e) {
      handleError(e, true);
      return false;
    } finally {
      pollSoon();
    }
  }

  return {
    get active() {
      return active;
    },

    start(): void {
      active = true;
      userLoaded = false;
      lastUri = '';
      lastQueueAt = 0;
      limitedUntil = 0;
      nextPollAt = 0;
      liked = null;
      options.onInfo({ status: 'connecting', problem: '', liked: null });
    },

    stop(): void {
      active = false;
    },

    /** Выклікаецца часта (кожныя ~250 мс): апытвае Spotify, калі надышоў час. */
    tick(at = now()): void {
      if (active && !busy && at >= nextPollAt) void poll();
    },

    command(command: PlayerCommand): Promise<boolean> {
      return run(() => api[command]());
    },

    /** «+»: дадаць песню ў «Любімыя трэкі». */
    async save(uri: string): Promise<void> {
      if (!active || !uri) return;
      const known = liked?.uri === uri ? liked.saved : null;
      if (known === true) return;
      setLiked({ uri, saved: known, busy: true });
      const ok = await run(() => api.saveToLibrary([uri]));
      if (liked?.uri !== uri) return;
      setLiked({ uri, saved: ok ? true : known, busy: false });
      if (ok) options.onNotice('saved', 'ok');
    },
  };
}

export type SpotifySync = ReturnType<typeof createSpotifySync>;

/** Лічыльнік запытаў за дзень, агульны для ўсіх лідараў (захоўваецца ў localStorage). */
export const STATS_KEY = 'spotify-bot:spotify:stats';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const dayOf = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export function createRequestCounter(storage: StorageLike | null, now: () => number = Date.now) {
  let day = '';
  let count = 0;
  try {
    const raw = JSON.parse(storage?.getItem(STATS_KEY) ?? 'null');
    if (raw && typeof raw.day === 'string' && typeof raw.count === 'number') ({ day, count } = raw);
  } catch {
    // Пачынаем лічыць нанова.
  }
  const current = () => (day === dayOf(now()) ? count : 0);
  return {
    get: current,
    /** +1 запыт; вяртае колькасць за сёння. */
    add(): number {
      const today = dayOf(now());
      count = day === today ? count + 1 : 1;
      day = today;
      try {
        storage?.setItem(STATS_KEY, JSON.stringify({ day, count }));
      } catch {
        // Не крытычна.
      }
      return count;
    },
  };
}
