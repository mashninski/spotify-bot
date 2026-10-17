// «Мозг» прыкладання (ADR-015): стан плэера і чаргі, заказы, Spotify (ADR-016), Twitch (ADR-018), відэа YouTube (ADR-020),
// падключэнне да OBS, адпраўка стану ў оверлей.
// Працуе толькі ў старонцы-лідары (док або оверлей). Стан піша ў агульныя сховішчы старонкі,
// а старонка (node.ts) рассылае яго астатнім. Само відэа грае толькі ў оверлэі — мозг кіруе чаргой і Spotify.

import { createEnvelopeFactory, type OverlayMessage } from '../core/messages';
import * as q from '../core/queue';
import * as rq from '../core/requests';
import { checkRequest, maxDurationFor, type RejectReason } from '../core/rules';
import { SIMULATED_AUDIO, type Settings } from '../core/settings';
import type { Store } from '../core/store';
import { startTicker } from '../core/ticker';
import { isVideo, type PlayerState, type QueueItem, type SpotifyResume, type Track } from '../core/types';
import * as vd from '../core/video';
import { t } from '../i18n';
import { createAutoGain, dbFromMeters, levelFromMeters, simulatedLevel } from '../obs/audio';
import { OverlaySender } from '../obs/channel';
import { ObsClient } from '../obs/client';
import { EventSubscription, type InputVolumeMetersEvent } from '../obs/protocol';
import { findOverlaySource } from '../obs/video-audio';
import { createMockProvider, MOCK_REQUEST_TRACKS, MOCK_VIEWERS, SPOTIFY_TEST_QUERIES, type MusicProvider } from '../providers/spotify';
import { createSpotifyApi } from '../providers/spotify/api';
import { clearTokens, hasTokens, saveLoginResult, type FetchLike } from '../providers/spotify/auth';
import { applyPlayback, canSave, optimisticSkip } from '../providers/spotify/map';
import { createSpotifyWindowReader } from '../obs/spotify-window';
import { createRequestCounter, createSpotifySync, initialSpotifyInfo, type SpotifyInfo } from '../providers/spotify/sync';
import { createMockRequestSource, type RequestKind, type SongRequest } from '../sources/twitch';
import { hasTokens as hasTwitchTokens, type FetchLike as TwitchFetch } from '../sources/twitch/auth';
import type { SocketFactory } from '../sources/twitch/eventsub';
import { createTwitchLink, initialTwitchInfo, type RequestOutcome, type TwitchInfo } from '../sources/twitch/twitch';
import { mentionsYouTube, parseYouTubeLink } from '../youtube/link';
import { findVideo, type FetchLike as YouTubeFetch, type VideoProbe } from '../youtube/lookup';
import type { ChannelInfo, Command, Notice, ObsInfo, YouTubeInfo } from './bus';
import { loadPlayer, savePlayer } from './persist';

/** Колькі трэкаў кантэксту трымаць напагатове. */
const CONTEXT_MIN = 5;
/** Як часта паўтараць стан і сігнал «жывы» для оверлея (каб оверлей пасля перазагрузкі хутка атрымаў стан). */
const HEARTBEAT_MS = 2000;
const TICK_MS = 250;
const SIMULATED_AUDIO_MS = 50;
/** Як часта захоўваць стан плэера ў localStorage (і заўсёды — пры спыненні). */
const PERSIST_MS = 1000;
/** Як часта правяраць загаловак акна Spotify праз OBS (бясплатна — без запытаў да Spotify). */
const WINDOW_CHECK_MS = 1000;
/** Калі ў OBS няма крыніцы са спісам акон — правяраць радзей. */
const WINDOW_CHECK_IDLE_MS = 10_000;
/** Калі Spotify не прыняў заказ у чаргу — паўтарыць праз гэты час (не часцей, каб не марнаваць квоту). */
const SEND_RETRY_MS = 5000;
/** Як часта шукаць у OBS крыніцу з оверлэем (гук відэа для хвалі, ADR-020). */
const OVERLAY_SOURCE_CHECK_MS = 30_000;
/** Відэа з мінулага запуску, пра якое плэер так даўно не паведамляў, не працягваем (OBS быў зачынены). */
const VIDEO_STALE_ON_START_MS = 60_000;
/** Паўтор паўзы Spotify перад відэа, калі першая каманда не прайшла. */
const PAUSE_RETRY_MS = 1500;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Сховішчы старонкі, у якія мозг піша свой стан. */
export interface BrainStores {
  settings: Store<Settings>;
  player: Store<PlayerState>;
  obs: Store<ObsInfo>;
  channel: Store<ChannelInfo>;
  meters: Store<Record<string, number>>;
  notice: Store<Notice | null>;
  spotify: Store<SpotifyInfo>;
  twitch: Store<TwitchInfo>;
  youtube: Store<YouTubeInfo>;
}

