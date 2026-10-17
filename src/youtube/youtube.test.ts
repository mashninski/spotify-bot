// Спасылкі YouTube і праверка відэа (ADR-020).

import { describe, expect, it } from 'vitest';
import { mentionsYouTube, parseYouTubeLink, youtubeSignInUrl } from './link';
import { findVideo, type FetchLike, type ProbeResult } from './lookup';

describe('спасылкі YouTube', () => {
  it('усе звычайныя віды спасылак', () => {
    const id = 'dQw4w9WgXcQ';
    for (const link of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
      `http://m.youtube.com/watch?feature=share&v=${id}`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?si=abc`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`,
      `youtu.be/${id}`,
      `глядзі гэта: https://youtu.be/${id} 🔥`,
    ]) {
      expect(parseYouTubeLink(link), link).toBe(id);
    }
  });

  it('не відэа — null', () => {
    for (const text of [
      'Rick Astley Never Gonna Give You Up',
      'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      'https://www.youtube.com/@RickAstleyYT',
      'https://www.youtube.com/playlist?list=PL123',
      'https://youtu.be/short',
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(parseYouTubeLink(text), text).toBeNull();
    }
  });

  it('уваход у YouTube з дока: Google → youtube.com → назад у док', () => {
    const back = 'https://mashninski.github.io/spotify-bot/dock.html#settings';
    const url = new URL(youtubeSignInUrl(back));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/ServiceLogin');
    expect(url.searchParams.get('service')).toBe('youtube');
    const signin = new URL(url.searchParams.get('continue')!);
    expect(signin.origin + signin.pathname).toBe('https://www.youtube.com/signin');
    const next = new URL(signin.searchParams.get('next')!, 'https://www.youtube.com');
    expect(next.pathname).toBe('/redirect');
    expect(next.searchParams.get('q')).toBe(back);
  });

  it('любая згадка YouTube (для падказкі ва ўзнагародзе песні)', () => {
    expect(mentionsYouTube('https://www.youtube.com/@RickAstleyYT')).toBe(true);
    expect(mentionsYouTube('Rick Astley')).toBe(false);
  });
});

function oembed(status: number, body: unknown = { title: 'Rick Astley - Never Gonna Give You Up', author_name: 'Rick Astley' }): FetchLike {
  return async () => new Response(status === 200 ? JSON.stringify(body) : 'Bad Request', { status });
}

const ok = (patch: Partial<Extract<ProbeResult, { status: 'ok' }>> = {}): ProbeResult => ({
  status: 'ok',
  durationMs: 213_000,
  title: 'з плэера',
  live: false,
  playable: true,
  ...patch,
});

describe('праверка відэа', () => {
  it('добрае відэа: назва і канал з oEmbed, даўжыня з плэера', async () => {
    const result = await findVideo('dQw4w9WgXcQ', { fetch: oembed(200), probe: async () => ok() });
    expect(result).toEqual({
      ok: true,
      track: {
        id: 'yt:dQw4w9WgXcQ',
        title: 'Rick Astley - Never Gonna Give You Up',
        artist: 'Rick Astley',
        durationMs: 213_000,
        explicit: false,
        source: 'youtube',
        videoId: 'dQw4w9WgXcQ',
      },
    });
  });

  it('oEmbed не адказаў — назва з плэера', async () => {
    const fail: FetchLike = async () => {
      throw new TypeError('network');
    };
    const result = await findVideo('dQw4w9WgXcQ', { fetch: fail, probe: async () => ok() });
    expect(result.ok && result.track.title).toBe('з плэера');
  });

  it('адмовы: няма відэа, забарона ўбудавання, трансляцыя, YouTube маўчыць', async () => {
    const never = async (): Promise<ProbeResult> => {
      throw new Error('плэер не павінен запускацца');
    };
    expect(await findVideo('aaaaaaaaaaa', { fetch: oembed(400), probe: never })).toEqual({ ok: false, reason: 'video-not-found' });
    expect(await findVideo('aaaaaaaaaaa', { fetch: oembed(404), probe: never })).toEqual({ ok: false, reason: 'video-not-found' });
    expect(await findVideo('aaaaaaaaaaa', { fetch: oembed(401), probe: never })).toEqual({ ok: false, reason: 'not-embeddable' });
    // oEmbed ёсць, а плэер кажа 150 — убудаванне забаронена або ўзроставае абмежаванне.
    expect(await findVideo('aaaaaaaaaaa', { fetch: oembed(200), probe: async () => ({ status: 'error', code: 150 }) })).toEqual({
      ok: false,
      reason: 'not-embeddable',
    });
    expect(await findVideo('aaaaaaaaaaa', { fetch: oembed(200), probe: async () => ok({ playable: false }) })).toEqual({
      ok: false,
      reason: 'not-embeddable',
    });
    expect(await findVideo('aaaaaaaaaaa', { fetch: oembed(200), probe: async () => ok({ live: true, durationMs: 0 }) })).toEqual({
      ok: false,
      reason: 'live',
    });
    expect(await findVideo('aaaaaaaaaaa', { fetch: oembed(200), probe: async () => ok({ durationMs: 0 }) })).toEqual({ ok: false, reason: 'live' });
    expect(await findVideo('aaaaaaaaaaa', { fetch: oembed(200), probe: async () => ({ status: 'timeout' }) })).toEqual({
      ok: false,
      reason: 'youtube-failed',
    });
  });
});
