// «Мозг» з відэа YouTube (ADR-020): падробкі Spotify, Twitch і YouTube; плэер оверлэя імітуецца паведамленнямі.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveTokens as saveSpotifyTokens } from '../providers/spotify/auth';
import { createFakeSpotify, memoryStorage, sampleTokens } from '../providers/spotify/fake';
import { saveTokens } from '../sources/twitch/auth';
import { createFakeTwitch, sampleTwitchTokens } from '../sources/twitch/fake';
import type { FetchLike, ProbeResult } from '../youtube/lookup';
import type { VideoPlayerState } from '../core/video';
import type { PageKind } from './bus';
import type { LockManagerLike } from './leader';
import { createBrainNode, type BrainNode } from './node';

const WAIT = { timeout: 6000, interval: 20 };
/** Пакуль чакае замова, бот апытвае Spotify раз у 5 с — натуральны канец песні бачны не адразу. */
const SLOW = { timeout: 12_000, interval: 50 };
vi.setConfig({ testTimeout: 30_000 });

interface FakeVideo {
  title: string;
  author: string;
  durationMs: number;
  /** Статус oEmbed (па змаўчанні 200). */
  oembed?: number;
  /** Памылка плэера (`onError`). */
  error?: number;
  live?: boolean;
}

const VIDEOS: Record<string, FakeVideo> = {
  dQw4w9WgXcQ: { title: 'Rick Astley - Never Gonna Give You Up', author: 'Rick Astley', durationMs: 213_000 },
  '9bZkp7q19f0': { title: 'PSY - GANGNAM STYLE', author: 'officialpsy', durationMs: 252_000 },
  longlonglon: { title: 'Доўгі стрым', author: 'Канал', durationMs: 13 * 60_000 },
  noembed0000: { title: 'Без убудавання', author: 'Лэйбл', durationMs: 200_000, error: 150 },
  livestream0: { title: 'Трансляцыя', author: 'Радыё', durationMs: 0, live: true },
};
const link = (id: string) => `https://www.youtube.com/watch?v=${id}`;

function createFakeYouTube() {
  const fetch: FetchLike = async (url) => {
    const id = new URL(new URL(url).searchParams.get('url') ?? '').searchParams.get('v') ?? '';
    const video = VIDEOS[id];
    const status = video ? (video.oembed ?? 200) : 400;
    if (status !== 200) return new Response('Bad Request', { status });
    return new Response(JSON.stringify({ title: video.title, author_name: video.author }), { status: 200 });
  };
  const probe = async (id: string): Promise<ProbeResult> => {
    const video = VIDEOS[id];
    if (!video) return { status: 'error', code: 150 };
    if (video.error) return { status: 'error', code: video.error };
    return { status: 'ok', durationMs: video.durationMs, title: video.title, live: video.live === true, playable: true };
  };
  return { fetch, probe };
}

let counter = 0;
let nodes: BrainNode[] = [];

function setup(opts: { silenceMs?: number; startMs?: number } = {}) {
  const name = `test-video-${++counter}-${Date.now()}`;
  const storage = memoryStorage();
  const spotify = createFakeSpotify();
  const twitch = createFakeTwitch();
  const youtube = createFakeYouTube();
  saveSpotifyTokens(storage, sampleTokens());
  saveTokens(storage, sampleTwitchTokens());
  const make = (page: PageKind) => {
    const node = createBrainNode({
      page,
      storage,
      locks: navigator.locks as unknown as LockManagerLike,
      lockName: name,
      busName: name,
      fetch: spotify.fetch,
      twitchFetch: twitch.fetch,
      createSocket: twitch.createSocket,
      youtubeFetch: youtube.fetch,
      videoProbe: youtube.probe,
      videoSilenceMs: opts.silenceMs,
      videoStartMs: opts.startMs,
    });
    nodes.push(node);
    node.start();
    return node;
  };
  return { storage, spotify, twitch, make };
}

/** Бот падключыўся да Twitch: абедзве ўзнагароды ёсць, падпіскі на жывым злучэнні. */
async function ready(twitch: ReturnType<typeof createFakeTwitch>, node: BrainNode) {
  await vi.waitFor(() => {
    const live = new Set(twitch.liveSockets().map((s) => s.session));
    expect(twitch.state.subscriptions.filter((s) => live.has(s.session))).toHaveLength(3);
    expect(twitch.state.rewards).toHaveLength(2);
  }, WAIT);
  await vi.waitFor(() => expect(node.spotify.get().status).toBe('ok'), WAIT);
}

const videoReward = (twitch: ReturnType<typeof createFakeTwitch>) => twitch.state.rewards.find((r) => r.title === 'Замовіць відэа з YouTube')!.id;

