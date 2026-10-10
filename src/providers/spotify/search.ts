// Пошук трэка для заказу гледача (Этап 3б, ADR-017): спасылка → `GET /tracks/{id}`, назва → `GET /search`
// і выбар найлепшага супадзення з не больш за 10 вынікаў (абмежаванне Development Mode з лютага 2026).

import type { Track } from '../../core/types';
import { SpotifyApiError, type SpotifyApi } from './api';
import { parseItem } from './map';

/** id трэка Spotify — 22 сімвалы base62. */
const TRACK_LINK = /(?:open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/i;
const ANY_LINK = /(?:https?:\/\/|spotify:|open\.spotify\.com|spotify\.link)/i;

/** id трэка са спасылкі `open.spotify.com/track/…` або `spotify:track:…`; `null` — гэта не спасылка на трэк. */
export function parseTrackLink(text: string): string | null {
  return TRACK_LINK.exec(text)?.[1] ?? null;
}

/** Ці ёсць у тэксце нейкая спасылка (альбом, плэйліст, кароткая spotify.link) — такую не шукаем як назву. */
export function looksLikeLink(text: string): boolean {
  return ANY_LINK.test(text);
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Трэк, які можна заказаць: не лакальны файл, не забаронены ў краіне стрымера. */
export function parsePlayableTrack(raw: unknown): Track | null {
  if (!isObject(raw) || raw.type !== 'track' || raw.is_local === true || raw.is_playable === false) return null;
  if (isObject(raw.restrictions) && raw.restrictions.reason !== 'explicit') return null;
  const track = parseItem(raw);
  return track?.uri?.startsWith('spotify:track:') ? track : null;
}

/** Нармалізацыя для параўнання: малыя літары, без націскаў і знакаў, «feat.» і падобнае прыбіраецца. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set(['feat', 'ft', 'featuring', 'the', 'by', 'song', 'песня', 'песню']);
/** Версіі, якія глядач наўрад ці хоча, калі не напісаў іх сам. */
const VARIANT_WORDS = ['karaoke', 'instrumental', 'remix', 'live', 'cover', 'acoustic', 'sped', 'slowed', 'nightcore', 'remastered'];

/** Наколькі трэк падыходзіць да запыту: доля слоў запыту, знойдзеных у назве і выканаўцах, і бонусы. */
export function matchScore(query: string, track: Track): number {
  const q = words(query);
  if (q.length === 0) return 0;
  const titleWords = words(track.title);
  const all = [...titleWords, ...words(track.artist)];
  const found = q.filter((w) => all.some((t) => t === w || (w.length >= 3 && t.startsWith(w)))).length;
  let score = found / q.length;
  // Чым большая частка назвы песні ёсць у запыце, тым хутчэй гэта яна.
  if (titleWords.length > 0) score += (0.5 * titleWords.filter((w) => q.includes(w)).length) / titleWords.length;
  for (const v of VARIANT_WORDS) if (titleWords.includes(v) && !q.includes(v)) score -= 0.3;
  return score;
}

/** Найлепшы трэк з вынікаў пошуку. Пры роўных балах — той, што вышэй у Spotify. Нічога не супала — першы ад Spotify. */
export function bestMatch(query: string, tracks: Track[]): Track | null {
  let best: Track | null = null;
  let bestScore = -Infinity;
  for (const track of tracks) {
    const score = matchScore(query, track);
    if (score > bestScore + 1e-9) {
      best = track;
      bestScore = score;
    }
  }
  // Калі ні адно слова не супала (напрыклад, глядач напісаў лацінкай, а ў Spotify кірыліца),
  // давяраем парадку Spotify — ён разумее транслітарацыю лепш.
  return bestScore <= 0 ? (tracks[0] ?? null) : best;
}

export type SearchResult =
  | { ok: true; track: Track }
  /** Не знойдзена або спасылка не на трэк. */
  | { ok: false; reason: 'not-found' }
  /** Spotify не адказаў (квота, сетка) — заказ не прыняты, але віна не гледача. */
  | { ok: false; reason: 'failed' };

/** Пошук трэка па тэксце гледача. Памылкі Spotify (квота, сетка) кідае далей як `SpotifyApiError`. */
export async function findTrack(api: Pick<SpotifyApi, 'track' | 'search'>, query: string): Promise<Track | null> {
  const text = query.trim();
  if (!text) return null;
  const id = parseTrackLink(text);
  if (id) {
    try {
      return parsePlayableTrack(await api.track(id));
    } catch (e) {
      // Няправільны або выдалены id — проста «не знайшоў».
      if (e instanceof SpotifyApiError && e.kind === 'other' && (e.status === 400 || e.status === 404)) return null;
      throw e;
    }
  }
  if (looksLikeLink(text)) return null;
  const json = await api.search(text.slice(0, 200));
  const items = isObject(json) && isObject(json.tracks) && Array.isArray(json.tracks.items) ? json.tracks.items : [];
  const tracks = items.map(parsePlayableTrack).filter((t: Track | null): t is Track => t !== null);
  return bestMatch(text, tracks);
}
