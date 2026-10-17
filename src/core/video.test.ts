// Відэа ў агульнай чарзе (ADR-020): калі пачынаць, што пасля, паведамленні плэера, вартаўнік.

import { describe, expect, it } from 'vitest';
import { emptyPlayerState } from './queue';
import type { PlayerState, QueueItem } from './types';
import * as vd from './video';

const song = (key: string, requestedBy?: string, patch: Partial<QueueItem> = {}): QueueItem => ({
  key,
  track: { id: `t-${key}`, title: `Песня ${key}`, artist: 'Гурт', durationMs: 180_000, explicit: false, uri: `spotify:track:${key}` },
  ...(requestedBy ? { requestedBy } : {}),
  ...patch,
});

const video = (key: string, requestedBy = 'kasia'): QueueItem => ({
  key,
  track: { id: `yt:${key}`, title: `Відэа ${key}`, artist: 'Канал', durationMs: 200_000, explicit: false, source: 'youtube', videoId: key },
  requestedBy,
});

const state = (patch: Partial<PlayerState>): PlayerState => ({ ...emptyPlayerState(), ...patch });
const keys = (items: QueueItem[]) => items.map((i) => i.key);

describe('відэа: калі пачынаць', () => {
  it('першае ў чарзе — відэа, песня Spotify вось-вось скончыцца', () => {
    const base = state({ current: song('s'), isPlaying: true, requests: [video('v'), song('r', 'ales')] });
    expect(vd.videoToStart({ ...base, progressMs: 170_000 })).toBeNull();
    expect(vd.videoToStart({ ...base, progressMs: 179_000 })?.key).toBe('v');
    // Spotify на паўзе — чакаем, як і з песнямі.
    expect(vd.videoToStart({ ...base, progressMs: 179_000, isPlaying: false })).toBeNull();
    // Першая — песня: відэа пасля яе.
    expect(vd.videoToStart({ ...base, progressMs: 179_000, requests: [song('r', 'ales'), video('v')] })).toBeNull();
  });

  it('рыхтаваць відэа ў оверлэі — за 10 с да канца песні', () => {
    const base = state({ current: song('s'), isPlaying: true, requests: [video('v')] });
    expect(vd.videoToPrepare({ ...base, progressMs: 160_000 })).toBeNull();
    expect(vd.videoToPrepare({ ...base, progressMs: 171_000 })).toBe('v');
    expect(vd.videoToPrepare({ ...base, progressMs: 171_000, isPlaying: false })).toBeNull();
    // Відэа пачалося — рыхтаваць больш няма чаго.
    expect(vd.startVideo({ ...base, videoPrepare: 'v' }, 'v', 'next', 0).videoPrepare).toBeNull();
  });

  it('відэа «гатовае» — толькі калі оверлэй паведаміў «грае» (паказаў відэа)', () => {
    const s = vd.startVideo(state({ requests: [video('v')] }), 'v', 'next', 0);
    expect(s.video?.ready).toBe(false);
    expect(vd.applyReport(s, { key: 'v', state: 'loading', positionMs: 0 }, 1).state.video?.ready).toBe(false);
    expect(vd.applyReport(s, { key: 'v', state: 'playing', positionMs: 0 }, 1).state.video?.ready).toBe(true);
  });

  it('Spotify сам перайшоў да наступнай песні плэйліста — відэа адразу', () => {
    const before = state({ current: song('s'), isPlaying: true, requests: [video('v')], context: [song('c1'), song('c2')] });
    const after = state({ ...before, current: song('c1'), context: [song('c2')] });
    expect(vd.missedVideo(before, after)?.key).toBe('v');
    // Стрымер выбраў зусім іншую песню — не перабіваем.
    expect(vd.missedVideo(before, { ...after, current: song('other') })).toBeNull();
  });

  it('пачатак відэа: песня — у гісторыю; пры restart — назад у чаргу', () => {
    const s = state({ current: song('s'), isPlaying: true, progressMs: 179_500, requests: [video('v'), song('r', 'ales')], context: [song('c1')] });
    const next = vd.startVideo(s, 'v', 'next', 1000);
    expect(next.current?.key).toBe('v');
    expect(next).toMatchObject({ isPlaying: true, progressMs: 0, video: { key: 'v', resume: 'next', startedAt: 1000, started: false } });
    expect(keys(next.requests)).toEqual(['r']);
    expect(keys(next.history)).toEqual(['s']);
    expect(vd.currentVideo(next)?.key).toBe('v');

    const restart = vd.startVideo({ ...s, current: song('c0') }, 'v', 'restart', 1000);
    expect(keys(restart.context)).toEqual(['c0', 'c1']);
    expect(keys(restart.history)).toEqual([]);
  });
});