/** Плэер оверлэя паведамляе пра бягучае відэа. */
function report(node: BrainNode, state: VideoPlayerState, positionMs = 0) {
  const current = node.player.get().current;
  node.reportVideo({ key: current?.key ?? '', state, positionMs });
}

afterEach(() => {
  for (const node of nodes) node.stop();
  nodes = [];
});

describe('відэа YouTube: замова і чарга', () => {
  it('замова відэа — у агульнай чарзе з нікам; песня скончылася — Spotify на паўзе, відэа; потым музыка далей', async () => {
    const { make, twitch, spotify } = setup();
    const dock = make('dock');
    await ready(twitch, dock);
    const r = twitch.redeem('Kasia', link('dQw4w9WgXcQ'), { rewardId: videoReward(twitch) });
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    expect(dock.player.get().requests[0]).toMatchObject({
      requestedBy: 'Kasia',
      redemptionId: r.id,
      track: { source: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', artist: 'Rick Astley', durationMs: 213_000 },
    });
    await vi.waitFor(() => expect(twitch.state.chat).toEqual(['@Kasia відэа «Rick Astley - Never Gonna Give You Up» стала ў чаргу']), WAIT);

    // Песня ў Spotify амаль скончылася: бот ставіць паўзу і пачынае відэа, Spotify нічога ў чаргу не атрымлівае.
    spotify.state.progressMs = 180_000 - 2500;
    await vi.waitFor(() => expect(dock.player.get().current?.track.source).toBe('youtube'), SLOW);
    await vi.waitFor(() => expect(spotify.state.playing).toBe(false), WAIT);
    expect(spotify.count('POST /me/player/queue')).toBe(0);
    expect(dock.player.get().video).toMatchObject({ resume: 'next', started: false });
    // Пакуль плэер не паказаў відэа, замова не выканана.
    await new Promise((res) => setTimeout(res, 3500));
    expect(twitch.statusOf(r.id)).toBe('UNFULFILLED');

    report(dock, 'playing', 1500);
    await vi.waitFor(() => expect(dock.player.get().progressMs).toBeGreaterThanOrEqual(1500), WAIT);
    await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('FULFILLED'), WAIT);

    report(dock, 'ended', 213_000);
    // Пасля відэа — наступная песня плэйліста, Spotify зноў грае.
    await vi.waitFor(() => expect(spotify.state).toMatchObject({ playing: true, current: { id: 'b' } }), WAIT);
    await vi.waitFor(() => expect(dock.player.get().current?.track.id).toBe('b'), WAIT);
    expect(dock.player.get().video ?? null).toBeNull();
    expect(spotify.count('PUT /me/player/pause')).toBe(1);
  });

  it('▶ на відэа — адразу; «Папярэдняя» — з пачатку; «Наступная» — замова песні пасля відэа', async () => {
    const { make, twitch, spotify } = setup();
    const dock = make('dock');
    await ready(twitch, dock);
    twitch.redeem('Kasia', link('9bZkp7q19f0'), { rewardId: videoReward(twitch) });
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    twitch.redeem('Ales', 'Daft Punk Get Lucky');
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(2), WAIT);
    const [video, song] = dock.player.get().requests;

    dock.playNow(video.key);
    await vi.waitFor(() => expect(dock.player.get().current?.key).toBe(video.key), WAIT);
    await vi.waitFor(() => expect(spotify.state.playing).toBe(false), WAIT);
    report(dock, 'playing', 40_000);
    await vi.waitFor(() => expect(dock.player.get().progressMs).toBeGreaterThanOrEqual(40_000), WAIT);

    dock.previous();
    await vi.waitFor(() => expect(dock.player.get().video?.seek).toBe(1), WAIT);
    expect(dock.player.get().progressMs).toBeLessThan(2000);

    dock.togglePlay();
    await vi.waitFor(() => expect(dock.player.get().isPlaying).toBe(false), WAIT);
    expect(spotify.state.playing).toBe(false); // паўза відэа Spotify не чапае

    dock.next();
    await vi.waitFor(() => expect(spotify.state).toMatchObject({ playing: true, current: { id: song.track.id } }), WAIT);
    await vi.waitFor(() => expect(dock.player.get().current).toMatchObject({ key: song.key, requestedBy: 'Ales' }), WAIT);
    expect(dock.player.get().requests).toHaveLength(0);
  });

  it('Spotify паспеў перайсці да наступнай песні — паўза адразу, пасля відэа гэтая песня з пачатку', async () => {
    const { make, twitch, spotify } = setup();
    const dock = make('dock');
    await ready(twitch, dock);
    twitch.redeem('Kasia', link('dQw4w9WgXcQ'), { rewardId: videoReward(twitch) });
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    spotify.finishSong(); // стрымер перамотаў у канец — Spotify ужо грае «Песня b»
    spotify.state.progressMs = 3000;
    await vi.waitFor(() => expect(dock.player.get().current?.track.source).toBe('youtube'), SLOW);
    await vi.waitFor(() => expect(spotify.state.playing).toBe(false), WAIT);
    expect(dock.player.get().video?.resume).toBe('restart');
    expect(dock.player.get().context[0]?.track.id).toBe('b');
    report(dock, 'playing', 1000);
    report(dock, 'ended', 213_000);
    await vi.waitFor(() => expect(spotify.state).toMatchObject({ playing: true, current: { id: 'b' }, progressMs: 0 }), WAIT);
    expect(spotify.count('POST /me/player/next')).toBe(0);
    await vi.waitFor(() => expect(dock.player.get().current?.track.id).toBe('b'), WAIT);
  });

  it('два відэа запар: Spotify застаецца на паўзе паміж імі', async () => {
    const { make, twitch, spotify } = setup();
    const dock = make('dock');
    await ready(twitch, dock);
    twitch.redeem('Kasia', link('dQw4w9WgXcQ'), { rewardId: videoReward(twitch) });
    twitch.redeem('Ales', link('9bZkp7q19f0'), { rewardId: videoReward(twitch) });
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(2), WAIT);
    dock.next();
    await vi.waitFor(() => expect(dock.player.get().current?.track.videoId).toBe('dQw4w9WgXcQ'), WAIT);
    report(dock, 'playing', 1000);
    report(dock, 'ended', 213_000);
    await vi.waitFor(() => expect(dock.player.get().current?.track.videoId).toBe('9bZkp7q19f0'), WAIT);
    expect(spotify.state.playing).toBe(false);
    expect(spotify.count('PUT /me/player/play')).toBe(0);
    report(dock, 'playing', 1000);
    report(dock, 'ended', 252_000);
    await vi.waitFor(() => expect(spotify.state.playing).toBe(true), WAIT);
  });
});

