// Twitch у лідары з кіраваным часам: 429, старыя заказы пры запуску, паўза ўзнагароды.

import { describe, expect, it } from 'vitest';
import { emptyPlayerState } from '../../core/queue';
import type { PlayerState } from '../../core/types';
import { memoryStorage } from '../../providers/spotify/fake';
import { RATE_WAIT_MS } from './api';
import { saveTokens } from './auth';
import { createFakeTwitch, sampleTwitchTokens } from './fake';
import { chatText, createTwitchLink, STALE_MS, type RequestOutcome } from './twitch';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1));
};

function setup(outcome: RequestOutcome = { ok: true, title: 'Песня', n: 1 }) {
  const twitch = createFakeTwitch();
  const storage = memoryStorage();
  saveTokens(storage, sampleTwitchTokens());
  let clock = Date.now();
  let readiness: 'ready' | 'wait' | 'off' = 'ready';
  let player: PlayerState = emptyPlayerState();
  const handled: string[] = [];
  const link = createTwitchLink({
    storage,
    fetch: twitch.fetch,
    createSocket: twitch.createSocket,
    now: () => clock,
    price: () => 1000,
    readiness: (kind) => (kind === 'song' ? readiness : 'ready'),
    onRedemption: async (r) => {
      handled.push(r.query);
      // Як мозг: прыняты заказ — у чарзе з сувяззю з выкупам.
      if (outcome.ok) {
        const track = { id: r.id, title: r.query, artist: '', durationMs: 1000, explicit: false, uri: `spotify:track:${r.id}` };
        player = { ...player, requests: [...player.requests, { key: r.id, track, requestedBy: r.user, redemptionId: r.id }] };
      }
      return outcome;
    },
    player: () => player,
    onInfo: () => {},
    onLoggedOut: () => {},
  });
  /** Некалькі крокаў таймера мозгу па `ms`. */
  const run = async (ms: number, step = 250) => {
    for (let t = 0; t < ms; t += step) {
      clock += step;
      link.tick(clock);
      await flush();
    }
  };
  return {
    twitch,
    link,
    run,
    handled,
    setReadiness: (r: typeof readiness) => (readiness = r),
    now: () => clock,
    clearPlayer: () => (player = emptyPlayerState()),
  };
}

describe('Twitch у лідары', () => {
  it('429 пры вяртанні балаў — чакае каля паўхвіліны і паўтарае', async () => {
    const { twitch, link, run } = setup({ ok: false, reason: 'not-found' });
    link.start();
    await run(3000);
    expect(twitch.state.subscriptions).toHaveLength(3);
    twitch.state.rateLimited = 1;
    const r = twitch.redeem('Ales', 'zzzz');
    await run(1000);
    expect(twitch.count('PATCH /channel_points/custom_rewards/redemptions')).toBe(1);
    expect(twitch.statusOf(r.id)).toBe('UNFULFILLED');
    await run(RATE_WAIT_MS - 2000, 1000);
    expect(twitch.statusOf(r.id)).toBe('UNFULFILLED');
    await run(3000, 500);
    expect(twitch.statusOf(r.id)).toBe('CANCELED');
    await run(1000);
    expect(twitch.state.chat).toEqual([chatText('Ales', { ok: false, reason: 'not-found' }, 'zzzz')]);
  });

  it('заказы, зробленыя, калі бот не працаваў: свежы — у чаргу, стары — балы вернуты', async () => {
    const { twitch, link, run, handled, now } = setup();
    link.start();
    await run(3000);
    link.stop();
    const old = twitch.redeem('Old', 'стары заказ', { redeemedAt: now() - STALE_MS - 60_000 });
    const fresh = twitch.redeem('Fresh', 'новы заказ', { redeemedAt: now() - 60_000 });
    link.start();
    await run(4000);
    expect(handled).toEqual(['новы заказ']);
    expect(twitch.statusOf(old.id)).toBe('CANCELED');
    expect(twitch.statusOf(fresh.id)).toBe('UNFULFILLED');
    expect(twitch.state.chat).toContain('@Old бот не працаваў у момант замовы, балы вернуты');
  });

  it('пакуль Spotify падключаецца, заказ чакае, а не адмяняецца', async () => {
    const { twitch, link, run, handled, setReadiness } = setup();
    link.start();
    await run(3000);
    setReadiness('wait');
    const r = twitch.redeem('Kasia', 'песня');
    await run(2000);
    expect(handled).toEqual([]);
    expect(twitch.statusOf(r.id)).toBe('UNFULFILLED');
    setReadiness('ready');
    await run(500);
    expect(handled).toEqual(['песня']);
  });

  it('пусты заказ — балы вернуты', async () => {
    const { twitch, link, run, handled } = setup();
    link.start();
    await run(3000);
    const r = twitch.redeem('Kasia', '   ');
    await run(2000);
    expect(handled).toEqual([]);
    expect(twitch.statusOf(r.id)).toBe('CANCELED');
  });

  it('паўза ўзнагароды не міргае: толькі калі бот не гатовы некалькі секунд', async () => {
    const { twitch, link, run, setReadiness } = setup();
    link.start();
    await run(4000);
    setReadiness('off');
    await run(1000);
    setReadiness('ready');
    await run(5000);
    expect(twitch.count('PATCH /channel_points/custom_rewards')).toBe(0);
    setReadiness('off');
    await run(4000);
    expect(twitch.state.rewards[0].is_paused).toBe(true);
  });

  it('песня двойчы знікла з чаргі, не пачаўшы граць, — адзін паўтор, потым балы вернуты', async () => {
    const { twitch, link, run, handled, clearPlayer } = setup();
    link.start();
    await run(3000);
    const r = twitch.redeem('Kasia', 'песня');
    await run(1000);
    expect(handled).toEqual(['песня']);
    clearPlayer();
    await run(1000);
    expect(handled).toEqual(['песня', 'песня']);
    clearPlayer();
    await run(2000);
    expect(handled).toHaveLength(2);
    expect(twitch.statusOf(r.id)).toBe('CANCELED');
  });

  it('паведамленне пра прынятую замову: «Гурт — Назва стала ў чаргу»; доўгія назвы скарачаюцца', () => {
    expect(chatText('u', { ok: true, title: 'Pneuma', artist: 'TOOL', n: 1 })).toBe('@u TOOL — Pneuma стала ў чаргу');
    expect(chatText('u', { ok: true, title: 'Pneuma', n: 1 })).toBe('@u Pneuma стала ў чаргу');
    const text = chatText('u', { ok: true, title: 'x'.repeat(300), artist: 'y'.repeat(300), n: 2 });
    expect(text.length).toBeLessThan(200);
  });
});
