// «Мозг» прыкладання (ADR-015): стан плэера і чаргі, заказы, Spotify (ADR-016), падключэнне да OBS, адпраўка стану ў оверлей.
// Працуе толькі ў старонцы-лідары (док або оверлей). Стан піша ў агульныя сховішчы старонкі,
// а старонка (node.ts) рассылае яго астатнім.

import { createEnvelopeFactory, type OverlayMessage } from '../core/messages';
import * as q from '../core/queue';
import * as rq from '../core/requests';
import { checkRequest, type RejectReason } from '../core/rules';
import { SIMULATED_AUDIO, type Settings } from '../core/settings';
import type { Store } from '../core/store';
import { startTicker } from '../core/ticker';
import type { PlayerState, QueueItem, Track } from '../core/types';
import { t } from '../i18n';
import { levelFromMeters, simulatedLevel } from '../obs/audio';
import { OverlaySender } from '../obs/channel';
import { ObsClient } from '../obs/client';
import { EventSubscription, type InputVolumeMetersEvent } from '../obs/protocol';
import { createMockProvider, MOCK_REQUEST_TRACKS, MOCK_VIEWERS, SPOTIFY_TEST_QUERIES, type MusicProvider } from '../providers/spotify';
import { createSpotifyApi } from '../providers/spotify/api';
import { clearTokens, hasTokens, saveLoginResult, type FetchLike } from '../providers/spotify/auth';
import { applyPlayback, canSave, optimisticSkip } from '../providers/spotify/map';
import { createSpotifyWindowReader } from '../obs/spotify-window';
import { createRequestCounter, createSpotifySync, initialSpotifyInfo, type SpotifyInfo } from '../providers/spotify/sync';
import { createMockRequestSource, type SongRequest } from '../sources/twitch';
import type { ChannelInfo, Command, Notice, ObsInfo } from './bus';
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
}

