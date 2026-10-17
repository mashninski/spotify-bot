// Старонка прыкладання (док або оверлей) як удзельнік «мозгу» (ADR-015).
// Кожная старонка становіцца ў чаргу на лідарства. Лідар запускае мозг (brain.ts) і рассылае стан;
// астатнія старонкі паказваюць атрыманы стан і перадаюць каманды лідару.
// UI працуе аднолькава ў абодвух выпадках: чытае сховішчы і выклікае дзеянні адсюль.

import { randomId } from '../core/id';
import * as q from '../core/queue';
import { loadSettings, safeLocalStorage, saveSettings, SETTINGS_KEY, type Settings } from '../core/settings';
import { createStore } from '../core/store';
import type { PlayerState } from '../core/types';
import type { VideoReport } from '../core/video';
import type { FetchLike as YouTubeFetch, VideoProbe } from '../youtube/lookup';
import { createBrain, type Brain } from './brain';
import {
  Bus,
  type BrainSnapshot,
  type ChannelInfo,
  type Command,
  type LeaderInfo,
  type Notice,
  type ObsInfo,
  type PageKind,
  initialYouTubeInfo,
  type YouTubeInfo,
} from './bus';
import { electLeader, getLockManager, type LeaderElection, type LockManagerLike } from './leader';
import { loadPlayer } from './persist';
import { hasTokens, type FetchLike } from '../providers/spotify/auth';
import { initialSpotifyInfo, type SpotifyInfo } from '../providers/spotify/sync';
import { hasTokens as hasTwitchTokens, type FetchLike as TwitchFetch } from '../sources/twitch/auth';
import type { SocketFactory } from '../sources/twitch/eventsub';
import { initialTwitchInfo, type TwitchInfo } from '../sources/twitch/twitch';

/** Затрымка рассылкі стану пасля змены: некалькі змен запар ідуць адным паведамленнем. */
const SNAPSHOT_DELAY_MS = 50;
/** Лідар паўтарае стан, нават калі нічога не змянілася. */
const SNAPSHOT_HEARTBEAT_MS = 1000;
/** Калі ад лідара так доўга нічога няма — лічым, што яго няма. */
const LEADER_TIMEOUT_MS = 3500;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface BrainNodeOptions {
  page: PageKind;
  /** Па змаўчанні — localStorage. */
  storage?: StorageLike | null;
  /** Па змаўчанні — `navigator.locks`; `null` — Web Locks няма (лідарам можа быць толькі док). */
  locks?: LockManagerLike | null;
  /** Назвы замка і шыны (у тэстах — свае для кожнага тэста). */
  lockName?: string;
  busName?: string;
  onObsEvent?: () => void;
  /** Тэставы плэйліст без Spotify (толькі тэсты, гл. BrainOptions.demo). */
  demo?: boolean;
  fetch?: FetchLike;
  /** Падмена Twitch (тэсты). */
  twitchFetch?: TwitchFetch;
  createSocket?: SocketFactory;
  /** Падмена YouTube (тэсты): oEmbed і схаваны плэер. */
  youtubeFetch?: YouTubeFetch;
  videoProbe?: VideoProbe;
  videoSilenceMs?: number;
  videoStartMs?: number;
}

