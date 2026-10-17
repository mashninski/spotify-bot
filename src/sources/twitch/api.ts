// Кліент Twitch Helix API (ADR-018). Выкарыстоўвае толькі лідар (ADR-015): ён жа абнаўляе токены.
// Токены кожны раз чытаюцца з localStorage — лідар адразу бачыць новы ўваход з дока.

import { guarded } from '../../core/busy';
import {
  clearTokens,
  loadTokens,
  needsRefresh,
  refreshTokens,
  saveLoginResult,
  saveTokens,
  TwitchAuthError,
  type FetchLike,
  type TwitchTokens,
} from './auth';

export const HELIX_URL = 'https://api.twitch.tv/helix';

/**
 * Колькі чакаць пасля 429. Twitch кажа час у загалоўку `Ratelimit-Reset`, але браўзер яго не бачыць
 * (CORS не адкрывае гэты загаловак, праверана 2026-10-11), таму чакаем каля хвіліны — столькі доўжыцца «вядро» запытаў.
 */
export const RATE_WAIT_MS = 30_000;

export type TwitchErrorKind =
  /** Няма токенаў або ўваход састарэў — трэба ўвайсці нанова. */
  | 'auth'
  | 'rate'
  /** 403: канал не Affiliate/Partner або ўзнагарода створана іншым прыкладаннем. */
  | 'forbidden'
  | 'not-found'
  | 'bad-request'
  | 'conflict'
  | 'network'
  | 'other';

