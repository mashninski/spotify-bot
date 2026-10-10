// Сінхранізацыя з плэерам Spotify (ADR-016): ашчаднае апытанне, кнопкі плэера, гучнасць, «Любімыя трэкі».
// Працуе толькі ў лідары. Час кіруецца звонку праз `tick(now)` — ад таймера мозгу, які не запавольваецца ў схаваным доку.

import type { Track } from '../../core/types';
import type { WindowWatchStatus } from '../../obs/spotify-window';
import { SpotifyApiError, type SpotifyApi } from './api';
import { canSave, parsePlayback, parseQueue, type SpotifyPlayback } from './map';

/** Інтэрвалы апытання, мс (ADR-016). Квота Development Mode не апублікавана — не апытваць часцей без патрэбы. */
export const POLL = {
  /** Калі музыка грае: ручное пераключэнне ў Spotify будзе відаць не пазней, чым праз гэты час. */
  playing: 6000,
  paused: 15_000,
  /** Spotify нідзе не адкрыты: каб пасля адкрыцця Spotify бот хутка гэта заўважыў. */
  idle: 15_000,
  /**
   * Тое ж, калі бот бачыць акно Spotify праз OBS: пра змену песні, паўзу і адкрыццё Spotify скажа загаловак акна,
   * а апытанне патрэбна толькі, каб выправіць час песні (стрымер мог перамотваць) і заўважыць змены на іншых прыладах.
   */
  playingWatched: 20_000,
  pausedWatched: 30_000,
  idleWatched: 30_000,
  /** Пасля канца песні — каб пераход на наступную быў відаць амаль адразу. */
  endGrace: 500,
  min: 1000,
  /** Першая праверка пасля кнопкі: Spotify звычайна паспявае за гэты час. */
  afterCommand: 300,
  /** Пакуль Spotify не пацвердзіў кнопку — правяраем так часта, але не даўжэй за `confirmFor`. */
  confirm: 400,
  confirmFor: 4000,
  /** Пасля сігналу «нешта змянілася» (загаловак акна Spotify). */
  nudge: 250,
  /** Пасля змены гучнасці не верыць старой гучнасці з апытання так доўга. */
  volumeHold: 2500,
  /** Не часцей за раз у гэты час, пакуль цягнуць рэгулятар гучнасці. */
  volumeThrottle: 300,
  /** Як часта перачытваць чаргу Spotify, калі песня не мяняецца (стрымер мог змяніць чаргу або shuffle). */
  queueRefresh: 120_000,
  network: 10_000,
  other: 15_000,
  forbidden: 60_000,
} as const;

/** Калі апытаць зноў пасля такога стану плэера. */
export function pollDelay(playback: SpotifyPlayback | null, windowWatched = false): number {
  if (!playback?.track) return windowWatched ? POLL.idleWatched : POLL.idle;
  if (!playback.isPlaying) return windowWatched ? POLL.pausedWatched : POLL.paused;
  const remaining = playback.track.durationMs - playback.progressMs;
  return Math.max(POLL.min, Math.min(windowWatched ? POLL.playingWatched : POLL.playing, remaining + POLL.endGrace));
}

export type SpotifyStatus =
  /** Spotify не падключаны. */
  | 'off'
  | 'connecting'
  | 'ok'
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
  /** Гучнасць Spotify 0…100 (`null` — невядома). */
  volume: number | null;
  /** Ці можна змяніць гучнасць гэтай прылады. */
  supportsVolume: boolean;
  /** Колькі запытаў да Spotify зроблена сёння (для «Праверкі»). */
  requestsToday: number;
  /** Ці бачыць бот загаловак акна Spotify праз OBS (хуткае выяўленне змен, `src/obs/spotify-window.ts`). */
  windowWatch: WindowWatchStatus;
}