export interface BrainOptions {
  /** Ідэнтыфікатар старонкі: з яго пачынаюцца ключы запісаў чаргі і `sid` паведамленняў оверлею. */
  id: string;
  storage: StorageLike | null;
  stores: BrainStores;
  updateSettings(update: (s: Settings) => Settings): void;
  provider?: MusicProvider;
  /**
   * Тэставы плэйліст, пакуль Spotify не падключаны (толькі для тэстаў). Па змаўчанні без Spotify нічога не грае,
   * каб на стрыме не з'явіліся выдуманыя песні (ADR-016).
   */
  demo?: boolean;
  /** Падмена `fetch` для запытаў да Spotify (тэсты). */
  fetch?: FetchLike;
  /** Выклікаецца на кожную падзею ад OBS (дыягностыка схаванага дока). */
  onObsEvent?: () => void;
  /** Падмена `fetch` і WebSocket для Twitch (тэсты). */
  twitchFetch?: TwitchFetch;
  createSocket?: SocketFactory;
  /** Падмена YouTube (тэсты): oEmbed і схаваны плэер, які правярае відэа. */
  youtubeFetch?: YouTubeFetch;
  videoProbe?: VideoProbe;
  /** Колькі плэер оверлэя можа маўчаць, пакуль відэа не лічыцца страчаным (тэсты — менш). */
  videoSilenceMs?: number;
  /** Колькі чакаць, пакуль плэер пачне паказваць відэа (тэсты — менш). */
  videoStartMs?: number;
}

