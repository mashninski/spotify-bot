// Крыніца музыкі. На Этапе 2 — толькі тэставая (mock); сапраўдны Spotify Web API — на Этапе 3 (ADR-007, ADR-008).

import type { Track } from '../../core/types';
import { MOCK_REQUEST_TRACKS, MOCK_TRACKS } from './mock-data';

/** Тое, што ядро чакае ад любой крыніцы музыкі (Spotify, пазней — YouTube). */
export interface MusicProvider {
  readonly id: string;
  /** Наступныя трэкі з кантэксту прайгравання (плэйліст, альбом) пасля ўжо вядомых. */
  nextContextTracks(count: number): Promise<Track[]>;
  /** Пошук трэка па спасылцы або назве (для заказаў гледачоў). */
  searchTrack(query: string): Promise<Track | null>;
}

/** Тэставая крыніца: бясконца па крузе аддае трэкі «плэйліста», шукае па ўсіх тэставых трэках. */
export function createMockProvider(
  tracks: Track[] = MOCK_TRACKS,
  searchable: Track[] = [...MOCK_TRACKS, ...MOCK_REQUEST_TRACKS],
): MusicProvider {
  let cursor = 0;
  return {
    id: 'mock',
    async nextContextTracks(count) {
      const out: Track[] = [];
      for (let i = 0; i < count && tracks.length > 0; i++) {
        out.push(tracks[cursor % tracks.length]);
        cursor++;
      }
      return out;
    },
    async searchTrack(query) {
      const q = query.trim().toLowerCase();
      if (!q) return null;
      return searchable.find((t) => `${t.artist} ${t.title}`.toLowerCase().includes(q)) ?? null;
    },
  };
}

export { MOCK_TRACKS, MOCK_REQUEST_TRACKS, MOCK_VIEWERS, SPOTIFY_TEST_QUERIES } from './mock-data';
