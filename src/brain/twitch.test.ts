// «Мозг» з Twitch (ADR-018): заказы за балы канала праз падробкі Twitch і Spotify.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveTokens as saveSpotifyTokens } from '../providers/spotify/auth';
import { createFakeSpotify, memoryStorage, sampleTokens } from '../providers/spotify/fake';
import { loadTokens, readLoginResult, saveTokens } from '../sources/twitch/auth';
import { createFakeTwitch, sampleTwitchTokens } from '../sources/twitch/fake';
import { LOG_KEY } from '../sources/twitch/redemptions';
import type { PageKind } from './bus';
import type { LockManagerLike } from './leader';
import { createBrainNode, type BrainNode } from './node';

const WAIT = { timeout: 6000, interval: 20 };
// Сцэнарыі з падключэннем і зменай лідара ідуць у рэальным часе — некалькі секунд.
vi.setConfig({ testTimeout: 20_000 });
const RICK = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
let counter = 0;
let nodes: BrainNode[] = [];

function setup(opts: { spotify?: boolean; twitch?: boolean } = {}) {
  const name = `test-twitch-${++counter}-${Date.now()}`;
  const storage = memoryStorage();
  const spotify = createFakeSpotify();
  const twitch = createFakeTwitch();
  if (opts.spotify !== false) saveSpotifyTokens(storage, sampleTokens());
  if (opts.twitch !== false) saveTokens(storage, sampleTwitchTokens());
  /** Пошук у Spotify можна «прытрымаць», каб змяніць лідара пасярэдзіне апрацоўкі заказу. */
  let gate: Promise<void> | null = null;
  let searches = 0;
  const spotifyFetch: typeof spotify.fetch = async (url, init) => {
    if (url.includes('/search') || url.includes('/tracks/')) {
      searches++;
      if (gate) await gate;
    }
    return spotify.fetch(url, init);
  };
  const make = (page: PageKind) => {
    const node = createBrainNode({
      page,
      storage,
      locks: navigator.locks as unknown as LockManagerLike,
      lockName: name,
      busName: name,
      fetch: spotifyFetch,
      twitchFetch: twitch.fetch,
      createSocket: twitch.createSocket,
    });
    nodes.push(node);
    node.start();
    return node;
  };
  const hold = () => {
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    return () => {
      gate = null;
      release();
    };
  };
  return { storage, spotify, twitch, make, hold, searches: () => searches };
}

/** Бот падключыўся да Twitch: узнагарода ёсць, падпіскі на жывым злучэнні. */
async function ready(twitch: ReturnType<typeof createFakeTwitch>) {
  await vi.waitFor(() => {
    const live = new Set(twitch.liveSockets().map((s) => s.session));
    expect(twitch.state.subscriptions.filter((s) => live.has(s.session))).toHaveLength(3);
  }, WAIT);
}

afterEach(() => {
  for (const node of nodes) node.stop();
  nodes = [];
});

describe('Twitch: падключэнне і ўзнагарода', () => {
  it('бот стварае ўзнагароду «Замовіць песню» з коштам з правілаў і падпісваецца на заказы', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch);
    expect(twitch.state.rewards).toHaveLength(1);
    expect(twitch.state.rewards[0]).toMatchObject({
      title: 'Замовіць песню',
      cost: 1000,
      is_user_input_required: true,
      should_redemptions_skip_request_queue: false,
    });
    await vi.waitFor(() => expect(dock.twitch.get()).toMatchObject({ status: 'ok', login: 'streamer', events: 'ok', reward: { cost: 1000 } }), WAIT);
    expect(twitch.count('GET /channel_points/custom_rewards/redemptions')).toBe(1); // даганялка пасля падпіскі
  });

  it('пасля перазапуску бот бярэ сваю ўзнагароду, а не стварае другую; змена цаны ідзе ў Twitch', async () => {
    const { make, twitch } = setup();
    const first = make('dock');
    await ready(twitch);
    first.stop();
    const overlay = make('overlay');
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    await ready(twitch);
    expect(twitch.state.rewards).toHaveLength(1);
    overlay.updateSettings((s) => ({ ...s, rules: { ...s.rules, price: 500 } }));
    await vi.waitFor(() => expect(twitch.state.rewards[0].cost).toBe(500), WAIT);
  });

  it('узнагароду са старой назвай «Заказаць песню» бот бярэ сабе і перайменоўвае', async () => {
    const { make, twitch } = setup();
    twitch.state.rewards.push({
      id: 'old-reward',
      title: 'Заказаць песню',
      cost: 1000,
      prompt: '',
      is_paused: false,
      is_enabled: true,
      is_user_input_required: true,
      should_redemptions_skip_request_queue: false,
      managed: true,
    });
    make('dock');
    await ready(twitch);
    expect(twitch.state.rewards.map((r) => r.id)).toEqual(['old-reward']);
    await vi.waitFor(() => expect(twitch.state.rewards[0].title).toBe('Замовіць песню'), WAIT);
  });

  it('канал без балаў канала — зразумелая памылка', async () => {
    const { make, twitch } = setup();
    twitch.state.affiliate = false;
    const dock = make('dock');
    await vi.waitFor(() => expect(dock.twitch.get()).toMatchObject({ status: 'error', problem: 'not-affiliate' }), WAIT);
  });

  it('без Spotify узнагарода на паўзе, са Spotify — зноў працуе', async () => {
    const { make, twitch, storage } = setup({ spotify: false });
    const dock = make('dock');
    await ready(twitch);
    await vi.waitFor(() => expect(twitch.state.rewards[0].is_paused).toBe(true), { ...WAIT, timeout: 12_000 });
    await vi.waitFor(() => expect(dock.twitch.get().reward).toMatchObject({ paused: true }), WAIT);
    saveSpotifyTokens(storage, sampleTokens());
    await vi.waitFor(() => expect(twitch.state.rewards[0].is_paused).toBe(false), { ...WAIT, timeout: 12_000 });
  }, 30_000);

  it('«Адключыць»: узнагарода на паўзе, токены выдалены', async () => {
    const { make, twitch, storage } = setup();
    const dock = make('dock');
    await ready(twitch);
    dock.disconnectTwitch();
    await vi.waitFor(() => expect(loadTokens(storage)).toBeNull(), WAIT);
    expect(dock.twitch.get().status).toBe('off');
    expect(twitch.state.rewards[0].is_paused).toBe(true);
    await new Promise((r) => setTimeout(r, 2500)); // сігнал «жывы» не падключае нанова
    expect(dock.twitch.get().status).toBe('off');
  });
});

