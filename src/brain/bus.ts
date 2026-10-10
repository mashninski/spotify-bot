// Шына паміж старонкамі прыкладання (ADR-015): лідар рассылае стан, астатнія старонкі шлюць яму каманды.
// Працуе праз BroadcastChannel — у OBS 32 ён агульны для дока і Browser Source (праверана аўтарам).

import type { PlayerState } from '../core/types';
import type { ObsChannelMode } from '../obs/channel';
import type { ObsStatus } from '../obs/client';
import type { SpotifyInfo } from '../providers/spotify/sync';

export const BUS_NAME = 'spotify-bot:brain';
export const BUS_VERSION = 1;

export type PageKind = 'dock' | 'overlay';

export interface LeaderInfo {
  /** Ідэнтыфікатар старонкі-лідара (новы пры кожнай загрузцы старонкі). */
  id: string;
  page: PageKind;
  /** Калі старонка стала лідарам. */
  since: number;
  /** Ці выбіраецца лідар праз Web Locks (без іх лідарам можа быць толькі док). */
  locks: boolean;
}

export interface ObsInfo {
  status: ObsStatus;
  detail: string;
  version: string;
}

export interface ChannelInfo {
  mode: ObsChannelMode;
  sent: number;
  errors: number;
  lastError: string;
}

export interface Notice {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}

/** Каманды, якія старонкі шлюць лідару. */
export type Command =
  | { type: 'toggle-play' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'play-now'; key: string }
  | { type: 'remove'; key: string }
  | { type: 'test-request' }
  | { type: 'obs-connect' }
  | { type: 'obs-disconnect' }
  /** «+»: дадаць бягучую песню ў «Любімыя трэкі» Spotify. */
  | { type: 'save-current' }
  | { type: 'spotify-disconnect' };

/** Усё, што лідар паказвае іншым старонкам. Гісторыя песень не перадаецца — яна патрэбна толькі лідару. */
export interface BrainSnapshot {
  leader: LeaderInfo;
  player: PlayerState;
  obs: ObsInfo;
  channel: ChannelInfo;
  spotify: SpotifyInfo;
}

export type BusMessage =
  /** Новая старонка просіць лідара адразу даслаць стан. */
  | { kind: 'hello' }
  | { kind: 'command'; command: Command }
  | { kind: 'snapshot'; snapshot: BrainSnapshot }
  /** Узровень гуку крыніц OBS (для выбару крыніцы ў наладах). */
  | { kind: 'meters'; meters: Record<string, number> }
  | { kind: 'notice'; notice: Notice }
  /** Налады змяніліся ў localStorage — перачытаць. */
  | { kind: 'settings' };

export interface BusEnvelope {
  app: typeof BUS_NAME;
  v: typeof BUS_VERSION;
  /** Ідэнтыфікатар старонкі-адпраўніка. */
  from: string;
  msg: BusMessage;
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

const SIMPLE_COMMANDS = new Set([
  'toggle-play',
  'next',
  'previous',
  'test-request',
  'obs-connect',
  'obs-disconnect',
  'save-current',
  'spotify-disconnect',
]);

export function parseCommand(raw: unknown): Command | null {
  if (!isObject(raw) || typeof raw.type !== 'string') return null;
  if (SIMPLE_COMMANDS.has(raw.type)) return { type: raw.type } as Command;
  if ((raw.type === 'play-now' || raw.type === 'remove') && typeof raw.key === 'string') {
    return { type: raw.type, key: raw.key };
  }
  return null;
}

/**
 * Правярае паведамленне шыны. Паведамленні прыходзяць толькі ад нашых жа старонак (той жа origin),
 * таму глыбока правяраюцца толькі каманды — яны мяняюць стан лідара.
 */
export function parseBusEnvelope(raw: unknown): BusEnvelope | null {
  if (!isObject(raw) || raw.app !== BUS_NAME || raw.v !== BUS_VERSION || typeof raw.from !== 'string') return null;
  const msg = raw.msg;
  if (!isObject(msg)) return null;
  const base = { app: BUS_NAME, v: BUS_VERSION, from: raw.from } as const;
  switch (msg.kind) {
    case 'hello':
    case 'settings':
      return { ...base, msg: { kind: msg.kind } };
    case 'command': {
      const command = parseCommand(msg.command);
      return command ? { ...base, msg: { kind: 'command', command } } : null;
    }
    case 'snapshot':
      return isObject(msg.snapshot) && isObject(msg.snapshot.leader) && isObject(msg.snapshot.player)
        ? { ...base, msg: { kind: 'snapshot', snapshot: msg.snapshot as BrainSnapshot } }
        : null;
    case 'meters':
      return isObject(msg.meters) ? { ...base, msg: { kind: 'meters', meters: msg.meters } } : null;
    case 'notice':
      return isObject(msg.notice) && typeof msg.notice.text === 'string'
        ? { ...base, msg: { kind: 'notice', notice: msg.notice as Notice } }
        : null;
    default:
      return null;
  }
}

/** Шына старонкі. У тэстах працуе праз BroadcastChannel з Node. */
export class Bus {
  private readonly channel: BroadcastChannel | null;
  private readonly listeners = new Set<(env: BusEnvelope) => void>();

  constructor(
    readonly from: string,
    name = BUS_NAME,
  ) {
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name);
    if (this.channel) {
      this.channel.onmessage = (event) => {
        const env = parseBusEnvelope(event.data);
        if (!env || env.from === this.from) return;
        for (const l of [...this.listeners]) l(env);
      };
    }
  }

  get available(): boolean {
    return this.channel !== null;
  }

  post(msg: BusMessage): void {
    try {
      this.channel?.postMessage({ app: BUS_NAME, v: BUS_VERSION, from: this.from, msg } satisfies BusEnvelope);
    } catch {
      // Шына зачынена (старонка выгружаецца) — паведамленне проста губляецца.
    }
  }

  onMessage(listener: (env: BusEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.channel?.close();
  }
}
