// Праверка відэа для замовы (ADR-020): назва і канал — з oEmbed, даўжыня і ці можна ўбудаваць — са схаванага плэера.
// Замова па назве (B-032): пошук праз люстэркі (`search.ts`), потым тая ж праверка для першых вынікаў.
// Без ключоў і платных сэрвісаў. Плэер падстаўляецца звонку (`probe`), каб логіку можна было тэставаць без браўзера.

import type { Track } from '../core/types';
import { watchUrl } from './link';
import type { SearchResult } from './search';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const OEMBED_URL = 'https://www.youtube.com/oembed';

/** Што сказаў схаваны плэер YouTube пра відэа. */
export type ProbeResult =
  | { status: 'ok'; durationMs: number; title: string; live: boolean; playable: boolean }
  /** `onError` плэера: 2 — няправільны id, 5 — памылка плэера, 100 — не знойдзена, 101/150 — нельга ўбудаваць. */
  | { status: 'error'; code: number }
  /** Плэер не адказаў (няма сеткі, YouTube недаступны). */
  | { status: 'timeout' };

export type VideoProbe = (videoId: string) => Promise<ProbeResult>;

export type VideoFailure =
  /** Відэа няма (выдалена, прыватнае, няправільная спасылка). */
  | 'video-not-found'
  /** Аўтар забараніў убудаванне, узроставае абмежаванне і падобнае. */
  | 'not-embeddable'
  /** Трансляцыя або прэм’ера: даўжыні няма. */
  | 'live'
  /** YouTube не адказаў — віна не гледача. */
  | 'youtube-failed';

export type VideoLookup = { ok: true; track: Track } | { ok: false; reason: VideoFailure };

interface OEmbed {
  title: string;
  author: string;
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** oEmbed: `null` — сетка або YouTube не адказалі (тады спадзяемся на плэер). */
async function oembed(fetchFn: FetchLike, videoId: string): Promise<OEmbed | VideoFailure | null> {
  let response: Response;
  try {
    response = await fetchFn(`${OEMBED_URL}?format=json&url=${encodeURIComponent(watchUrl(videoId))}`);
  } catch {
    return null;
  }
  if (response.status === 401 || response.status === 403) return 'not-embeddable';
  if (response.status === 400 || response.status === 404) return 'video-not-found';
  if (!response.ok) return null;
  try {
    const body = await response.json();
    if (!isObject(body) || typeof body.title !== 'string') return null;
    return { title: body.title, author: typeof body.author_name === 'string' ? body.author_name : '' };
  } catch {
    return null;
  }
}

/** Колькі вынікаў пошуку правяраць плэерам, перш чым адмовіць. */
export const SEARCH_CHECK_LIMIT = 5;

export type SearchFailure =
  /** Па запыце нічога не знайшлося. */
  | 'video-search-none'
  /** Знайшлося, але ніводнае відэа нельга паказаць (задоўгае, трансляцыя, забарона ўбудавання). */
  | 'video-search-unsuitable'
  /** Пошук не працуе: ніводнае люстэрка не адказала. */
  | 'video-search-failed'
  | 'youtube-failed';

export type VideoQueryLookup = { ok: true; track: Track } | { ok: false; reason: SearchFailure };

/**
 * Відэа па назве (B-032): першае з вынікаў пошуку, якое можна паказаць на стрыме і не даўжэйшае за `maxDurationMs`.
 * Відавочна непрыдатныя (трансляцыі, задоўгія — па даных люстэрка) адсейваюцца без плэера.
 */
export async function findVideoByQuery(
  query: string,
  deps: { fetch: FetchLike; probe: VideoProbe; search: (query: string) => Promise<SearchResult>; maxDurationMs: number },
): Promise<VideoQueryLookup> {
  const result = await deps.search(query);
  if (!result.ok) return { ok: false, reason: 'video-search-failed' };
  if (result.hits.length === 0) return { ok: false, reason: 'video-search-none' };
  const seen = new Set<string>();
  const candidates = result.hits.filter((hit) => {
    if (seen.has(hit.videoId)) return false;
    seen.add(hit.videoId);
    return !hit.live && (hit.durationS === null || hit.durationS * 1000 <= deps.maxDurationMs);
  });
  let youtubeDown = false;
  for (const hit of candidates.slice(0, SEARCH_CHECK_LIMIT)) {
    const found = await findVideo(hit.videoId, deps);
    if (found.ok) {
      if (found.track.durationMs > deps.maxDurationMs) continue;
      return { ok: true, track: { ...found.track, title: found.track.title || hit.title, artist: found.track.artist || hit.author } };
    }
    if (found.reason === 'youtube-failed') {
      // Плэер не адказаў — наступныя таксама не адкажуць.
      youtubeDown = true;
      break;
    }
  }
  return { ok: false, reason: youtubeDown ? 'youtube-failed' : 'video-search-unsuitable' };
}

/** Знайсці відэа і праверыць, што яго можна паказаць на стрыме. */
export async function findVideo(videoId: string, deps: { fetch: FetchLike; probe: VideoProbe }): Promise<VideoLookup> {
  const meta = await oembed(deps.fetch, videoId);
  if (typeof meta === 'string') return { ok: false, reason: meta };
  const probe = await deps.probe(videoId);
  if (probe.status === 'timeout') return { ok: false, reason: 'youtube-failed' };
  if (probe.status === 'error') {
    // 2 і 100 — відэа няма; астатняе (101, 150, 5) — паказаць нельга. oEmbed адказаў — значыць, відэа ёсць.
    return { ok: false, reason: (probe.code === 2 || probe.code === 100) && !meta ? 'video-not-found' : 'not-embeddable' };
  }
  if (probe.live || !(probe.durationMs > 0)) return { ok: false, reason: 'live' };
  if (!probe.playable) return { ok: false, reason: 'not-embeddable' };
  return {
    ok: true,
    track: {
      id: `yt:${videoId}`,
      title: meta?.title || probe.title || videoId,
      artist: meta?.author ?? '',
      durationMs: probe.durationMs,
      explicit: false,
      source: 'youtube',
      videoId,
    },
  };
}
