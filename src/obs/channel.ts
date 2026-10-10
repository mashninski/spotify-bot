// Канал док → оверлей (ADR-012).
// Асноўны шлях: obs-websocket CallVendorRequest → obs-browser `emit_event` → падзея `window` ва ўсіх
// Browser Source. Оверлею не патрэбны пароль і ўласнае падключэнне.
// Запасны шлях: BroadcastCustomEvent → падзея CustomEvent (оверлей падключаецца сам, пароль у URL #hash).
// Дадаткова: BroadcastChannel — для праверкі ў звычайным браўзеры без OBS.

import { CHANNEL_NAME, Deduper, parseEnvelope, type Envelope } from '../core/messages';
import { ObsClient } from './client';
import { EventSubscription } from './protocol';

export type ObsChannelMode = 'vendor' | 'broadcast' | 'none';

export interface SenderStats {
  sent: number;
  errors: number;
  lastError: string;
}

/** Адпраўка паведамленняў з дока. */
export class OverlaySender {
  private readonly bc: BroadcastChannel | null;
  private obs: ObsClient | null = null;
  mode: ObsChannelMode = 'none';
  readonly stats: SenderStats = { sent: 0, errors: 0, lastError: '' };

  constructor() {
    this.bc = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
  }

  /** Вызначае, які шлях праз OBS працуе. Выклікаць пасля падключэння да OBS. */
  async attach(obs: ObsClient, probe: Envelope): Promise<ObsChannelMode> {
    this.obs = obs;
    try {
      await obs.call('CallVendorRequest', vendorRequest(probe));
      this.mode = 'vendor';
    } catch (e) {
      this.stats.lastError = String(e);
      try {
        await obs.call('BroadcastCustomEvent', { eventData: probe });
        this.mode = 'broadcast';
      } catch (e2) {
        this.stats.lastError = String(e2);
        this.mode = 'none';
      }
    }
    return this.mode;
  }

  detach(): void {
    this.obs = null;
    this.mode = 'none';
  }

  send(env: Envelope): void {
    this.bc?.postMessage(env);
    const obs = this.obs;
    if (!obs || this.mode === 'none' || obs.getStatus() !== 'connected') return;
    const request =
      this.mode === 'vendor'
        ? obs.call('CallVendorRequest', vendorRequest(env))
        : obs.call('BroadcastCustomEvent', { eventData: env });
    this.stats.sent++;
    request.catch((e) => {
      this.stats.errors++;
      this.stats.lastError = String(e);
    });
  }
}

function vendorRequest(env: Envelope): Record<string, unknown> {
  return {
    vendorName: 'obs-browser',
    requestType: 'emit_event',
    requestData: { event_name: CHANNEL_NAME, event_data: env },
  };
}

export type ReceiveChannel = 'obs-browser' | 'broadcast-channel' | 'custom-event';

export interface ReceiverOptions {
  /** Калі зададзена — оверлей сам падключаецца да OBS і слухае CustomEvent (запасны шлях). */
  obs?: { url: string; password: string };
  onObsStatus?: (status: string) => void;
}

/** Прыём паведамленняў у оверлеі з усіх каналаў з адкіданнем паўтораў. */
export function listenForDock(
  onEnvelope: (env: Envelope, channel: ReceiveChannel) => void,
  options: ReceiverOptions = {},
): () => void {
  const deduper = new Deduper();
  const deliver = (raw: unknown, channel: ReceiveChannel) => {
    const env = parseEnvelope(raw);
    if (env && deduper.accept(env)) onEnvelope(env, channel);
  };

  const onWindowEvent = (e: Event) => deliver((e as CustomEvent).detail, 'obs-browser');
  window.addEventListener(CHANNEL_NAME, onWindowEvent);

  const bc = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
  if (bc) bc.onmessage = (e) => deliver(e.data, 'broadcast-channel');

  let obs: ObsClient | null = null;
  if (options.obs) {
    obs = new ObsClient({ ...options.obs, eventSubscriptions: EventSubscription.General });
    obs.on('CustomEvent', (data) => deliver(data, 'custom-event'));
    if (options.onObsStatus) obs.onStatus(options.onObsStatus);
    obs.connect();
  }

  return () => {
    window.removeEventListener(CHANNEL_NAME, onWindowEvent);
    bc?.close();
    obs?.disconnect();
  };
}
