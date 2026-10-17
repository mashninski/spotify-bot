// Падробка Spotify для тэстаў: сервер токенаў і плэер Web API у памяці. У зборку не трапляе (імпартуюць толькі тэсты).

import type { FetchLike, SpotifyTokens } from './auth';

export interface FakeTrack {
  id: string;
  name: string;
  artist: string;
  durationMs: number;
  explicit?: boolean;
}

export const fakeTrack = (id: string, durationMs = 180_000): FakeTrack => ({ id, name: `Песня ${id}`, artist: `Гурт ${id}`, durationMs });

/** Трэк каталога для пошуку: id з 22 сімвалаў, як у сапраўдным Spotify (каб працавалі спасылкі). */
export const catalogTrack = (n: number, name: string, artist: string, patch: Partial<FakeTrack> = {}): FakeTrack => ({
  id: `trk${String(n).padStart(19, '0')}`,
  name,
  artist,
  durationMs: 200_000,
  ...patch,
});

/** Каталог па змаўчанні: што знойдзе пошук падробкі. */
export const FAKE_CATALOG: FakeTrack[] = [
  catalogTrack(1, 'Get Lucky', 'Daft Punk'),
  catalogTrack(2, 'Get Lucky - Karaoke Version', 'Party Singers'),
  catalogTrack(3, 'Гісторыя майго жыцця', 'NaviBand'),
  catalogTrack(4, '2112', 'Rush', { durationMs: 20 * 60_000 + 33_000 }),
  catalogTrack(5, 'Lose Yourself', 'Eminem', { explicit: true }),
  catalogTrack(6, 'Тры чарапахі', 'N.R.M.'),
  // Як у SPOTIFY_TEST_QUERIES (тэставыя заказы з дока) — каб іх можна было праверыць з падробкай.
  catalogTrack(7, 'Never Gonna Give You Up', 'Rick Astley', { id: '4cOdK2wGLETKBW3PvgPWqT' }),
  catalogTrack(8, 'Bohemian Rhapsody', 'Queen', { id: '4u7EnebtmKWzUH433cf5Qv' }),
  catalogTrack(9, "Don't Stop Me Now", 'Queen'),
  catalogTrack(10, 'Судно (Борис Рыжий)', 'Molchat Doma'),
];

const toJson = (t: FakeTrack) => ({
  type: 'track',
  id: t.id,
  uri: `spotify:track:${t.id}`,
  name: t.name,
  artists: [{ name: t.artist }],
  duration_ms: t.durationMs,
  explicit: t.explicit === true,
});

export function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

