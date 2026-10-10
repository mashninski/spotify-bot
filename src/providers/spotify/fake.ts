// Падробка Spotify для тэстаў: сервер токенаў і плэер Web API у памяці. У зборку не трапляе (імпартуюць толькі тэсты).

import type { FetchLike, SpotifyTokens } from './auth';

export interface FakeTrack {
  id: string;
  name: string;
  artist: string;
  durationMs: number;
}

export const fakeTrack = (id: string, durationMs = 180_000): FakeTrack => ({ id, name: `Песня ${id}`, artist: `Гурт ${id}`, durationMs });

const toJson = (t: FakeTrack) => ({
  type: 'track',
  id: t.id,
  uri: `spotify:track:${t.id}`,
  name: t.name,
  artists: [{ name: t.artist }],
  duration_ms: t.durationMs,
  explicit: false,
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
    history: [] as FakeTrack[],
    saved: new Set<string>(),
    validToken: 'access-1',
    validRefresh: 'refresh-1',
    tokenCounter: 1,
    /** Адказ, які атрымае наступны запыт да API (адзін раз). */
    nextReply: null as Reply | null,
    refreshError: '' as string,
  };
  const calls: string[] = [];

  function api(method: string, path: string): Reply {
    const p = path.split('?')[0];
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    const uris = (query.get('uris') ?? '').split(',').filter(Boolean);
    if (method === 'GET' && p === '/me') return { status: 200, body: { id: 'user1', display_name: 'Стрымер' } };
    if (method === 'GET' && p === '/me/player') {
      if (!state.device) return { status: 204 };
      return {
        status: 200,
        body: {
          is_playing: state.playing,
          progress_ms: state.progressMs,
          item: state.current ? toJson(state.current) : null,
          currently_playing_type: 'track',
          device: { name: state.device },
        },
      };
    }
    if (method === 'GET' && p === '/me/player/queue') {
      return { status: 200, body: { currently_playing: state.current && toJson(state.current), queue: state.queue.map(toJson) } };
    }
    if (method === 'GET' && p === '/me/library/contains') return { status: 200, body: uris.map((u) => state.saved.has(u)) };
    if (method === 'PUT' && p === '/me/library') {
      for (const u of uris) state.saved.add(u);
      return { status: 200 };
    }
    const noDevice = { status: 404, body: { error: { status: 404, message: 'No active device', reason: 'NO_ACTIVE_DEVICE' } } };
    if (p.startsWith('/me/player/') && !state.device) return noDevice;
    if (method === 'PUT' && p === '/me/player/pause') {
      state.playing = false;
      return { status: 200 };
    }
    if (method === 'PUT' && p === '/me/player/play') {
      state.playing = true;
      return { status: 200 };
    }
    if (method === 'POST' && p === '/me/player/next') {
      if (state.current) state.history.push(state.current);
      state.current = state.queue.shift() ?? null;
      state.progressMs = 0;
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

  return { state, calls, fetch };
}
