import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../../core/types';
import { createSpotifyApi } from './api';
import { saveTokens } from './auth';
import { createFakeSpotify, fakeTrack, memoryStorage, sampleTokens } from './fake';
import type { SpotifyPlayback } from './map';
import { createRequestCounter, createSpotifySync, initialSpotifyInfo, POLL, pollDelay, type SpotifyInfo } from './sync';

const track = (durationMs: number): Track => ({ id: 'a', title: 'A', artist: 'B', durationMs, explicit: false, uri: 'spotify:track:a' });
const playback = (isPlaying: boolean, progressMs: number, durationMs = 180_000): SpotifyPlayback => ({
  isPlaying,
  progressMs,
  track: track(durationMs),
  device: 'ПК',
  volume: 50,
  supportsVolume: true,
});

describe('інтэрвалы апытання Spotify', () => {
  it('грае — раз у 6 с, а бліжэй да канца песні — адразу пасля канца', () => {
    expect(pollDelay(playback(true, 10_000))).toBe(POLL.playing);
    expect(pollDelay(playback(true, 177_000))).toBe(3000 + POLL.endGrace);
    expect(pollDelay(playback(true, 180_000))).toBe(POLL.min);
  });

  it('паўза і «нідзе не адкрыты» — радзей', () => {
    expect(pollDelay(playback(false, 10_000))).toBe(POLL.paused);
    expect(pollDelay(null)).toBe(POLL.idle);
    expect(pollDelay({ isPlaying: false, progressMs: 0, track: null, device: '', volume: null, supportsVolume: false })).toBe(POLL.idle);
  });

  it('за гадзіну музыкі — не больш за ~600 апытанняў стану', () => {
    expect(3600_000 / POLL.playing).toBeLessThanOrEqual(600);
  });
});

function setup() {
  const storage = memoryStorage();
  const fake = createFakeSpotify();
  saveTokens(storage, sampleTokens());
  let now = 1_000_000;
  const api = createSpotifyApi({ storage, fetch: fake.fetch, now: () => now });
  let info: SpotifyInfo = initialSpotifyInfo();
  const notices: string[] = [];
  const updates: { playback: SpotifyPlayback | null; queue: Track[] | null }[] = [];
  const onLoggedOut = vi.fn();
  const sync = createSpotifySync({
    api,
    now: () => now,
    onPlayback: (p, queue) => updates.push({ playback: p, queue }),
    onInfo: (patch) => (info = { ...info, ...patch }),
    onNotice: (n) => notices.push(n),
    onLoggedOut,
  });
  /** Дачакацца, пакуль апытанне скончыцца (усе запыты падробкі — мікразадачы). */
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const advance = async (ms: number) => {
    now += ms;
    sync.tick(now);
    await settle();
  };
  return { fake, sync, updates, notices, onLoggedOut, info: () => info, advance, settle };
}

