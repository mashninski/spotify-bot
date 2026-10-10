// Кліент Spotify Web API (ADR-016). Выкарыстоўвае толькі лідар (ADR-015): ён жа абнаўляе токены.
// Токены кожны раз чытаюцца з localStorage — так лідар адразу бачыць новы ўваход са старонкі вяртання.

import {
  clearTokens,
  loadTokens,
  needsRefresh,
  refreshTokens,
  saveTokens,
  SpotifyAuthError,
  type FetchLike,
  type SpotifyTokens,
} from './auth';

export const API_URL = 'https://api.spotify.com/v1';

/** Калі Spotify не сказаў, колькі чакаць пасля вычарпання квоты. */
const QUOTA_DEFAULT_WAIT_MS = 60 * 60_000;
const RATE_DEFAULT_WAIT_MS = 5000;

export type SpotifyErrorKind =
  /** Няма токенаў або ўваход састарэў — трэба ўвайсці нанова. */
  | 'auth'
  /** Вычарпана квота Development Mode (`QUOTA_EXCEEDED`) — чакаць гадзінамі. */
  | 'quota'
  /** Звычайны ліміт запытаў — чакаць секунды. */
  | 'rate'
  /** Spotify нідзе не адкрыты. */
  | 'no-device'
  /** 403: акаўнт не дададзены ў User Management, няма Premium або дзеянне зараз немагчымае. */
  | 'forbidden'
  | 'network'
  | 'other';

