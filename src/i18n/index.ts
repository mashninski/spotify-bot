// Пераклады. Зараз толькі беларуская мова (ADR-010); новая мова — новы файл з тымі ж ключамі.

import { be, type MessageKey } from './be';

export type { MessageKey };

const dictionary: Record<MessageKey, string> = be;

/** Тэкст па ключы з падстаноўкай параметраў: t('player.added', { n: 2 }). */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = dictionary[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Працягласць для чалавека: «42 с» або «6 хв 5 с». */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return t('time.seconds', { n: total });
  return t('time.minutes', { m: Math.floor(total / 60), s: total % 60 });
}

/** Час песні: 3:05. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
