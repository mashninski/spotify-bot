import { describe, expect, it } from 'vitest';
import * as q from '../core/queue';
import type { PlayerState, Track } from '../core/types';
import { loadPlayer, PLAYER_KEY, savePlayer } from './persist';

const track = (id: string, durationMs = 180_000): Track => ({ id, title: `T${id}`, artist: 'A', durationMs, explicit: false });

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

function sample(isPlaying: boolean): PlayerState {
  return {
    ...q.emptyPlayerState(),
    current: { key: 'c#1', track: track('c') },
    isPlaying,
    progressMs: 10_000,
    requests: [{ key: 'r#1', track: track('r'), requestedBy: 'kasia' }],
    context: [{ key: 'x#1', track: track('x') }],
  };
}

describe('захаванне чаргі', () => {
  it('захаванае чытаецца назад', () => {
    const storage = memoryStorage();
    savePlayer(storage, sample(false), 1000);
    expect(loadPlayer(storage, 5000)).toEqual(sample(false));
  });

  it('калі песня грала, яна прасоўваецца на прайшоўшы час', () => {
    const storage = memoryStorage();
    savePlayer(storage, sample(true), 1000);
    expect(loadPlayer(storage, 6000)?.progressMs).toBe(15_000);
  });

  it('калі песня за гэты час скончылася, грае наступная (спачатку заказ)', () => {
    const storage = memoryStorage();
    savePlayer(storage, sample(true), 0);
    const loaded = loadPlayer(storage, 175_000);
    expect(loaded?.current?.key).toBe('r#1');
    expect(loaded?.progressMs).toBe(5_000);
    expect(loaded?.history.map((i) => i.key)).toEqual(['c#1']);
  });

  it('сапсаваныя даныя — null', () => {
    const storage = memoryStorage();
    expect(loadPlayer(storage)).toBeNull();
    storage.setItem(PLAYER_KEY, 'не json');
    expect(loadPlayer(storage)).toBeNull();
    storage.setItem(PLAYER_KEY, JSON.stringify({ savedAt: 1, state: { ...sample(true), requests: [{ key: 1 }] } }));
    expect(loadPlayer(storage)).toBeNull();
    storage.setItem(PLAYER_KEY, JSON.stringify({ state: sample(true) }));
    expect(loadPlayer(storage)).toBeNull();
  });

  it('без localStorage нічога не ламаецца', () => {
    expect(savePlayer(null, sample(true))).toBe(false);
    expect(loadPlayer(null)).toBeNull();
  });

  it('песня са Spotify: захоўваецца uri, пасля паўзы ў працы бот не перамотвае на наступную сам', () => {
    const storage = memoryStorage();
    const spotifyTrack = { ...track('s', 20_000), uri: 'spotify:track:s' };
    const s: PlayerState = { ...q.emptyPlayerState(), current: { key: 'sp', track: spotifyTrack }, isPlaying: true, progressMs: 15_000, context: [{ key: 'n', track: { ...track('n'), uri: 'spotify:track:n' } }] };
    savePlayer(storage, s, 0);
    const loaded = loadPlayer(storage, 60_000)!;
    expect(loaded.current?.track.uri).toBe('spotify:track:s');
    expect(loaded.progressMs).toBe(20_000);
    expect(loaded.context).toHaveLength(1);
  });
});
