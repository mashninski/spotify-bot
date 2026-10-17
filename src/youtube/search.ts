// Пошук відэа YouTube па назве (B-032, ADR-020 дапаўненне 8) — без ключоў API і платных сэрвісаў.
// Афіцыйнага спосабу няма: унутраны API YouTube са старонак іншых сайтаў адказвае 403, `listType=search` у плэеры
// выдалены (памылка 150; праверана 2026-10-17). Таму шукаем праз адкрытыя люстэркі YouTube (Piped, Invidious),
// якія дазваляюць запыты з любой старонкі (CORS). Люстэркі часам не працуюць — спрабуем па чарзе, першым —
// тое, што адказала апошнім. Люстэрка толькі прапануе відэа: ці можна яго паказаць, правярае сам YouTube (`findVideo`).

import type { FetchLike } from './lookup';

/** Відэа з вынікаў пошуку. Даўжыня і «трансляцыя» — з люстэрка (для хуткага адсеву), праўду скажа плэер. */
export interface SearchHit {
  videoId: string;
  title: string;
  author: string;
  /** Секунды; `null` — люстэрка не ведае. */
  durationS: number | null;
  live: boolean;
}

export type SearchResult = { ok: true; hits: SearchHit[] } | { ok: false };

interface Mirror {
  /** Імя для дыягностыкі. */
  name: string;
  url: (query: string) => string;
  parse: (body: unknown) => SearchHit[] | null;
}

/** Колькі чакаць адно люстэрка. */
export const MIRROR_TIMEOUT_MS = 6000;
/** Як часта абнаўляць спіс люстэркаў Invidious. */
const DISCOVERY_EVERY_MS = 6 * 60 * 60_000;
/** Агульны спіс люстэркаў Invidious з адзнакамі «API» і «CORS». */
export const INVIDIOUS_LIST_URL = 'https://api.invidious.io/instances.json?sort_by=health';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown) => (typeof x === 'string' ? x : '');

/** Piped: `{ items: [{ url: '/watch?v=…', title, uploaderName, duration, … }] }`, у трансляцый `duration` = -1. */
export function parsePiped(body: unknown): SearchHit[] | null {
  if (!isObject(body) || !Array.isArray(body.items)) return null;
  const hits: SearchHit[] = [];
  for (const item of body.items) {
    if (!isObject(item) || (item.type !== undefined && item.type !== 'stream')) continue;
    const videoId = str(item.url).match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1];
    if (!videoId) continue;
    const duration = typeof item.duration === 'number' ? item.duration : null;
    hits.push({
      videoId,
      title: str(item.title),
      author: str(item.uploaderName),
      durationS: duration !== null && duration > 0 ? duration : null,
      live: duration === -1 || item.isLive === true,
    });
  }
  return hits;
}

/** Invidious: `[{ type: 'video', videoId, title, author, lengthSeconds, liveNow, isUpcoming }]`. */
export function parseInvidious(body: unknown): SearchHit[] | null {
  if (!Array.isArray(body)) return null;
  const hits: SearchHit[] = [];
  for (const item of body) {
    if (!isObject(item) || item.type !== 'video' || !VIDEO_ID.test(str(item.videoId))) continue;
    const length = typeof item.lengthSeconds === 'number' ? item.lengthSeconds : null;
    const live = item.liveNow === true || item.isUpcoming === true;
    hits.push({ videoId: item.videoId, title: str(item.title), author: str(item.author), durationS: length && length > 0 ? length : null, live });
  }
  return hits;
}

const piped = (host: string): Mirror => ({
  name: host,
  url: (q) => `https://${host}/search?q=${encodeURIComponent(q)}&filter=videos`,
  parse: parsePiped,
});

const invidious = (host: string): Mirror => ({
  name: host,
  url: (q) => `https://${host}/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
  parse: parseInvidious,
});

/** Люстэркі, якія адказвалі з CORS 2026-10-17. Спіс Invidious дапаўняецца з `INVIDIOUS_LIST_URL`. */
export const BUILT_IN_MIRRORS: Mirror[] = [piped('api.piped.private.coffee'), piped('pipedapi.ducks.party'), invidious('invidious.f5.si')];

/** З агульнага спісу Invidious — толькі https-люстэркі з уключанымі API і CORS. */
export function parseInvidiousList(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  const hosts: string[] = [];
  for (const entry of body) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !isObject(entry[1])) continue;
    const info = entry[1];
    if (info.type === 'https' && info.api === true && info.cors === true && /^[a-z0-9.-]+$/i.test(entry[0])) hosts.push(entry[0]);
  }
  return hosts;
}

async function fetchJson(fetchFn: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetchFn(url, controller ? { signal: controller.signal } : undefined), timeout]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await Promise.race([response.json(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface VideoSearchOptions {
  fetch: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  /** Свой спіс люстэркаў (тэсты). */
  mirrors?: Mirror[];
  /** Ці дапаўняць спіс з агульнага спісу Invidious. */
  discover?: boolean;
}

export function createVideoSearch(options: VideoSearchOptions) {
  const fetchFn = options.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? MIRROR_TIMEOUT_MS;
  const builtIn = options.mirrors ?? BUILT_IN_MIRRORS;
  const discover = options.discover ?? !options.mirrors;
  let discovered: Mirror[] = [];
  let discoveredAt = -Infinity;
  /** Люстэрка, якое адказала апошнім, — спрабуем першым. */
  let preferred = '';
  /** Апошняе люстэрка, што адказала (для «Стану»). */
  let lastUsed = '';

  async function refreshDiscovered(): Promise<void> {
    if (!discover || now() - discoveredAt < DISCOVERY_EVERY_MS) return;
    discoveredAt = now();
    try {
      const known = new Set(builtIn.map((m) => m.name));
      discovered = parseInvidiousList(await fetchJson(fetchFn, INVIDIOUS_LIST_URL, timeoutMs))
        .filter((host) => !known.has(host))
        .map(invidious);
    } catch {
      // Спіс недаступны — застаюцца ўбудаваныя люстэркі.
    }
  }

  function ordered(): Mirror[] {
    const all = [...builtIn, ...discovered];
    const first = all.find((m) => m.name === preferred);
    return first ? [first, ...all.filter((m) => m !== first)] : all;
  }

  /** Пошук: першае люстэрка, якое адказала. `ok: false` — не адказала ніводнае. */
  async function search(query: string): Promise<SearchResult> {
    const tried = new Set<string>();
    const attempt = async (mirrors: Mirror[]): Promise<SearchHit[] | null> => {
      for (const mirror of mirrors) {
        if (tried.has(mirror.name)) continue;
        tried.add(mirror.name);
        try {
          const hits = mirror.parse(await fetchJson(fetchFn, mirror.url(query), timeoutMs));
          if (!hits) continue;
          preferred = lastUsed = mirror.name;
          return hits;
        } catch {
          // Наступнае люстэрка.
        }
      }
      return null;
    };
    let hits = await attempt(ordered());
    if (!hits) {
      // Ніводнае не адказала — магчыма, спіс састарэў: абнавіць і паспрабаваць новыя.
      await refreshDiscovered();
      hits = await attempt(discovered);
    }
    return hits ? { ok: true, hits } : { ok: false };
  }

  return { search, lastMirror: () => lastUsed };
}

export type VideoSearch = ReturnType<typeof createVideoSearch>;
