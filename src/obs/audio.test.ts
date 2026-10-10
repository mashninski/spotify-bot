import { describe, expect, it } from 'vitest';
import { CEILING_DB, dbToLevel, FLOOR_DB, levelFromMeters, mulToDb, simulatedLevel, smoothLevel } from './audio';

describe('узровень гуку', () => {
  it('пераўтварэнне ў дБ', () => {
    expect(mulToDb(1)).toBeCloseTo(0);
    expect(mulToDb(0.1)).toBeCloseTo(-20);
    expect(mulToDb(0)).toBe(-Infinity);
  });

  it('дБ → 0…1', () => {
    expect(dbToLevel(-Infinity)).toBe(0);
    expect(dbToLevel(FLOOR_DB)).toBe(0);
    expect(dbToLevel(CEILING_DB)).toBe(1);
    expect(dbToLevel(0)).toBe(1);
    expect(dbToLevel((FLOOR_DB + CEILING_DB) / 2)).toBeCloseTo(0.5);
  });

  it('бярэцца найгучнейшы канал; няправільныя даныя — цішыня', () => {
    expect(levelFromMeters([[0.001, 0.5, 0.5], [0.1, 0.2, 0.2]])).toBeCloseTo(dbToLevel(-20));
    expect(levelFromMeters([])).toBe(0);
    expect(levelFromMeters('bad')).toBe(0);
    expect(levelFromMeters([[Number.NaN]])).toBe(0);
  });

  it('згладжванне: хутка ўверх, павольна ўніз', () => {
    const up = smoothLevel(0, 1, 50);
    const down = 1 - smoothLevel(1, 0, 50);
    expect(up).toBeGreaterThan(down);
    expect(smoothLevel(0.3, 0.3, 50)).toBeCloseTo(0.3);
  });

  it('імітацыя заўсёды ў 0…1', () => {
    for (let ms = 0; ms < 5000; ms += 37) {
      const l = simulatedLevel(ms);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
    }
  });
});
