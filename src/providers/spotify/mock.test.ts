import { describe, expect, it } from 'vitest';
import { createMockProvider, MOCK_REQUEST_TRACKS, MOCK_TRACKS } from '.';

describe('тэставая крыніца музыкі', () => {
  it('кантэкст ідзе па крузе', async () => {
    const p = createMockProvider();
    const first = await p.nextContextTracks(MOCK_TRACKS.length);
    const again = await p.nextContextTracks(1);
    expect(first).toEqual(MOCK_TRACKS);
    expect(again[0]).toBe(MOCK_TRACKS[0]);
  });

  it('пошук знаходзіць і трэкі для заказаў', async () => {
    const p = createMockProvider();
    const wanted = MOCK_REQUEST_TRACKS[2];
    expect(await p.searchTrack(`${wanted.artist} ${wanted.title}`)).toBe(wanted);
    expect(await p.searchTrack('такой песні няма')).toBeNull();
    expect(await p.searchTrack('  ')).toBeNull();
  });
});