describe('відэа: што пасля', () => {
  const playing = (requests: QueueItem[], resume: 'next' | 'restart' | 'none' = 'next') =>
    vd.startVideo(state({ current: song('s'), isPlaying: true, requests: [video('v'), ...requests], context: [song('c1'), song('c2')] }), 'v', resume, 0);

  it('наступнае відэа, замова песні або плэйліст', () => {
    expect(vd.endVideo(playing([video('v2')]))?.next).toEqual({ kind: 'video', key: 'v2', resume: 'next' });
    expect(vd.endVideo(playing([song('r', 'ales')]))?.next).toEqual({ kind: 'request', key: 'r', resume: 'next' });
    expect(vd.endVideo(playing([]))?.next).toEqual({ kind: 'context', resume: 'next' });
    // Spotify да відэа не граў — не чапаем яго і пасля.
    expect(vd.endVideo(playing([song('r', 'ales')], 'none'))?.next).toEqual({ kind: 'context', resume: 'none' });
  });

  it('відэа — у гісторыю, бягучага няма; плэйліст — першая песня адразу', () => {
    const ended = vd.endVideo(playing([]))!;
    expect(ended.state).toMatchObject({ current: null, isPlaying: false, video: null });
    expect(keys(ended.state.history)).toEqual(['s', 'v']);
    const resumed = vd.resumeContext(ended.state);
    expect(resumed.current?.key).toBe('c1');
    expect(keys(resumed.context)).toEqual(['c2']);
  });
});

describe('відэа: паведамленні плэера', () => {
  const s = vd.startVideo(state({ requests: [video('v')] }), 'v', 'next', 0);

  it('ход відэа і «пачало паказвацца»', () => {
    const loading = vd.applyReport(s, { key: 'v', state: 'loading', positionMs: 0 }, 500);
    expect(loading.state.video).toMatchObject({ reportAt: 500, started: false });
    const playing = vd.applyReport(loading.state, { key: 'v', state: 'playing', positionMs: 4200 }, 5000);
    expect(playing.state.progressMs).toBe(4200);
    expect(playing.state.video).toMatchObject({ reportAt: 5000, started: true });
    expect(playing.ended || playing.failed).toBe(false);
  });

  it('канец і памылка; паведамленне пра іншае відэа не ўлічваецца', () => {
    expect(vd.applyReport(s, { key: 'v', state: 'ended', positionMs: 0 }, 1).ended).toBe(true);
    expect(vd.applyReport(s, { key: 'v', state: 'error', positionMs: 0, code: 150 }, 1).failed).toBe(true);
    const other = vd.applyReport(s, { key: 'old', state: 'ended', positionMs: 0 }, 1);
    expect(other.state).toBe(s);
    expect(other.ended).toBe(false);
  });

  it('рэклама: адзнака ад плэера, час відэа не мяняецца, відэа не лічыцца пачатым', () => {
    const r = vd.applyReport({ ...s, progressMs: 0 }, { key: 'v', state: 'ad', positionMs: 15_000 }, 700);
    expect(r.ad).toBe(true);
    expect(r.state.progressMs).toBe(0);
    expect(r.state.video).toMatchObject({ reportAt: 700, started: false });
  });

  it('вартаўнік: плэер маўчыць 12 с', () => {
    expect(vd.videoStalled(s, vd.PLAYER_SILENCE_MS - 1)).toBe(false);
    expect(vd.videoStalled(s, vd.PLAYER_SILENCE_MS)).toBe(true);
    const reported = vd.applyReport(s, { key: 'v', state: 'playing', positionMs: 1000 }, 10_000).state;
    expect(vd.videoStalled(reported, 15_000)).toBe(false);
  });

  it('відэа не пачынаецца 60 с (плэер жывы) — паказаць не атрымалася; на паўзе не лічым', () => {
    expect(vd.videoNotStarting(s, vd.VIDEO_START_TIMEOUT_MS - 1)).toBe(false);
    expect(vd.videoNotStarting(s, vd.VIDEO_START_TIMEOUT_MS)).toBe(true);
    expect(vd.videoNotStarting({ ...s, isPlaying: false }, vd.VIDEO_START_TIMEOUT_MS)).toBe(false);
    const started = vd.applyReport(s, { key: 'v', state: 'playing', positionMs: 500 }, 1000).state;
    expect(vd.videoNotStarting(started, vd.VIDEO_START_TIMEOUT_MS * 2)).toBe(false);
  });

  it('«Папярэдняя» — з пачатку: лічыльнік перамоткі', () => {
    const moved = vd.restartVideo({ ...s, progressMs: 50_000 });
    expect(moved.progressMs).toBe(0);
    expect(moved.video?.seek).toBe(1);
  });
});
