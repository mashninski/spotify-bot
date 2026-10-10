// «Мозг» са Spotify (ADR-016): док кіруе Spotify праз лідара-оверлей; падробка Spotify замест сапраўднага.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveTokens, TOKENS_KEY } from '../providers/spotify/auth';
import { createFakeSpotify, fakeTrack, memoryStorage, sampleTokens } from '../providers/spotify/fake';
import type { PageKind } from './bus';
import type { LockManagerLike } from './leader';
import { createBrainNode, type BrainNode } from './node';

const WAIT = { timeout: 4000, interval: 20 };
let counter = 0;
let nodes: BrainNode[] = [];

function setup(withTokens = true) {
  const name = `test-spotify-${++counter}-${Date.now()}`;
  const storage = memoryStorage();
  const spotify = createFakeSpotify();
  if (withTokens) saveTokens(storage, sampleTokens());
  const make = (page: PageKind) => {
    const node = createBrainNode({
      page,
      storage,
      locks: navigator.locks as unknown as LockManagerLike,
      lockName: name,
      busName: name,
      fetch: spotify.fetch,
    });
    nodes.push(node);
    node.start();
    return node;
  };
  return { storage, spotify, make };
}

afterEach(() => {
  for (const node of nodes) node.stop();
  nodes = [];
});

describe('бот са Spotify', () => {
  it('без Spotify нічога не грае і выдуманых песень няма', async () => {
    const { make } = setup(false);
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.isLeader()).toBe(true), WAIT);
    await new Promise((r) => setTimeout(r, 300));
    expect(dock.player.get().current).toBeNull();
    expect(dock.player.get().context).toEqual([]);
    expect(dock.spotify.get().status).toBe('off');
  });

  it('док і оверлей паказваюць тое, што грае ў Spotify; кнопкі дока кіруюць Spotify', async () => {
    const { make, spotify } = setup();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = make('dock');

    await vi.waitFor(() => expect(dock.player.get().current?.track.id).toBe('a'), WAIT);
    expect(dock.player.get().context.map((c) => c.track.id)).toEqual(['b', 'c', 'd']);
    await vi.waitFor(() => expect(dock.spotify.get()).toMatchObject({ status: 'ok', user: 'Стрымер' }), WAIT);

    dock.next();
    await vi.waitFor(() => expect(spotify.state.current?.id).toBe('b'), WAIT);
    await vi.waitFor(() => expect(dock.player.get().current?.track.id).toBe('b'), WAIT);

    dock.togglePlay();
    await vi.waitFor(() => expect(spotify.state.playing).toBe(false), WAIT);
    await vi.waitFor(() => expect(dock.player.get().isPlaying).toBe(false), WAIT);

    dock.previous();
    await vi.waitFor(() => expect(dock.player.get().current?.track.id).toBe('a'), WAIT);
  });

  it('«+» з дока дадае бягучую песню ў «Любімыя трэкі»', async () => {
    const { make, spotify } = setup();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.spotify.get().liked).toMatchObject({ uri: 'spotify:track:a', saved: false }), WAIT);
    dock.saveCurrent();
    await vi.waitFor(() => expect(dock.spotify.get().liked?.saved).toBe(true), WAIT);
    expect(spotify.state.saved.has('spotify:track:a')).toBe(true);
    await vi.waitFor(() => expect(dock.notice.get()?.kind).toBe('ok'), WAIT);
  });

  it('уваход са старонкі вяртання падхоплівае лідар без перазагрузкі', async () => {
    const { make, storage } = setup(false);
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    saveTokens(storage, sampleTokens()); // так робіць callback.html
    await vi.waitFor(() => expect(overlay.player.get().current?.track.id).toBe('a'), WAIT);
  });

  it('«Адключыць» выдаляе токены і спыняе Spotify', async () => {
    const { make, storage } = setup();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.player.get().current).not.toBeNull(), WAIT);
    dock.disconnectSpotify();
    await vi.waitFor(() => expect(dock.spotify.get().status).toBe('off'), WAIT);
    expect(storage.getItem(TOKENS_KEY)).toBeNull();
    await vi.waitFor(() => expect(dock.player.get().current).toBeNull(), WAIT);
  });

  it('новы лідар працягвае са Spotify (токены агульныя)', async () => {
    const { make, spotify } = setup();
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.player.get().current?.track.id).toBe('a'), WAIT);
    const overlay = make('overlay');
    dock.stop(); // док закрылі — бот пераходзіць у оверлей
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    spotify.state.current = fakeTrack('z');
    spotify.state.progressMs = 0;
    // Новы лідар апытвае Spotify адразу пасля старту.
    await vi.waitFor(() => expect(overlay.player.get().current?.track.id).toBe('z'), WAIT);
  });
});

describe('хуткі водгук у OBS', () => {
  it('«Наступная» з дока: новая песня ў доку адразу, нават калі Spotify адказвае са спазненнем', async () => {
    const { make, spotify } = setup();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.player.get().context).toHaveLength(3), WAIT);
    spotify.state.lagPolls = 3;
    const started = Date.now();
    dock.next();
    await vi.waitFor(() => expect(dock.player.get().current?.track.id).toBe('b'), WAIT);
    expect(Date.now() - started).toBeLessThan(300);
    // Пакуль Spotify «думае», док не скача назад на «a».
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 100));
      expect(dock.player.get().current?.track.id).toBe('b');
    }
  });

  it('гучнасць з дока трапляе ў Spotify', async () => {
    const { make, spotify } = setup();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.spotify.get().volume).toBe(60), WAIT);
    dock.setVolume(25);
    await vi.waitFor(() => expect(spotify.state.volume).toBe(25), WAIT);
    await vi.waitFor(() => expect(dock.spotify.get().volume).toBe(25), WAIT);
  });
});
