import { describe, expect, it } from 'vitest';
import { emptyPlayerState } from './queue';
import { checkRequest, DEFAULT_RULES } from './rules';
import type { PlayerState, Track } from './types';

const track = (id: string, patch: Partial<Track> = {}): Track => ({
  id,
  title: id,
  artist: 'A',
  durationMs: 200_000,
  explicit: false,
  ...patch,
});

const withRequests = (...reqs: [string, string][]): PlayerState => ({
  ...emptyPlayerState(),
  requests: reqs.map(([id, user], i) => ({ key: `k${i}`, track: track(id), requestedBy: user })),
});

describe('правілы заказаў', () => {
  it('звычайны заказ праходзіць', () => {
    expect(checkRequest(DEFAULT_RULES, emptyPlayerState(), track('a'), 'u')).toEqual({ ok: true });
  });

  it('песня даўжэй за 12 хвілін адхіляецца, роўна 12 — праходзіць', () => {
    const s = emptyPlayerState();
    expect(checkRequest(DEFAULT_RULES, s, track('a', { durationMs: 12 * 60_000 }), 'u').ok).toBe(true);
    expect(checkRequest(DEFAULT_RULES, s, track('a', { durationMs: 12 * 60_000 + 1 }), 'u')).toEqual({ ok: false, reason: 'too-long' });
  });

  it('explicit можна забараніць', () => {
    const t = track('a', { explicit: true });
    expect(checkRequest(DEFAULT_RULES, emptyPlayerState(), t, 'u').ok).toBe(true);
    expect(checkRequest({ ...DEFAULT_RULES, allowExplicit: false }, emptyPlayerState(), t, 'u')).toEqual({ ok: false, reason: 'explicit' });
  });

  it('песню, якая ўжо ў чарзе, нельга заказаць паўторна', () => {
    expect(checkRequest(DEFAULT_RULES, withRequests(['a', 'x']), track('a'), 'u')).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('не больш за 2 песні аднаго гледача (без уліку рэгістра ніка)', () => {
    const s = withRequests(['a', 'Kasia'], ['b', 'kasia']);
    expect(checkRequest(DEFAULT_RULES, s, track('c'), 'KASIA')).toEqual({ ok: false, reason: 'user-limit' });
    expect(checkRequest(DEFAULT_RULES, s, track('c'), 'ales').ok).toBe(true);
  });
});
