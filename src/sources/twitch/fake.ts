// Падробка Twitch для тэстаў: id.twitch.tv (Device Code Flow, токены), Helix (узнагароды, выкупы, падпіскі, чат)
// і EventSub WebSocket у памяці. У зборку не трапляе (імпартуюць толькі тэсты).

import type { FetchLike, TwitchTokens } from './auth';
import type { SocketLike } from './eventsub';

export const FAKE_CLIENT_ID = 'abcdefghijklmnopqrstuvwxyz0123';

export function sampleTwitchTokens(patch: Partial<TwitchTokens> = {}): TwitchTokens {
  return {
    accessToken: 'tw-access-1',
    refreshToken: 'tw-refresh-1',
    expiresAt: Date.now() + 4 * 3600_000,
    scopes: ['channel:manage:redemptions', 'user:write:chat'],
    clientId: FAKE_CLIENT_ID,
    userId: '1001',
    login: 'streamer',
    authorizedAt: Date.now(),
    ...patch,
  };
}

interface Reply {
  status: number;
  body?: unknown;
}

export interface FakeReward {
  id: string;
  title: string;
  cost: number;
  prompt: string;
  is_paused: boolean;
  is_enabled: boolean;
  is_user_input_required: boolean;
  should_redemptions_skip_request_queue: boolean;
  /** Узнагароду стварыла наша прыкладанне (толькі такую можна мяняць). */
  managed: boolean;
}

export interface FakeRedemption {
  id: string;
  reward_id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  status: 'UNFULFILLED' | 'FULFILLED' | 'CANCELED';
  redeemed_at: string;
}

interface Subscription {
  type: string;
  condition: Record<string, string>;
  session: string;
}

/** Злучэнне EventSub на баку падробкі. */
export class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  session = '';

  constructor(
    readonly url: string,
    private readonly server: { closed(s: FakeSocket): void },
  ) {}

  /** Паведамленне ад «Twitch». */
  deliver(msg: unknown): void {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(msg) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.closed(this);
  }

  /** Twitch сам разарваў злучэнне. */
  drop(code = 4006): void {
    if (this.closed) return;
    this.closed = true;
    this.server.closed(this);
    this.onclose?.({ code });
  }
}