export class TwitchApiError extends Error {
  constructor(
    readonly kind: TwitchErrorKind,
    readonly status = 0,
    readonly reason = '',
  ) {
    super(`${kind}${status ? ` ${status}` : ''}${reason ? `: ${reason}` : ''}`);
    this.name = 'TwitchApiError';
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface TwitchApiOptions {
  storage: StorageLike | null;
  fetch?: FetchLike;
  now?: () => number;
  /** Уваход састарэў або адкліканы (токены ўжо выдалены). */
  onLoggedOut?: () => void;
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

export interface Reward {
  id: string;
  title: string;
  cost: number;
  /** Падказка гледачу ў акне ўзнагароды. */
  prompt?: string;
  isPaused: boolean;
  isEnabled: boolean;
}

export interface Redemption {
  id: string;
  rewardId: string;
  userId: string;
  userLogin: string;
  userName: string;
  userInput: string;
  status: string;
  redeemedAt: number;
}

export function parseReward(raw: unknown): Reward | null {
  if (!isObject(raw) || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    cost: typeof raw.cost === 'number' ? raw.cost : 0,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined,
    isPaused: raw.is_paused === true,
    isEnabled: raw.is_enabled !== false,
  };
}

/** Выкуп узнагароды з Helix або з падзеі EventSub (палі аднолькавыя, акрамя ўзнагароды). */
export function parseRedemption(raw: unknown): Redemption | null {
  if (!isObject(raw) || typeof raw.id !== 'string') return null;
  const reward = isObject(raw.reward) ? raw.reward : {};
  const rewardId = typeof reward.id === 'string' ? reward.id : typeof raw.reward_id === 'string' ? raw.reward_id : '';
  const at = Date.parse(typeof raw.redeemed_at === 'string' ? raw.redeemed_at : '');
  const login = typeof raw.user_login === 'string' ? raw.user_login : '';
  return {
    id: raw.id,
    rewardId,
    userId: typeof raw.user_id === 'string' ? raw.user_id : '',
    userLogin: login,
    userName: (typeof raw.user_name === 'string' && raw.user_name) || login,
    userInput: typeof raw.user_input === 'string' ? raw.user_input : '',
    status: typeof raw.status === 'string' ? raw.status.toUpperCase() : '',
    redeemedAt: Number.isFinite(at) ? at : 0,
  };
}

export function createTwitchApi(options: TwitchApiOptions) {
  const { storage } = options;
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  let refreshing: Promise<TwitchTokens> | null = null;

  function loggedOut(tokens: TwitchTokens): never {
    // Новы ўваход за гэты час не чапаем.
    if (loadTokens(storage)?.refreshToken === tokens.refreshToken) {
      clearTokens(storage);
      saveLoginResult(storage, { ok: false, error: 'expired', at: now() });
      options.onLoggedOut?.();
    }
    throw new TwitchApiError('auth', 401, 'logged-out');
  }

  async function refresh(tokens: TwitchTokens): Promise<TwitchTokens> {
    try {
      const fresh = await refreshTokens(tokens, fetchFn, now());
      // Пакуль ішоў запыт, стрымер мог увайсці нанова — тады новыя токены важнейшыя.
      const stored = loadTokens(storage);
      if (stored && stored.refreshToken !== tokens.refreshToken) return stored;
      saveTokens(storage, fresh);
      return fresh;
    } catch (e) {
      if (e instanceof TwitchAuthError && (e.status === 400 || e.status === 401)) loggedOut(tokens);
      throw new TwitchApiError('network', 0, 'refresh');
    }
  }

  /** Бягучыя токены; калі access token хутка скончыцца (або `force`) — абнаўляе. Адначасова — толькі адно абнаўленне. */
  async function tokens(force = false): Promise<TwitchTokens> {
    const current = loadTokens(storage);
    if (!current) throw new TwitchApiError('auth', 0, 'no-tokens');
    if (!force && !needsRefresh(current, now())) return current;
    // Пакуль ідзе абнаўленне, старонка сама не перазагружаецца (refresh token Twitch аднаразовы).
    refreshing ??= guarded(() => refresh(current)).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function errorFrom(response: Response): Promise<TwitchApiError> {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Цела можа не быць.
    }
    const reason = isObject(body) && typeof body.message === 'string' ? body.message : '';
    const status = response.status;
    if (status === 429) return new TwitchApiError('rate', status, reason);
    if (status === 401) return new TwitchApiError('auth', status, reason);
    if (status === 403) return new TwitchApiError('forbidden', status, reason);
    if (status === 404) return new TwitchApiError('not-found', status, reason);
    if (status === 409) return new TwitchApiError('conflict', status, reason);
    if (status === 400 || status === 422) return new TwitchApiError('bad-request', status, reason);
    return new TwitchApiError('other', status, reason);
  }

  /** Запыт да Helix. На 401 адзін раз абнаўляе токен і паўтарае. */
  async function request(method: string, path: string, body?: unknown, retried = false): Promise<unknown> {
    const t = await tokens(retried);
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${t.accessToken}`,
        'Client-Id': t.clientId,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response: Response;
    try {
      response = await fetchFn(`${HELIX_URL}${path}`, init);
    } catch {
      throw new TwitchApiError('network');
    }
    if (response.status === 401 && !retried) return request(method, path, body, true);
    if (response.status === 401) loggedOut(t);
    if (!response.ok) throw await errorFrom(response);
    if (response.status === 204) return null;
    const text = await response.text().catch(() => '');
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  const data = (json: unknown): unknown[] => (isObject(json) && Array.isArray(json.data) ? json.data : []);
  const q = (params: Record<string, string | string[]>) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) search.append(k, x);
    return search.toString();
  };

  return {
    /** Бягучыя токены (для EventSub і ідэнтыфікатара канала). */
    tokens,

    async getRewards(broadcasterId: string, ids: string[] = []): Promise<Reward[]> {
      const params: Record<string, string | string[]> = { broadcaster_id: broadcasterId, only_manageable_rewards: 'true' };
      if (ids.length) params.id = ids;
      const json = await request('GET', `/channel_points/custom_rewards?${q(params)}`);
      return data(json).map(parseReward).filter((r): r is Reward => r !== null);
    },

    async createReward(broadcasterId: string, reward: Record<string, unknown>): Promise<Reward> {
      const json = await request('POST', `/channel_points/custom_rewards?${q({ broadcaster_id: broadcasterId })}`, reward);
      const created = parseReward(data(json)[0]);
      if (!created) throw new TwitchApiError('other', 200, 'bad-response');
      return created;
    },

    async updateReward(broadcasterId: string, id: string, patch: Record<string, unknown>, keepalive = false): Promise<Reward | null> {
      if (keepalive) {
        // Старонка зачыняецца: запыт павінен дайсці і пасля выгрузкі, адказ ужо ніхто не прачытае.
        const t = loadTokens(storage);
        if (!t) return null;
        await fetchFn(`${HELIX_URL}/channel_points/custom_rewards?${q({ broadcaster_id: broadcasterId, id })}`, {
          method: 'PATCH',
          keepalive: true,
          headers: { Authorization: `Bearer ${t.accessToken}`, 'Client-Id': t.clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }).catch(() => null);
        return null;
      }
      const json = await request('PATCH', `/channel_points/custom_rewards?${q({ broadcaster_id: broadcasterId, id })}`, patch);
      return parseReward(data(json)[0]);
    },

    /** Невыкананыя выкупы ўзнагароды (найстарэйшыя спачатку). */
    async unfulfilled(broadcasterId: string, rewardId: string, after = ''): Promise<{ items: Redemption[]; cursor: string }> {
      const params: Record<string, string> = { broadcaster_id: broadcasterId, reward_id: rewardId, status: 'UNFULFILLED', sort: 'OLDEST', first: '50' };
      if (after) params.after = after;
      const json = await request('GET', `/channel_points/custom_rewards/redemptions?${q(params)}`);
      const cursor = isObject(json) && isObject(json.pagination) && typeof json.pagination.cursor === 'string' ? json.pagination.cursor : '';
      return { items: data(json).map(parseRedemption).filter((r): r is Redemption => r !== null), cursor };
    },

    /** FULFILLED — выканана; CANCELED — адмена, баллы вяртаюцца гледачу. */
    async setRedemptionStatus(broadcasterId: string, rewardId: string, id: string, status: 'FULFILLED' | 'CANCELED'): Promise<void> {
      await request('PATCH', `/channel_points/custom_rewards/redemptions?${q({ broadcaster_id: broadcasterId, reward_id: rewardId, id })}`, { status });
    },

    async subscribe(type: string, condition: Record<string, string>, sessionId: string): Promise<void> {
      await request('POST', '/eventsub/subscriptions', { type, version: '1', condition, transport: { method: 'websocket', session_id: sessionId } });
    },

    /** Паведамленне ў чат канала ад імя стрымера. `false` — Twitch не прапусціў паведамленне (фільтры чата, AutoMod). */
    async sendChat(broadcasterId: string, message: string): Promise<boolean> {
      const json = await request('POST', '/chat/messages', { broadcaster_id: broadcasterId, sender_id: broadcasterId, message });
      const first = data(json)[0];
      return !isObject(first) || first.is_sent !== false;
    },
  };
}

export type TwitchApi = ReturnType<typeof createTwitchApi>;
