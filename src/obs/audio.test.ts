import { describe, expect, it } from 'vitest';
import { CEILING_DB, createAutoGain, dbToLevel, FLOOR_DB, levelFromMeters, mulToDb, simulatedLevel, smoothLevel } from './audio';

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

describe('аўтаўзмацненне хвалі', () => {
  /** «Музыка»: удары на `base` дБ і правалы на 10 дБ ціхэй, кожныя 0,5 с; вяртае размах узроўню за апошнія 2 с. */
  function swing(gain: ReturnType<typeof createAutoGain>, base: number, fromMs: number, seconds: number) {
    const levels: number[] = [];
    for (let t = fromMs; t < fromMs + seconds * 1000; t += 50) {
      const db = (t % 500) < 150 ? base : base - 10;
      const level = gain.level(db, t);
      if (t >= fromMs + (seconds - 2) * 1000) levels.push(level);
    }
    return Math.max(...levels) - Math.min(...levels);
  }

  it('ціхая музыка рухае хвалю гэтак жа выразна, як гучная', () => {
    const loud = swing(createAutoGain(), -12, 0, 10);
    const quiet = swing(createAutoGain(), -42, 0, 10);
    expect(quiet).toBeGreaterThan(0.4);
    expect(Math.abs(loud - quiet)).toBeLessThan(0.05);
    // Без аўтаўзмацнення ціхая музыка амаль не рухала б хвалю.
    expect(dbToLevel(-42) - dbToLevel(-52)).toBeLessThan(0.2);
  });

  it('пасля гучнай песні ціхая праз некалькі секунд зноў выразная; цішыня — 0', () => {
    const gain = createAutoGain();
    swing(gain, -10, 0, 10);
    expect(swing(gain, -40, 10_000, 15)).toBeGreaterThan(0.4);
    expect(gain.level(-Infinity, 30_000)).toBe(0);
    expect(gain.level(-70, 30_050)).toBe(0);
  });
});
