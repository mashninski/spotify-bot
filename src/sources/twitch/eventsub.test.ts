import { describe, expect, it, vi } from 'vitest';
import { createEventSub, KEEPALIVE_S } from './eventsub';
import { createFakeTwitch } from './fake';

const flush = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const twitch = createFakeTwitch();
  let now = 1_000_000;
  const welcomes: string[] = [];
  const events: unknown[] = [];
  const statuses: string[] = [];
  const es = createEventSub({
    createSocket: twitch.createSocket,
    now: () => now,
    onWelcome: (id) => welcomes.push(id),
    onNotification: (_type, event) => events.push(event),
    onRevoked: () => {},
    onStatus: (s) => statuses.push(s),
  });
  return { twitch, es, welcomes, events, statuses, advance: (ms: number) => (now += ms), now: () => now };
}

const notification = (id: string) => ({
  metadata: { message_id: id, message_type: 'notification', subscription_type: 'x' },
  payload: { subscription: { type: 'x' }, event: { id } },
});

describe('EventSub WebSocket', () => {
  it('welcome → можна падпісвацца; паўторная дастаўка паведамлення ігнаруецца', async () => {
    const { twitch, es, welcomes, events, statuses } = setup();
    es.start();
    await flush();
    expect(welcomes).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'ok']);
    expect(twitch.sockets[0].url).toContain(`keepalive_timeout_seconds=${KEEPALIVE_S}`);
    twitch.sockets[0].deliver(notification('m1'));
    twitch.sockets[0].deliver(notification('m1'));
    twitch.sockets[0].deliver(notification('m2'));
    expect(events).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('Twitch маўчыць даўжэй за keepalive — перападключэнне і новы welcome', async () => {
    const { twitch, es, welcomes, advance, now } = setup();
    es.start();
    await flush();
    advance((KEEPALIVE_S + 4) * 1000);
    es.tick(now());
    expect(twitch.liveSockets()).toHaveLength(1);
    advance(2000);
    es.tick(now());
    expect(twitch.liveSockets()).toHaveLength(0);
    advance(1000);
    es.tick(now());
    await flush();
    expect(twitch.liveSockets()).toHaveLength(1);
    expect(welcomes).toHaveLength(2);
  });

  it('session_reconnect: новае злучэнне з тымі ж падпіскамі, старое закрыта, нанова не падпісваемся', async () => {
    const { twitch, es, welcomes } = setup();
    es.start();
    await flush();
    twitch.state.subscriptions.push({ type: 'x', condition: {}, session: twitch.sockets[0].session });
    twitch.askReconnect();
    await flush();
    expect(welcomes).toHaveLength(1);
    expect(twitch.sockets).toHaveLength(2);
    expect(twitch.sockets[0].closed).toBe(true);
    expect(twitch.state.subscriptions[0].session).toBe(twitch.sockets[1].session);
    expect(es.status).toBe('ok');
  });

  it('разрыў злучэння — перападключэнне з паўзай, якая расце', async () => {
    const { twitch, es, welcomes, advance, now } = setup();
    es.start();
    await flush();
    twitch.sockets[0].drop();
    expect(es.status).toBe('connecting');
    es.tick(now());
    expect(twitch.liveSockets()).toHaveLength(0);
    advance(1000);
    es.tick(now());
    await flush();
    expect(welcomes).toHaveLength(2);
    twitch.sockets[1].drop();
    advance(1000);
    es.tick(now());
    expect(twitch.liveSockets()).toHaveLength(0); // другі раз чакаем 2 с
    advance(1000);
    es.tick(now());
    await flush();
    expect(welcomes).toHaveLength(3);
  });

  it('stop закрывае злучэнне і не перападключаецца', async () => {
    const { twitch, es, advance, now } = setup();
    es.start();
    await flush();
    es.stop();
    advance(60_000);
    es.tick(now());
    await flush();
    expect(twitch.liveSockets()).toHaveLength(0);
    expect(vi.isFakeTimers()).toBe(false);
  });
});