export function createBrainNode(options: BrainNodeOptions) {
  const id = randomId();
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  const locks = options.locks === undefined ? getLockManager() : options.locks;
  const bus = new Bus(id, options.busName);

  const settings = createStore<Settings>(loadSettings(storage));
  // Да першага паведамлення ад лідара паказваем захаваны стан — каб не было пустога экрана.
  const player = createStore<PlayerState>(loadPlayer(storage) ?? q.emptyPlayerState());
  const obs = createStore<ObsInfo>({ status: 'disconnected', detail: '', version: '' });
  const channel = createStore<ChannelInfo>({ mode: 'none', sent: 0, errors: 0, lastError: '' });
  /** Узровень гуку кожнай крыніцы OBS (для выбару крыніцы ў наладах). */
  const meters = createStore<Record<string, number>>({});
  const notice = createStore<Notice | null>(null);
  /** Стан падключэння да Spotify (ADR-016). Да першага паведамлення ад лідара — па наяўнасці токенаў. */
  const spotify = createStore<SpotifyInfo>(initialSpotifyInfo(hasTokens(storage) ? 'connecting' : 'off'));
  /** Стан падключэння да Twitch (ADR-018). */
  const twitch = createStore<TwitchInfo>(initialTwitchInfo(hasTwitchTokens(storage) ? 'connecting' : 'off'));
  /** Відэа YouTube (ADR-020): плэер у оверлэі і гук відэа для хвалі. */
  const youtube = createStore<YouTubeInfo>(initialYouTubeInfo());
  /** Хто зараз лідар (`null` — невядома або нікога няма). */
  const leader = createStore<LeaderInfo | null>(null);
  /** Колькі разоў заўважаны іншы лідар, калі лідар — гэтая старонка (не павінна быць ніколі). */
  const conflicts = createStore(0);

  let brain: Brain | null = null;
  let election: LeaderElection | null = null;
  let lastSnapshotAt = 0;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  const stopFns: (() => void)[] = [];
  const leaderStopFns: (() => void)[] = [];

  function snapshot(info: LeaderInfo): BrainSnapshot {
    return { leader: info, player: { ...player.get(), history: [] }, obs: obs.get(), channel: channel.get(), spotify: spotify.get(), twitch: twitch.get(), youtube: youtube.get() };
  }

  function postSnapshot(): void {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = null;
    const info = leader.get();
    if (brain && info) bus.post({ kind: 'snapshot', snapshot: snapshot(info) });
  }

  function scheduleSnapshot(): void {
    snapshotTimer ??= setTimeout(postSnapshot, SNAPSHOT_DELAY_MS);
  }

  function updateSettings(update: (s: Settings) => Settings): void {
    settings.set(update);
    saveSettings(storage, settings.get());
    bus.post({ kind: 'settings' });
  }

  function reloadSettings(): void {
    settings.set(loadSettings(storage));
  }

  function becomeLeader(): void {
    if (brain) return;
    leader.set({ id, page: options.page, since: Date.now(), locks: locks !== null });
    brain = createBrain({
      id,
      storage,
      stores: { settings, player, obs, channel, meters, notice, spotify, twitch, youtube },
      updateSettings,
      onObsEvent: options.onObsEvent,
      demo: options.demo,
      fetch: options.fetch,
      twitchFetch: options.twitchFetch,
      createSocket: options.createSocket,
      youtubeFetch: options.youtubeFetch,
      videoProbe: options.videoProbe,
      videoSilenceMs: options.videoSilenceMs,
      videoStartMs: options.videoStartMs,
    });
    const heartbeat = setInterval(postSnapshot, SNAPSHOT_HEARTBEAT_MS);
    leaderStopFns.push(
      player.subscribe(scheduleSnapshot),
      obs.subscribe(scheduleSnapshot),
      channel.subscribe(scheduleSnapshot),
      spotify.subscribe(scheduleSnapshot),
      twitch.subscribe(scheduleSnapshot),
      youtube.subscribe(scheduleSnapshot),
      meters.subscribe((m) => bus.post({ kind: 'meters', meters: m })),
      notice.subscribe((n) => n && bus.post({ kind: 'notice', notice: n })),
      () => clearInterval(heartbeat),
    );
    void brain.start();
    postSnapshot();
  }

  function applySnapshot(s: BrainSnapshot): void {
    lastSnapshotAt = Date.now();
    leader.set(s.leader);
    player.set(s.player);
    obs.set(s.obs);
    channel.set(s.channel);
    if (s.spotify) spotify.set(s.spotify);
    if (s.twitch) twitch.set(s.twitch);
    if (s.youtube) youtube.set(s.youtube);
  }

  function command(c: Command): void {
    if (brain) brain.execute(c);
    else bus.post({ kind: 'command', command: c });
  }

  return {
    id,
    page: options.page,
    locksSupported: locks !== null,
    settings,
    player,
    obs,
    channel,
    meters,
    notice,
    spotify,
    twitch,
    youtube,
    leader,
    conflicts,

    isLeader: () => brain !== null,

    start() {
      stopFns.push(
        bus.onMessage(({ msg }) => {
          switch (msg.kind) {
            case 'hello':
              if (brain) postSnapshot();
              break;
            case 'command':
              brain?.execute(msg.command);
              break;
            case 'snapshot':
              if (brain) conflicts.set((n) => n + 1);
              else applySnapshot(msg.snapshot);
              break;
            case 'meters':
              if (!brain) meters.set(msg.meters);
              break;
            case 'notice':
              if (!brain) notice.set(msg.notice);
              break;
            case 'settings':
              reloadSettings();
              break;
          }
        }),
      );
      // Запасны шлях для налад: падзея `storage` прыходзіць у іншыя старонкі з тым жа localStorage.
      if (typeof window !== 'undefined') {
        const onStorage = (e: StorageEvent) => e.key === SETTINGS_KEY && reloadSettings();
        window.addEventListener('storage', onStorage);
        stopFns.push(() => window.removeEventListener('storage', onStorage));
      }
      const staleCheck = setInterval(() => {
        if (!brain && leader.get() && Date.now() - lastSnapshotAt > LEADER_TIMEOUT_MS) leader.set(null);
      }, 1000);
      stopFns.push(() => clearInterval(staleCheck));

      if (locks) election = electLeader(locks, becomeLeader, options.lockName);
      else if (options.page === 'dock') becomeLeader();
      bus.post({ kind: 'hello' });
    },

    stop() {
      // Спачатку мозг захоўвае стан, потым аддаём замок — новы лідар прачытае ўжо захаваную чаргу.
      for (const f of leaderStopFns.splice(0)) f();
      brain?.stop();
      brain = null;
      election?.stop();
      election = null;
      for (const f of stopFns.splice(0)) f();
      if (snapshotTimer) clearTimeout(snapshotTimer);
      bus.close();
    },

    updateSettings,
    togglePlay: () => command({ type: 'toggle-play' }),
    next: () => command({ type: 'next' }),
    previous: () => command({ type: 'previous' }),
    playNow: (key: string) => command({ type: 'play-now', key }),
    removeRequest: (key: string) => command({ type: 'remove', key }),
    addTestRequest: () => command({ type: 'test-request' }),
    connectObs: () => command({ type: 'obs-connect' }),
    disconnectObs: () => command({ type: 'obs-disconnect' }),
    saveCurrent: () => command({ type: 'save-current' }),
    disconnectSpotify: () => command({ type: 'spotify-disconnect' }),
    disconnectTwitch: () => command({ type: 'twitch-disconnect' }),
    setVolume: (value: number) => command({ type: 'volume', value }),
    /** Плэер відэа ў оверлэі паведамляе лідару пра ход відэа (ADR-020). */
    reportVideo: (report: VideoReport) => command({ type: 'video-report', ...report }),
    /** Оверлэй паведамляе пра сябе: ці ён грае з гукам і якая ў яго версія. */
    reportOverlay: (owner: boolean, version: string) => command({ type: 'overlay-status', id, owner, version }),
  };
}

export type BrainNode = ReturnType<typeof createBrainNode>;
