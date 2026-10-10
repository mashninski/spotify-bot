import { describe, expect, it } from 'vitest';
import * as q from '../../core/queue';
import type { Track } from '../../core/types';
import { applyPlayback, canSave, parseItem, parsePlayback, parseQueue } from './map';

const spotifyTrack = (id: string) => ({
  type: 'track',
  id,
  uri: `spotify:track:${id}`,
  name: `Песня ${id}`,
  artists: [{ name: 'Першы' }, { name: 'Другі' }],
  duration_ms: 200_000,
  explicit: true,
});

const track = (id: string): Track => parseItem(spotifyTrack(id))!;

describe('адказы Spotify', () => {
  it('трэк: выканаўцы праз коску, explicit, uri', () => {
    expect(parseItem(spotifyTrack('x'))).toEqual({
      id: 'x',
      title: 'Песня x',
      artist: 'Першы, Другі',
      durationMs: 200_000,
      explicit: true,
      uri: 'spotify:track:x',
    });
  });

  it('эпізод падкаста: «выканаўца» — назва шоу', () => {
    const ep = parseItem({ type: 'episode', id: 'e', uri: 'spotify:episode:e', name: 'Выпуск 1', show: { name: 'Падкаст' }, duration_ms: 1000 });
    expect(ep).toMatchObject({ title: 'Выпуск 1', artist: 'Падкаст' });
    expect(canSave(ep)).toBe(true);
  });

  it('лакальны файл: без id, у «Любімыя» не дадаць', () => {
    const local = parseItem({ type: 'track', id: null, uri: 'spotify:local:a:b:c:100', name: 'Мой файл', artists: [], duration_ms: 100_000, is_local: true });
    expect(local?.id).toBe('spotify:local:a:b:c:100');
    expect(canSave(local)).toBe(false);
  });

  it('стан плэера; рэклама і пусты адказ — нічога не грае', () => {
    expect(parsePlayback({ is_playing: true, progress_ms: 5000, item: spotifyTrack('a'), device: { name: 'ПК' } })).toMatchObject({
      isPlaying: true,
      progressMs: 5000,
      device: 'ПК',
      track: { id: 'a' },
    });
    expect(parsePlayback({ is_playing: true, currently_playing_type: 'ad', item: null })).toMatchObject({ track: null, isPlaying: false });
    expect(parsePlayback(null)).toBeNull();
  });

  it('чарга: сапсаваныя элементы прапускаюцца', () => {
    expect(parseQueue({ queue: [spotifyTrack('b'), { foo: 1 }, spotifyTrack('c')] }).map((t) => t.id)).toEqual(['b', 'c']);
    expect(parseQueue({})).toEqual([]);
  });
});

describe('стан плэера са Spotify', () => {
  it('новая песня і чарга', () => {
    const s = applyPlayback(q.emptyPlayerState(), { isPlaying: true, progressMs: 10, track: track('a'), device: 'ПК' }, [track('b'), track('c')]);
    expect(s.current?.track.id).toBe('a');
    expect(s.isPlaying).toBe(true);
    expect(s.context.map((c) => c.track.id)).toEqual(['b', 'c']);
  });

  it('тая ж песня — ключ не мяняецца, нік гледача захоўваецца', () => {
    const base = { ...q.emptyPlayerState(), current: { key: 'k', track: track('a'), requestedBy: 'kasia' } };
    const s = applyPlayback(base, { isPlaying: false, progressMs: 50, track: track('a'), device: '' }, null);
    expect(s.current).toMatchObject({ key: 'k', requestedBy: 'kasia' });
    expect(s.progressMs).toBe(50);
  });

  it('песня змянілася на першую з чаргі, чарга не перачытвалася — яна здымаецца з чаргі', () => {
    const base = applyPlayback(q.emptyPlayerState(), { isPlaying: true, progressMs: 0, track: track('a'), device: '' }, [track('b'), track('c')]);
    const s = applyPlayback(base, { isPlaying: true, progressMs: 0, track: track('b'), device: '' }, null);
    expect(s.context.map((c) => c.track.id)).toEqual(['c']);
  });

  it('заказы гледачоў не кранаюцца', () => {
    const base = { ...q.emptyPlayerState(), requests: [{ key: 'r', track: track('r'), requestedBy: 'u' }] };
    expect(applyPlayback(base, null, []).requests).toEqual(base.requests);
  });
});