export function initialSpotifyInfo(status: SpotifyStatus = 'off'): SpotifyInfo {
  return {
    status,
    user: '',
    device: '',
    problem: '',
    limitedUntil: 0,
    liked: null,
    volume: null,
    supportsVolume: false,
    requestsToday: 0,
    windowWatch: 'unknown',
  };
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

/** Чаго чакаем ад Spotify пасля кнопкі. Пакуль адказ «стары» — не паказваем яго (інакш песня мільгне назад). */
interface Expectation {
  accept(playback: SpotifyPlayback | null): boolean;
  until: number;
}

export function createSpotifySync(options: SpotifySyncOptions) {
  const { api } = options;
  const now = options.now ?? Date.now;

  let active = false;
  let busy = false;
  let nextPollAt = 0;
  /** Да гэтага часу запытаў не робім зусім (квота або ліміт Spotify). */
  let blockedUntil = 0;
  let limitedUntil = 0;
  let userLoaded = false;
  let lastUri = '';
  let lastQueueAt = 0;
  let last: { playback: SpotifyPlayback | null; at: number } = { playback: null, at: 0 };
  let liked: SpotifyInfo['liked'] = null;
  let expectation: Expectation | null = null;
  /** Павялічваецца пры кожнай кнопцы: вынік апытання, пачатага да кнопкі, ужо састарэлы. */
  let generation = 0;

  /** Бот бачыць акно Spotify праз OBS — можна апытваць радзей. */
  let windowWatched = false;

  let pendingVolume: number | null = null;
  let volumeBusy = false;
  let lastVolumeAt = 0;
  let volumeHoldUntil = 0;

  function setLiked(next: SpotifyInfo['liked']): void {
    liked = next;
    options.onInfo({ liked });
  }

  function pollSoon(delay: number): void {
    nextPollAt = Math.max(blockedUntil, Math.min(nextPollAt, now() + delay));
  }

  /** Колькі прайграна зараз, па апошнім адказе Spotify. */
  function estimatedProgress(): number {
    const p = last.playback;
    if (!p?.track) return 0;
    return p.isPlaying ? p.progressMs + (now() - last.at) : p.progressMs;
  }

  function expectationFor(command: PlayerCommand): Expectation {
    const until = now() + POLL.confirmFor;
    const fromUri = lastUri;
    switch (command) {
      case 'play':
        return { until, accept: (p) => p?.isPlaying === true };
      case 'pause':
        return { until, accept: (p) => p?.isPlaying !== true };
      case 'next':
        return { until, accept: (p) => (p?.track?.uri ?? '') !== fromUri };
      case 'previous': {
        // Пасля 3 с Spotify пачынае тую ж песню нанова — тады чакаем, што час вярнуўся амаль да нуля.
        const restart = estimatedProgress() > 3000;
        return {
          until,
          accept: (p) => (p?.track?.uri ?? '') !== fromUri || (restart && (p?.progressMs ?? 0) < 2500),
        };
      }
    }
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
        blockedUntil = limitedUntil;
        nextPollAt = limitedUntil;
        options.onInfo({ status: 'limited', limitedUntil });
        if (fromCommand) options.onNotice('limited', 'error');
        return;
      case 'rate':
        blockedUntil = Math.max(blockedUntil, now() + err.retryAfterMs);
        nextPollAt = Math.max(nextPollAt, blockedUntil);
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
      if (expectation) {
        if (!expectation.accept(playback) && now() < expectation.until) {
          // Spotify яшчэ не выканаў кнопку — паказваем тое, што ўжо паказалі, і правяраем зноў.
          nextPollAt = now() + POLL.confirm;
          return;
        }
        expectation = null;
      }
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
      last = { playback, at: now() };
      limitedUntil = 0;
      options.onPlayback(playback, queue);
      const info: Partial<SpotifyInfo> = { status: 'ok', problem: '', device: playback?.device ?? '', limitedUntil: 0 };
      if (now() >= volumeHoldUntil && pendingVolume === null) {
        info.volume = playback?.volume ?? null;
        info.supportsVolume = playback?.supportsVolume ?? false;
      }
      options.onInfo(info);
      nextPollAt = now() + pollDelay(playback, windowWatched);
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
      if (generation !== startedGeneration) pollSoon(POLL.afterCommand);
    }
  }

  /** Кнопка плэера (`expect` — чаго чакаць ад Spotify) або іншае дзеянне (`null`: апытваць зноў не трэба). */
  async function run(action: () => Promise<unknown>, expect: Expectation | null): Promise<boolean> {
    if (!active) return false;
    if (now() < limitedUntil) {
      options.onNotice('limited', 'error');
      return false;
    }
    if (expect) {
      generation++;
      expectation = expect;
    }
    try {
      await action();
      return true;
    } catch (e) {
      if (expect) expectation = null;
      handleError(e, true);
      return false;
    } finally {
      if (expect) pollSoon(POLL.afterCommand);
    }
  }

  function flushVolume(): void {
    if (!active || volumeBusy || pendingVolume === null) return;
    if (now() < blockedUntil || now() - lastVolumeAt < POLL.volumeThrottle) return;
    const value = pendingVolume;
    pendingVolume = null;
    volumeBusy = true;
    lastVolumeAt = now();
    api
      .volume(value)
      .catch((e) => handleError(e, true))
      .finally(() => {
        volumeBusy = false;
        volumeHoldUntil = now() + POLL.volumeHold;
      });
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
      blockedUntil = 0;
      nextPollAt = 0;
      liked = null;
      expectation = null;
      pendingVolume = null;
      last = { playback: null, at: 0 };
      options.onInfo({ status: 'connecting', problem: '', liked: null });
    },

    stop(): void {
      active = false;
    },

    /** Выклікаецца часта (кожныя ~250 мс): апытвае Spotify, калі надышоў час, і адпраўляе гучнасць. */
    tick(at = now()): void {
      if (!active) return;
      flushVolume();
      if (!busy && at >= nextPollAt) void poll();
    },

    /** Ці бачыць бот акно Spotify праз OBS. Калі перастаў бачыць — вяртаемся да частага апытання. */
    setWindowWatched(watched: boolean): void {
      if (watched === windowWatched) return;
      windowWatched = watched;
      if (!watched && active) pollSoon(POLL.playing);
    },

    /** Нешта ў Spotify, падобна, змянілася (загаловак акна) — апытаць хутчэй, калі можна. */
    nudge(): void {
      if (active) pollSoon(POLL.nudge);
    },

    command(command: PlayerCommand): Promise<boolean> {
      return run(() => api[command](), expectationFor(command));
    },

    /** Рэгулятар гучнасці: адпраўляецца не часцей за раз у 300 мс, апошняе значэнне — заўсёды. */
    setVolume(percent: number): void {
      if (!active) return;
      pendingVolume = Math.max(0, Math.min(100, Math.round(percent)));
      volumeHoldUntil = now() + POLL.volumeHold;
      options.onInfo({ volume: pendingVolume });
      flushVolume();
    },

    /** «+»: дадаць песню ў «Любімыя трэкі». */
    async save(uri: string): Promise<void> {
      if (!active || !uri) return;
      const known = liked?.uri === uri ? liked.saved : null;
      if (known === true) return;
      setLiked({ uri, saved: known, busy: true });
      const ok = await run(() => api.saveToLibrary([uri]), null);
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