export function sampleTokens(patch: Partial<SpotifyTokens> = {}): SpotifyTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 3600_000,
    scope: '',
    clientId: '0123456789abcdef0123456789abcdef',
    authorizedAt: Date.now(),
    ...patch,
  };
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function createFakeSpotify() {
  const state = {
    /** `null` — Spotify нідзе не адкрыты (204). */
    device: 'ПК' as string | null,
    playing: true,
    progressMs: 1000,
    current: fakeTrack('a') as FakeTrack | null,
    queue: [fakeTrack('b'), fakeTrack('c'), fakeTrack('d')],
    /** «Далей у чарзе» Spotify (`POST /me/player/queue`): грае раней за `queue` (кантэкст). */
    userQueue: [] as FakeTrack[],
    /** Што знаходзяць пошук і `GET /tracks/{id}`. */
    catalog: [...FAKE_CATALOG],
    history: [] as FakeTrack[],
    saved: new Set<string>(),
    volume: 60,
    /**
     * Сапраўдны Spotify паказвае вынік кнопкі не імгненна. Колькі наступных `GET /me/player`
     * пасля кнопкі адкажуць старым станам.
     */
    lagPolls: 0,
    stale: null as unknown,
    validToken: 'access-1',
    validRefresh: 'refresh-1',
    tokenCounter: 1,
    /** Адказ, які атрымае наступны запыт да API (адзін раз). */
    nextReply: null as Reply | null,
    refreshError: '' as string,
  };
  const calls: string[] = [];

  const noDevice: Reply = { status: 404, body: { error: { status: 404, message: 'No active device', reason: 'NO_ACTIVE_DEVICE' } } };

  function playerReply(): Reply {
    if (!state.device) return { status: 204 };
    return {
      status: 200,
      body: {
        is_playing: state.playing,
        progress_ms: state.progressMs,
        item: state.current ? toJson(state.current) : null,
        currently_playing_type: 'track',
        device: { name: state.device, volume_percent: state.volume, supports_volume: true },
      },
    };
  }

  function api(method: string, path: string): Reply {
    const p = path.split('?')[0];
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    const uris = (query.get('uris') ?? '').split(',').filter(Boolean);
    if (method === 'GET' && p === '/me') return { status: 200, body: { id: 'user1', display_name: 'Стрымер' } };
    if (method === 'GET' && p === '/me/player') {
      if (state.stale && state.lagPolls > 0) {
        state.lagPolls--;
        return { status: 200, body: state.stale };
      }
      return playerReply();
    }
    if (method === 'PUT' && p === '/me/player/volume') {
      if (!state.device) return noDevice;
      state.volume = Number(query.get('volume_percent'));
      return { status: 200 };
    }
    if (method === 'GET' && p === '/me/player/queue') {
      const queue = [...state.userQueue, ...state.queue].map(toJson);
      return { status: 200, body: { currently_playing: state.current && toJson(state.current), queue } };
    }
    if (method === 'GET' && p === '/search') {
      const limit = Number(query.get('limit') ?? '5');
      if (!(limit >= 0 && limit <= 10)) return { status: 400, body: { error: { status: 400, message: 'Invalid limit' } } };
      const words = (query.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const score = (t: FakeTrack) => words.filter((w) => `${t.name} ${t.artist}`.toLowerCase().includes(w)).length;
      const items = state.catalog
        .filter((t) => score(t) > 0)
        .sort((a, b) => score(b) - score(a))
        .slice(0, limit)
        .map(toJson);
      return { status: 200, body: { tracks: { items, limit, offset: 0, total: items.length } } };
    }
    if (method === 'GET' && p.startsWith('/tracks/')) {
      const id = decodeURIComponent(p.slice('/tracks/'.length));
      if (!/^[A-Za-z0-9]{22}$/.test(id)) return { status: 400, body: { error: { status: 400, message: 'Invalid base62 id' } } };
      const track = state.catalog.find((t) => t.id === id);
      return track ? { status: 200, body: toJson(track) } : { status: 404, body: { error: { status: 404, message: 'Resource not found' } } };
    }
    if (method === 'GET' && p === '/me/library/contains') return { status: 200, body: uris.map((u) => state.saved.has(u)) };
    if (method === 'PUT' && p === '/me/library') {
      for (const u of uris) state.saved.add(u);
      return { status: 200 };
    }
    if (p.startsWith('/me/player/') && !state.device) return noDevice;
    // Перад кнопкай запамінаем стан — яго «запаздалы» Spotify пакажа яшчэ некалькі апытанняў.
    if (method !== 'GET' && p.startsWith('/me/player/')) state.stale = playerReply().body;
    if (method === 'PUT' && p === '/me/player/pause') {
      state.playing = false;
      return { status: 200 };
    }
    if (method === 'PUT' && p === '/me/player/play') {
      state.playing = true;
      return { status: 200 };
    }
    if (method === 'PUT' && p === '/me/player/seek') {
      state.progressMs = Number(query.get('position_ms') ?? 0);
      return { status: 200 };
    }
    if (method === 'POST' && p === '/me/player/queue') {
      const id = (query.get('uri') ?? '').replace('spotify:track:', '');
      const track = [...state.catalog, ...state.queue].find((t) => t.id === id);
      if (!track) return { status: 400, body: { error: { status: 400, message: 'Invalid track uri' } } };
      state.userQueue.push(track);
      return { status: 204 };
    }
    if (method === 'POST' && p === '/me/player/next') {
      advance();
      return { status: 200 };
    }
    if (method === 'POST' && p === '/me/player/previous') {
      const prev = state.history.pop();
      if (prev) {
        if (state.current) state.queue.unshift(state.current);
        state.current = prev;
      }
      state.progressMs = 0;
      return { status: 200 };
    }
    return { status: 404, body: { error: { status: 404, message: 'not found' } } };
  }

  /** Наступная песня: спачатку «Далей у чарзе», потым кантэкст (як у Spotify). */
  function advance(): void {
    if (state.current) state.history.push(state.current);
    state.current = state.userQueue.shift() ?? state.queue.shift() ?? null;
    state.progressMs = 0;
  }

  function token(body: URLSearchParams): Reply {
    if (body.get('grant_type') === 'authorization_code') {
      if (body.get('code') !== 'good-code') return { status: 400, body: { error: 'invalid_grant' } };
      state.validToken = `access-${++state.tokenCounter}`;
      return { status: 200, body: { access_token: state.validToken, refresh_token: state.validRefresh, expires_in: 3600, scope: 'x' } };
    }
    if (body.get('grant_type') === 'refresh_token') {
      if (state.refreshError) return { status: 400, body: { error: state.refreshError } };
      if (body.get('refresh_token') !== state.validRefresh) return { status: 400, body: { error: 'invalid_grant' } };
      state.validToken = `access-${++state.tokenCounter}`;
      return { status: 200, body: { access_token: state.validToken, expires_in: 3600 } };
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }

  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    let reply: Reply;
    if (url === 'https://accounts.spotify.com/api/token') {
      calls.push(`TOKEN ${new URLSearchParams(String(init?.body)).get('grant_type')}`);
      reply = token(new URLSearchParams(String(init?.body)));
    } else {
      const path = url.replace('https://api.spotify.com/v1', '');
      calls.push(`${method} ${path.split('?')[0]}`);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (state.nextReply) {
        reply = state.nextReply;
        state.nextReply = null;
      } else if (auth !== `Bearer ${state.validToken}`) {
        reply = { status: 401, body: { error: { status: 401, message: 'The access token expired' } } };
      } else reply = api(method, path);
    }
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return new Response(reply.status === 204 ? null : text, { status: reply.status, headers: reply.headers });
  };

  /** Колькі разоў быў такі запыт (напрыклад, `POST /me/player/queue`). */
  const count = (call: string) => calls.filter((c) => c === call).length;

  /** Бягучая песня скончылася сама — Spotify пераходзіць да наступнай. */
  const finishSong = () => advance();

  return { state, calls, fetch, count, finishSong };
}
