// Правілы замоў песень і відэа (PROJECT.md, MVP п. 4; ADR-020). Значэнні мяняюцца ў наладах дока.

import { isVideo, type PlayerState, type Track } from './types';

export interface RequestRules {
  /** Кошт замовы песні ў балах канала. */
  price: number;
  /** Максімальная даўжыня песні, хвіліны. */
  maxDurationMin: number;
  /** Колькі замоў аднаго гледача (песні і відэа разам) можа быць у чарзе адначасова. */
  maxPerUser: number;
  allowExplicit: boolean;
  /** Кошт замовы відэа YouTube у балах канала. */
  videoPrice: number;
  /** Максімальная даўжыня відэа, хвіліны. */
  videoMaxDurationMin: number;
}

export const DEFAULT_RULES: RequestRules = {
  price: 1000,
  maxDurationMin: 12,
  maxPerUser: 2,
  allowExplicit: true,
  videoPrice: 1000,
  videoMaxDurationMin: 12,
};

export type RejectReason = 'too-long' | 'explicit' | 'user-limit' | 'duplicate';

export type RuleCheck = { ok: true } | { ok: false; reason: RejectReason };

const sameUser = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Найбольшая даўжыня для гэтага трэка (песні і відэа — асобна), хвіліны. */
export const maxDurationFor = (rules: RequestRules, track: Pick<Track, 'source'>) =>
  isVideo(track) ? rules.videoMaxDurationMin : rules.maxDurationMin;

/** Ці можна дадаць замову. Правяраецца чарга замоў і замова, якая грае зараз (не кантэкст плэйліста). */
export function checkRequest(rules: RequestRules, state: PlayerState, track: Track, user: string): RuleCheck {
  if (track.durationMs > maxDurationFor(rules, track) * 60_000) return { ok: false, reason: 'too-long' };
  if (track.explicit && !rules.allowExplicit && !isVideo(track)) return { ok: false, reason: 'explicit' };
  const playingRequest = state.current?.requestedBy && state.current.track.id === track.id;
  if (playingRequest || state.requests.some((r) => r.track.id === track.id)) return { ok: false, reason: 'duplicate' };
  // Ліміт агульны для песень і відэа (ADR-020).
  const fromUser = state.requests.filter((r) => r.requestedBy && sameUser(r.requestedBy, user)).length;
  if (fromUser >= rules.maxPerUser) return { ok: false, reason: 'user-limit' };
  return { ok: true };
}
