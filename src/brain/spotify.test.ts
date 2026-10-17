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

describe('заказы гледачоў у Spotify (Этап 3б, ADR-017)', () => {
  const SLOW = { timeout: 7000, interval: 25 };

  /** Песня ў Spotify амаль скончылася: заказ трэба адправіць адразу. */
  function nearEnd(spotify: ReturnType<typeof createFakeSpotify>) {
    spotify.state.progressMs = 180_000 - 1500;
  }

  afterEach(() => vi.restoreAllMocks());

  async function connected() {
    const ctx = setup();
    const overlay = ctx.make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = ctx.make('dock');
    await vi.waitFor(() => expect(dock.spotify.get().status).toBe('ok'), WAIT);
    return { ...ctx, overlay, dock };
  }

  /** Тэставыя заказы ад розных гледачоў па чарзе (інакш выпадковы глядач можа ўпёрціся ў правіла «не больш за 2»). */
  async function addRequests(dock: BrainNode, count: number) {
    let viewer = 0;
    if (!vi.isMockFunction(Math.random)) vi.spyOn(Math, 'random').mockImplementation(() => (viewer++ % 5) / 5);
    for (let n = dock.player.get().requests.length + 1; count > 0; n++, count--) {
      dock.addTestRequest();
      await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(n), WAIT);
    }
  }

  it('тэставы заказ па спасылцы і па назве знаходзіцца ў Spotify і стаіць у чарзе з нікам', async () => {
    const { dock, spotify } = await connected();
    await addRequests(dock, 2); // спасылка, потым назва па-беларуску
    const requests = dock.player.get().requests;
    expect(requests.map((r) => r.track.title)).toEqual(['Never Gonna Give You Up', 'Гісторыя майго жыцця']);
    expect(requests.every((r) => r.requestedBy && r.track.uri)).toBe(true);
    expect(spotify.calls).toContain('GET /tracks/4cOdK2wGLETKBW3PvgPWqT');
    expect(spotify.calls).toContain('GET /search');
    // Да канца песні далёка — у Spotify яшчэ нічога не адпраўлена.
    expect(spotify.count('POST /me/player/queue')).toBe(0);
    await vi.waitFor(() => expect(dock.notice.get()?.kind).toBe('ok'), WAIT);
  });

  it('заказ адпраўляецца сам за некалькі секунд да канца і не адпраўляецца другі раз', async () => {
    const ctx = setup();
    nearEnd(ctx.spotify);
    const overlay = ctx.make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    const dock = ctx.make('dock');
    await vi.waitFor(() => expect(dock.spotify.get().status).toBe('ok'), WAIT);
    const { spotify } = ctx;
    dock.addTestRequest();
    await vi.waitFor(() => expect(spotify.state.userQueue.map((t) => t.id)).toEqual(['4cOdK2wGLETKBW3PvgPWqT']), SLOW);
    await vi.waitFor(() => expect(dock.player.get().requests[0]?.sentAt).toBeTypeOf('number'), WAIT);
    // У доку і оверлеі заказ адзін раз — з нікам, а не яшчэ і ў «Далей у Spotify».
    expect(dock.player.get().context.some((c) => c.track.id === '4cOdK2wGLETKBW3PvgPWqT')).toBe(false);
    spotify.finishSong();
    await vi.waitFor(() => expect(dock.player.get().current?.track.title).toBe('Never Gonna Give You Up'), SLOW);
    expect(dock.player.get().current?.requestedBy).toBeTruthy();
    expect(dock.player.get().requests).toHaveLength(0);
    expect(spotify.count('POST /me/player/queue')).toBe(1);
  });

  it('стрымер перамотаў песню ў самы канец, заказ не паспеў у Spotify — ён усё роўна грае наступным', async () => {
    const { dock, spotify } = await connected();
    await addRequests(dock, 2);
    const [first] = dock.player.get().requests;
    expect(spotify.count('POST /me/player/queue')).toBe(0);
    spotify.finishSong(); // Spotify уключыў плэйліст («Песня b»), бот пра перамотку не ведаў
    await vi.waitFor(() => expect(spotify.state.current?.id).toBe(first.track.id), SLOW);
    await vi.waitFor(() => expect(dock.player.get().current).toMatchObject({ key: first.key, requestedBy: first.requestedBy }), WAIT);
    expect(spotify.state.history.map((t) => t.id)).toContain('b');
    expect(dock.player.get().requests).toHaveLength(1);
    expect(spotify.count('POST /me/player/queue')).toBe(1);
  }, 15_000); // без акна Spotify у OBS бот даведваецца пра новую песню з апытання (да 5 с)

  it('«прайграць зараз» уключае заказ адразу, астатнія застаюцца; «выдаліць» — толькі з нашай чаргі', async () => {
    const { dock, spotify } = await connected();
    await addRequests(dock, 3);
    const [first, second, third] = dock.player.get().requests;
    dock.removeRequest(third.key);
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(2), WAIT);
    dock.playNow(second.key);
    await vi.waitFor(() => expect(spotify.state.current?.id).toBe(second.track.id), WAIT);
    await vi.waitFor(() => expect(dock.player.get().current).toMatchObject({ key: second.key, requestedBy: second.requestedBy }), WAIT);
    expect(dock.player.get().requests.map((r) => r.key)).toEqual([first.key]);
    expect(spotify.count('POST /me/player/queue')).toBe(1);
    expect(spotify.count('POST /me/player/next')).toBe(1);
    // Выдалены заказ у Spotify не трапляў зусім.
    expect([...spotify.state.history, ...spotify.state.userQueue].some((t) => t.id === third.track.id)).toBe(false);
  });

  it('«Наступная» ўключае першы заказ, а не плэйліст', async () => {
    const { dock, spotify } = await connected();
    await addRequests(dock, 1);
    const first = dock.player.get().requests[0];
    dock.next();
    await vi.waitFor(() => expect(spotify.state.current?.id).toBe('4cOdK2wGLETKBW3PvgPWqT'), WAIT);
    await vi.waitFor(() => expect(dock.player.get().current).toMatchObject({ key: first.key, requestedBy: first.requestedBy }), WAIT);
    // Апытанні Spotify пасля гэтага не сціраюць нік.
    await new Promise((r) => setTimeout(r, 1000));
    expect(dock.player.get().current).toMatchObject({ key: first.key, requestedBy: first.requestedBy });
    expect(dock.player.get().requests).toHaveLength(0);
  });

  it('правілы: трэці заказ аднаго гледача не прымаецца, прычына — у паведамленні дока', async () => {
    const { dock, spotify } = await connected();
    vi.spyOn(Math, 'random').mockReturnValue(0); // заўсёды той жа глядач
    await addRequests(dock, 2);
    dock.addTestRequest();
    await vi.waitFor(() => expect(dock.notice.get()).toMatchObject({ kind: 'error', text: 'zubr_gamer: у чарзе ўжо максімум замоў ад гледача (2)' }), WAIT);
    expect(dock.player.get().requests).toHaveLength(2);
    expect(spotify.count('POST /me/player/queue')).toBe(0);
  });

  it('Spotify не адказвае на пошук (квота) — заказ не дададзены, паведамленне ў доку', async () => {
    const { dock, spotify } = await connected();
    await new Promise((r) => setTimeout(r, 100));
    spotify.state.nextReply = { status: 429, body: { error: { status: 429, reason: 'QUOTA_EXCEEDED' } }, headers: { 'Retry-After': '60' } };
    dock.addTestRequest();
    await vi.waitFor(() => expect(dock.notice.get()?.text).toContain('Spotify не адказаў'), WAIT);
    expect(dock.player.get().requests).toHaveLength(0);
    await vi.waitFor(() => expect(dock.spotify.get().status).toBe('limited'), WAIT);
  });

  it('змена лідара пасля адпраўкі: заказ не губляецца і не адпраўляецца другі раз', async () => {
    const { make, spotify } = setup();
    nearEnd(spotify);
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.isLeader()).toBe(true), WAIT);
    await vi.waitFor(() => expect(dock.spotify.get().status).toBe('ok'), WAIT);
    dock.addTestRequest();
    await vi.waitFor(() => expect(spotify.count('POST /me/player/queue')).toBe(1), SLOW);
    await vi.waitFor(() => expect(dock.player.get().requests[0]?.sentAt).toBeTypeOf('number'), WAIT);
    const overlay = make('overlay');
    dock.stop(); // док закрылі — бот пераходзіць у оверлей
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    await vi.waitFor(() => expect(overlay.player.get().requests).toHaveLength(1), WAIT);
    await new Promise((r) => setTimeout(r, 1500));
    expect(spotify.count('POST /me/player/queue')).toBe(1);
    spotify.finishSong();
    await vi.waitFor(() => expect(overlay.player.get().current?.requestedBy).toBeTruthy(), SLOW);
    expect(overlay.player.get().requests).toHaveLength(0);
    expect(spotify.count('POST /me/player/queue')).toBe(1);
  });
});
