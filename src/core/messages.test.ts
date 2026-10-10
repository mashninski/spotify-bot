import { describe, expect, it } from 'vitest';
import { createEnvelopeFactory, Deduper, parseEnvelope, type Envelope } from './messages';

/** Імітацыя таго, што робіць OBS (obs_data) з JSON: палі з null знікаюць. */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, dropNulls(v)]),
    );
  }
  return value;
}

describe('пратакол док → оверлей', () => {
  const make = createEnvelopeFactory('sid-1');

  it('паведамленне праходзіць туды і назад', () => {
    const env = make({
      type: 'state',
      state: { current: { key: 'k', title: 'T', artist: 'A', requestedBy: 'u' }, isPlaying: true, upcoming: [] },
    });
    expect(parseEnvelope(env)).toEqual(env);
    expect(parseEnvelope(JSON.stringify(env))).toEqual(env);
  });

  it('стан без песні вытрымлівае пераўтварэнне OBS (null знікае)', () => {
    const env = make({ type: 'state', state: { current: null, isPlaying: false, upcoming: [] } });
    const parsed = parseEnvelope(dropNulls(env));
    expect(parsed?.msg).toEqual({ type: 'state', state: { current: null, isPlaying: false, upcoming: [] } });
  });

  it('чужыя і сапсаваныя паведамленні адкідаюцца', () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope('не json')).toBeNull();
    expect(parseEnvelope({ app: 'other', v: 1, sid: 's', seq: 1, msg: { type: 'ping', at: 1 } })).toBeNull();
    expect(parseEnvelope({ ...make({ type: 'ping', at: 1 }), msg: { type: 'unknown' } })).toBeNull();
  });

  it('узровень гуку абмяжоўваецца 0…1', () => {
    const env = parseEnvelope({ ...make({ type: 'level', level: 0 }), msg: { type: 'level', level: 7 } });
    expect(env?.msg).toEqual({ type: 'level', level: 1 });
  });

  it('паўторы з розных каналаў адкідаюцца, новы док пачынае адлік нанова', () => {
    const d = new Deduper();
    const env = (sid: string, seq: number): Envelope => ({ app: 'spotify-bot', v: 1, sid, seq, msg: { type: 'ping', at: 0 } });
    expect(d.accept(env('a', 1))).toBe(true);
    expect(d.accept(env('a', 1))).toBe(false);
    expect(d.accept(env('a', 2))).toBe(true);
    expect(d.accept(env('a', 1))).toBe(false);
    expect(d.accept(env('b', 1))).toBe(true);
  });
});
