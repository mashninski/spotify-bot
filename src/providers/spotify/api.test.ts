import { describe, expect, it } from 'vitest';
import { createSpotifyApi, SpotifyApiError } from './api';
import { loadTokens, saveTokens } from './auth';
import { createFakeSpotify, memoryStorage, sampleTokens } from './fake';

function setup() {
  const storage = memoryStorage();
  const spotify = createFakeSpotify();
  saveTokens(storage, sampleTokens());
  let requests = 0;
  const api = createSpotifyApi({ storage, fetch: spotify.fetch, onRequest: () => requests++ });
  return { storage, spotify, api, requests: () => requests };
}

describe('Spotify Web API', () => {
  it('чытае стан і чаргу, лічыць запыты', async () => {
    const { api, requests } = setup();
    expect(await api.playback()).toMatchObject({ is_playing: true, item: { id: 'a' } });
    expect(await api.queue()).toMatchObject({ queue: [{ id: 'b' }, { id: 'c' }, { id: 'd' }] });
    expect(requests()).toBe(2);
  });

  it('204 (Spotify нідзе не адкрыты) — null', async () => {
    const { api, spotify } = setup();
    spotify.state.device = null;
    expect(await api.playback()).toBeNull();
  });

  it('«Любімыя трэкі» праз /me/library', async () => {
    const { api, spotify } = setup();
    expect(await api.libraryContains(['spotify:track:a'])).toEqual([false]);
    await api.saveToLibrary(['spotify:track:a']);
    expect(spotify.calls).toContain('PUT /me/library');
    expect(await api.libraryContains(['spotify:track:a'])).toEqual([true]);
  });

  it('састарэлы access token: абнаўляе і паўтарае запыт адзін раз', async () => {
    const { api, spotify, storage } = setup();
    spotify.state.validToken = 'access-new'; // Spotify ужо не прымае наш токен
    spotify.state.tokenCounter = 10;
    expect(await api.me()).toEqual({ name: 'Стрымер' });
    expect(spotify.calls).toEqual(['GET /me', 'TOKEN refresh_token', 'GET /me']);
    expect(loadTokens(storage)?.accessToken).toBe('access-11');
  });

  it('access token скончыўся па часе — абнаўляецца да запыту, адзін раз на некалькі запытаў', async () => {
    const { api, spotify, storage } = setup();
    saveTokens(storage, sampleTokens({ expiresAt: Date.now() - 1000 }));
    await Promise.all([api.playback(), api.queue()]);
    expect(spotify.calls.filter((c) => c.startsWith('TOKEN'))).toHaveLength(1);
  });

  it('уваход састарэў (invalid_grant) — токены выдаляюцца, памылка auth', async () => {
    const { api, spotify, storage } = setup();
    saveTokens(storage, sampleTokens({ expiresAt: 0 }));
    spotify.state.refreshError = 'invalid_grant';
    await expect(api.playback()).rejects.toMatchObject({ kind: 'auth', reason: 'invalid_grant' });
    expect(loadTokens(storage)).toBeNull();
  });

  it('новы ўваход падчас абнаўлення не перазапісваецца', async () => {
    const storage = memoryStorage();
    const spotify = createFakeSpotify();
    saveTokens(storage, sampleTokens({ expiresAt: 0 }));
    const slowFetch: typeof spotify.fetch = async (url, init) => {
      if (url.includes('/api/token')) saveTokens(storage, sampleTokens({ refreshToken: 'refresh-new', accessToken: 'access-2' }));
      return spotify.fetch(url, init);
    };
    const api = createSpotifyApi({ storage, fetch: slowFetch });
    await api.playback();
    expect(loadTokens(storage)?.refreshToken).toBe('refresh-new');
  });

  it('квота: 429 QUOTA_EXCEEDED з Retry-After', async () => {
    const { api, spotify } = setup();
    spotify.state.nextReply = {
      status: 429,
      headers: { 'Retry-After': '7200' },
      body: { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } },
    };
    const err = await api.playback().catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect(err).toMatchObject({ kind: 'quota', retryAfterMs: 7_200_000 });
  });

  it('звычайны ліміт без Retry-After — кароткае чаканне', async () => {
    const { api, spotify } = setup();
    spotify.state.nextReply = { status: 429, body: { error: { status: 429, message: 'API rate limit exceeded' } } };
    await expect(api.playback()).rejects.toMatchObject({ kind: 'rate', retryAfterMs: 5000 });
  });

  it('кнопка без адкрытага Spotify — no-device; 403 — forbidden', async () => {
    const { api, spotify } = setup();
    spotify.state.device = null;
    await expect(api.next()).rejects.toMatchObject({ kind: 'no-device' });
    spotify.state.nextReply = { status: 403, body: { error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } } };
    await expect(api.pause()).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('без токенаў — auth, у сетку нічога не ідзе', async () => {
    const spotify = createFakeSpotify();
    const api = createSpotifyApi({ storage: memoryStorage(), fetch: spotify.fetch });
    await expect(api.playback()).rejects.toMatchObject({ kind: 'auth' });
    expect(spotify.calls).toEqual([]);
  });
});
