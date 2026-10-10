import { describe, expect, it } from 'vitest';
import { createSpotifyWindowReader, spotifyTitleFromItems, type ObsCaller } from './spotify-window';

const item = (title: string, cls: string, exe: string) => ({ itemName: `[${exe}]: ${title}`, itemValue: `${title}:${cls}:${exe}`, itemEnabled: true });

function fakeObs(inputs: { inputName: string; inputKind: string }[], windows: ReturnType<typeof item>[] | null) {
  const calls: string[] = [];
  const obs: ObsCaller = {
    async call(type, data) {
      calls.push(`${type}${data?.inputName ? ` ${data.inputName}` : ''}`);
      if (type === 'GetInputList') return { inputs: inputs.map((i) => ({ ...i, unversionedInputKind: i.inputKind })) };
      if (type === 'GetInputPropertiesListPropertyItems') {
        if (!windows) throw new Error('no property');
        return { propertyItems: windows };
      }
      return {};
    },
  };
  return { obs, calls };
}

describe('загаловак акна Spotify', () => {
  it('знаходзіць галоўнае акно Spotify сярод іншых', () => {
    const items = [
      item('Чат', 'Chrome_WidgetWin_1', 'chrome.exe'),
      item('', 'Chrome_WidgetWin_1', 'Spotify.exe'),
      item('Linkin Park - Numb', 'Chrome_WidgetWin_0', 'Spotify.exe'),
    ];
    expect(spotifyTitleFromItems(items)).toBe('Linkin Park - Numb');
  });

  it('паўза — «Spotify Premium»; Spotify закрыты — null', () => {
    expect(spotifyTitleFromItems([item('Spotify Premium', 'Chrome_WidgetWin_0', 'Spotify.exe')])).toBe('Spotify Premium');
    expect(spotifyTitleFromItems([item('Чат', 'Chrome_WidgetWin_1', 'chrome.exe')])).toBeNull();
    expect(spotifyTitleFromItems([])).toBeNull();
  });

  it('чытае праз крыніцу «Захват звука приложения»', async () => {
    const { obs, calls } = fakeObs(
      [
        { inputName: 'Мікрафон', inputKind: 'wasapi_input_capture' },
        { inputName: 'Spotify гук', inputKind: 'wasapi_process_output_capture' },
      ],
      [item('Queen - Bohemian Rhapsody', 'Chrome_WidgetWin_0', 'Spotify.exe')],
    );
    expect(await createSpotifyWindowReader(obs).read()).toEqual({ status: 'ok', title: 'Queen - Bohemian Rhapsody' });
    expect(calls).toEqual(['GetInputList', 'GetInputPropertiesListPropertyItems Spotify гук']);
  });

  it('няма патрэбнай крыніцы або акна Spotify', async () => {
    const noSource = fakeObs([{ inputName: 'Мікрафон', inputKind: 'wasapi_input_capture' }], []);
    expect(await createSpotifyWindowReader(noSource.obs).read()).toEqual({ status: 'no-source', title: null });
    const noWindow = fakeObs([{ inputName: 'Акно', inputKind: 'window_capture' }], [item('Чат', 'X', 'chrome.exe')]);
    expect(await createSpotifyWindowReader(noWindow.obs).read()).toEqual({ status: 'no-window', title: null });
  });

  it('крыніца без спіса акон не ламае праверку', async () => {
    const broken = fakeObs([{ inputName: 'Гульня', inputKind: 'game_capture' }], null);
    expect(await createSpotifyWindowReader(broken.obs).read()).toEqual({ status: 'no-window', title: null });
  });
});