describe('Twitch: заказы за балы', () => {
  it('заказ па спасылцы — у чаргу з нікам, «дададзена» ў чаце; калі зайграў — «выканана»', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch);
    const r = twitch.redeem('Kasia', RICK);
    await vi.waitFor(() => expect(dock.player.get().requests.map((x) => x.requestedBy)).toEqual(['Kasia']), WAIT);
    await vi.waitFor(() => expect(twitch.state.chat).toEqual(['@Kasia Rick Astley — Never Gonna Give You Up стала ў чаргу']), WAIT);
    expect(twitch.statusOf(r.id)).toBe('UNFULFILLED');
    dock.playNow(dock.player.get().requests[0].key);
    await vi.waitFor(() => expect(dock.player.get().current?.requestedBy).toBe('Kasia'), WAIT);
    await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('FULFILLED'), WAIT);
    expect(twitch.state.chat).toHaveLength(1);
  });

  it('не знайшоў — балы вернуты і паведамленне з прычынай', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch);
    const r = twitch.redeem('Ales', 'zzzz qqqq');
    await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('CANCELED'), WAIT);
    await vi.waitFor(() => expect(twitch.state.chat).toEqual(['@Ales «zzzz qqqq» не знайшлося ў Spotify, балы вернуты']), WAIT);
    expect(dock.player.get().requests).toEqual([]);
  });

  it('парушэнне правілаў (задоўгая песня, паўтор) — балы вернуты', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch);
    const long = twitch.redeem('Ales', 'Rush 2112');
    await vi.waitFor(() => expect(twitch.statusOf(long.id)).toBe('CANCELED'), WAIT);
    const a = twitch.redeem('Kasia', 'Daft Punk Get Lucky');
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    const b = twitch.redeem('Ales', 'Get Lucky Daft Punk');
    await vi.waitFor(() => expect(twitch.statusOf(b.id)).toBe('CANCELED'), WAIT);
    expect(twitch.statusOf(a.id)).toBe('UNFULFILLED');
    await vi.waitFor(
      () =>
        expect(twitch.state.chat).toEqual([
          '@Ales «2112» даўжэйшая за 12 хв, балы вернуты',
          '@Kasia Daft Punk — Get Lucky стала ў чаргу',
          '@Ales «Get Lucky» ужо ў чарзе, балы вернуты',
        ]),
      WAIT,
    );
  });

  it('стрымер прыбраў заказ (✕) — балы вернуты', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch);
    const r = twitch.redeem('Kasia', RICK);
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    dock.removeRequest(dock.player.get().requests[0].key);
    await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('CANCELED'), WAIT);
    await vi.waitFor(() => expect(twitch.state.chat.at(-1)).toBe('@Kasia «Never Gonna Give You Up» прыбралі з чаргі, балы вернуты'), WAIT);
  });

  it('паўторная дастаўка падзеі — адзін заказ', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch);
    const r = twitch.redeem('Kasia', RICK);
    twitch.redeliver(r); // новы message_id, той жа заказ
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    await new Promise((res) => setTimeout(res, 500));
    expect(dock.player.get().requests).toHaveLength(1);
    expect(twitch.state.chat).toHaveLength(1);
  });

  it('злучэнне з Twitch разарвалася — заказ, зроблены ў перапынак, прыходзіць праз даганялку', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch);
    for (const s of twitch.liveSockets()) s.drop();
    const r = twitch.redeem('Kasia', RICK); // падпісак няма — падзея нікуды не прыйшла
    await vi.waitFor(() => expect(dock.player.get().requests.map((x) => x.redemptionId)).toEqual([r.id]), WAIT);
    await vi.waitFor(() => expect(twitch.state.chat).toHaveLength(1), WAIT);
  });

  it('Spotify не падключаны — заказ, які паспеў прайсці, адмяняецца з вяртаннем балаў', async () => {
    const { make, twitch } = setup({ spotify: false });
    make('dock');
    await ready(twitch);
    const r = twitch.redeem('Kasia', RICK);
    await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('CANCELED'), WAIT);
    await vi.waitFor(() => expect(twitch.state.chat).toEqual(['@Kasia замовы зараз не працуюць, балы вернуты']), WAIT);
  });
});

