import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, t } from '.';
import { be } from './be';

describe('пераклады', () => {
  it('падстаноўка параметраў', () => {
    expect(t('player.added', { user: 'kasia', title: 'Песня', n: 2 })).toBe('kasia: «Песня» — №2 у чарзе');
  });

  it('невядомы параметр застаецца як ёсць', () => {
    expect(t('player.added', { user: 'u' })).toContain('{title}');
  });

  it('няма пустых тэкстаў', () => {
    for (const [key, value] of Object.entries(be)) expect(value.trim(), key).not.toBe('');
  });

  it('апошні сказ тэксту без кропкі (ADR-014) — і ў кожным абзацы і кроку падказкі', () => {
    for (const [key, value] of Object.entries(be)) {
      for (const line of value.split('\n')) expect(line.trimEnd().endsWith('.'), `${key}: ${line}`).toBe(false);
    }
  });

  it('без вядомых русізмаў і памылак (ADR-010)', () => {
    const banned = [/балл/i, /скапіру/i, /прайграць/i, /адпраўлен/i, /заказ/i, /оверлей/i];
    for (const [key, value] of Object.entries(be)) for (const re of banned) expect(re.test(value), `${key}: ${re}`).toBe(false);
  });

  it('падказкі: абзацы праз адзін пусты радок, без лішніх прабелаў', () => {
    for (const [key, value] of Object.entries(be)) {
      expect(value.includes('\n\n\n'), key).toBe(false);
      for (const line of value.split('\n')) expect(line !== line.trim(), `${key}: «${line}»`).toBe(false);
    }
  });

  it('фарматы часу', () => {
    expect(formatClock(185_000)).toBe('3:05');
    expect(formatDuration(42_000)).toBe('42 с');
    expect(formatDuration(365_000)).toBe('6 хв 5 с');
  });
});
