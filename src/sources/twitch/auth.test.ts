import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../providers/spotify/fake';
import {
  hasScopes,
  isTwitchClientId,
  loadTokens,
  readLoginResult,
  refreshTokens,
  startDeviceLogin,
  validateToken,
  type DeviceCode,
  type LoginResult,
} from './auth';
import { createFakeTwitch, FAKE_CLIENT_ID, sampleTwitchTokens } from './fake';

function login(twitch: ReturnType<typeof createFakeTwitch>, clientId = FAKE_CLIENT_ID) {
  const storage = memoryStorage();
  let code: DeviceCode | null = null;
  const done = new Promise<LoginResult>((resolve) => {
    startDeviceLogin({ storage, fetch: twitch.fetch, clientId, onCode: (c) => (code = c), onDone: resolve });
  });
  return { storage, done, code: () => code };
}

describe('уваход у Twitch (Device Code Flow)', () => {
  it('код → стрымер пацвердзіў → токены з каналам захаваны', async () => {
    const twitch = createFakeTwitch();
    const { storage, done, code } = login(twitch);
    await new Promise((r) => setTimeout(r, 120)); // некалькі апытанняў «authorization_pending»
    expect(code()).toMatchObject({ userCode: 'ABCDEFGH' });
    expect(code()!.verificationUri).toContain('twitch.tv/activate');
    expect(loadTokens(storage)).toBeNull();
    twitch.state.deviceApproved = true;
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(loadTokens(storage)).toMatchObject({ userId: '1001', login: 'streamer', clientId: FAKE_CLIENT_ID, refreshToken: 'tw-refresh-2' });
    expect(twitch.count('ID /token urn:ietf:params:oauth:grant-type:device_code')).toBeGreaterThan(1);
  });

  it('няправільны Client ID — памылка, токенаў няма', async () => {
    const twitch = createFakeTwitch();
    const { storage, done } = login(twitch, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
    await expect(done).resolves.toMatchObject({ ok: false, error: 'invalid client' });
    expect(loadTokens(storage)).toBeNull();
    expect(readLoginResult(storage)).toMatchObject({ ok: false });
  });

  it('refresh token аднаразовы: новы захоўваецца, стары больш не дзейнічае', async () => {
    const twitch = createFakeTwitch();
    const fresh = await refreshTokens(sampleTwitchTokens(), twitch.fetch);
    expect(fresh.refreshToken).toBe('tw-refresh-2');
    expect(fresh.userId).toBe('1001');
    await expect(refreshTokens(sampleTwitchTokens(), twitch.fetch)).rejects.toMatchObject({ status: 400 });
  });

  it('праверка токена: 401 — null, інакш канал і правы', async () => {
    const twitch = createFakeTwitch();
    expect(await validateToken(twitch.fetch, 'bad')).toBeNull();
    const v = await validateToken(twitch.fetch, 'tw-access-1');
    expect(v).toMatchObject({ userId: '1001', login: 'streamer' });
    expect(hasScopes(v!.scopes)).toBe(true);
    expect(hasScopes(['user:write:chat'])).toBe(false);
  });

  it('фармат Client ID', () => {
    expect(isTwitchClientId(FAKE_CLIENT_ID)).toBe(true);
    expect(isTwitchClientId('ABC')).toBe(false);
    expect(isTwitchClientId('0123456789abcdef0123456789abcdef!')).toBe(false);
  });
});