describe('відэа YouTube: адмовы з вяртаннем балаў', () => {
  it('задоўгае, нельга ўбудаваць, трансляцыя, няма відэа, не спасылка', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch, dock);
    const reward = videoReward(twitch);
    const cases: [string, string][] = [
      [link('longlonglon'), '@u1 відэа «Доўгі стрым» даўжэйшае за 12 хв, балы вернуты'],
      [link('noembed0000'), '@u2 гэтае відэа нельга паказаць на стрыме, балы вернуты'],
      [link('livestream0'), '@u3 трансляцыі не прымаюцца, балы вернуты'],
      [link('aaaaaaaaaaa'), '@u4 такога відэа на YouTube няма, балы вернуты'],
      ['Rick Astley Never Gonna Give You Up', '@u5 дашлі спасылку на відэа YouTube, балы вернуты'],
    ];
    const ids = cases.map(([input], i) => twitch.redeem(`u${i + 1}`, input, { rewardId: reward }).id);
    await vi.waitFor(() => expect(ids.map((id) => twitch.statusOf(id))).toEqual(cases.map(() => 'CANCELED')), WAIT);
    await vi.waitFor(() => expect([...twitch.state.chat].sort()).toEqual(cases.map(([, chat]) => chat).sort()), WAIT);
    expect(dock.player.get().requests).toHaveLength(0);
  });

  it('ліміт агульны для песень і відэа; дубль відэа; спасылка YouTube ва ўзнагародзе песні', async () => {
    const { make, twitch } = setup();
    const dock = make('dock');
    await ready(twitch, dock);
    const reward = videoReward(twitch);
    twitch.redeem('Kasia', 'Daft Punk Get Lucky');
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    twitch.redeem('Kasia', link('dQw4w9WgXcQ'), { rewardId: reward });
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(2), WAIT);
    const third = twitch.redeem('kasia', link('9bZkp7q19f0'), { rewardId: reward });
    await vi.waitFor(() => expect(twitch.statusOf(third.id)).toBe('CANCELED'), WAIT);
    const dup = twitch.redeem('Ales', `https://youtu.be/dQw4w9WgXcQ`, { rewardId: reward });
    await vi.waitFor(() => expect(twitch.statusOf(dup.id)).toBe('CANCELED'), WAIT);
    const wrong = twitch.redeem('Ales', link('9bZkp7q19f0'));
    await vi.waitFor(() => expect(twitch.statusOf(wrong.id)).toBe('CANCELED'), WAIT);
    await vi.waitFor(
      () =>
        expect(twitch.state.chat.slice(2)).toEqual([
          '@kasia у чарзе ўжо максімум тваіх замоў (2), балы вернуты',
          '@Ales «Rick Astley - Never Gonna Give You Up» ужо ў чарзе, балы вернуты',
          '@Ales для відэа з YouTube ёсць узнагарода «Замовіць відэа з YouTube», балы вернуты',
        ]),
      WAIT,
    );
  });

  it('оверлэй не паказаў відэа (плэер маўчыць) — балы вернуты, музыка працягваецца', async () => {
    const { make, twitch, spotify } = setup({ silenceMs: 1500 });
    const dock = make('dock');
    await ready(twitch, dock);
    const r = twitch.redeem('Kasia', link('dQw4w9WgXcQ'), { rewardId: videoReward(twitch) });
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    dock.next();
    await vi.waitFor(() => expect(spotify.state.playing).toBe(false), WAIT);
    await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('CANCELED'), WAIT);
    await vi.waitFor(() => expect(twitch.state.chat.at(-1)).toBe('@Kasia відэа «Rick Astley - Never Gonna Give You Up» не атрымалася паказаць, балы вернуты'), WAIT);
    await vi.waitFor(() => expect(spotify.state.playing).toBe(true), WAIT);
    expect(dock.notice.get()?.kind).toBe('error');
  });

  it('плэер жывы, але відэа не пачынаецца — балы вернуты, музыка працягваецца', async () => {
    const { make, twitch, spotify } = setup({ startMs: 1500 });
    const dock = make('dock');
    await ready(twitch, dock);
    const r = twitch.redeem('Kasia', link('dQw4w9WgXcQ'), { rewardId: videoReward(twitch) });
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    dock.next();
    await vi.waitFor(() => expect(dock.player.get().current?.track.source).toBe('youtube'), WAIT);
    const loading = setInterval(() => report(dock, 'loading'), 300);
    try {
      await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('CANCELED'), WAIT);
      await vi.waitFor(() => expect(spotify.state.playing).toBe(true), WAIT);
    } finally {
      clearInterval(loading);
    }
  });

  it('памылка плэера пасля пачатку — відэа заканчваецца, але балы не вяртаюцца', async () => {
    const { make, twitch, spotify } = setup();
    const dock = make('dock');
    await ready(twitch, dock);
    const r = twitch.redeem('Kasia', link('dQw4w9WgXcQ'), { rewardId: videoReward(twitch) });
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    dock.next();
    await vi.waitFor(() => expect(dock.player.get().current?.track.source).toBe('youtube'), WAIT);
    report(dock, 'playing', 1000);
    await vi.waitFor(() => expect(twitch.statusOf(r.id)).toBe('FULFILLED'), WAIT);
    report(dock, 'error');
    await vi.waitFor(() => expect(spotify.state.playing).toBe(true), WAIT);
    expect(twitch.statusOf(r.id)).toBe('FULFILLED');
  });
});

