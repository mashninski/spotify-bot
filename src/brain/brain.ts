// «Мозг» прыкладання (ADR-015): стан плэера і чаргі, заказы, падключэнне да OBS, адпраўка стану ў оверлей.
// Працуе толькі ў старонцы-лідары (док або оверлей). Стан піша ў агульныя сховішчы старонкі,
// а старонка (node.ts) рассылае яго астатнім.

import { createEnvelopeFactory, type OverlayMessage } from '../core/messages';
import * as q from '../core/queue';
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
import { createMockProvider, MOCK_REQUEST_TRACKS, MOCK_VIEWERS, type MusicProvider } from '../providers/spotify';
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

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Сховішчы старонкі, у якія мозг піша свой стан. */
export interface BrainStores {
  settings: Store<Settings>;
  player: Store<PlayerState>;
  obs: Store<ObsInfo>;
  channel: Store<ChannelInfo>;
  meters: Store<Record<string, number>>;
  notice: Store<Notice | null>;
}

export interface BrainOptions {
  /** Ідэнтыфікатар старонкі: з яго пачынаюцца ключы запісаў чаргі і `sid` паведамленняў оверлею. */
  id: string;
  storage: StorageLike | null;
  stores: BrainStores;
  updateSettings(update: (s: Settings) => Settings): void;
  provider?: MusicProvider;
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
  let keyCounter = 0;
  let lastOverlayJson = '';
  let lastLevel = -1;
  let lastTickAt = Date.now();
  let lastHeartbeatAt = 0;
  let lastPersistAt = 0;
  let refilling = false;
  let running = false;
  /** Стан ужо загружаны або створаны — толькі тады яго можна захоўваць (інакш перазапішам чаргу пустой). */
  let loaded = false;
  const stopFns: (() => void)[] = [];

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
      if (running) player.set((s) => q.appendContext(s, tracks.map((tr) => makeItem(tr))));
    } finally {
      refilling = false;
    }
  }

  function onTick(): void {
    const now = Date.now();
    const delta = now - lastTickAt;
    lastTickAt = now;
    player.set((s) => q.tick(s, delta));
    if (player.get().context.length < CONTEXT_MIN) void refillContext();
    if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
      lastHeartbeatAt = now;
      sendState(true);
      send({ type: 'ping', at: now });
      updateChannel();
    }
    if (now - lastPersistAt >= PERSIST_MS) persist();
  }

  function handleRequest(request: SongRequest): void {
    void provider.searchTrack(request.query).then((track) => {
      if (!running) return;
      if (!track) {
        showNotice(t('player.notFound', { user: request.user, query: request.query }), 'error');
        return;
      }
      const check = checkRequest(settings.get().rules, player.get(), track, request.user);
      if (!check.ok) {
        showNotice(rejectText(check.reason, request.user, track.title), 'error');
        return;
      }
      player.set((s) => q.addRequest(s, makeItem(track, request.user)));
      const n = player.get().requests.length;
      showNotice(t('player.added', { user: request.user, title: track.title, n: Math.max(n, 1) }));
    });
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
        void sender.attach(client, envelope({ type: 'ping', at: Date.now() })).then(() => {
          if (obs !== client) return;
          updateChannel();
          sendState(true);
        });
      } else {
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
      case 'toggle-play':
        return player.set(q.togglePlay);
      case 'next':
        return player.set(q.skipNext);
      case 'previous':
        return player.set(q.skipPrevious);
      case 'play-now':
        return player.set((s) => q.playNow(s, command.key));
      case 'remove':
        return player.set((s) => q.removeRequest(s, command.key));
      case 'test-request': {
        const track = MOCK_REQUEST_TRACKS[Math.floor(Math.random() * MOCK_REQUEST_TRACKS.length)];
        const user = MOCK_VIEWERS[Math.floor(Math.random() * MOCK_VIEWERS.length)];
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
      else await seedDemo();
      if (!running) return;
      loaded = true;
      persist();
      requestSource.start(handleRequest);
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
      for (const f of stopFns.splice(0)) f();
      requestSource.stop();
      persist();
      disconnectObs();
      sender.close();
    },
  };
}

export type Brain = ReturnType<typeof createBrain>;
