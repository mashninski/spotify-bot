import { describe, expect, it } from 'vitest';
import * as q from './queue';
import type { PlayerState, QueueItem } from './types';

const item = (key: string, requestedBy?: string, durationMs = 180_000): QueueItem => ({
  key,
  track: { id: `t-${key}`, title: `Песня ${key}`, artist: 'Выканаўца', durationMs, explicit: false },
  ...(requestedBy ? { requestedBy } : {}),
});

const state = (patch: Partial<PlayerState>): PlayerState => ({ ...q.emptyPlayerState(), ...patch });

const keys = (items: QueueItem[]) => items.map((i) => i.key);

describe('чарга', () => {
  it('наступныя: спачатку заказы, потым кантэкст', () => {
    const s = state({ requests: [item('r1', 'a'), item('r2', 'b')], context: [item('c1'), item('c2')] });
    expect(keys(q.upcoming(s, 3))).toEqual(['r1', 'r2', 'c1']);
  });

  it('«наступная» бярэ заказ раней за кантэкст і запамінае папярэднюю', () => {
    const s = state({ current: item('x'), isPlaying: true, requests: [item('r1', 'a')], context: [item('c1')] });
    const next = q.skipNext(s);
    expect(next.current?.key).toBe('r1');
    expect(keys(next.requests)).toEqual([]);
    expect(keys(next.context)).toEqual(['c1']);
    expect(keys(next.history)).toEqual(['x']);
  });

  it('«наступная» без чаргі спыняе прайграванне', () => {
    const next = q.skipNext(state({ current: item('x'), isPlaying: true }));
    expect(next.current).toBeNull();
    expect(next.isPlaying).toBe(false);
  });

  it('«папярэдняя» пасля 3 с пачынае песню нанова', () => {
    const s = state({ current: item('x'), progressMs: 10_000, history: [item('h')] });
    const prev = q.skipPrevious(s);
    expect(prev.current?.key).toBe('x');
    expect(prev.progressMs).toBe(0);
  });

  it('«папярэдняя» на пачатку песні вяртае папярэднюю, бягучая вяртаецца ў сваю чаргу', () => {
    const s = state({ current: item('r1', 'a'), progressMs: 1000, history: [item('h')], requests: [item('r2', 'b')] });
    const prev = q.skipPrevious(s);
    expect(prev.current?.key).toBe('h');
    expect(keys(prev.requests)).toEqual(['r1', 'r2']);
    expect(prev.history).toEqual([]);
  });

  it('«прайграць зараз» не мяняе парадак астатніх заказаў', () => {
    const s = state({ current: item('x'), requests: [item('r1', 'a'), item('r2', 'b'), item('r3', 'c')] });
    const next = q.playNow(s, 'r2');
    expect(next.current?.key).toBe('r2');
    expect(next.isPlaying).toBe(true);
    expect(keys(next.requests)).toEqual(['r1', 'r3']);
    expect(keys(next.history)).toEqual(['x']);
  });

  it('«выдаліць» прыбірае толькі адзін заказ', () => {
    const s = state({ requests: [item('r1', 'a'), item('r2', 'b'), item('r3', 'c')] });
    expect(keys(q.removeRequest(s, 'r2').requests)).toEqual(['r1', 'r3']);
    expect(q.removeRequest(s, 'няма')).toBe(s);
  });

  it('заказ, калі нічога не грае, адразу становіцца бягучым', () => {
    const next = q.addRequest(q.emptyPlayerState(), item('r1', 'a'));
    expect(next.current?.key).toBe('r1');
    expect(next.isPlaying).toBe(true);
  });

  it('ход часу прасоўвае песню і пераходзіць да наступнай у канцы', () => {
    const s = state({ current: item('x', undefined, 10_000), isPlaying: true, progressMs: 9_000, context: [item('c1')] });
    expect(q.tick(s, 500).progressMs).toBe(9_500);
    const next = q.tick(s, 1_500);
    expect(next.current?.key).toBe('c1');
    expect(next.progressMs).toBe(500);
  });

  it('на паўзе час не ідзе', () => {
    const s = state({ current: item('x'), isPlaying: false, progressMs: 1000 });
    expect(q.tick(s, 5000)).toBe(s);
  });

  it('гісторыя абмежаваная', () => {
    let s = state({ current: item('start') });
    for (let i = 0; i < q.HISTORY_LIMIT + 10; i++) s = q.skipNext({ ...s, context: [item(`c${i}`)] });
    expect(s.history.length).toBe(q.HISTORY_LIMIT);
  });

  it('стан для оверлея: толькі патрэбныя палі і 5 наступных (ADR-020)', () => {
    const s = state({
      current: item('x'),
      isPlaying: true,
      requests: [item('r1', 'kasia')],
      context: [item('c1'), item('c2'), item('c3'), item('c4'), item('c5')],
    });
    const o = q.toOverlayState(s);
    expect(o.current).toEqual({ key: 'x', title: 'Песня x', artist: 'Выканаўца' });
    expect(o.upcoming.map((u) => u.key)).toEqual(['r1', 'c1', 'c2', 'c3', 'c4']);
    expect(o.upcoming[0].requestedBy).toBe('kasia');
    expect('requestedBy' in o.upcoming[1]).toBe(false);
  });

  it('песні са Spotify: час ідзе, але ў канцы песні не пераходзіць далей (наступную скажа Spotify)', () => {
    const s = state({ current: item('a', undefined, 10_000), isPlaying: true, progressMs: 8000, context: [item('b')] });
    const after = q.advanceProgress(s, 5000);
    expect(after.current?.key).toBe('a');
    expect(after.progressMs).toBe(10_000);
    expect(q.advanceProgress(after, 1000)).toBe(after);
    expect(q.advanceProgress({ ...s, isPlaying: false }, 1000).progressMs).toBe(8000);
  });
});
