import { describe, expect, it } from 'vitest';
import { BUS_NAME, BUS_VERSION, parseBusEnvelope, parseCommand } from './bus';

const env = (msg: unknown, extra: Record<string, unknown> = {}) => ({ app: BUS_NAME, v: BUS_VERSION, from: 'p1', msg, ...extra });

describe('паведамленні шыны', () => {
  it('каманды правяраюцца', () => {
    expect(parseCommand({ type: 'next' })).toEqual({ type: 'next' });
    expect(parseCommand({ type: 'play-now', key: 'k1' })).toEqual({ type: 'play-now', key: 'k1' });
    expect(parseCommand({ type: 'play-now' })).toBeNull();
    expect(parseCommand({ type: 'remove', key: 5 })).toBeNull();
    expect(parseCommand({ type: 'format-disk' })).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });

  it('лішнія палі каманды адкідаюцца', () => {
    expect(parseCommand({ type: 'next', key: 'x', evil: true })).toEqual({ type: 'next' });
  });

  it('чужыя і сапсаваныя паведамленні адкідаюцца', () => {
    expect(parseBusEnvelope(env({ kind: 'hello' }))).toMatchObject({ from: 'p1', msg: { kind: 'hello' } });
    expect(parseBusEnvelope(env({ kind: 'hello' }, { app: 'other' }))).toBeNull();
    expect(parseBusEnvelope(env({ kind: 'hello' }, { v: 99 }))).toBeNull();
    expect(parseBusEnvelope(env({ kind: 'hello' }, { from: 1 }))).toBeNull();
    expect(parseBusEnvelope(env({ kind: 'unknown' }))).toBeNull();
    expect(parseBusEnvelope(env({ kind: 'command', command: { type: 'nope' } }))).toBeNull();
    expect(parseBusEnvelope(env({ kind: 'snapshot', snapshot: {} }))).toBeNull();
    expect(parseBusEnvelope('{"app":"spotify-bot:brain"}')).toBeNull();
  });

  it('каманда ў абгортцы', () => {
    expect(parseBusEnvelope(env({ kind: 'command', command: { type: 'remove', key: 'a#1' } }))?.msg).toEqual({
      kind: 'command',
      command: { type: 'remove', key: 'a#1' },
    });
  });
});
