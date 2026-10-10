import { describe, expect, it } from 'vitest';
import { emptyPlayerState } from './queue';
import {
  appendRequest,
  hideSent,
  LOST_GRACE_MS,
  markSent,
  reconcileQueue,
  removeRequest,
  requestToSend,
  SEND_BEFORE_MS,
  skipsToReach,
  startRequest,
  unmarkSent,
} from './requests';
import type { PlayerState, QueueItem, Track } from './types';

const track = (id: string, durationMs = 200_000): Track => ({
  id,
  title: `Песня ${id}`,
  artist: 'Гурт',
  durationMs,
  explicit: false,
  uri: `spotify:track:${id}`,
});
const item = (id: string, requestedBy?: string, sentAt?: number): QueueItem => ({
  key: `k-${id}`,
  track: track(id),
  ...(requestedBy ? { requestedBy } : {}),
  ...(sentAt !== undefined ? { sentAt } : {}),
});

function playing(progressMs: number, requests: QueueItem[] = []): PlayerState {
  return { ...emptyPlayerState(), current: item('now'), isPlaying: true, progressMs, requests };
}

describe('адпраўка заказу ў Spotify', () => {
  it('першы заказ адпраўляецца толькі незадоўга да канца бягучай песні', () => {
    const r = item('r1', 'ales');
    expect(requestToSend(playing(10_000, [r]))).toBeNull();
    expect(requestToSend(playing(200_000 - SEND_BEFORE_MS, [r]))).toEqual(r);
  });

  it('не адпраўляе другі раз, на паўзе і без Spotify-трэка', () => {
    const late = 200_000 - 1000;
    expect(requestToSend(playing(late, [item('r1', 'a', 5)]))).toBeNull();
    expect(requestToSend({ ...playing(late, [item('r1', 'a')]), isPlaying: false })).toBeNull();
    const local = { ...item('r1', 'a'), track: { ...track('r1'), uri: undefined } };
    expect(requestToSend(playing(late, [local]))).toBeNull();
    expect(requestToSend(playing(late, []))).toBeNull();
  });

  it('адзнака адпраўкі ставіцца і здымаецца толькі сваім запытам', () => {
    let s = playing(0, [item('r1', 'a'), item('r2', 'b')]);
    s = markSent(s, 'k-r1', 100);
    expect(s.requests[0].sentAt).toBe(100);
    expect(unmarkSent(s, 'k-r1', 99)).toBe(s);
    expect(unmarkSent(s, 'k-r1', 100).requests[0].sentAt).toBeUndefined();
  });

  it('новы заказ ідзе ў канец і не становіцца бягучым, нават калі нічога не грае', () => {
    const s = appendRequest(emptyPlayerState(), item('r1', 'a'));
    expect(s.current).toBeNull();
    expect(s.requests).toHaveLength(1);
  });
});

describe('«прайграць зараз» і «выдаліць» з Spotify', () => {
  it('заказ становіцца бягучым з нікам, астатнія — у тым жа парадку і без адзнакі адпраўкі', () => {
    const s = startRequest(playing(5000, [item('r1', 'a', 10), item('r2', 'b'), item('r3', 'c')]), 'k-r3');
    expect(s.current).toMatchObject({ key: 'k-r3', requestedBy: 'c' });
    expect(s.requests.map((r) => r.key)).toEqual(['k-r1', 'k-r2']);
    expect(s.requests[0].sentAt).toBeUndefined();
    expect(s.history.at(-1)?.key).toBe('k-now');
  });

  it('калі першы заказ ужо ў чарзе Spotify, да іншага трэба дзве «наступная»', () => {
    const s = playing(0, [item('r1', 'a', 10), item('r2', 'b')]);
    expect(skipsToReach(s, 'k-r2')).toBe(2);
    expect(skipsToReach(s, 'k-r1')).toBe(1);
    expect(skipsToReach(playing(0, [item('r1', 'a'), item('r2', 'b')]), 'k-r2')).toBe(1);
  });

  it('неадпраўлены заказ проста выдаляецца, адпраўлены — запамінаецца, каб прапусціць', () => {
    const s = playing(0, [item('r1', 'a', 10), item('r2', 'b')]);
    expect(removeRequest(s, 'k-r2')).toMatchObject({ requests: [{ key: 'k-r1' }] });
    expect(removeRequest(s, 'k-r2').skip).toBeUndefined();
    expect(removeRequest(s, 'k-r1')).toMatchObject({ requests: [{ key: 'k-r2' }], skip: { uri: 'spotify:track:r1', at: 10 } });
  });
});

describe('зверка з чаргой Spotify', () => {
  const uri = (id: string) => `spotify:track:${id}`;

  it('адпраўлены заказ ёсць у чарзе Spotify — нічога не мяняецца', () => {
    const s = playing(0, [item('r1', 'a', 0)]);
    expect(reconcileQueue(s, uri('now'), [uri('r1'), uri('x')], LOST_GRACE_MS * 2)).toBe(s);
  });

  it('адпраўлены заказ знік з чаргі Spotify — адправім нанова (але не адразу пасля адпраўкі)', () => {
    const s = playing(0, [item('r1', 'a', 0)]);
    expect(reconcileQueue(s, uri('now'), [uri('x')], LOST_GRACE_MS - 1)).toBe(s);
    expect(reconcileQueue(s, uri('now'), [uri('x')], LOST_GRACE_MS).requests[0].sentAt).toBeUndefined();
  });

  it('неадпраўлены заказ ужо першы ў чарзе Spotify — лічыцца адпраўленым (без дубля)', () => {
    const s = playing(0, [item('r1', 'a')]);
    expect(reconcileQueue(s, uri('now'), [uri('r1')], 500).requests[0].sentAt).toBe(500);
    // Далей у плэйлісце — гэта не наш заказ, адпраўляць трэба.
    expect(reconcileQueue(s, uri('now'), [uri('x'), uri('r1')], 500)).toBe(s);
  });

  it('выдалены заказ знік з чаргі Spotify — пра яго забываем', () => {
    const s = { ...playing(0), skip: { uri: uri('r1'), at: 0 } };
    expect(reconcileQueue(s, uri('now'), [uri('r1')], LOST_GRACE_MS).skip).toEqual(s.skip);
    expect(reconcileQueue(s, uri('now'), [], LOST_GRACE_MS).skip).toBeNull();
  });

  it('адпраўлены і выдалены заказы не паказваюцца ў «Далей у Spotify» другі раз', () => {
    const context = ['r1', 'x', 'r9', 'r1'].map((id) => ({ track: track(id) }));
    const shown = hideSent(context, { requests: [item('r1', 'a', 5)], skip: { uri: uri('r9'), at: 0 } });
    expect(shown.map((c) => c.track.id)).toEqual(['x', 'r1']);
  });
});
