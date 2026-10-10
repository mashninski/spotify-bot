// Некалькі «старонак» (док, оверлеі) у адным працэсе: сапраўдныя Web Locks і BroadcastChannel з Node,
// агульны localStorage — як у OBS 32, дзе док і Browser Source дзеляць сховішча.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageKind } from './bus';
import type { LockManagerLike } from './leader';
import { createBrainNode, type BrainNode } from './node';

const WAIT = { timeout: 3000, interval: 20 };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

let counter = 0;
let nodes: BrainNode[] = [];

function setup() {
  const name = `test-brain-${++counter}-${Date.now()}`;
  const storage = memoryStorage();
  const make = (page: PageKind, locks: LockManagerLike | null = navigator.locks as unknown as LockManagerLike) => {
    const node = createBrainNode({ page, storage, locks, lockName: name, busName: name, demo: true });
    nodes.push(node);
    node.start();
    return node;
  };
  return { storage, make };
}

/** Чакае, пакуль лідар запусціцца, а `follower` атрымае ад яго стан. */
async function connected(leader: BrainNode, ...followers: BrainNode[]) {
  await vi.waitFor(() => expect(leader.isLeader()).toBe(true), WAIT);
  await vi.waitFor(() => expect(leader.player.get().current).not.toBeNull(), WAIT);
  for (const f of followers) {
    await vi.waitFor(() => expect(f.leader.get()?.id).toBe(leader.id), WAIT);
    await vi.waitFor(() => expect(f.player.get().current?.key).toBe(leader.player.get().current?.key), WAIT);
  }
}

afterEach(() => {
  for (const node of nodes) node.stop();
  nodes = [];
});

describe('«мозг» у некалькіх старонках', () => {
  it('першая старонка становіцца лідарам, астатнія паказваюць яе стан', async () => {
    const { make } = setup();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = make('dock');
    await connected(overlay, dock);
    expect(dock.isLeader()).toBe(false);
    expect(dock.leader.get()).toMatchObject({ page: 'overlay', locks: true });
    expect(dock.player.get().requests.map((r) => r.key)).toEqual(overlay.player.get().requests.map((r) => r.key));
  });

  it('адначасова працуе толькі адзін мозг', async () => {
    const { make } = setup();
    const pages = [make('overlay'), make('dock'), make('overlay')];
    await vi.waitFor(() => expect(pages.filter((p) => p.isLeader())).toHaveLength(1), WAIT);
    const leader = pages.find((p) => p.isLeader())!;
    await connected(leader, ...pages.filter((p) => p !== leader));
    await pause(1200); // хаця б адзін «сігнал жывы» ад лідара
    expect(pages.filter((p) => p.isLeader())).toHaveLength(1);
    expect(pages.map((p) => p.conflicts.get())).toEqual([0, 0, 0]);
  });

  it('кнопкі дока выконвае лідар-оверлей', async () => {
    const { make } = setup();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = make('dock');
    await connected(overlay, dock);

    const [first, second] = overlay.player.get().requests;
    dock.next();
    await vi.waitFor(() => expect(overlay.player.get().current?.key).toBe(first.key), WAIT);
    await vi.waitFor(() => expect(dock.player.get().current?.key).toBe(first.key), WAIT);

    dock.removeRequest(second.key);
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(0), WAIT);

    dock.togglePlay();
    await vi.waitFor(() => expect(overlay.player.get().isPlaying).toBe(false), WAIT);
    await vi.waitFor(() => expect(dock.player.get().isPlaying).toBe(false), WAIT);

    dock.previous();
    await vi.waitFor(() => expect(dock.player.get().current?.key).not.toBe(first.key), WAIT);
  });

  it('паведамленне пра заказ даходзіць да дока', async () => {
    const { make } = setup();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = make('dock');
    await connected(overlay, dock);
    dock.addTestRequest();
    await vi.waitFor(() => expect(dock.notice.get()?.text).toBeTruthy(), WAIT);
  });

  it('налады, змененыя ў доку, атрымлівае лідар', async () => {
    const { make } = setup();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = make('dock');
    await connected(overlay, dock);
    dock.updateSettings((s) => ({ ...s, rules: { ...s.rules, maxPerUser: 7 } }));
    await vi.waitFor(() => expect(overlay.settings.get().rules.maxPerUser).toBe(7), WAIT);
  });

  it('калі лідар знікае, наступная старонка працягвае з той жа чаргі', async () => {
    const { make } = setup();
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.isLeader()).toBe(true), WAIT);
    const overlay = make('overlay');
    await connected(dock, overlay);
    dock.next();
    dock.togglePlay();
    await vi.waitFor(() => expect(dock.player.get().isPlaying).toBe(false), WAIT);
    const before = dock.player.get();

    dock.stop(); // док перазагрузіўся або OBS закрыў яго
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    await vi.waitFor(() => expect(overlay.player.get().current?.key).toBe(before.current?.key), WAIT);
    const after = overlay.player.get();
    expect(after.requests.map((r) => r.key)).toEqual(before.requests.map((r) => r.key));
    expect(after.history.map((r) => r.key)).toEqual(before.history.map((r) => r.key));
    expect(after.progressMs).toBe(before.progressMs);

    // Док адкрылі зноў — ён бачыць новага лідара і кіруе ім.
    const dockAgain = make('dock');
    await connected(overlay, dockAgain);
    expect(dockAgain.isLeader()).toBe(false);
    dockAgain.togglePlay();
    await vi.waitFor(() => expect(overlay.player.get().isPlaying).toBe(true), WAIT);
  });

  it('новы оверлей пасля перазагрузкі атрымлівае стан адразу з localStorage', async () => {
    const { make } = setup();
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.isLeader()).toBe(true), WAIT);
    await vi.waitFor(() => expect(dock.player.get().current).not.toBeNull(), WAIT);
    await pause(1100); // мозг захоўвае стан не часцей за раз у секунду
    const overlay = make('overlay');
    // Яшчэ да першага паведамлення ад лідара.
    expect(overlay.player.get().current).not.toBeNull();
  });

  it('без Web Locks мозг працуе толькі ў доку', async () => {
    const { make } = setup();
    const overlay = make('overlay', null);
    await pause(100);
    expect(overlay.isLeader()).toBe(false);
    const dock = make('dock', null);
    expect(dock.isLeader()).toBe(true);
    await connected(dock, overlay);
    expect(overlay.leader.get()).toMatchObject({ page: 'dock', locks: false });
  });
});
