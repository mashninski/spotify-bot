import { describe, expect, it } from 'vitest';
import { defaultSettings, loadSettings, saveSettings, SETTINGS_KEY } from './settings';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe('налады', () => {
  it('без захаваных налад — значэнні па змаўчанні', () => {
    expect(loadSettings(memoryStorage())).toEqual(defaultSettings());
    expect(loadSettings(null)).toEqual(defaultSettings());
  });

  it('захаваць і прачытаць', () => {
    const storage = memoryStorage();
    const s = defaultSettings();
    s.obs.password = 'x';
    s.audioSource = 'Spotify';
    s.rules.maxPerUser = 3;
    expect(saveSettings(storage, s)).toBe(true);
    expect(loadSettings(storage)).toEqual(s);
  });

  it('сапсаваныя даныя не ламаюць док', () => {
    expect(loadSettings(memoryStorage({ [SETTINGS_KEY]: '{не json' }))).toEqual(defaultSettings());
    const partial = loadSettings(memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ rules: { price: -5, maxPerUser: 4 } }) }));
    expect(partial.rules.price).toBe(1000);
    expect(partial.rules.maxPerUser).toBe(4);
    expect(partial.obs.url).toBe('ws://127.0.0.1:4455');
  });

  it('памылка запісу не кідае выключэнне', () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(saveSettings(broken, defaultSettings())).toBe(false);
  });
});
