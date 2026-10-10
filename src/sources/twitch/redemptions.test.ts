import { describe, expect, it } from 'vitest';
import { emptyPlayerState } from '../../core/queue';
import type { PlayerState, QueueItem } from '../../core/types';
import { memoryStorage } from '../../providers/spotify/fake';
import * as rl from './redemptions';

const base = { rewardId: 'rw', user: 'Kasia', query: 'Get Lucky', redeemedAt: 1000 };
const item = (key: string, redemptionId?: string): QueueItem => ({
  key,
  track: { id: key, title: `Песня ${key}`, artist: 'Гурт', durationMs: 200_000, explicit: false, uri: `spotify:track:${key}` },
  requestedBy: 'Kasia',
  ...(redemptionId ? { redemptionId } : {}),
});
const state = (patch: Partial<PlayerState>): PlayerState => ({ ...emptyPlayerState(), ...patch });

function queued(id = 'r1', now = 0) {
  return rl.accept(rl.track(rl.emptyLog(), { id, ...base }, now)!, id, 'дададзена', now);
}

describe('журнал заказаў Twitch', () => {
  it('паўторная падзея з тым жа заказам ігнаруецца', () => {
    const log = rl.track(rl.emptyLog(), { id: 'r1', ...base }, 0)!;
    expect(log.records.r1.stage).toBe('processing');
    expect(rl.track(log, { id: 'r1', ...base }, 5)).toBeNull();
  });

  it('прыняты заказ: спачатку паведамленне ў чат, статус у Twitch не мяняецца', () => {
    const log = queued();
    expect(rl.nextTask(log, 0)).toMatchObject({ kind: 'chat', text: 'дададзена' });
    const after = rl.chatDone(rl.chatStarted(log, 'r1', 1), 'r1', 2);
    expect(rl.nextTask(after, 3)).toBeNull();
    expect(after.records.r1.stage).toBe('queued');
  });

  it('адмова: спачатку вяртанне баллаў, паведамленне — толькі пасля', () => {
    let log = rl.track(rl.emptyLog(), { id: 'r1', ...base }, 0)!;
    log = rl.refund(log, 'r1', 'not-found', 'не знайшоў, баллы вернуты', 0);
    expect(rl.nextTask(log, 0)).toMatchObject({ kind: 'status', status: 'CANCELED' });
    log = rl.statusFailed(log, 'r1', 0);
    expect(rl.nextTask(log, 1000)).toBeNull(); // паўза перад паўторам
    expect(rl.nextTask(log, 5000)).toMatchObject({ kind: 'status' });
    log = rl.statusDone(log, 'r1', 6000);
    expect(rl.nextTask(log, 6000)).toMatchObject({ kind: 'chat', text: 'не знайшоў, баллы вернуты' });
  });

  it('калі статус ужо змяніў стрымер — паведамленне не адпраўляецца', () => {
    let log = rl.refund(rl.track(rl.emptyLog(), { id: 'r1', ...base }, 0)!, 'r1', 'removed', 'вернуты', 0);
    log = rl.statusDone(log, 'r1', 1, false);
    expect(rl.nextTask(log, 2)).toBeNull();
  });

  it('заказ, які ўжо выкананы, нельга адмяніць', () => {
    let log = rl.fulfill(queued(), 'r1', 1);
    log = rl.refund(log, 'r1', 'removed', 'x', 2);
    expect(log.records.r1.stage).toBe('fulfill');
  });

  it('зверка: заказ грае 3 с — «выканана»; прайграны — «выканана»', () => {
    let log = queued();
    log = rl.reconcile(log, state({ requests: [item('a', 'r1')] }), 100).log;
    expect(log.records.r1.stage).toBe('queued');
    log = rl.reconcile(log, state({ current: item('a', 'r1') }), 1000).log;
    expect(log.records.r1.playingSince).toBe(1000);
    log = rl.reconcile(log, state({ current: item('a', 'r1') }), 2000).log;
    expect(log.records.r1.stage).toBe('queued');
    log = rl.reconcile(log, state({ current: item('a', 'r1') }), 4000).log;
    expect(log.records.r1.stage).toBe('fulfill');

    const played = rl.reconcile(queued('r2'), state({ history: [item('b', 'r2')] }), 0).log;
    expect(played.records.r2.stage).toBe('fulfill');
  });

  it('зверка: «прайграць зараз» не атрымалася — заказ зноў у чарзе, не выкананы', () => {
    let log = rl.reconcile(queued(), state({ current: item('a', 'r1') }), 0).log;
    log = rl.reconcile(log, state({ requests: [item('a', 'r1')] }), 1000).log;
    expect(log.records.r1.playingSince).toBeUndefined();
    log = rl.reconcile(log, state({ requests: [item('a', 'r1')] }), 5000).log;
    expect(log.records.r1.stage).toBe('queued');
  });

  it('зверка: заказ знік з чаргі, не пачаўшы граць, — страчаны (апрацаваць нанова)', () => {
    const { lost } = rl.reconcile(queued(), state({}), 0);
    expect(lost.map((r) => r.id)).toEqual(['r1']);
  });

  it('новы лідар: незавершаныя заказы — нанова, паведамленне, якое ўжо адпраўлялася, не паўтараецца', () => {
    let log = rl.track(rl.emptyLog(), { id: 'p', ...base }, 0)!;
    log = rl.accept(rl.track(log, { id: 'q', ...base }, 0)!, 'q', 'дададзена', 0);
    log = rl.chatStarted(log, 'q', 1);
    const { log: resumed, reprocess } = rl.resume(log, 2);
    expect(reprocess.map((r) => r.id)).toEqual(['p']);
    expect(resumed.records.q.chat).toBeUndefined();
    expect(rl.nextTask(resumed, 3)).toBeNull();
  });

  it('захаванне і чытанне; старыя скончаныя запісы выдаляюцца', () => {
    const storage = memoryStorage();
    let log = rl.statusDone(rl.fulfill(queued(), 'r1', 0), 'r1', 0);
    log = rl.chatDone(log, 'r1', 0);
    rl.saveLog(storage, log);
    expect(rl.loadLog(storage).records.r1.stage).toBe('done');
    expect(rl.prune(log, 1000).records.r1).toBeDefined();
    expect(rl.prune(log, 4 * 24 * 3600_000).records.r1).toBeUndefined();
    storage.setItem(rl.LOG_KEY, '{сапсавана');
    expect(rl.loadLog(storage)).toEqual(rl.emptyLog());
  });
});
