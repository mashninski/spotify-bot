import { describe, expect, it, vi } from 'vitest';
import { electLeader, type LockManagerLike } from './leader';

// Node 24 мае сапраўдны Web Locks API (navigator.locks) — выбар правяраецца на ім, а не на падробцы.
const locks = navigator.locks as unknown as LockManagerLike;
let n = 0;
const lockName = () => `test-leader-${++n}-${Date.now()}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('выбар лідара', () => {
  it('лідар толькі адзін; пасля яго сыходу лідарам становіцца наступны', async () => {
    const name = lockName();
    const first = vi.fn();
    const second = vi.fn();
    const a = electLeader(locks, first, name);
    await vi.waitFor(() => expect(a.isLeader()).toBe(true));
    const b = electLeader(locks, second, name);
    await pause(50);
    expect(b.isLeader()).toBe(false);
    expect(second).not.toHaveBeenCalled();

    a.stop();
    expect(a.isLeader()).toBe(false);
    await vi.waitFor(() => expect(b.isLeader()).toBe(true));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    b.stop();
  });

  it('старонка, якая сышла з чаргі, лідарам не становіцца і не трымае іншых', async () => {
    const name = lockName();
    const a = electLeader(locks, () => {}, name);
    await vi.waitFor(() => expect(a.isLeader()).toBe(true));
    const quitter = vi.fn();
    const b = electLeader(locks, quitter, name);
    const c = electLeader(locks, () => {}, name);
    b.stop();
    a.stop();
    await vi.waitFor(() => expect(c.isLeader()).toBe(true));
    expect(quitter).not.toHaveBeenCalled();
    expect(b.isLeader()).toBe(false);
    c.stop();
  });

  it('паўторны stop() бяспечны', async () => {
    const a = electLeader(locks, () => {}, lockName());
    await vi.waitFor(() => expect(a.isLeader()).toBe(true));
    a.stop();
    a.stop();
    expect(a.isLeader()).toBe(false);
  });
});