describe('відэа YouTube: змена лідара', () => {
  it('док зачынілі пасярэдзіне відэа — відэа працягваецца, не дублюецца, музыка — толькі пасля яго', async () => {
    const { make, twitch, spotify } = setup();
    const dock = make('dock');
    await ready(twitch, dock);
    const overlay = make('overlay');
    twitch.redeem('Kasia', link('dQw4w9WgXcQ'), { rewardId: videoReward(twitch) });
    await vi.waitFor(() => expect(dock.player.get().requests).toHaveLength(1), WAIT);
    dock.next();
    await vi.waitFor(() => expect(overlay.player.get().current?.track.source).toBe('youtube'), WAIT);
    // Плэер у оверлэі паведамляе лідару (доку) праз шыну.
    report(overlay, 'playing', 30_000);
    await vi.waitFor(() => expect(dock.player.get().progressMs).toBeGreaterThanOrEqual(30_000), WAIT);
    const key = dock.player.get().current!.key;

    dock.stop();
    await vi.waitFor(() => expect(overlay.isLeader()).toBe(true), WAIT);
    await new Promise((res) => setTimeout(res, 1500));
    expect(overlay.player.get().current?.key).toBe(key);
    expect(overlay.player.get().progressMs).toBeGreaterThanOrEqual(30_000);
    expect(spotify.state.playing).toBe(false);
    expect(spotify.count('PUT /me/player/play')).toBe(0);

    report(overlay, 'playing', 40_000);
    report(overlay, 'ended', 213_000);
    await vi.waitFor(() => expect(spotify.state.playing).toBe(true), WAIT);
    expect(overlay.player.get().history.filter((h) => h.key === key)).toHaveLength(1);
  });
});