describe('Twitch: змена лідара і збоі', () => {
  it('лідар знік пасярэдзіне апрацоўкі заказу — новы лідар апрацоўвае яго адзін раз', async () => {
    const { make, twitch, hold, searches } = setup();
    const dock = make('dock');
    await ready(twitch);
    const overlay = make('overlay');
    const release = hold();
    const r = twitch.redeem('Kasia', 'Daft Punk Get Lucky');
    await vi.waitFor(() => expect(searches()).toBe(1), WAIT);
    dock.stop(); // док знік, пакуль ішоў пошук
    release();
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    await vi.waitFor(() => expect(overlay.player.get().requests.map((x) => x.redemptionId)).toEqual([r.id]), WAIT);
    await vi.waitFor(() => expect(twitch.state.chat).toHaveLength(1), WAIT);
    await new Promise((res) => setTimeout(res, 800));
    expect(overlay.player.get().requests).toHaveLength(1);
    expect(twitch.state.chat).toHaveLength(1);
    expect(twitch.statusOf(r.id)).toBe('UNFULFILLED');
  });

  it('новы лідар не дублюе заказ з чаргі і ставіць «выканана», калі ён зайграе', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch);
    const r = twitch.redeem('Kasia', RICK);
    await vi.waitFor(() => expect(twitch.state.chat).toHaveLength(1), WAIT);
    const overlay = make('overlay');
    dock.stop();
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    await ready(twitch);
    await new Promise((res) => setTimeout(res, 500));
    expect(overlay.player.get().requests).toHaveLength(1); // даганялка бачыць UNFULFILLED, але заказ ужо ў журнале
    expect(twitch.state.chat).toHaveLength(1);
    overlay.playNow(overlay.player.get().requests[0].key);
    await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('FULFILLED'), WAIT);
  });

  it('журнал сцёрты, а заказ у чарзе — не дублюецца', async () => {
    const { make, twitch, storage } = setup();
    const dock = make('dock');
    await ready(twitch);
    twitch.redeem('Kasia', RICK);
    await vi.waitFor(() => expect(twitch.state.chat).toHaveLength(1), WAIT);
    const overlay = make('overlay');
    dock.stop();
    storage.removeItem(LOG_KEY);
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    await ready(twitch);
    await new Promise((res) => setTimeout(res, 500));
    expect(overlay.player.get().requests).toHaveLength(1);
  });

  it('access token скончыўся — бот абнаўляе яго (аднаразовы refresh) і працуе далей', async () => {
    const { make, twitch, storage } = setup({ twitch: false });
    saveTokens(storage, sampleTwitchTokens({ expiresAt: Date.now() - 1000 }));
    make('dock');
    await ready(twitch);
    expect(loadTokens(storage)).toMatchObject({ refreshToken: 'tw-refresh-2', accessToken: 'tw-access-2' });
  });

  it('Twitch адклікаў доступ — бот адключаецца і просіць увайсці зноў', async () => {
    const { make, twitch, storage } = setup();
    const dock = make('dock');
    await ready(twitch);
    twitch.state.validToken = 'revoked';
    twitch.state.validRefresh = 'revoked';
    twitch.redeem('Kasia', 'zzzz'); // адмова → запыт да Twitch → 401 → refresh не працуе
    await vi.waitFor(() => expect(dock.twitch.get().status).toBe('off'), WAIT);
    expect(loadTokens(storage)).toBeNull();
    expect(readLoginResult(storage)).toMatchObject({ ok: false, error: 'expired' });
  });

  it('збой Twitch пры вяртанні балаў — паўтор, пакуль не атрымаецца', async () => {
    const { make, twitch } = setup();
    make('dock');
    await ready(twitch);
    twitch.state.nextReply = { path: 'PATCH /channel_points/custom_rewards/redemptions', reply: { status: 500, body: { message: 'oops' } } };
    const r = twitch.redeem('Ales', 'zzzz qqqq');
    await vi.waitFor(() => expect(twitch.count('PATCH /channel_points/custom_rewards/redemptions')).toBe(1), WAIT);
    expect(twitch.statusOf(r.id)).toBe('UNFULFILLED');
    await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('CANCELED'), { ...WAIT, timeout: 10_000 });
    await vi.waitFor(() => expect(twitch.state.chat).toHaveLength(1), WAIT);
  }, 20_000);
});
