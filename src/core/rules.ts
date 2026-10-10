// Правілы заказаў песень (PROJECT.md, MVP п. 4). Значэнні мяняюцца ў наладах дока.

import type { PlayerState, Track } from './types';

export interface RequestRules {
  /** Цана заказу ў баллах канала (выкарыстоўваецца на Этапе 4). */
  price: number;
  /** Максімальная даўжыня песні, хвіліны. */
  maxDurationMin: number;
  /** Колькі песень аднаго гледача можа быць у чарзе адначасова. */
  maxPerUser: number;
  allowExplicit: boolean;
}

export const DEFAULT_RULES: RequestRules = {
  price: 1000,
  maxDurationMin: 12,
  maxPerUser: 2,
  allowExplicit: true,
};

export type RejectReason = 'too-long' | 'explicit' | 'user-limit' | 'duplicate';

export type RuleCheck = { ok: true } | { ok: false; reason: RejectReason };

const sameUser = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Ці можна дадаць заказ. Правяраецца чарга заказаў і заказ, які грае зараз (не кантэкст плэйліста). */
export function checkRequest(rules: RequestRules, state: PlayerState, track: Track, user: string): RuleCheck {
  if (track.durationMs > rules.maxDurationMin * 60_000) return { ok: false, reason: 'too-long' };
  if (track.explicit && !rules.allowExplicit) return { ok: false, reason: 'explicit' };
  const playingRequest = state.current?.requestedBy && state.current.track.id === track.id;
  if (playingRequest || state.requests.some((r) => r.track.id === track.id)) return { ok: false, reason: 'duplicate' };
  const fromUser = state.requests.filter((r) => r.requestedBy && sameUser(r.requestedBy, user)).length;
  if (fromUser >= rules.maxPerUser) return { ok: false, reason: 'user-limit' };
  return { ok: true };
}
