// «Мозг» дока: стан плэера і чаргі, налады, падключэнне да OBS, адпраўка стану ў оверлей.
// UI толькі чытае сховішчы адсюль і выклікае дзеянні.

import { createEnvelopeFactory, type OverlayMessage } from '../../core/messages';
import * as q from '../../core/queue';
import { checkRequest, type RejectReason } from '../../core/rules';
import { loadSettings, safeLocalStorage, saveSettings, SIMULATED_AUDIO, type Settings } from '../../core/settings';
import { createStore } from '../../core/store';
import { startTicker } from '../../core/ticker';
import type { PlayerState, QueueItem, Track } from '../../core/types';
import { t } from '../../i18n';
import { levelFromMeters, simulatedLevel } from '../../obs/audio';
import { OverlaySender, type ObsChannelMode } from '../../obs/channel';
import { ObsClient, type ObsStatus } from '../../obs/client';
import { EventSubscription, type InputVolumeMetersEvent } from '../../obs/protocol';
import { createMockProvider, MOCK_REQUEST_TRACKS, MOCK_VIEWERS, type MusicProvider } from '../../providers/spotify';
import { createMockRequestSource, type SongRequest } from '../../sources/twitch';
import { DIAG_MARKER_KEY, randomId, REDIRECT_PENDING_KEY, REDIRECT_SERVICE, writeJson } from '../shared/diag';
import { HiddenMonitor } from './hidden-monitor';

/** Колькі трэкаў кантэксту трымаць напагатове. */
const CONTEXT_MIN = 5;
/** Як часта док паўтарае стан і сігнал «жывы» для оверлея (каб оверлей пасля перазагрузкі хутка атрымаў стан). */
const HEARTBEAT_MS = 2000;
const TICK_MS = 250;
const SIMULATED_AUDIO_MS = 50;

export interface Notice {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}

export function createDockController() {
  const storage = safeLocalStorage();
  const provider: MusicProvider = createMockProvider();
  const requestSource = createMockRequestSource();
  const sender = new OverlaySender();
  const envelope = createEnvelopeFactory(randomId());
  const monitor = new HiddenMonitor(storage);

  const settings = createStore<Settings>(loadSettings(storage));
  const player = createStore<PlayerState>(q.emptyPlayerState());
  const obsStatus = createStore<{ status: ObsStatus; detail: string; version: string }>({
    status: 'disconnected',
    detail: '',
    version: '',
  });
  const channelMode = createStore<ObsChannelMode>('none');
  /** Узровень гуку кожнай крыніцы OBS (для выбару крыніцы ў наладах). */
  const meters = createStore<Record<string, number>>({});
  const notice = createStore<Notice | null>(null);

  let obs: ObsClient | null = null;
  let keyCounter = 0;
  let lastOverlayJson = '';
  let lastLevel = -1;
  let lastTickAt = Date.now();
  let lastHeartbeatAt = 0;
  let refilling = false;
  const stopFns: (() => void)[] = [];

  const makeItem = (track: Track, requestedBy?: string): QueueItem => ({
    key: `${track.id}#${++keyCounter}`,
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

  function showNotice(text: string, kind: Notice['kind'] = 'ok'): void {
    notice.set({ id: Date.now(), text, kind });
  }

  async function refillContext(): Promise<void> {
    if (refilling || player.get().context.length >= CONTEXT_MIN) return;
    refilling = true;
    try {
      const tracks = await provider.nextContextTracks(CONTEXT_MIN - player.get().context.length);
      player.set((s) => q.appendContext(s, tracks.map((tr) => makeItem(tr))));
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
    }
  }

  function handleRequest(request: SongRequest): void {
    void provider.searchTrack(request.query).then((track) => {
      if (!track) {
        showNotice(t('player.notFound', { user: request.user, query: request.query }), 'error');
        return;
      }
      const state = player.get();
      const check = checkRequest(settings.get().rules, state, track, request.user);
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
      obsStatus.set({ status, detail, version: client.obsWebSocketVersion });
      if (status === 'connected') {
        updateSettings((s) => ({ ...s, obs: { ...s.obs, autoConnect: true } }));
        void sender.attach(client, envelope({ type: 'ping', at: Date.now() })).then((mode) => {
          channelMode.set(mode);
          sendState(true);
        });
      } else {
        sender.detach();
        channelMode.set('none');
      }
    });
    client.on('InputVolumeMeters', (data) => {
      monitor.countObsEvent();
      const inputs = (data as unknown as InputVolumeMetersEvent).inputs ?? [];
      const levels: Record<string, number> = {};
      for (const input of inputs) levels[input.inputName] = levelFromMeters(input.inputLevelsMul);
      meters.set(levels);
      const source = settings.get().audioSource;
      if (source && source !== SIMULATED_AUDIO) sendLevel(levels[source] ?? 0);
    });
    client.connect();
  }

  function disconnectObs(): void {
    obs?.disconnect();
    obs = null;
    sender.detach();
    channelMode.set('none');
    meters.set({});
  }

  function updateSettings(update: (s: Settings) => Settings): void {
    settings.set(update);
    saveSettings(storage, settings.get());
  }

  // --- Дыягностыка перанакіравання ---

  function runRedirectTest(): void {
    const nonce = randomId();
    writeJson(storage, REDIRECT_PENDING_KEY, { nonce, at: Date.now() });
    const back = new URL(`callback.html?test=redirect&nonce=${nonce}`, location.href).toString();
    location.href = `${REDIRECT_SERVICE}?url=${encodeURIComponent(back)}`;
  }

  function runPopupTest(): void {
    window.open(new URL('callback.html?test=popup', location.href).toString(), '_blank');
  }

  return {
    settings,
    player,
    obsStatus,
    channelMode,
    meters,
    notice,
    monitor,
    sender,

    async start() {
      writeJson(storage, DIAG_MARKER_KEY, Date.now());
      monitor.start();
      const initial = await provider.nextContextTracks(CONTEXT_MIN + 1);
      player.set((s) => {
        let next = q.appendContext(s, initial.map((tr) => makeItem(tr)));
        next = q.skipNext(next);
        next = { ...next, isPlaying: true };
        next = q.addRequest(next, makeItem(MOCK_REQUEST_TRACKS[0], MOCK_VIEWERS[0]));
        return q.addRequest(next, makeItem(MOCK_REQUEST_TRACKS[1], MOCK_VIEWERS[1]));
      });
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
      if (settings.get().obs.autoConnect) connectObs();
    },

    stop() {
      for (const f of stopFns.splice(0)) f();
      requestSource.stop();
      monitor.stop();
      disconnectObs();
    },

    togglePlay: () => player.set(q.togglePlay),
    next: () => player.set(q.skipNext),
    previous: () => player.set(q.skipPrevious),
    playNow: (key: string) => player.set((s) => q.playNow(s, key)),
    removeRequest: (key: string) => player.set((s) => q.removeRequest(s, key)),

    addTestRequest() {
      const track = MOCK_REQUEST_TRACKS[Math.floor(Math.random() * MOCK_REQUEST_TRACKS.length)];
      const user = MOCK_VIEWERS[Math.floor(Math.random() * MOCK_VIEWERS.length)];
      requestSource.simulate({ user, query: `${track.artist} ${track.title}` });
    },

    updateSettings,
    connectObs,
    disconnectObs,
    runRedirectTest,
    runPopupTest,
  };
}

export type DockController = ReturnType<typeof createDockController>;
