import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTHORIZE_URL,
  codeChallenge,
  completeLogin,
  loadTokens,
  needsRefresh,
  PENDING_KEY,
  randomVerifier,
  readLoginResult,
  redirectUriFor,
  refreshTokens,
  SCOPES,
  SpotifyAuthError,
  startLogin,
} from './auth';
import { createFakeSpotify, memoryStorage, sampleTokens } from './fake';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const REDIRECT = 'http://127.0.0.1:5173/callback.html';

describe('уваход у Spotify (PKCE)', () => {
  it('адрас вяртання — callback.html побач з докам, без параметраў', () => {
    expect(redirectUriFor('http://127.0.0.1:5173/dock.html#settings')).toBe(REDIRECT);
    expect(redirectUriFor('https://example.org/bot/dock.html?x=1')).toBe('https://example.org/bot/callback.html');
  });

  it('verifier — з дазволеных сімвалаў, патрэбнай даўжыні', () => {
    const v = randomVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(randomVerifier()).not.toBe(v);
  });

  it('code_challenge = base64url(SHA-256(verifier))', async () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = createHash('sha256').update(v).digest('base64url');
    expect(await codeChallenge(v)).toBe(expected);
  });

  it('пачатак уваходу: адрас Spotify з усімі параметрамі, verifier захаваны', async () => {
    const storage = memoryStorage();
    const url = new URL(await startLogin(storage, CLIENT_ID, REDIRECT));
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('scope')).toBe(SCOPES.join(' '));
    const pending = JSON.parse(storage.getItem(PENDING_KEY)!);
    expect(p.get('state')).toBe(pending.state);
    expect(p.get('code_challenge')).toBe(await codeChallenge(pending.verifier));
  });

  it('вяртанне з кодам: токены захаваны, вынік — ok', async () => {
    const storage = memoryStorage();
    const spotify = createFakeSpotify();
    const url = new URL(await startLogin(storage, CLIENT_ID, REDIRECT, 1000));
    const params = new URLSearchParams({ code: 'good-code', state: url.searchParams.get('state')! });
    const result = await completeLogin(storage, params, spotify.fetch, 2000);
    expect(result).toEqual({ ok: true, at: 2000 });
    expect(loadTokens(storage)).toMatchObject({ refreshToken: 'refresh-1', clientId: CLIENT_ID, authorizedAt: 2000 });
    expect(storage.getItem(PENDING_KEY)).toBeNull();
    expect(readLoginResult(storage)?.ok).toBe(true);
  });

  it('чужы state або адмова стрымера — токенаў няма, памылка запісана', async () => {
    const storage = memoryStorage();
    const spotify = createFakeSpotify();
    await startLogin(storage, CLIENT_ID, REDIRECT);
    const bad = await completeLogin(storage, new URLSearchParams({ code: 'good-code', state: 'чужы' }), spotify.fetch);
    expect(bad).toMatchObject({ ok: false, error: 'state' });
    expect(loadTokens(storage)).toBeNull();

    await startLogin(storage, CLIENT_ID, REDIRECT);
    const denied = await completeLogin(storage, new URLSearchParams({ error: 'access_denied' }), spotify.fetch);
    expect(denied).toMatchObject({ ok: false, error: 'access_denied' });
    expect(readLoginResult(storage)?.error).toBe('access_denied');
  });

  it('абнаўленне: новы access token, стары refresh token застаецца, калі новага няма', async () => {
    const spotify = createFakeSpotify();
    const fresh = await refreshTokens(sampleTokens({ accessToken: 'old' }), spotify.fetch, 5000);
    expect(fresh.accessToken).toBe(spotify.state.validToken);
    expect(fresh.refreshToken).toBe('refresh-1');
    expect(fresh.expiresAt).toBe(5000 + 3600_000);
  });

  it('састарэлы refresh token — памылка invalid_grant', async () => {
    const spotify = createFakeSpotify();
    await expect(refreshTokens(sampleTokens({ refreshToken: 'other' }), spotify.fetch)).rejects.toEqual(
      new SpotifyAuthError('invalid_grant'),
    );
  });

  it('access token абнаўляецца за хвіліну да канца', () => {
    expect(needsRefresh(sampleTokens({ expiresAt: 100_000 }), 30_000)).toBe(false);
    expect(needsRefresh(sampleTokens({ expiresAt: 100_000 }), 50_000)).toBe(true);
  });
});
