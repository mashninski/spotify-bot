// Тэставыя даныя (выдуманыя назвы і выканаўцы) для працы без Spotify.

import type { Track } from '../../core/types';

const min = (m: number, s: number) => (m * 60 + s) * 1000;

/** «Плэйліст» стрымера — кантэкст прайгравання. */
export const MOCK_TRACKS: Track[] = [
  { id: 'mock-01', title: 'Начны горад', artist: 'Ліпень', durationMs: min(3, 12), explicit: false },
  { id: 'mock-02', title: 'Дождж па шыбах', artist: 'Сіні Туман', durationMs: min(2, 48), explicit: false },
  { id: 'mock-03', title: 'Апошні цягнік', artist: 'Вецер з усходу', durationMs: min(4, 5), explicit: false },
  { id: 'mock-04', title: 'Неонавае сэрца', artist: 'Kalina Wave', durationMs: min(3, 33), explicit: true },
  { id: 'mock-05', title: 'Зоркі над Нёмнам', artist: 'Ліпень', durationMs: min(3, 51), explicit: false },
  { id: 'mock-06', title: 'Lo-fi для стрыма', artist: 'Pixel Bison', durationMs: min(2, 20), explicit: false },
  { id: 'mock-07', title: 'Вельмі доўгая назва песні, каб праверыць, як яна абразаецца', artist: 'Аркестр Тэставых Даных', durationMs: min(5, 2), explicit: false },
  { id: 'mock-08', title: 'Хуткі старт', artist: 'Speedrun Club', durationMs: min(2, 2), explicit: false },
];

/** Трэкі, якія «заказваюць» гледачы ў тэставым рэжыме. Адзін — даўжэй за 12 хвілін (для праверкі правілаў). */
export const MOCK_REQUEST_TRACKS: Track[] = [
  { id: 'mock-r1', title: 'Песня для чата', artist: 'Зубр і Сябры', durationMs: min(3, 3), explicit: false },
  { id: 'mock-r2', title: 'Кава а трэцяй ночы', artist: 'Сонны Кот', durationMs: min(2, 57), explicit: false },
  { id: 'mock-r3', title: 'Баявы рэйд', artist: 'Raid Boss', durationMs: min(3, 40), explicit: true },
  { id: 'mock-r4', title: 'Лясная сцежка', artist: 'Ціхі Бор', durationMs: min(4, 18), explicit: false },
  { id: 'mock-r5', title: 'Бясконцы джэм', artist: 'Doŭhi Session', durationMs: min(13, 30), explicit: false },
  { id: 'mock-r6', title: 'Сінтвэйв над Мінскам', artist: 'Kalina Wave', durationMs: min(3, 25), explicit: false },
];

export const MOCK_VIEWERS = ['zubr_gamer', 'kasia_bel', 'ales_mix', 'jana_lis', 'pavel_bulba'];

/**
 * Запыты для «+ Тэставы заказ», калі Spotify падключаны: сапраўдныя трэкі праз пошук Spotify.
 * Ідуць па чарзе, каб праверыць усе выпадкі: спасылка, назва па-беларуску і па-англійску, задоўгая песня (правіла 12 хв).
 */
export const SPOTIFY_TEST_QUERIES = [
  'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
  'NaviBand Гісторыя майго жыцця',
  'Daft Punk Get Lucky',
  'N.R.M. Тры чарапахі',
  'spotify:track:4u7EnebtmKWzUH433cf5Qv',
  "Queen Don't Stop Me Now",
  'Rush 2112',
  'Molchat Doma Судно',
];