export function createBrain(options: BrainOptions) {
  const { storage, stores, updateSettings } = options;
  const { settings, player } = stores;
  const provider = options.provider ?? createMockProvider();
  const requestSource = createMockRequestSource();
  const sender = new OverlaySender();
  const envelope = createEnvelopeFactory(options.id);

  let obs: ObsClient | null = null;
  let windowReader: ReturnType<typeof createSpotifyWindowReader> | null = null;
  let windowBusy = false;
  let nextWindowCheckAt = 0;
  /** Апошні вядомы стан акна Spotify (`null` — яшчэ не правяралі). */
  let lastWindowKey: string | null = null;
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
      const before = player.get();
      player.set((s) => applyPlayback(s, playback, queue));
      skipRemovedRequest();
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

  function enterSpotify(): void {
    spotifyMode = true;
    // Тэставыя трэкі (без Spotify URI) у Spotify не адправіш — прыбіраем іх.
    player.set((s) => ({
      ...s,
      current: s.current?.track.uri ? s.current : null,
      isPlaying: Boolean(s.current?.track.uri) && s.isPlaying,
      requests: s.requests.filter((r) => r.track.uri),
      context: s.context.filter((c) => c.track.uri),
      history: [],
    }));
    spotify.start();
  }

  function leaveSpotify(): void {
    spotifyMode = false;
    spotify.stop();
    stores.spotify.set({ ...initialSpotifyInfo('off'), requestsToday: counter.get() });
    player.set((s) => ({ ...s, current: null, isPlaying: false, progressMs: 0, context: [], history: [] }));
  }

  /** Токены з'явіліся (уваход на старонцы вяртання) або зніклі — пераключаем рэжым. */
  function checkSpotify(): void {
    const connected = hasTokens(storage);
    if (connected && !spotifyMode) enterSpotify();
    else if (!connected && spotifyMode) leaveSpotify();
  }

  // Ключ запісу павінен быць унікальны і пасля змены лідара, таму ў ім ідэнтыфікатар старонкі.
  const makeItem = (track: Track, requestedBy?: string): QueueItem => ({
    key: `${track.id}#${options.id}-${++keyCounter}`,
    track,
    ...(requestedBy ? { requestedBy } : {}),
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

  /** Заказ пачынае граць зараз: у Spotify — праз чаргу і «наступная» (ADR-007, ADR-017). */
  function playRequestNow(key: string): void {
    const before = player.get();
    const item = before.requests.find((r) => r.key === key);
    if (!item?.track.uri) return;
    const skips = rq.skipsToReach(before, key);
    const enqueue = item.sentAt === undefined;
    player.set((s) => rq.startRequest(s, key));
    persist();
    void spotify.playUri(item.track.uri, { enqueue, skips }).then((ok) => {
      if (ok || !running) return;
      // Spotify не паслухаўся — вяртаем заказы як былі (тыя, што яшчэ ёсць), песню скажа апытанне.
      player.set((s) => {
        const keys = new Set([...s.requests.map((r) => r.key), key]);
        const extra = s.requests.filter((r) => !before.requests.some((b) => b.key === r.key));
        return { ...s, requests: [...before.requests.filter((r) => keys.has(r.key)), ...extra] };
      });
      spotify.nudge();
    });
  }

  function onTick(): void {
    const now = Date.now();
    const delta = now - lastTickAt;
    lastTickAt = now;
    if (spotifyMode) {
      player.set((s) => q.advanceProgress(s, delta));
      const first = player.get().requests[0];
      spotify.setRequestWaiting(Boolean(first?.track.uri && first.sentAt === undefined));
      spotify.tick(now);
      sendNextRequest(now);
      checkSpotifyWindow(now);
    } else {
      player.set((s) => q.tick(s, delta));
      if (options.demo && player.get().context.length < CONTEXT_MIN) void refillContext();
    }
    if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
      lastHeartbeatAt = now;
      checkSpotify();
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

  /** Заказ гледача: пошук трэка, праверка правілаў, у канец нашай чаргі. Адмова — паведамленне ў доку (на Этапе 4 — у чат). */
  async function handleRequest(request: SongRequest): Promise<void> {
    let track: Track | null;
    if (spotifyMode) {
      const found = await spotify.search(request.query);
      if (!running) return;
      if (!found.ok && found.reason === 'failed') {
        showNotice(t('player.searchFailed', { user: request.user, query: request.query }), 'error');
        return;
      }
      track = found.ok ? found.track : null;
    } else {
      track = await provider.searchTrack(request.query);
      if (!running) return;
    }
    if (!track) {
      showNotice(t('player.notFound', { user: request.user, query: request.query }), 'error');
      return;
    }
    const check = checkRequest(settings.get().rules, player.get(), track, request.user);
    if (!check.ok) {
      showNotice(rejectText(check.reason, request.user, track.title), 'error');
      return;
    }
    const item = makeItem(track, request.user);
    player.set((s) => (spotifyMode ? rq.appendRequest(s, item) : q.addRequest(s, item)));
    const n = player.get().requests.length;
    showNotice(t('player.added', { user: request.user, title: track.title, n: Math.max(n, 1) }));
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
      const source = settings.get().audioSource;
      if (source && source !== SIMULATED_AUDIO) sendLevel(levels[source] ?? 0);
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
    switch (command.type) {
      case 'toggle-play': {
        if (!spotifyMode) return player.set(q.togglePlay);
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
        if (!spotifyMode) return player.set(command.type === 'next' ? q.skipNext : q.skipPrevious);
        // Наступная — першы заказ гледача, калі ён ёсць (як у чарзе дока і оверлея).
        const first = player.get().requests[0];
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
      case 'play-now':
        if (spotifyMode) return playRequestNow(command.key);
        return player.set((s) => q.playNow(s, command.key));
      case 'remove':
        return player.set((s) => (spotifyMode ? rq.removeRequest(s, command.key) : q.removeRequest(s, command.key)));
      case 'save-current': {
        const track = player.get().current?.track;
        if (spotifyMode && track?.uri && canSave(track)) void spotify.save(track.uri);
        return;
      }
      case 'spotify-disconnect':
        clearTokens(storage);
        if (spotifyMode) leaveSpotify();
        return;
      case 'test-request': {
        const user = MOCK_VIEWERS[Math.floor(Math.random() * MOCK_VIEWERS.length)];
        // Са Spotify — сапраўдныя трэкі праз пошук (па чарзе: спасылкі і назвы); без яго — выдуманыя.
        if (spotifyMode) {
          const query = SPOTIFY_TEST_QUERIES[testQueryIndex++ % SPOTIFY_TEST_QUERIES.length];
          return requestSource.simulate({ user, query });
        }
        const track = MOCK_REQUEST_TRACKS[Math.floor(Math.random() * MOCK_REQUEST_TRACKS.length)];
        return requestSource.simulate({ user, query: `${track.artist} ${track.title}` });
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
      stores.spotify.set((s) => ({ ...s, requestsToday: counter.get() }));
      checkSpotify();
      persist();
      requestSource.start((request) => void handleRequest(request));
      stopFns.push(player.subscribe(() => sendState()));
      const ticker = startTicker(TICK_MS, onTick);
      stopFns.push(() => ticker.stop());
      // Імітацыя гуку — асобны таймер з той жа частатой, што і InputVolumeMeters (~50 мс).
      let simTicker: { stop(): void } | null = null;
      const applyAudioSource = (s: Settings) => {
        const simulated = s.audioSource === SIMULATED_AUDIO;
        if (simulated && !simTicker) {
          simTicker = startTicker(SIMULATED_AUDIO_MS, () =>
            sendLevel(player.get().isPlaying ? simulatedLevel(Date.now()) : 0),
          );
        } else if (!simulated && simTicker) {
          simTicker.stop();
          simTicker = null;
        }
        if (!s.audioSource) sendLevel(0);
      };
      applyAudioSource(settings.get());
      stopFns.push(settings.subscribe(applyAudioSource), () => simTicker?.stop());
      sendState(true);
      if (settings.get().obs.autoConnect) connectObs();
    },

    stop() {
      if (!running) return;
      running = false;
      spotify.stop();
      for (const f of stopFns.splice(0)) f();
      requestSource.stop();
      persist();
      disconnectObs();
      sender.close();
    },
  };
}

export type Brain = ReturnType<typeof createBrain>;
