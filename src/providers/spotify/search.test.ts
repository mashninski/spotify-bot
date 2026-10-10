import { describe, expect, it } from 'vitest';
import type { Track } from '../../core/types';
import { createSpotifyApi } from './api';
import { saveTokens } from './auth';
import { createFakeSpotify, FAKE_CATALOG, memoryStorage, sampleTokens } from './fake';
import { bestMatch, findTrack, looksLikeLink, parsePlayableTrack, parseTrackLink } from './search';

const ID = '4cOdK2wGLETKBW3PvgPWqT';
const t = (title: string, artist: string): Track => ({ id: title, title, artist, durationMs: 1, explicit: false });

describe('спасылкі на трэк', () => {
  it('разумее open.spotify.com (з intl і параметрамі) і spotify:track:', () => {
    expect(parseTrackLink(`https://open.spotify.com/track/${ID}?si=abc123`)).toBe(ID);
    expect(parseTrackLink(`https://open.spotify.com/intl-de/track/${ID}`)).toBe(ID);
    expect(parseTrackLink(`глядзі open.spotify.com/track/${ID} клас`)).toBe(ID);
    expect(parseTrackLink(`spotify:track:${ID}`)).toBe(ID);
  });

  it('спасылка не на трэк — не id, але і не назва песні', () => {
    expect(parseTrackLink(`https://open.spotify.com/album/${ID}`)).toBeNull();
    expect(looksLikeLink(`https://open.spotify.com/album/${ID}`)).toBe(true);
    expect(looksLikeLink('https://spotify.link/abcd')).toBe(true);
    expect(looksLikeLink('Daft Punk Get Lucky')).toBe(false);
  });
});

describe('выбар найлепшага супадзення', () => {
  it('выбірае арыгінал, а не караоке, і ўлічвае выканаўцу', () => {
    const results = [t('Get Lucky - Karaoke Version', 'Party Singers'), t('Get Lucky', 'Daft Punk'), t('Lucky', 'Britney Spears')];
    expect(bestMatch('daft punk get lucky', results)?.artist).toBe('Daft Punk');
    expect(bestMatch('get lucky karaoke', results)?.artist).toBe('Party Singers');
  });

  it('кірыліца без адрознення націскаў і знакаў', () => {
    const results = [t('Іншая', 'Хтосьці'), t('Гісторыя майго жыцця', 'NaviBand')];
    expect(bestMatch('naviband - гісторыя майго жыцця!', results)?.artist).toBe('NaviBand');
  });

  it('ні адно слова не супала (транслітарацыя) — давяраем першаму выніку Spotify', () => {
    const results = [t('Воины света', 'Ляпис Трубецкой'), t('Іншая', 'Хтосьці')];
    expect(bestMatch('lyapis trubetskoy voiny sveta', results)?.title).toBe('Воины света');
    expect(bestMatch('што-небудзь', [])).toBeNull();
  });

  it('лакальныя файлы і недаступныя ў краіне трэкі заказаць нельга', () => {
    const raw = { type: 'track', id: ID, uri: `spotify:track:${ID}`, name: 'X', artists: [], duration_ms: 1000 };
    expect(parsePlayableTrack(raw)?.id).toBe(ID);
    expect(parsePlayableTrack({ ...raw, is_playable: false })).toBeNull();
    expect(parsePlayableTrack({ ...raw, restrictions: { reason: 'market' } })).toBeNull();
    expect(parsePlayableTrack({ ...raw, is_local: true })).toBeNull();
    expect(parsePlayableTrack({ ...raw, type: 'episode' })).toBeNull();
  });
});

describe('пошук праз Spotify (падробка)', () => {
  function setup() {
    const storage = memoryStorage();
    saveTokens(storage, sampleTokens());
    const spotify = createFakeSpotify();
    return { spotify, api: createSpotifyApi({ storage, fetch: spotify.fetch }) };
  }

  it('па спасылцы — GET /tracks/{id}', async () => {
    const { spotify, api } = setup();
    const target = FAKE_CATALOG[2];
    const found = await findTrack(api, `https://open.spotify.com/track/${target.id}?si=x`);
    expect(found).toMatchObject({ title: 'Гісторыя майго жыцця', uri: `spotify:track:${target.id}` });
    expect(spotify.calls).toEqual([`GET /tracks/${target.id}`]);
  });

  it('па назве — GET /search з limit не больш за 10', async () => {
    const { spotify, api } = setup();
    expect(await findTrack(api, 'Daft Punk Get Lucky')).toMatchObject({ title: 'Get Lucky', artist: 'Daft Punk' });
    expect(spotify.calls).toEqual(['GET /search']);
  });

  it('няма такога трэка, кепская спасылка або спасылка на альбом — не знойдзена', async () => {
    const { spotify, api } = setup();
    expect(await findTrack(api, 'zzz qqq')).toBeNull();
    expect(await findTrack(api, `spotify:track:${'Z'.repeat(22)}`)).toBeNull();
    expect(await findTrack(api, `https://open.spotify.com/album/${ID}`)).toBeNull();
    expect(await findTrack(api, '   ')).toBeNull();
    expect(spotify.calls).toEqual(['GET /search', `GET /tracks/${'Z'.repeat(22)}`]);
  });

  it('квота Spotify — памылка ідзе далей (заказ не прыняты не па віне гледача)', async () => {
    const { spotify, api } = setup();
    spotify.state.nextReply = { status: 429, body: { error: { status: 429, reason: 'QUOTA_EXCEEDED' } } };
    await expect(findTrack(api, 'Get Lucky')).rejects.toMatchObject({ kind: 'quota' });
  });
});