export class SpotifyApiError extends Error {
  constructor(
    readonly kind: SpotifyErrorKind,
    readonly status = 0,
    readonly reason = '',
    /** Колькі чакаць да наступнага запыту (для `quota` і `rate`). */
    readonly retryAfterMs = 0,
  ) {
    super(`${kind}${status ? ` ${status}` : ''}${reason ? `: ${reason}` : ''}`);
    this.name = 'SpotifyApiError';
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SpotifyApiOptions {
  storage: StorageLike | null;
  fetch?: FetchLike;
  now?: () => number;
  /** Выклікаецца на кожны запыт да Spotify (лічыльнік для «Праверкі»). */
  onRequest?: () => void;
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

function retryAfter(response: Response): number | null {
  const value = Number(response.headers.get('Retry-After'));
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

export function createSpotifyApi(options: SpotifyApiOptions) {
  const { storage } = options;
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  let refreshing: Promise<SpotifyTokens> | null = null;

  async function refresh(tokens: SpotifyTokens): Promise<SpotifyTokens> {
    try {
      options.onRequest?.();
      const fresh = await refreshTokens(tokens, fetchFn, now());
      // Пакуль ішоў запыт, стрымер мог увайсці нанова — тады новыя токены важнейшыя.
      const stored = loadTokens(storage);
      if (stored && stored.refreshToken !== tokens.refreshToken) return stored;
      saveTokens(storage, fresh);
      return fresh;
    } catch (e) {
      if (e instanceof SpotifyAuthError && (e.code === 'invalid_grant' || e.code === 'invalid_client')) {
        // Уваход састарэў (6 месяцаў) або прыкладанне выдалена: Spotify раіць не паўтараць, а ўвайсці нанова.
        if (loadTokens(storage)?.refreshToken === tokens.refreshToken) clearTokens(storage);
        throw new SpotifyApiError('auth', 400, e.code);
      }
      throw new SpotifyApiError('network', 0, e instanceof SpotifyAuthError ? e.code : 'refresh');
    }
  }

  async function accessToken(force = false): Promise<string> {
    const tokens = loadTokens(storage);
    if (!tokens) throw new SpotifyApiError('auth', 0, 'no-tokens');
    if (!force && !needsRefresh(tokens, now())) return tokens.accessToken;
    if (!refreshing) {
      refreshing = refresh(tokens).finally(() => {
        refreshing = null;
      });
    }
    return (await refreshing).accessToken;
  }

  async function errorFrom(response: Response): Promise<SpotifyApiError> {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Цела можа не быць.
    }
    const error = isObject(body) && isObject(body.error) ? body.error : {};
    const reason = typeof error.reason === 'string' ? error.reason : typeof error.message === 'string' ? error.message : '';
    const status = response.status;
    if (status === 429) {
      const quota = reason === 'QUOTA_EXCEEDED';
      const wait = retryAfter(response) ?? (quota ? QUOTA_DEFAULT_WAIT_MS : RATE_DEFAULT_WAIT_MS);
      return new SpotifyApiError(quota ? 'quota' : 'rate', status, reason, wait);
    }
    if (status === 404 && reason === 'NO_ACTIVE_DEVICE') return new SpotifyApiError('no-device', status, reason);
    if (status === 401) return new SpotifyApiError('auth', status, reason);
    if (status === 403) return new SpotifyApiError('forbidden', status, reason);
    return new SpotifyApiError('other', status, reason);
  }

  /** Запыт да Web API. Пусты адказ (204) — `null`. На 401 адзін раз абнаўляе токен і паўтарае. */
  async function request(method: string, path: string, retried = false): Promise<unknown> {
    const token = await accessToken(retried);
    options.onRequest?.();
    let response: Response;
    try {
      response = await fetchFn(`${API_URL}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
    } catch {
      throw new SpotifyApiError('network');
    }
    if (response.status === 401 && !retried) return request(method, path, true);
    if (!response.ok) throw await errorFrom(response);
    if (response.status === 204) return null;
    const text = await response.text().catch(() => '');
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  const uris = (list: string[]) => encodeURIComponent(list.join(','));

  return {
    /** Профіль стрымера: імя для налад дока. */
    async me(): Promise<{ name: string }> {
      const json = await request('GET', '/me');
      const name = isObject(json) ? (typeof json.display_name === 'string' && json.display_name) || json.id : '';
      return { name: typeof name === 'string' ? name : '' };
    },
    playback: () => request('GET', '/me/player?additional_types=track,episode'),
    queue: () => request('GET', '/me/player/queue'),
    play: () => request('PUT', '/me/player/play'),
    pause: () => request('PUT', '/me/player/pause'),
    next: () => request('POST', '/me/player/next'),
    previous: () => request('POST', '/me/player/previous'),
    /** Гучнасць Spotify на прыладзе, дзе ён грае (0…100). */
    volume: (percent: number) => request('PUT', `/me/player/volume?volume_percent=${Math.round(percent)}`),
    /** Адзін трэк па id (Этап 3б; пакетны `GET /tracks?ids=` выдалены ў лютым 2026). */
    track: (id: string) => request('GET', `/tracks/${encodeURIComponent(id)}`),
    /** Пошук трэкаў: у Development Mode `limit` не больш за 10 (люты 2026). */
    search: (query: string, limit = 10) =>
      request('GET', `/search?type=track&limit=${Math.min(10, Math.max(1, limit))}&q=${encodeURIComponent(query)}`),
    /** Дадаць трэк у канец «Далей у чарзе» Spotify (выдаліць адтуль API не дазваляе, ADR-007). */
    addToQueue: (uri: string) => request('POST', `/me/player/queue?uri=${encodeURIComponent(uri)}`),
    /** Дадаць у «Любімыя трэкі» (ADR-016: `PUT /me/library` замест выдаленага `PUT /me/tracks`). */
    saveToLibrary: (list: string[]) => request('PUT', `/me/library?uris=${uris(list)}`),
    async libraryContains(list: string[]): Promise<boolean[]> {
      const json = await request('GET', `/me/library/contains?uris=${uris(list)}`);
      return Array.isArray(json) ? json.map((x) => x === true) : list.map(() => false);
    },
  };
}

export type SpotifyApi = ReturnType<typeof createSpotifyApi>;