export function createFakeTwitch() {
  const state = {
    clientId: FAKE_CLIENT_ID,
    userId: '1001',
    login: 'streamer',
    affiliate: true,
    validToken: 'tw-access-1',
    validRefresh: 'tw-refresh-1',
    tokenCounter: 1,
    /** Device Code Flow: стрымер пацвердзіў код на twitch.tv. */
    deviceApproved: false,
    deviceUsed: false,
    /** Інтэрвал апытання для Device Code Flow, секунды (у тэстах — малы). */
    deviceInterval: 0.05,
    rewards: [] as FakeReward[],
    redemptions: [] as FakeRedemption[],
    chat: [] as string[],
    subscriptions: [] as Subscription[],
    /** Адказ, які атрымае наступны запыт да Helix з гэтым шляхам (адзін раз). */
    nextReply: null as { path: string; reply: Reply } | null,
    /** Колькі наступных запытаў да Helix адкажуць 429. */
    rateLimited: 0,
    counter: 0,
  };
  const calls: string[] = [];
  const sockets: FakeSocket[] = [];
  const server = {
    closed(s: FakeSocket) {
      // Twitch адключае падпіскі злучэння, якое закрылася.
      state.subscriptions = state.subscriptions.filter((x) => x.session !== s.session);
    },
  };

  const id = (prefix: string) => `${prefix}-${++state.counter}`;
  const error = (status: number, message: string): Reply => ({ status, body: { error: 'Error', status, message } });
  const activeSessions = () => new Set(sockets.filter((s) => !s.closed && s.session).map((s) => s.session));

  function welcome(socket: FakeSocket, session: string): void {
    socket.session = session;
    socket.deliver({
      metadata: { message_id: id('msg'), message_type: 'session_welcome', message_timestamp: new Date().toISOString() },
      payload: { session: { id: session, status: 'connected', keepalive_timeout_seconds: 30, reconnect_url: null } },
    });
  }

  const createSocket = (url: string): FakeSocket => {
    const socket = new FakeSocket(url, server);
    sockets.push(socket);
    const reconnectFrom = new URL(url).searchParams.get('from');
    setTimeout(() => {
      if (socket.closed) return;
      const session = id('session');
      if (reconnectFrom) {
        // Падпіскі пераходзяць на новае злучэнне.
        for (const sub of state.subscriptions) if (sub.session === reconnectFrom) sub.session = session;
      }
      welcome(socket, session);
    }, 0);
    return socket;
  };

  function notify(type: string, condition: (c: Record<string, string>) => boolean, event: unknown, messageId = id('msg')): void {
    const live = activeSessions();
    for (const sub of state.subscriptions) {
      if (sub.type !== type || !live.has(sub.session) || !condition(sub.condition)) continue;
      const socket = sockets.find((s) => !s.closed && s.session === sub.session);
      socket?.deliver({
        metadata: {
          message_id: messageId,
          message_type: 'notification',
          message_timestamp: new Date().toISOString(),
          subscription_type: type,
          subscription_version: '1',
        },
        payload: { subscription: { id: id('sub'), type, version: '1', status: 'enabled', condition: sub.condition }, event },
      });
    }
  }

  const rewardJson = (r: FakeReward) => {
    const { managed: _, ...rest } = r;
    return { ...rest, broadcaster_id: state.userId };
  };

  const redemptionEvent = (r: FakeRedemption) => {
    const reward = state.rewards.find((x) => x.id === r.reward_id);
    return {
      id: r.id,
      broadcaster_user_id: state.userId,
      broadcaster_user_login: state.login,
      broadcaster_user_name: state.login,
      user_id: r.user_id,
      user_login: r.user_login,
      user_name: r.user_name,
      user_input: r.user_input,
      status: r.status.toLowerCase(),
      reward: { id: r.reward_id, title: reward?.title ?? '', cost: reward?.cost ?? 0, prompt: reward?.prompt ?? '' },
      redeemed_at: r.redeemed_at,
    };
  };

  function helix(method: string, path: string, query: URLSearchParams, body: Record<string, any>): Reply {
    if (method === 'GET' && path === '/channel_points/custom_rewards') {
      const ids = query.getAll('id');
      let list = state.rewards.filter((r) => query.get('only_manageable_rewards') !== 'true' || r.managed);
      if (ids.length) list = list.filter((r) => ids.includes(r.id));
      if (ids.length && list.length === 0) return error(404, 'Not Found');
      return { status: 200, body: { data: list.map(rewardJson) } };
    }
    if (method === 'POST' && path === '/channel_points/custom_rewards') {
      if (!state.affiliate) return error(403, 'The broadcaster must have partner or affiliate status.');
      if (state.rewards.some((r) => r.title === body.title)) return error(400, 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD');
      if (typeof body.title !== 'string' || body.title.length > 45 || (body.prompt ?? '').length > 200) return error(400, 'bad title or prompt');
      const reward: FakeReward = {
        id: id('reward'),
        title: body.title,
        cost: body.cost,
        prompt: body.prompt ?? '',
        is_paused: false,
        is_enabled: body.is_enabled !== false,
        is_user_input_required: body.is_user_input_required === true,
        should_redemptions_skip_request_queue: body.should_redemptions_skip_request_queue === true,
        managed: true,
      };
      state.rewards.push(reward);
      return { status: 200, body: { data: [rewardJson(reward)] } };
    }
    if (method === 'PATCH' && path === '/channel_points/custom_rewards') {
      const reward = state.rewards.find((r) => r.id === query.get('id'));
      if (!reward) return error(404, 'Not Found');
      if (!reward.managed) return error(403, 'Forbidden');
      for (const key of ['cost', 'is_paused', 'is_enabled', 'title', 'prompt'] as const) {
        if (key in body) (reward as any)[key] = body[key];
      }
      notify('channel.channel_points_custom_reward.update', (c) => !c.reward_id || c.reward_id === reward.id, rewardJson(reward));
      return { status: 200, body: { data: [rewardJson(reward)] } };
    }
    if (method === 'GET' && path === '/channel_points/custom_rewards/redemptions') {
      const status = query.get('status');
      const list = state.redemptions.filter((r) => r.reward_id === query.get('reward_id') && (!status || r.status === status));
      const first = Number(query.get('first') ?? 20);
      const start = Number(query.get('after') || 0);
      const page = list.slice(start, start + first);
      const cursor = start + first < list.length ? String(start + first) : undefined;
      return { status: 200, body: { data: page.map(redemptionEvent).map((e) => ({ ...e, status: e.status.toUpperCase() })), pagination: cursor ? { cursor } : {} } };
    }
    if (method === 'PATCH' && path === '/channel_points/custom_rewards/redemptions') {
      const ids = query.getAll('id');
      const reward = state.rewards.find((r) => r.id === query.get('reward_id'));
      if (reward && !reward.managed) return error(403, 'Forbidden');
      const list = state.redemptions.filter((r) => ids.includes(r.id) && r.status === 'UNFULFILLED');
      if (list.length === 0) return error(404, 'Not Found');
      for (const r of list) r.status = body.status;
      return { status: 200, body: { data: list.map(redemptionEvent) } };
    }
    if (method === 'POST' && path === '/eventsub/subscriptions') {
      const session = body?.transport?.session_id;
      if (!activeSessions().has(session)) return error(400, 'websocket session not found');
      if (state.subscriptions.some((s) => s.type === body.type && s.session === session)) return error(409, 'subscription already exists');
      state.subscriptions.push({ type: body.type, condition: body.condition, session });
      return { status: 202, body: { data: [{ id: id('sub'), status: 'enabled', type: body.type }] } };
    }
    if (method === 'POST' && path === '/chat/messages') {
      if (body.sender_id !== state.userId || body.broadcaster_id !== state.userId) return error(403, 'Forbidden');
      if (typeof body.message !== 'string' || body.message.length > 500) return error(422, 'too large');
      state.chat.push(body.message);
      return { status: 200, body: { data: [{ message_id: id('chat'), is_sent: true }] } };
    }
    return error(404, 'not found');
  }

  function oauth(path: string, form: URLSearchParams, headers: Record<string, string>): Reply {
    if (path === '/device') {
      if (form.get('client_id') !== state.clientId) return error(400, 'invalid client');
      return {
        status: 200,
        body: {
          device_code: 'device-1',
          expires_in: 1800,
          interval: state.deviceInterval,
          user_code: 'ABCDEFGH',
          verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
        },
      };
    }
    if (path === '/token' && form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
      if (form.get('client_id') !== state.clientId) return error(400, 'invalid client');
      if (state.deviceUsed || form.get('device_code') !== 'device-1') return error(400, 'invalid device code');
      if (!state.deviceApproved) return error(400, 'authorization_pending');
      state.deviceUsed = true;
      state.validToken = `tw-access-${++state.tokenCounter}`;
      state.validRefresh = `tw-refresh-${state.tokenCounter}`;
      return {
        status: 200,
        body: { access_token: state.validToken, expires_in: 14400, refresh_token: state.validRefresh, scope: ['channel:manage:redemptions', 'user:write:chat'], token_type: 'bearer' },
      };
    }
    if (path === '/token' && form.get('grant_type') === 'refresh_token') {
      // Refresh token у Public-прыкладання аднаразовы.
      if (form.get('refresh_token') !== state.validRefresh) return error(400, 'Invalid refresh token');
      state.validToken = `tw-access-${++state.tokenCounter}`;
      state.validRefresh = `tw-refresh-${state.tokenCounter}`;
      return { status: 200, body: { access_token: state.validToken, refresh_token: state.validRefresh, expires_in: 14400, scope: ['channel:manage:redemptions', 'user:write:chat'] } };
    }
    if (path === '/validate') {
      if (headers.Authorization !== `OAuth ${state.validToken}`) return error(401, 'invalid access token');
      return {
        status: 200,
        body: { client_id: state.clientId, login: state.login, scopes: ['channel:manage:redemptions', 'user:write:chat'], user_id: state.userId, expires_in: 14000 },
      };
    }
    return error(404, 'not found');
  }

  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const u = new URL(url);
    let reply: Reply;
    if (u.host === 'id.twitch.tv') {
      const path = u.pathname.replace('/oauth2', '');
      const form = new URLSearchParams(String(init?.body ?? ''));
      calls.push(`ID ${path}${form.get('grant_type') ? ` ${form.get('grant_type')}` : ''}`);
      reply = oauth(path, form, headers);
    } else {
      const path = u.pathname.replace('/helix', '');
      calls.push(`${method} ${path}`);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (state.nextReply && state.nextReply.path === `${method} ${path}`) {
        reply = state.nextReply.reply;
        state.nextReply = null;
      } else if (headers.Authorization !== `Bearer ${state.validToken}` || headers['Client-Id'] !== state.clientId) {
        reply = error(401, 'Invalid OAuth token');
      } else if (state.rateLimited > 0) {
        state.rateLimited--;
        reply = error(429, 'Too Many Requests');
      } else reply = helix(method, path, u.searchParams, body);
    }
    return new Response(reply.status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  };

  /** Глядач купляе ўзнагароду. Калі бот падключаны, падзея прыходзіць праз EventSub. */
  function redeem(user: string, input: string, options: { redeemedAt?: number; rewardId?: string } = {}): FakeRedemption {
    const reward = state.rewards.find((r) => r.id === options.rewardId) ?? state.rewards.find((r) => r.managed);
    if (!reward) throw new Error('узнагароды няма');
    const r: FakeRedemption = {
      id: id('redemption'),
      reward_id: reward.id,
      user_id: id('user'),
      user_login: user.toLowerCase(),
      user_name: user,
      user_input: input,
      status: 'UNFULFILLED',
      redeemed_at: new Date(options.redeemedAt ?? Date.now()).toISOString(),
    };
    state.redemptions.push(r);
    notify('channel.channel_points_custom_reward_redemption.add', (c) => !c.reward_id || c.reward_id === reward.id, redemptionEvent(r));
    return r;
  }

  /** Даставіць падзею пра выкуп яшчэ раз (з тым жа або новым message_id). */
  function redeliver(r: FakeRedemption, messageId?: string): void {
    notify('channel.channel_points_custom_reward_redemption.add', () => true, redemptionEvent(r), messageId);
  }

  /** `session_reconnect`: Twitch просіць перайсці на новае злучэнне. */
  function askReconnect(): void {
    for (const s of sockets.filter((x) => !x.closed && x.session)) {
      s.deliver({
        metadata: { message_id: id('msg'), message_type: 'session_reconnect', message_timestamp: new Date().toISOString() },
        payload: { session: { id: s.session, status: 'reconnecting', reconnect_url: `wss://eventsub.wss.twitch.tv/ws?from=${s.session}` } },
      });
    }
  }

  const liveSockets = () => sockets.filter((s) => !s.closed);
  const count = (call: string) => calls.filter((c) => c === call).length;
  const statusOf = (redemptionId: string) => state.redemptions.find((r) => r.id === redemptionId)?.status;

  return { state, calls, sockets, liveSockets, fetch, createSocket, redeem, redeliver, askReconnect, count, statusOf };
}

export type FakeTwitch = ReturnType<typeof createFakeTwitch>;