describe('сінхранізацыя са Spotify', () => {
  it('першае апытанне: імя, песня, чарга, ці ў «Любімых»', async () => {
    const t = setup();
    t.sync.start();
    expect(t.info().status).toBe('connecting');
    await t.advance(0);
    expect(t.fake.calls).toEqual(['GET /me', 'GET /me/player', 'GET /me/player/queue', 'GET /me/library/contains']);
    expect(t.info()).toMatchObject({ status: 'ok', user: 'Стрымер', device: 'ПК', liked: { uri: 'spotify:track:a', saved: false } });
    expect(t.updates[0].playback?.track?.id).toBe('a');
    expect(t.updates[0].queue?.map((x) => x.id)).toEqual(['b', 'c', 'd']);
  });

  it('песня не мяняецца — чарга не перачытваецца; апытанне не часцей за 6 с', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    t.fake.calls.length = 0;
    await t.advance(5000);
    expect(t.fake.calls).toEqual([]);
    await t.advance(1000);
    expect(t.fake.calls).toEqual(['GET /me/player']);
    expect(t.updates.at(-1)?.queue).toBeNull();
  });

  it('пераключэнне ў самім Spotify відаць пры наступным апытанні', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    t.fake.state.current = fakeTrack('z');
    await t.advance(POLL.playing);
    expect(t.updates.at(-1)?.playback?.track?.id).toBe('z');
    expect(t.fake.calls).toContain('GET /me/player/queue');
  });

  it('кнопка «наступная»: каманда і хуткае апытанне пасля яе', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    expect(await t.sync.command('next')).toBe(true);
    t.fake.calls.length = 0;
    await t.advance(POLL.afterCommand);
    expect(t.fake.calls[0]).toBe('GET /me/player');
    expect(t.updates.at(-1)?.playback?.track?.id).toBe('b');
  });

  it('Spotify нідзе не адкрыты: кнопка дае паведамленне, апытанне — раз у 30 с', async () => {
    const t = setup();
    t.fake.state.device = null;
    t.sync.start();
    await t.advance(0);
    expect(t.updates.at(-1)?.playback).toBeNull();
    expect(t.info().device).toBe('');
    expect(await t.sync.command('play')).toBe(false);
    expect(t.notices).toEqual(['no-device']);
    t.fake.calls.length = 0;
    await t.advance(POLL.afterCommand);
    await t.advance(POLL.idle - POLL.afterCommand - 1);
    expect(t.fake.calls).toEqual(['GET /me/player']);
  });

  it('«+»: песня трапляе ў «Любімыя трэкі», паўторна не адпраўляецца', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    await t.sync.save('spotify:track:a');
    expect(t.fake.state.saved.has('spotify:track:a')).toBe(true);
    expect(t.info().liked).toEqual({ uri: 'spotify:track:a', saved: true, busy: false });
    expect(t.notices).toEqual(['saved']);
    const puts = t.fake.calls.filter((c) => c === 'PUT /me/library').length;
    await t.sync.save('spotify:track:a');
    expect(t.fake.calls.filter((c) => c === 'PUT /me/library').length).toBe(puts);
  });

  it('песня ўжо ў «Любімых» — адразу адзнака', async () => {
    const t = setup();
    t.fake.state.saved.add('spotify:track:a');
    t.sync.start();
    await t.advance(0);
    expect(t.info().liked?.saved).toBe(true);
  });

  it('квота вычарпана: чакаем Retry-After, кнопкі не шлюць запытаў', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    t.fake.state.nextReply = { status: 429, headers: { 'Retry-After': '3600' }, body: { error: { status: 429, reason: 'QUOTA_EXCEEDED' } } };
    await t.advance(POLL.playing);
    expect(t.info().status).toBe('limited');
    t.fake.calls.length = 0;
    expect(await t.sync.command('next')).toBe(false);
    expect(t.notices).toContain('limited');
    await t.advance(3_000_000);
    expect(t.fake.calls).toEqual([]);
    await t.advance(600_000);
    expect(t.fake.calls).toContain('GET /me/player');
    expect(t.info().status).toBe('ok');
  });

  it('уваход састарэў — onLoggedOut і больш ніякіх запытаў', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    t.fake.state.validToken = 'другі';
    t.fake.state.refreshError = 'invalid_grant';
    await t.advance(POLL.playing);
    expect(t.onLoggedOut).toHaveBeenCalledOnce();
    t.fake.calls.length = 0;
    await t.advance(POLL.idle);
    expect(t.fake.calls).toEqual([]);
  });

  it('403 пры чытанні стану — падказка пра User Management, паўтор праз хвіліну', async () => {
    const t = setup();
    t.fake.state.nextReply = { status: 403, body: { error: { status: 403, message: 'User not registered in the Developer Dashboard' } } };
    t.sync.start();
    await t.advance(0);
    expect(t.info()).toMatchObject({ status: 'error', problem: 'not-allowed' });
    t.fake.calls.length = 0;
    await t.advance(POLL.forbidden - 1);
    expect(t.fake.calls).toEqual([]);
    await t.advance(1);
    expect(t.info().status).toBe('ok');
  });
});

