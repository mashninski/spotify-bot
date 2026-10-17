// Пошук відэа па назве праз люстэркі (B-032) і выбар першага прыдатнага.

import { describe, expect, it } from 'vitest';
import { findVideoByQuery, type FetchLike, type ProbeResult } from './lookup';
import { BUILT_IN_MIRRORS, createVideoSearch, INVIDIOUS_LIST_URL, parseInvidious, parseInvidiousList, parsePiped, type SearchHit } from './search';

const pipedBody = {
  items: [
    { url: '/channel/UC123', type: 'channel', name: 'Канал' },
    { url: '/watch?v=dQw4w9WgXcQ', type: 'stream', title: 'Rick Astley - Never Gonna Give You Up', uploaderName: 'Rick Astley', duration: 214 },
    { url: '/watch?v=live0000000', type: 'stream', title: 'Радыё', uploaderName: 'Радыё', duration: -1 },
    { url: '/watch?v=bad', type: 'stream', title: 'Кароткі id' },
  ],
};

const invidiousBody = [
  { type: 'channel', author: 'Канал' },
  { type: 'video', videoId: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', author: 'Rick Astley', lengthSeconds: 213 },
  { type: 'video', videoId: 'live0000000', title: 'Радыё', author: 'Радыё', lengthSeconds: 0, liveNow: true },
];

describe('адказы люстэркаў', () => {
  it('Piped: толькі відэа, трансляцыя пазначана', () => {
    expect(parsePiped(pipedBody)).toEqual([
      { videoId: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', author: 'Rick Astley', durationS: 214, live: false },
      { videoId: 'live0000000', title: 'Радыё', author: 'Радыё', durationS: null, live: true },
    ]);
    expect(parsePiped({ error: 'x' })).toBeNull();
    expect(parsePiped('<html>')).toBeNull();
  });

  it('Invidious: толькі відэа, трансляцыя пазначана', () => {
    expect(parseInvidious(invidiousBody)).toEqual([
      { videoId: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', author: 'Rick Astley', durationS: 213, live: false },
      { videoId: 'live0000000', title: 'Радыё', author: 'Радыё', durationS: null, live: true },
    ]);
    expect(parseInvidious({ items: [] })).toBeNull();
  });

  it('спіс Invidious: толькі https з API і CORS', () => {
    const list = [
      ['good.example', { type: 'https', api: true, cors: true }],
      ['noapi.example', { type: 'https', api: false, cors: true }],
      ['nocors.example', { type: 'https', api: true, cors: false }],
      ['x.onion', { type: 'onion', api: true, cors: true }],
      ['bad/host', { type: 'https', api: true, cors: true }],
    ];
    expect(parseInvidiousList(list)).toEqual(['good.example']);
    expect(parseInvidiousList({})).toEqual([]);
  });
});

/** Падробка сеткі: люстэрка → адказ (`null` — не адказвае). */
function network(answers: Record<string, unknown | null>, list: unknown = []) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    const host = new URL(url).hostname;
    calls.push(host);
    if (url === INVIDIOUS_LIST_URL) return new Response(JSON.stringify(list), { status: 200 });
    const answer = answers[host];
    if (answer === undefined || answer === null) throw new TypeError('Failed to fetch');
    if (answer === 'slow') return new Promise<Response>(() => undefined);
    if (answer === 503) return new Response('down', { status: 503 });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { fetch, calls };
}

const [first, second, third] = BUILT_IN_MIRRORS.map((m) => m.name);

describe('пошук праз люстэркі', () => {
  it('першае люстэрка не працуе — наступнае; потым адразу тое, што адказала', async () => {
    const net = network({ [first]: 503, [second]: pipedBody });
    const search = createVideoSearch({ fetch: net.fetch });
    const result = await search.search('rick astley');
    expect(result.ok && result.hits.map((h) => h.videoId)).toEqual(['dQw4w9WgXcQ', 'live0000000']);
    expect(net.calls).toEqual([first, second]);
    expect(search.lastMirror()).toBe(second);
    net.calls.length = 0;
    await search.search('gangnam');
    expect(net.calls).toEqual([second]);
  });

  it('люстэрка маўчыць — не чакаем больш за ліміт', async () => {
    const net = network({ [first]: 'slow', [second]: pipedBody });
    const search = createVideoSearch({ fetch: net.fetch, timeoutMs: 50 });
    const result = await search.search('rick astley');
    expect(result.ok).toBe(true);
  });

  it('усе ўбудаваныя не адказваюць — бярэм люстэркі з агульнага спісу Invidious', async () => {
    const net = network({ 'fresh.example': invidiousBody }, [['fresh.example', { type: 'https', api: true, cors: true }]]);
    const search = createVideoSearch({ fetch: net.fetch });
    const result = await search.search('rick astley');
    expect(result.ok && result.hits[0].videoId).toBe('dQw4w9WgXcQ');
    expect(net.calls).toEqual([first, second, third, new URL(INVIDIOUS_LIST_URL).hostname, 'fresh.example']);
    expect(search.lastMirror()).toBe('fresh.example');
  });

  it('не адказвае ніводнае — пошук не працуе', async () => {
    const net = network({});
    const search = createVideoSearch({ fetch: net.fetch });
    expect(await search.search('rick astley')).toEqual({ ok: false });
  });
});

const hit = (videoId: string, durationS: number | null = 200, live = false): SearchHit => ({ videoId, title: `Відэа ${videoId}`, author: 'Канал', durationS, live });

describe('першае прыдатнае відэа', () => {
  const oembed: FetchLike = async (url) => {
    const id = new URL(new URL(url).searchParams.get('url') ?? '').searchParams.get('v');
    return new Response(JSON.stringify({ title: `Назва ${id}`, author_name: 'Аўтар' }), { status: 200 });
  };
  const probeOf =
    (results: Record<string, ProbeResult>, calls: string[] = []) =>
    async (id: string): Promise<ProbeResult> => {
      calls.push(id);
      return results[id] ?? { status: 'ok', durationMs: 200_000, title: '', live: false, playable: true };
    };
  const deps = (hits: SearchHit[] | null, probe: (id: string) => Promise<ProbeResult>) => ({
    fetch: oembed,
    probe,
    search: async () => (hits ? { ok: true as const, hits } : { ok: false as const }),
    maxDurationMs: 12 * 60_000,
  });

  it('трансляцыі, задоўгія і паўторы адсейваюцца, забарона ўбудавання — наступнае', async () => {
    const calls: string[] = [];
    const hits = [hit('live0000000', null, true), hit('long0000000', 13 * 60), hit('block000000'), hit('block000000'), hit('good0000000')];
    const result = await findVideoByQuery('x', deps(hits, probeOf({ block000000: { status: 'error', code: 150 } }, calls)));
    expect(result).toMatchObject({ ok: true, track: { id: 'yt:good0000000', videoId: 'good0000000', title: 'Назва good0000000', artist: 'Аўтар', source: 'youtube' } });
    expect(calls).toEqual(['block000000', 'good0000000']);
  });

  it('люстэрка не ведала даўжыні — задоўгае адсейвае плэер', async () => {
    const hits = [hit('long0000000', null), hit('good0000000')];
    const probe = probeOf({ long0000000: { status: 'ok', durationMs: 20 * 60_000, title: '', live: false, playable: true } });
    expect(await findVideoByQuery('x', deps(hits, probe))).toMatchObject({ ok: true, track: { videoId: 'good0000000' } });
  });

  it('адмовы: нічога, нічога прыдатнага, пошук не працуе, YouTube маўчыць', async () => {
    expect(await findVideoByQuery('x', deps([], probeOf({})))).toEqual({ ok: false, reason: 'video-search-none' });
    expect(await findVideoByQuery('x', deps([hit('live0000000', null, true)], probeOf({})))).toEqual({ ok: false, reason: 'video-search-unsuitable' });
    expect(await findVideoByQuery('x', deps(null, probeOf({})))).toEqual({ ok: false, reason: 'video-search-failed' });
    const calls: string[] = [];
    const silent = probeOf({ a0000000000: { status: 'timeout' } }, calls);
    expect(await findVideoByQuery('x', deps([hit('a0000000000'), hit('b0000000000')], silent))).toEqual({ ok: false, reason: 'youtube-failed' });
    expect(calls).toEqual(['a0000000000']);
  });

  it('правяраем не больш за 5 вынікаў', async () => {
    const calls: string[] = [];
    const hits = Array.from({ length: 8 }, (_, i) => hit(`block00000${i}`));
    const blocked = Object.fromEntries(hits.map((h) => [h.videoId, { status: 'error', code: 150 } as ProbeResult]));
    expect(await findVideoByQuery('x', deps(hits, probeOf(blocked, calls)))).toEqual({ ok: false, reason: 'video-search-unsuitable' });
    expect(calls).toHaveLength(5);
  });
});