export function createBrain(options: BrainOptions) {
  const { storage, stores, updateSettings } = options;
  const { settings, player } = stores;
  const provider = options.provider ?? createMockProvider();
  const requestSource = createMockRequestSource();
  const sender = new OverlaySender();
  const envelope = createEnvelopeFactory(options.id);
  const youtubeFetch: YouTubeFetch = options.youtubeFetch ?? ((url, init) => fetch(url, init));
  /** Схаваны плэер для праверкі відэа — толькі ў браўзеры (загружаецца, калі спатрэбіцца). */
  const videoProbe: VideoProbe =
    options.videoProbe ??
    (async (videoId) => {
      if (typeof document === 'undefined') return { status: 'timeout' };
      const { probeVideo } = await import('../youtube/probe');
      return probeVideo(videoId);
    });

  let obs: ObsClient | null = null;
  let windowReader: ReturnType<typeof createSpotifyWindowReader> | null = null;
  let windowBusy = false;
  let nextWindowCheckAt = 0;
  /** Апошні вядомы стан акна Spotify (`null` — яшчэ не правяралі). */
  let lastWindowKey: string | null = null;
  let overlaySourceBusy = false;
  let nextOverlaySourceCheckAt = 0;
  let keyCounter = 0;
  let lastOverlayJson = '';
  let lastLevel = -1;
  let lastTickAt = Date.now();
  let lastHeartbeatAt = 0;
  let lastPersistAt = 0;
  let refilling = false;
  /** Заказ, які зараз адпраўляецца ў Spotify (ключ), і калі можна паспрабаваць зноў пасля няўдачы. */
  let sendingKey: string | null = null;
  let nextSendAt = 0;
  let testQueryIndex = 0;
  /** Аўтаўзмацненне хвалі для кожнай крыніцы гуку (музыка і відэа — асобна). */
  const autoGains = new Map<string, ReturnType<typeof createAutoGain>>();
  let running = false;
  /** Песні мяняе Spotify (ёсць токены), а не ўнутраны таймер. */
  let spotifyMode = false;
  /** Стан ужо загружаны або створаны — толькі тады яго можна захоўваць (інакш перазапішам чаргу пустой). */
  let loaded = false;
  const stopFns: (() => void)[] = [];

  // --- Spotify (ADR-016) ---

  const counter = createRequestCounter(storage);
  const api = createSpotifyApi({
    storage,
    fetch: options.fetch,
    onRequest: () => {
      const n = counter.add();
      stores.spotify.set((s) => ({ ...s, requestsToday: n }));
    },
  });
  const spotify = createSpotifySync({
    api,
    onPlayback: (playback, queue) => {
      if (!spotifyMode) return;
      // Падчас відэа (ADR-020) Spotify на паўзе і бягучую песню не мяняе.
      if (vd.currentVideo(player.get())) {
        const video = player.get().video!;
        if (!playback?.isPlaying) {
          if (!video.spotifyPaused) player.set((s) => (s.video ? { ...s, video: { ...s.video, spotifyPaused: true } } : s));
          return;
        }
        // Паўза ўжо была, а Spotify зноў грае — стрымер сам уключыў музыку: відэа спыняецца, гук не накладваецца.
        if (!video.spotifyPaused) return;
        finishVideo('streamer');
      }
      const before = player.get();
      player.set((s) => applyPlayback(s, playback, queue));
      skipRemovedRequest();
      // Spotify перайшоў да плэйліста, а першае ў чарзе — відэа: паўза і відэа адразу (ADR-020).
      const missedVideo = vd.missedVideo(before, player.get());
      if (missedVideo) return startVideoNow(missedVideo.key, 'restart');
      // Spotify перайшоў да плэйліста, а заказ не паспеў трапіць у Spotify — уключаем заказ адразу (ADR-017).
      const missed = rq.missedRequest(before, player.get());
      if (missed) playRequestNow(missed.key);
    },
    onInfo: (patch) => stores.spotify.set((s) => ({ ...s, ...patch })),
    onNotice: (n, kind) => showNotice(t(`spotify.notice.${n}`), kind),
    onLoggedOut: () => {
      // Уваход састарэў (6 месяцаў) або Spotify яго адклікаў — док папросіць падключыцца зноў.
      clearTokens(storage);
      saveLoginResult(storage, { ok: false, error: 'expired', at: Date.now() });
      leaveSpotify();
    },
  });

  // --- Twitch (ADR-018) ---

  /** Стрымер націснуў «Адключыць»: пакуль узнагарода ставіцца на паўзу, не падключацца нанова. */
  let twitchDisconnecting = false;
  const twitch = createTwitchLink({
    storage,
    fetch: options.twitchFetch,
    createSocket: options.createSocket,
    price: (kind) => (kind === 'video' ? settings.get().rules.videoPrice : settings.get().rules.price),
    readiness: () => {
      if (!spotifyMode) return hasTokens(storage) ? 'wait' : 'off';
      const status = stores.spotify.get().status;
      return status === 'ok' ? 'ready' : status === 'connecting' ? 'wait' : 'off';
    },
    onRedemption: (r) => processRequest({ user: r.user, query: r.query, redemptionId: r.id, kind: r.kind }),
    player: () => player.get(),
    onInfo: (patch) => stores.twitch.set((s) => ({ ...s, ...patch })),
    onLoggedOut: () => stores.twitch.set(initialTwitchInfo('off')),
  });

  /** Токены Twitch з'явіліся (уваход у доку) або зніклі — падключаем або спыняем. */
  function checkTwitch(): void {
    if (twitchDisconnecting) return;
    const connected = hasTwitchTokens(storage);
    if (connected && !twitch.running) twitch.start();
    else if (!connected && twitch.running) twitch.stop();
  }

  /** Запіс можна паказаць пры Spotify: песня Spotify (з URI) або відэа YouTube. */
  const playable = (item: QueueItem | null | undefined) => Boolean(item && (item.track.uri || isVideo(item.track)));

  function enterSpotify(): void {
    spotifyMode = true;
    // Тэставыя трэкі (без Spotify URI) у Spotify не адправіш — прыбіраем іх. Відэа застаюцца (ADR-020).
    player.set((s) => {
      const current = playable(s.current) ? s.current : null;
      return {
        ...s,
        current,
        isPlaying: Boolean(current) && s.isPlaying,
        requests: s.requests.filter(playable),
        context: s.context.filter((c) => c.track.uri),
        history: [],
        video: current && s.video?.key === current.key ? s.video : null,
      };
    });
    spotify.start();
  }

  function leaveSpotify(): void {
    spotifyMode = false;
    spotify.stop();
    stores.spotify.set({ ...initialSpotifyInfo('off'), requestsToday: counter.get() });
    player.set((s) => ({ ...s, current: null, isPlaying: false, progressMs: 0, context: [], history: [], video: null }));
  }

  /** Токены з'явіліся (уваход на старонцы вяртання) або зніклі — пераключаем рэжым. */
  function checkSpotify(): void {
    const connected = hasTokens(storage);
    if (connected && !spotifyMode) enterSpotify();
    else if (!connected && spotifyMode) leaveSpotify();
  }

  // Ключ запісу павінен быць унікальны і пасля змены лідара, таму ў ім ідэнтыфікатар старонкі.
  const makeItem = (track: Track, requestedBy?: string, redemptionId?: string): QueueItem => ({
    key: `${track.id}#${options.id}-${++keyCounter}`,
    track,
    ...(requestedBy ? { requestedBy } : {}),
    ...(redemptionId ? { redemptionId } : {}),
  });

  function send(msg: OverlayMessage): void {
    sender.send(envelope(msg));
  }

  function sendState(force = false): void {
    const state = q.toOverlayState(player.get());
    const json = JSON.stringify(state);
    if (!force && json === lastOverlayJson) return;
    lastOverlayJson = json;
    send({ type: 'state', state });
  }

  function sendLevel(level: number): void {
    if (Math.abs(level - lastLevel) < 0.004) return;
    lastLevel = level;
    send({ type: 'level', level });
  }

  function updateChannel(): void {
    stores.channel.set({ mode: sender.mode, ...sender.stats });
  }

  function showNotice(text: string, kind: Notice['kind'] = 'ok'): void {
    stores.notice.set({ id: Date.now(), text, kind });
  }

  function persist(): void {
    if (!loaded) return;
    lastPersistAt = Date.now();
    savePlayer(storage, player.get(), lastPersistAt);
  }

  async function refillContext(): Promise<void> {
    if (refilling || player.get().context.length >= CONTEXT_MIN) return;
    refilling = true;
    try {
      const tracks = await provider.nextContextTracks(CONTEXT_MIN - player.get().context.length);
      if (running && !spotifyMode) player.set((s) => q.appendContext(s, tracks.map((tr) => makeItem(tr))));
    } finally {
      refilling = false;
    }
  }

  /**
   * Першы заказ — у чаргу Spotify незадоўга да канца бягучай песні (ADR-017). Адзнака «адпраўлены» захоўваецца
   * ў localStorage да запыту: калі лідар знікне пасярэдзіне, новы лідар заказ не задвоіць (а калі запыт
   * так і не дайшоў, зверка з чаргой Spotify адправіць яго нанова).
   */
  function sendNextRequest(now: number): void {
    if (sendingKey || now < nextSendAt) return;
    const item = rq.requestToSend(player.get());
    if (!item?.track.uri) return;
    player.set((s) => rq.markSent(s, item.key, now));
    persist();
    sendingKey = item.key;
    void spotify.enqueue(item.track.uri).then((ok) => {
      sendingKey = null;
      if (ok || !running) return;
      nextSendAt = Date.now() + SEND_RETRY_MS;
      player.set((s) => rq.unmarkSent(s, item.key, now));
    });
  }

  /** Выдалены заказ, які ўжо быў у чарзе Spotify, пачаў граць — адразу пераключаем на наступную. */
  function skipRemovedRequest(): void {
    const s = player.get();
    if (!s.skip || s.current?.track.uri !== s.skip.uri) return;
    player.set((st) => ({ ...st, skip: null }));
    void spotify.command('next');
  }

  /** Вярнуць заказы, як былі, калі Spotify не паслухаўся (тыя, што яшчэ ёсць), песню скажа апытанне. */
  function restoreRequests(before: PlayerState, key: string): void {
    player.set((s) => {
      const keys = new Set([...s.requests.map((r) => r.key), key]);
      const extra = s.requests.filter((r) => !before.requests.some((b) => b.key === r.key));
      return { ...s, requests: [...before.requests.filter((r) => keys.has(r.key)), ...extra] };
    });
    spotify.nudge();
  }

  /** Заказ пачынае граць зараз: у Spotify — праз чаргу і «наступная» (ADR-007, ADR-017). Відэа — у оверлэі (ADR-020). */
  function playRequestNow(key: string): void {
    const before = player.get();
    const item = before.requests.find((r) => r.key === key);
    if (!item) return;
    if (vd.currentVideo(before)) return finishVideo('next', key);
    if (isVideo(item.track)) return startVideoNow(key, 'next');
    if (!item.track.uri) return;
    const skips = rq.skipsToReach(before, key);
    const enqueue = item.sentAt === undefined;
    player.set((s) => rq.startRequest(s, key));
    persist();
    void spotify.playUri(item.track.uri, { enqueue, skips }).then((ok) => {
      if (!ok && running) restoreRequests(before, key);
    });
  }

  // --- Відэа YouTube (ADR-020) ---

  /**
   * Відэа становіцца бягучым: Spotify — на паўзу (калі грае). Плэер у оверлэі ўбачыць новае відэа ў стане
   * і пачне яго. `resume` — як працягнуць Spotify пасля відэа.
   */
  function startVideoNow(key: string, resume: SpotifyResume): void {
    const before = player.get();
    const wasVideo = vd.currentVideo(before);
    const spotifyPlaying = spotifyMode && !wasVideo && before.isPlaying && Boolean(before.current?.track.uri);
    // Ланцужок відэа захоўвае, як працягнуць Spotify пасля апошняга; без музыкі Spotify не чапаем.
    const mode: SpotifyResume = !spotifyMode ? 'none' : wasVideo ? (before.video?.resume ?? 'none') : spotifyPlaying ? resume : 'none';
    let state = before;
    if (wasVideo) state = vd.endVideo(state)?.state ?? state;
    state = vd.startVideo(state, key, mode, Date.now());
    if (!vd.currentVideo(state)) return;
    player.set(state);
    persist();
    if (spotifyPlaying) pauseForVideo();
  }

  function pauseForVideo(retry = true): void {
    void spotify.command('pause').then((ok) => {
      if (ok || !running || !retry) return;
      setTimeout(() => {
        if (running && vd.currentVideo(player.get())) pauseForVideo(false);
      }, PAUSE_RETRY_MS);
    });
  }

  /**
   * Відэа скончылася або яго спынілі. `playKey` — замова, якую ўключыць замест наступнай (▶ у доку).
   * Відэа, якое так і не пачало паказвацца (памылка, оверлэя няма), — балы гледачу вяртаюцца.
   */
  function finishVideo(reason: 'ended' | 'next' | 'failed' | 'stalled' | 'streamer' | 'ad', playKey?: string): void {
    const before = player.get();
    const video = vd.currentVideo(before);
    if (!video || !before.video) return;
    if (reason === 'failed' || reason === 'stalled') {
      if (!before.video.started && video.redemptionId) twitch.failed(video.redemptionId, video.track.title);
      showNotice(t('player.videoFailed', { title: video.track.title }), 'error');
    } else if (reason === 'ad') {
      // Рэкламу на стрым не пускаем (ADR-020): відэа спынена, гледачу — балы назад.
      if (!before.video.started && video.redemptionId) twitch.failed(video.redemptionId, video.track.title, 'video-ad');
      showNotice(t('player.videoAd', { title: video.track.title }), 'error');
    }
    const ended = vd.endVideo(before);
    if (!ended) return;
    if (reason === 'streamer') {
      // Spotify ужо грае — песню скажа гэтае ж апытанне.
      player.set(ended.state);
      persist();
      return;
    }
    let next = ended.next;
    const chosen = playKey ? ended.state.requests.find((r) => r.key === playKey) : null;
    if (chosen) {
      next = isVideo(chosen.track)
        ? { kind: 'video', key: chosen.key, resume: before.video.resume }
        : { kind: 'request', key: chosen.key, resume: before.video.resume === 'none' ? 'next' : before.video.resume };
    }
    afterVideo(ended.state, next);
    persist();
  }

  /**
   * Што грае пасля відэа: наступнае відэа, замова песні або музыка стрымера. Новы стан ставіцца адным крокам:
   * оверлэй не павінен убачыць паміж відэа і наступным «нічога не грае» (палоска мігнула б).
   */
  function afterVideo(base: PlayerState, next: vd.AfterVideo): void {
    if (next.kind === 'video') {
      const state = vd.startVideo(base, next.key, spotifyMode ? next.resume : 'none', Date.now());
      return player.set(state);
    }
    if (!spotifyMode) {
      // Без Spotify (тэсты) — як раней: наступны запіс з чаргі.
      const moved = next.kind === 'request' ? q.playNow(base, next.key) : q.skipNext(base);
      return player.set(moved.current ? { ...moved, isPlaying: true } : moved);
    }
    if (next.kind === 'request') {
      const item = base.requests.find((r) => r.key === next.key);
      if (!item?.track.uri) return player.set(base);
      const enqueue = item.sentAt === undefined;
      player.set(rq.startRequest(base, next.key));
      void spotify.resume({ uri: item.track.uri, enqueue, skips: 1 }).then((ok) => {
        if (!ok && running) restoreRequests(base, next.key);
      });
      return;
    }
    if (next.resume === 'none') {
      player.set(base);
      return spotify.nudge();
    }
    player.set(vd.resumeContext(base));
    void spotify.resume(next.resume === 'restart' ? { restart: true } : { skips: 1 }).then((ok) => {
      if (!ok) spotify.nudge();
    });
  }

  /** Оверлэі, якія паведамлялі пра сябе: id → ці з гукам, версія, калі. */
  const overlays = new Map<string, { owner: boolean; version: string; at: number }>();
  const OVERLAY_ALIVE_MS = 15_000;

  function onOverlayStatus(id: string, owner: boolean, version: string): void {
    const now = Date.now();
    overlays.set(id, { owner, version, at: now });
    updateOverlays(now);
  }

  function updateOverlays(now: number): void {
    for (const [id, o] of overlays) if (now - o.at > OVERLAY_ALIVE_MS) overlays.delete(id);
    const list = [...overlays.values()];
    const patch = {
      overlays: list.length,
      soundOverlays: list.filter((o) => o.owner).length,
      overlayVersions: [...new Set(list.map((o) => o.version))].sort().join(', '),
    };
    const info = stores.youtube.get();
    if (info.overlays !== patch.overlays || info.soundOverlays !== patch.soundOverlays || info.overlayVersions !== patch.overlayVersions) {
      stores.youtube.set((s) => ({ ...s, ...patch }));
    }
  }

  /** Паведамленне плэера оверлэя: ход відэа, канец, памылка. */
  function onVideoReport(report: vd.VideoReport): void {
    const now = Date.now();
    if (now - stores.youtube.get().playerSeenAt >= 1000) stores.youtube.set((s) => ({ ...s, playerSeenAt: now }));
    if (!report.key) return;
    const result = vd.applyReport(player.get(), report, now);
    if (result.state !== player.get()) player.set(result.state);
    if (result.ad) {
      if (now - stores.youtube.get().lastAdAt > 2000) stores.youtube.set((s) => ({ ...s, ads: s.ads + 1, lastAdAt: now }));
      if (settings.get().video.skipAds) finishVideo('ad');
      return;
    }
    if (result.ended) finishVideo('ended');
    else if (result.failed) finishVideo('failed');
  }

  /** Відэа з мінулага запуску або ад папярэдняга лідара: стан відэа павінен быць, а даўно забытае відэа — не працягваем. */
  function resumeSavedVideo(): void {
    const s = player.get();
    if (!s.current || !isVideo(s.current.track)) return;
    const now = Date.now();
    if (!s.video || s.video.key !== s.current.key) {
      player.set({ ...s, video: { key: s.current.key, resume: 'next', startedAt: now, reportAt: 0, seek: 0, spotifyPaused: false, started: false } });
      return;
    }
    if (now - Math.max(s.video.startedAt, s.video.reportAt) < VIDEO_STALE_ON_START_MS) return;
    // OBS быў зачынены: відэа ў гісторыю, Spotify не чапаем (стрымер уключыць музыку сам).
    if (!s.video.started && s.current.redemptionId) twitch.failed(s.current.redemptionId, s.current.track.title);
    const ended = vd.endVideo(s);
    if (ended) player.set(ended.state);
  }

  function onTick(): void {
    const now = Date.now();
    const delta = now - lastTickAt;
    lastTickAt = now;
    const video = vd.currentVideo(player.get());
    if (video) {
      // Час відэа паміж паведамленнямі плэера (раз у секунду) лічым самі — для дока.
      player.set((s) => q.advanceProgress(s, delta));
      if (vd.videoStalled(player.get(), now, options.videoSilenceMs) || vd.videoNotStarting(player.get(), now, options.videoStartMs)) {
        finishVideo('stalled');
      }
    }
    if (spotifyMode) {
      if (!video) player.set((s) => q.advanceProgress(s, delta));
      const state = player.get();
      const first = state.requests[0];
      const waiting = !vd.currentVideo(state) && Boolean(first && ((first.track.uri && first.sentAt === undefined) || isVideo(first.track)));
      spotify.setRequestWaiting(waiting);
      spotify.tick(now);
      const toStart = vd.videoToStart(player.get());
      if (toStart) startVideoNow(toStart.key, 'next');
      else sendNextRequest(now);
      checkSpotifyWindow(now);
    } else if (!video) {
      player.set((s) => q.tick(s, delta));
      if (options.demo && player.get().context.length < CONTEXT_MIN) void refillContext();
    }
    if (loaded) twitch.tick(now);
    checkOverlaySource(now);
    if (overlays.size && now - lastHeartbeatAt >= HEARTBEAT_MS) updateOverlays(now);
    if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
      lastHeartbeatAt = now;
      checkSpotify();
      checkTwitch();
      sendState(true);
      send({ type: 'ping', at: now });
      updateChannel();
    }
    if (now - lastPersistAt >= PERSIST_MS) persist();
  }

  /**
   * Змена загалоўка акна Spotify (іншая песня, паўза, Spotify адкрыты/закрыты) — сігнал апытаць Spotify адразу,
   * не чакаючы планавага апытання. Калі ў OBS няма патрэбнай крыніцы — проста апытанне па раскладзе.
   */
  function checkSpotifyWindow(now: number): void {
    if (!windowReader || windowBusy || now < nextWindowCheckAt) return;
    windowBusy = true;
    const reader = windowReader;
    void reader
      .read()
      .then((result) => {
        if (reader !== windowReader || !spotifyMode) return;
        const key = `${result.status}|${result.title ?? ''}`;
        if (lastWindowKey !== null && key !== lastWindowKey) spotify.nudge();
        lastWindowKey = key;
        spotify.setWindowWatched(result.status === 'ok' || result.status === 'no-window');
        if (stores.spotify.get().windowWatch !== result.status) stores.spotify.set((s) => ({ ...s, windowWatch: result.status }));
        nextWindowCheckAt = Date.now() + (result.status === 'no-source' ? WINDOW_CHECK_IDLE_MS : WINDOW_CHECK_MS);
      })
      .catch(() => {
        spotify.setWindowWatched(false);
        nextWindowCheckAt = Date.now() + WINDOW_CHECK_IDLE_MS;
      })
      .finally(() => {
        windowBusy = false;
      });
  }

  /** Крыніца OBS з оверлэем: па яе ўзроўні гуку хваля рэагуе на відэа (ADR-020). */
  function checkOverlaySource(now: number): void {
    const client = obs;
    if (!client || client.getStatus() !== 'connected' || overlaySourceBusy || now < nextOverlaySourceCheckAt) return;
    overlaySourceBusy = true;
    void findOverlaySource(client)
      .then((found) => {
        if (obs !== client) return;
        const info = stores.youtube.get();
        const name = found?.name ?? '';
        const audio = found?.audio ?? false;
        if (info.overlaySource !== name || info.overlayAudio !== audio) stores.youtube.set((s) => ({ ...s, overlaySource: name, overlayAudio: audio }));
      })
      .catch(() => undefined)
      .finally(() => {
        overlaySourceBusy = false;
        nextOverlaySourceCheckAt = Date.now() + OVERLAY_SOURCE_CHECK_MS;
      });
  }

  /** Крыніца гуку для хвалі зараз: падчас відэа — гук відэа (выбраны ў наладах або знойдзены сам), інакш — музыка. */
  function levelSource(): string {
    const s = settings.get();
    if (!vd.currentVideo(player.get())) return s.audioSource;
    if (s.video.audioSource) return s.video.audioSource;
    const info = stores.youtube.get();
    if (info.overlaySource && info.overlayAudio) return info.overlaySource;
    // Гуку відэа ў OBS няма — хваля рухаецца сама, пакуль відэа грае.
    return SIMULATED_AUDIO;
  }

  /**
   * Заказ гледача (тэставы з дока або за баллы з Twitch): пошук трэка або відэа, праверка правілаў, у канец нашай чаргі.
   * Вынік бачны ў доку; для Twitch з яго робяцца «выканана» / вяртанне баллаў і паведамленне ў чат (ADR-018).
   * `null` — мозг спыніўся, пакуль ішоў пошук (заказ Twitch апрацуе новы лідар).
   */
  async function processRequest(request: SongRequest): Promise<RequestOutcome | null> {
    const outcome = await findAndAdd(request);
    if (outcome) showNotice(noticeText(request, outcome), outcome.ok ? 'ok' : 'error');
    return outcome;
  }

  /** Песня або відэа: узнагарода вызначае гэта для Twitch, а тэставая замова — па спасылцы. */
  function kindOf(request: SongRequest): RequestKind {
    if (request.kind) return request.kind;
    return parseYouTubeLink(request.query) ? 'video' : 'song';
  }

  async function findTrack(request: SongRequest, kind: RequestKind): Promise<{ track: Track } | RequestOutcome | null> {
    if (kind === 'video') {
      const videoId = parseYouTubeLink(request.query);
      if (!videoId) return { ok: false, reason: 'not-youtube', video: true };
      if (!spotifyMode && request.redemptionId) return { ok: false, reason: 'spotify-off', video: true };
      const found = await findVideo(videoId, { fetch: youtubeFetch, probe: videoProbe });
      if (!running) return null;
      return found.ok ? { track: found.track } : { ok: false, reason: found.reason, video: true };
    }
    // Спасылка на YouTube ва ўзнагародзе песні — падказка, што для відэа ёсць свая ўзнагарода.
    if (request.redemptionId && mentionsYouTube(request.query)) return { ok: false, reason: 'youtube-link' };
    if (spotifyMode) {
      const found = await spotify.search(request.query);
      if (!running) return null;
      if (!found.ok && found.reason === 'failed') return { ok: false, reason: 'spotify-failed' };
      return found.ok ? { track: found.track } : { ok: false, reason: 'not-found' };
    }
    // Без Spotify — толькі выдуманыя трэкі: за баллы такое не дадаём.
    if (request.redemptionId) return { ok: false, reason: 'spotify-off' };
    const track = await provider.searchTrack(request.query);
    if (!running) return null;
    return track ? { track } : { ok: false, reason: 'not-found' };
  }

  async function findAndAdd(request: SongRequest): Promise<RequestOutcome | null> {
    const kind = kindOf(request);
    const found = await findTrack(request, kind);
    if (!found || 'ok' in found) return found;
    const { track } = found;
    const video = isVideo(track) || undefined;
    const rules = settings.get().rules;
    const check = checkRequest(rules, player.get(), track, request.user);
    if (!check.ok) {
      const max = check.reason === 'too-long' ? maxDurationFor(rules, track) : rules.maxPerUser;
      return { ok: false, reason: check.reason, title: track.title, max, video };
    }
    const item = makeItem(track, request.user, request.redemptionId);
    player.set((s) => (spotifyMode || video ? rq.appendRequest(s, item) : q.addRequest(s, item)));
    // Захоўваем адразу: заказ за баллы не павінен згубіцца, калі лідар знікне.
    persist();
    return { ok: true, title: track.title, artist: track.artist, n: Math.max(player.get().requests.length, 1), video };
  }

  function noticeText(request: SongRequest, outcome: RequestOutcome): string {
    const { user, query } = request;
    if (outcome.ok) return t('player.added', { user, title: outcome.title, n: outcome.n });
    switch (outcome.reason) {
      case 'not-found':
        return t('player.notFound', { user, query });
      case 'spotify-failed':
        return t('player.searchFailed', { user, query });
      case 'too-long':
        if (outcome.video) return t('player.rejected.video-too-long', { user, title: outcome.title ?? '', max: outcome.max ?? 0 });
        return rejectText(outcome.reason, user, outcome.title ?? '');
      case 'explicit':
      case 'user-limit':
      case 'duplicate':
        return rejectText(outcome.reason, user, outcome.title ?? '');
      case 'empty':
        return t('player.emptyRequest', { user });
      case 'not-youtube':
      case 'youtube-link':
      case 'video-not-found':
      case 'not-embeddable':
      case 'live':
      case 'youtube-failed':
        return t(`player.video.${outcome.reason}`, { user, query });
      default:
        return t('player.spotifyOffRequest', { user, query });
    }
  }

  function rejectText(reason: RejectReason, user: string, title: string): string {
    const rules = settings.get().rules;
    const max = reason === 'too-long' ? rules.maxDurationMin : rules.maxPerUser;
    return t(`player.rejected.${reason}`, { user, title, max });
  }

  // --- OBS ---

  function connectObs(): void {
    disconnectObs();
    const { url, password } = settings.get().obs;
    const client = new ObsClient({
      url,
      password,
      eventSubscriptions: EventSubscription.General | EventSubscription.InputVolumeMeters,
    });
    obs = client;
    client.onStatus((status, detail) => {
      if (obs !== client) return;
      stores.obs.set({ status, detail, version: client.obsWebSocketVersion });
      if (status === 'connected') {
        if (!settings.get().obs.autoConnect) updateSettings((s) => ({ ...s, obs: { ...s.obs, autoConnect: true } }));
        windowReader = createSpotifyWindowReader(client);
        lastWindowKey = null;
        nextWindowCheckAt = 0;
        nextOverlaySourceCheckAt = 0;
        void sender.attach(client, envelope({ type: 'ping', at: Date.now() })).then(() => {
          if (obs !== client) return;
          updateChannel();
          sendState(true);
        });
      } else {
        windowReader = null;
        spotify.setWindowWatched(false);
        stores.spotify.set((s) => (s.windowWatch === 'unknown' ? s : { ...s, windowWatch: 'unknown' }));
        sender.detach();
        updateChannel();
      }
    });
    client.on('InputVolumeMeters', (data) => {
      options.onObsEvent?.();
      const inputs = (data as unknown as InputVolumeMetersEvent).inputs ?? [];
      const levels: Record<string, number> = {};
      for (const input of inputs) levels[input.inputName] = levelFromMeters(input.inputLevelsMul);
      stores.meters.set(levels);
      const source = levelSource();
      if (source && source !== SIMULATED_AUDIO) {
        let gain = autoGains.get(source);
        if (!gain) autoGains.set(source, (gain = createAutoGain()));
        const input = inputs.find((i) => i.inputName === source);
        sendLevel(gain.level(input ? dbFromMeters(input.inputLevelsMul) : -Infinity, Date.now()));
      }
    });
    client.connect();
  }

  function disconnectObs(): void {
    obs?.disconnect();
    obs = null;
    windowReader = null;
    sender.detach();
    updateChannel();
    stores.obs.set({ status: 'disconnected', detail: '', version: '' });
    stores.meters.set({});
  }

  async function seedDemo(): Promise<void> {
    const initial = await provider.nextContextTracks(CONTEXT_MIN + 1);
    player.set((s) => {
      let next = q.appendContext(s, initial.map((tr) => makeItem(tr)));
      next = q.skipNext(next);
      next = { ...next, isPlaying: true };
      next = q.addRequest(next, makeItem(MOCK_REQUEST_TRACKS[0], MOCK_VIEWERS[0]));
      return q.addRequest(next, makeItem(MOCK_REQUEST_TRACKS[1], MOCK_VIEWERS[1]));
    });
  }

  function execute(command: Command): void {
    if (!running) return;
    const video = vd.currentVideo(player.get());
    switch (command.type) {
      case 'toggle-play': {
        // Відэа ставіць на паўзу плэер оверлэя: ён сочыць за `isPlaying` (ADR-020).
        if (!spotifyMode || video) return player.set(q.togglePlay);
        // Адразу паказваем паўзу/працяг, а калі Spotify не паслухаўся — вяртаем як было.
        const wasPlaying = player.get().isPlaying;
        player.set(q.togglePlay);
        void spotify.command(wasPlaying ? 'pause' : 'play').then((ok) => {
          if (!ok && running) player.set((s) => ({ ...s, isPlaying: wasPlaying }));
        });
        return;
      }
      case 'next':
      case 'previous': {
        if (video) return command.type === 'next' ? finishVideo('next') : player.set(vd.restartVideo);
        const first = player.get().requests[0];
        if (command.type === 'next' && first && isVideo(first.track)) return startVideoNow(first.key, 'next');
        if (!spotifyMode) return player.set(command.type === 'next' ? q.skipNext : q.skipPrevious);
        // Наступная — першы заказ гледача, калі ён ёсць (як у чарзе дока і оверлея).
        if (command.type === 'next' && first?.track.uri) return playRequestNow(first.key);
        // Паказваем вынік адразу (наступная — з чаргі, папярэдняя — з гісторыі), Spotify пацвердзіць або выправіць.
        player.set((s) => optimisticSkip(s, command.type));
        void spotify.command(command.type).then((ok) => {
          if (!ok) spotify.nudge();
        });
        return;
      }
      case 'volume':
        if (spotifyMode) spotify.setVolume(command.value);
        return;
      case 'play-now': {
        const item = player.get().requests.find((r) => r.key === command.key);
        if (spotifyMode || video || (item && isVideo(item.track))) return playRequestNow(command.key);
        return player.set((s) => q.playNow(s, command.key));
      }
      case 'remove': {
        // Заказ за баллы прыбралі — глядачу вяртаюцца баллы (ADR-018).
        const item = player.get().requests.find((r) => r.key === command.key);
        if (item?.redemptionId) twitch.removed(item.redemptionId, item.track.title);
        player.set((s) => (spotifyMode ? rq.removeRequest(s, command.key) : q.removeRequest(s, command.key)));
        return persist();
      }
      case 'save-current': {
        const track = player.get().current?.track;
        if (spotifyMode && track?.uri && canSave(track)) void spotify.save(track.uri);
        return;
      }
      case 'spotify-disconnect':
        clearTokens(storage);
        if (spotifyMode) leaveSpotify();
        return;
      case 'twitch-disconnect':
        twitchDisconnecting = true;
        void twitch.disconnect().finally(() => {
          twitchDisconnecting = false;
          stores.twitch.set(initialTwitchInfo('off'));
        });
        return;
      case 'test-request': {
        const user = MOCK_VIEWERS[Math.floor(Math.random() * MOCK_VIEWERS.length)];
        // Са Spotify — сапраўдныя трэкі праз пошук і відэа YouTube (па чарзе); без яго — выдуманыя.
        if (spotifyMode) {
          const query = SPOTIFY_TEST_QUERIES[testQueryIndex++ % SPOTIFY_TEST_QUERIES.length];
          return requestSource.simulate({ user, query });
        }
        const track = MOCK_REQUEST_TRACKS[Math.floor(Math.random() * MOCK_REQUEST_TRACKS.length)];
        return requestSource.simulate({ user, query: `${track.artist} ${track.title}` });
      }
      case 'overlay-status':
        return onOverlayStatus(command.id, command.owner, command.version);
      case 'video-report': {
        const { type: _, ...report } = command;
        return onVideoReport(report);
      }
      case 'obs-connect':
        return connectObs();
      case 'obs-disconnect':
        disconnectObs();
        return updateSettings((s) => ({ ...s, obs: { ...s.obs, autoConnect: false } }));
    }
  }

  return {
    execute,

    async start() {
      running = true;
      lastTickAt = Date.now();
      // Стан папярэдняга лідара (або з мінулага запуску OBS); калі яго няма — тэставыя даныя.
      const saved = loadPlayer(storage);
      if (saved) player.set(saved);
      else if (options.demo) await seedDemo();
      if (!running) return;
      loaded = true;
      resumeSavedVideo();
      stores.spotify.set((s) => ({ ...s, requestsToday: counter.get() }));
      checkSpotify();
      checkTwitch();
      persist();
      requestSource.start((request) => void processRequest(request));
      stopFns.push(player.subscribe(() => sendState()));
      const ticker = startTicker(TICK_MS, onTick);
      stopFns.push(() => ticker.stop());
      // Імітацыя гуку — асобны таймер з той жа частатой, што і InputVolumeMeters (~50 мс): для «Імітацыі рытму»
      // і для відэа, гук якога OBS не бачыць.
      const simTicker = startTicker(SIMULATED_AUDIO_MS, () => {
        const source = levelSource();
        if (source === SIMULATED_AUDIO) sendLevel(player.get().isPlaying ? simulatedLevel(Date.now()) : 0);
        else if (!source) sendLevel(0);
      });
      stopFns.push(() => simTicker.stop());
      sendState(true);
      if (settings.get().obs.autoConnect) connectObs();
    },

    stop() {
      if (!running) return;
      running = false;
      spotify.stop();
      // Старонка зачыняецца — узнагароду на паўзу; новы лідар (калі ён ёсць) зніме паўзу праз некалькі секунд.
      twitch.stop(true);
      for (const f of stopFns.splice(0)) f();
      requestSource.stop();
      persist();
      disconnectObs();
      sender.close();
    },
  };
}

export type Brain = ReturnType<typeof createBrain>;