describe('хуткі водгук пасля кнопак і гучнасць', () => {
  it('Spotify яшчэ не пераключыўся — старыя адказы не паказваюцца, правяраем часта, пакуль не пацвердзіць', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    t.fake.state.lagPolls = 2; // два апытанні запар Spotify адкажа старой песняй
    const shown = t.updates.length;
    await t.sync.command('next');
    await t.advance(POLL.afterCommand);
    await t.advance(POLL.confirm);
    expect(t.updates.length).toBe(shown); // стары стан «a» не паказаны
    await t.advance(POLL.confirm);
    expect(t.updates.at(-1)?.playback?.track?.id).toBe('b');
  });

  it('паўза пацверджана — далей звычайны інтэрвал', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    await t.sync.command('pause');
    await t.advance(POLL.afterCommand);
    expect(t.updates.at(-1)?.playback?.isPlaying).toBe(false);
    t.fake.calls.length = 0;
    await t.advance(POLL.confirm);
    expect(t.fake.calls).toEqual([]);
  });

  it('Spotify так і не пацвердзіў — праз 4 с паказваем тое, што ёсць', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    t.fake.state.lagPolls = 100;
    await t.sync.command('next');
    await t.advance(POLL.afterCommand);
    for (let i = 0; i < 12; i++) await t.advance(POLL.confirm);
    expect(t.updates.at(-1)?.playback?.track?.id).toBe('a');
    expect(t.fake.calls.filter((c) => c === 'GET /me/player').length).toBeLessThan(16);
  });

  it('сігнал «нешта змянілася» (загаловак акна) — апытанне праз 250 мс замест 6 с', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    t.fake.state.current = fakeTrack('z');
    t.sync.nudge();
    await t.advance(POLL.nudge);
    expect(t.updates.at(-1)?.playback?.track?.id).toBe('z');
  });

  it('пакуль Spotify абмежаваў запыты, сігнал не прыспешвае апытанне', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    t.fake.state.nextReply = { status: 429, headers: { 'Retry-After': '60' }, body: { error: { status: 429, reason: 'QUOTA_EXCEEDED' } } };
    await t.advance(POLL.playing);
    t.fake.calls.length = 0;
    t.sync.nudge();
    await t.advance(POLL.nudge);
    expect(t.fake.calls).toEqual([]);
  });

  it('гучнасць: адразу ў стане, у Spotify — не часцей за раз у 300 мс, апошняе значэнне не губляецца', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    expect(t.info()).toMatchObject({ volume: 60, supportsVolume: true });
    t.fake.calls.length = 0;
    t.sync.setVolume(10);
    await t.settle();
    t.sync.setVolume(20);
    t.sync.setVolume(30);
    expect(t.info().volume).toBe(30);
    await t.advance(100);
    expect(t.fake.calls.filter((c) => c === 'PUT /me/player/volume')).toHaveLength(1);
    await t.advance(POLL.volumeThrottle);
    expect(t.fake.calls.filter((c) => c === 'PUT /me/player/volume')).toHaveLength(2);
    expect(t.fake.state.volume).toBe(30);
  });

  it('пасля змены гучнасці старое значэнне з апытання не вяртае паўзунок назад', async () => {
    const t = setup();
    t.sync.start();
    await t.advance(0);
    t.sync.setVolume(15);
    await t.settle();
    t.fake.state.volume = 60; // Spotify яшчэ не паспеў
    t.fake.state.current = fakeTrack('q');
    t.sync.nudge();
    await t.advance(POLL.nudge);
    expect(t.info().volume).toBe(15);
  });
});

describe('лічыльнік запытаў', () => {
  it('лічыць за дзень і пачынае нанова назаўтра', () => {
    const storage = memoryStorage();
    let now = new Date(2026, 9, 10, 12).getTime();
    const counter = createRequestCounter(storage, () => now);
    counter.add();
    expect(counter.add()).toBe(2);
    expect(createRequestCounter(storage, () => now).get()).toBe(2); // новы лідар працягвае лік
    now += 24 * 3600_000;
    expect(counter.get()).toBe(0);
    expect(counter.add()).toBe(1);
  });
});
