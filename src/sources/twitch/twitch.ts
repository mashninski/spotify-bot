// Twitch у лідары (ADR-018, ADR-020): праверка токена, узнагароды «Замовіць песню» і «Замовіць відэа з YouTube»,
// EventSub, даганялка прапушчаных заказаў, «выканана» / вяртанне баллаў і паведамленні ў чат.
// Час кіруецца звонку праз `tick(now)` — ад таймера мозгу.
// Сам пошук песні або відэа і правілы — у мозгу (`onRedemption`), тут — толькі размова з Twitch і журнал заказаў.

import type { PlayerState } from '../../core/types';
import { t, type MessageKey } from '../../i18n';
import { createTwitchApi, parseRedemption, parseReward, RATE_WAIT_MS, TwitchApiError, type Redemption, type Reward } from './api';
import { clearTokens, hasScopes, loadTokens, saveLoginResult, TwitchAuthError, validateToken, type FetchLike } from './auth';
import { createEventSub, type EventSubStatus, type SocketFactory } from './eventsub';
import * as rl from './redemptions';
import type { RewardKind } from './redemptions';

export type { RewardKind };

export const REWARD_KEY = 'spotify-bot:twitch:reward:v1';
/** Узнагарода відэа захоўваецца асобна, каб не чапаць запіс узнагароды песні (ADR-020). */
export const VIDEO_REWARD_KEY = 'spotify-bot:twitch:reward:video:v1';

export const REWARD_KINDS: RewardKind[] = ['song', 'video'];

/** Узнагароды, якія стварае прыкладанне. Назва — да 45 сімвалаў, падказка — да 200 (правілы Twitch). */
export const REWARD_COLOR = '#1DB954';
export const VIDEO_REWARD_COLOR = '#FF0000';

interface RewardSpec {
  key: string;
  title: MessageKey;
  prompt: MessageKey;
  color: string;
  /** Ранейшыя назвы: калі бот страціў id, знаходзіць узнагароду і па старой назве (і перайменоўвае). */
  legacy: string[];
}

const SPECS: Record<RewardKind, RewardSpec> = {
  song: { key: REWARD_KEY, title: 'twitch.reward.title', prompt: 'twitch.reward.prompt', color: REWARD_COLOR, legacy: ['Заказаць песню'] },
  video: { key: VIDEO_REWARD_KEY, title: 'twitch.videoReward.title', prompt: 'twitch.videoReward.prompt', color: VIDEO_REWARD_COLOR, legacy: [] },
};

/** Як часта Twitch патрабуе правяраць токен. */
const VALIDATE_EVERY_MS = 3600_000;
/** Пасля старту лідара не чапаем паўзу ўзнагароды крыху: папярэдні лідар мог толькі што паставіць яе на паўзу. */
const PAUSE_SYNC_DELAY_MS = 3000;
/** Стан «бот гатовы / не гатовы» павінен пратрымацца столькі, каб узнагарода не міргала. */
const PAUSE_STABLE_MS = 3000;
/** Раз у столькі правяраем, што ўзнагарода ў Twitch такая, як трэба (цана, паўза). */
const REWARD_CHECK_EVERY_MS = 10 * 60_000;
/** Заказ, зроблены так даўно, калі бот не працаваў, — вяртаем баллы, а не ставім у чаргу праз гадзіны. */
export const STALE_MS = 10 * 60_000;
const ERROR_RETRY_MS = 15_000;
const PRUNE_EVERY_MS = 3600_000;
/** Найдаўжэйшая назва песні ў паведамленні ў чат. */
const TITLE_MAX = 80;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type TwitchStatus = 'off' | 'connecting' | 'ok' | 'error';
export type TwitchProblem = '' | 'network' | 'not-affiliate' | 'duplicate-title' | 'duplicate-title-video' | 'scopes' | 'rate' | 'other';

export interface RewardInfo {
  cost: number;
  paused: boolean;
}

export interface TwitchInfo {
  status: TwitchStatus;
  /** Канал стрымера (імя для ўваходу). */
  login: string;
  problem: TwitchProblem;
  /** Узнагарода песні ў Twitch (`null` — яшчэ не створана або невядома). */
  reward: RewardInfo | null;
  /** Узнагарода відэа YouTube (ADR-020). */
  videoReward?: RewardInfo | null;
  events: EventSubStatus;
  /** Колькі заказаў чакаюць адказу ад Twitch (статус або паведамленне ў чат). */
  pending: number;
  /** Калі прыйшоў апошні заказ ад Twitch. */
  lastEventAt: number;
}

export function initialTwitchInfo(status: TwitchStatus = 'off'): TwitchInfo {
  return { status, login: '', problem: '', reward: null, videoReward: null, events: 'off', pending: 0, lastEventAt: 0 };
}

/** Што мозг зрабіў з заказам. `video` — гэта відэа YouTube (іншыя тэксты ў чаце). */
export type RequestOutcome =
  | { ok: true; title: string; artist?: string; n: number; video?: boolean }
  | { ok: false; reason: rl.RefundReason; title?: string; max?: number; video?: boolean };

export interface TwitchRequest {
  id: string;
  user: string;
  query: string;
  kind: RewardKind;
}

export interface TwitchLinkOptions {
  storage: StorageLike | null;
  fetch?: FetchLike;
  createSocket?: SocketFactory;
  eventSubUrl?: string;
  now?: () => number;
  /** Кошт замовы з налад (песні і відэа — асобна). */
  price(kind: RewardKind): number;
  /**
   * Ці можа бот зараз браць заказы: `ready` — так; `wait` — хутка (Spotify падключаецца), заказы пачакаюць;
   * `off` — не (Spotify не падключаны): баллы вяртаюцца.
   */
  readiness(kind: RewardKind): 'ready' | 'wait' | 'off';
  /** Пошук песні або відэа і правілы. `null` — мозг спыніўся, заказ апрацуе наступны лідар. */
  onRedemption(request: TwitchRequest): Promise<RequestOutcome | null>;
  player(): PlayerState;
  onInfo(patch: Partial<TwitchInfo>): void;
  onLoggedOut(): void;
}

interface StoredReward {
  broadcasterId: string;
  clientId: string;
  rewardId: string;
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

function readReward(storage: StorageLike | null, key: string): StoredReward | null {
  try {
    const raw = JSON.parse(storage?.getItem(key) ?? 'null');
    return isObject(raw) && typeof raw.rewardId === 'string' && typeof raw.broadcasterId === 'string' ? (raw as StoredReward) : null;
  } catch {
    return null;
  }
}

function writeReward(storage: StorageLike | null, key: string, value: StoredReward | null): void {
  try {
    if (value) storage?.setItem(key, JSON.stringify(value));
    else storage?.removeItem(key);
  } catch {
    // Не крытычна: узнагароду знойдзем па назве.
  }
}

const shorten = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s);

/** Тэкст паведамлення ў чат пра вынік заказу (ADR-011, па-беларуску праз i18n). */
export function chatText(user: string, outcome: RequestOutcome, query = ''): string {
  if (outcome.ok) {
    if (outcome.video) return t('chat.added.video', { user, title: shorten(outcome.title), n: outcome.n });
    // «Гурт — Назва стала ў чаргу»: без ніка і нумара (просьба аўтара).
    const song = outcome.artist ? `${shorten(outcome.artist)} — ${shorten(outcome.title)}` : shorten(outcome.title);
    return t('chat.added', { user, song, n: outcome.n });
  }
  // Для відэа свае тэксты там, дзе «песня» не падыходзіць (род, падказка пра спасылку).
  const reason = outcome.video && outcome.reason === 'too-long' ? 'video-too-long' : outcome.video && outcome.reason === 'empty' ? 'not-youtube' : outcome.reason;
  const key = `chat.refund.${reason}`;
  return t(key as MessageKey, {
    user,
    title: shorten(outcome.title ?? ''),
    query: shorten(query),
    max: outcome.max ?? 0,
    reward: t('twitch.videoReward.title'),
  });
}

export function createTwitchLink(options: TwitchLinkOptions) {
  const { storage } = options;
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const api = createTwitchApi({ storage, fetch: fetchFn, now, onLoggedOut: () => loggedOut() });

  let running = false;
  let log = rl.emptyLog();
  let broadcasterId = '';
  let clientId = '';
  const rewards: Record<RewardKind, Reward | null> = { song: null, video: null };
  const rewardCheckedAt: Record<RewardKind, number> = { song: 0, video: 0 };
  let validatedAt = 0;
  let prunedAt = 0;
  let startedAt = 0;
  /** Адна аперацыя з Twitch за раз (праверка, узнагарода, статус, паведамленне) — каб не перасягнуць ліміты. */
  let busy = false;
  let nextStepAt = 0;
  /** Гатоўнасць кожнай узнагароды (песні патрэбны Spotify, відэа — не) і з якога часу яна такая. */
  const readySince: Record<RewardKind, number> = { song: 0, video: 0 };
  const lastReady: Record<RewardKind, boolean | null> = { song: null, video: null };
  let session = '';
  let catchUpNeeded = false;
  let info = initialTwitchInfo('connecting');
  /** Заказы, якія зараз апрацоўвае мозг (у памяці — каб падзея і даганялка не запусцілі адзін заказ двойчы). */
  const inflight = new Set<string>();

  const eventsub = createEventSub({
    createSocket: options.createSocket,
    url: options.eventSubUrl,
    now,
    onWelcome: (id) => {
      // Падпіска і даганялка — на наступным кроку (`step`).
      session = id;
    },
    onNotification: (type, event) => onNotification(type, event),
    onRevoked: (_type, status) => {
      if (status === 'authorization_revoked' || status === 'user_removed') loggedOut();
      else eventsub.restart();
    },
    onStatus: (events) => setInfo({ events }),
  });

  function setInfo(patch: Partial<TwitchInfo>): void {
    info = { ...info, ...patch };
    options.onInfo(patch);
  }

  const rewardInfo = (r: Reward | null): RewardInfo | null => (r ? { cost: r.cost, paused: r.isPaused } : null);

  function setReward(kind: RewardKind, reward: Reward | null): void {
    rewards[kind] = reward;
    setInfo(kind === 'song' ? { reward: rewardInfo(reward) } : { videoReward: rewardInfo(reward) });
  }

  /** Якая гэта ўзнагарода (`null` — не наша). */
  function kindOf(rewardId: string): RewardKind | null {
    return REWARD_KINDS.find((k) => rewards[k]?.id === rewardId) ?? null;
  }

  function setLog(next: rl.RedemptionLog): void {
    if (next === log) return;
    log = next;
    rl.saveLog(storage, log);
    const pending = rl.pendingCount(log);
    if (pending !== info.pending) setInfo({ pending });
  }

  function loggedOut(): void {
    const t0 = loadTokens(storage);
    if (t0) clearTokens(storage);
    saveLoginResult(storage, { ok: false, error: 'expired', at: now() });
    stop();
    options.onLoggedOut();
  }

  function fail(problem: TwitchProblem, retryMs = ERROR_RETRY_MS): void {
    setInfo({ status: 'error', problem });
    nextStepAt = now() + retryMs;
  }

  function problemOf(e: unknown): TwitchProblem {
    if (e instanceof TwitchApiError) return e.kind === 'rate' ? 'rate' : e.kind === 'network' ? 'network' : 'other';
    if (e instanceof TwitchAuthError && e.code === 'network') return 'network';
    return 'other';
  }

  // --- Крокі падключэння ---

  async function validate(): Promise<boolean> {
    const tokens = await api.tokens();
    let v = await validateToken(fetchFn, tokens.accessToken);
    if (!v) v = await validateToken(fetchFn, (await api.tokens(true)).accessToken);
    if (!v) {
      loggedOut();
      return false;
    }
    if (!hasScopes(v.scopes)) {
      fail('scopes', VALIDATE_EVERY_MS);
      return false;
    }
    validatedAt = now();
    if (broadcasterId && broadcasterId !== v.userId) {
      // Іншы канал — усё нанова.
      rewards.song = null;
      rewards.video = null;
      eventsub.stop();
    }
    broadcasterId = v.userId;
    clientId = tokens.clientId;
    setInfo({ login: v.login || tokens.login });
    return true;
  }

  function rewardBody(kind: RewardKind): Record<string, unknown> {
    const spec = SPECS[kind];
    return {
      title: t(spec.title),
      prompt: t(spec.prompt),
      cost: Math.max(1, Math.round(options.price(kind))),
      is_user_input_required: true,
      background_color: spec.color,
      // Заказы павінны ісці праз чаргу Twitch: толькі тады бот можа вярнуць баллы (ADR-008).
      should_redemptions_skip_request_queue: false,
    };
  }

  /** Знайсці сваю ўзнагароду (па захаваным id або па назве) або стварыць новую. `false` — не атрымалася. */
  async function ensureReward(kind: RewardKind): Promise<boolean> {
    const spec = SPECS[kind];
    const stored = readReward(storage, spec.key);
    let found: Reward | null = null;
    if (stored && stored.broadcasterId === broadcasterId && stored.clientId === clientId) {
      try {
        found = (await api.getRewards(broadcasterId, [stored.rewardId]))[0] ?? null;
      } catch (e) {
        if (!(e instanceof TwitchApiError && e.kind === 'not-found')) throw e;
      }
    }
    if (!found) {
      const titles = [t(spec.title), ...spec.legacy];
      const other = REWARD_KINDS.filter((k) => k !== kind).map((k) => rewards[k]?.id);
      found = (await api.getRewards(broadcasterId)).find((r) => titles.includes(r.title) && !other.includes(r.id)) ?? null;
    }
    if (!found) {
      try {
        found = await api.createReward(broadcasterId, rewardBody(kind));
      } catch (e) {
        if (e instanceof TwitchApiError && e.kind === 'forbidden') {
          fail('not-affiliate', VALIDATE_EVERY_MS);
          return false;
        }
        if (e instanceof TwitchApiError && e.kind === 'bad-request' && /title|unique|duplicate/i.test(e.reason)) {
          // Узнагарода з такой назвай ёсць, але яе стварыў не бот (уручную або іншае прыкладанне).
          fail(kind === 'song' ? 'duplicate-title' : 'duplicate-title-video', 60_000);
          return false;
        }
        throw e;
      }
    }
    rewardCheckedAt[kind] = now();
    writeReward(storage, spec.key, { broadcasterId, clientId, rewardId: found.id });
    setReward(kind, found);
    return true;
  }

  /** Падпіскі на ўсе ўзнагароды канала (без `reward_id`): падзеі чужых узнагарод адкідаюцца (ADR-020). */
  async function subscribe(id: string): Promise<void> {
    const condition = { broadcaster_user_id: broadcasterId };
    for (const type of [
      'channel.channel_points_custom_reward_redemption.add',
      'channel.channel_points_custom_reward.update',
      'channel.channel_points_custom_reward.remove',
    ]) {
      try {
        await api.subscribe(type, condition, id);
      } catch (e) {
        if (e instanceof TwitchApiError && e.kind === 'conflict') continue; // ужо ёсць
        throw e;
      }
    }
  }

  /** Даганялка: заказы, якія прыйшлі, пакуль не было злучэння (змена лідара, перападключэнне, бот не працаваў). */
  async function catchUp(): Promise<void> {
    for (const kind of REWARD_KINDS) {
      const reward = rewards[kind];
      if (!reward) continue;
      let cursor = '';
      for (let page = 0; page < 10; page++) {
        const { items, cursor: next } = await api.unfulfilled(broadcasterId, reward.id, cursor);
        for (const r of items) receive(r, kind, true);
        if (!next || items.length === 0) break;
        cursor = next;
      }
    }
  }

  // --- Заказы ---

  function onNotification(type: string, event: unknown): void {
    if (type === 'channel.channel_points_custom_reward_redemption.add') {
      const r = parseRedemption(event);
      const kind = r ? kindOf(r.rewardId) : null;
      if (r && kind) {
        setInfo({ lastEventAt: now() });
        receive(r, kind, false);
      }
    } else if (type === 'channel.channel_points_custom_reward.update') {
      const r = parseReward(event);
      const kind = r ? kindOf(r.id) : null;
      const reward = kind ? rewards[kind] : null;
      if (r && kind && reward) setReward(kind, { ...reward, cost: r.cost, title: r.title, isPaused: r.isPaused });
    } else if (type === 'channel.channel_points_custom_reward.remove') {
      const r = parseReward(event);
      const kind = r ? kindOf(r.id) : null;
      if (!kind) return;
      // Стрымер выдаліў узнагароду ў Twitch — створым нанова на наступным кроку.
      writeReward(storage, SPECS[kind].key, null);
      setReward(kind, null);
    }
  }

  function receive(r: Redemption, kind: RewardKind, fromCatchUp: boolean): void {
    if (r.status && r.status !== 'UNFULFILLED') return;
    const t0 = now();
    const tracked = rl.track(log, { id: r.id, rewardId: r.rewardId, kind, user: r.userName, query: r.userInput.trim(), redeemedAt: r.redeemedAt || t0 }, t0);
    if (!tracked) return; // паўтор
    setLog(tracked);
    // Журнал сцёрты, а песня ўжо ў чарзе — проста аднаўляем запіс.
    const found = rl.findItem(options.player(), r.id);
    if (found) return setLog(rl.accept(log, r.id, '', t0));
    if (fromCatchUp && r.redeemedAt && t0 - r.redeemedAt > STALE_MS) {
      return resolve(r.id, { ok: false, reason: 'offline' });
    }
  }

  /** Апрацаваць заказы этапу `processing`, калі бот гатовы (або вярнуць баллы, калі песні, а Spotify не падключаны). */
  function processWaiting(): void {
    const ready: Record<RewardKind, 'ready' | 'wait' | 'off'> = { song: options.readiness('song'), video: options.readiness('video') };
    for (const record of Object.values(log.records)) {
      if (record.stage !== 'processing' || inflight.has(record.id)) continue;
      const readiness = ready[record.kind ?? 'song'];
      if (readiness === 'wait') continue;
      if (rl.findItem(options.player(), record.id)) {
        setLog(rl.accept(log, record.id, '', now()));
        continue;
      }
      if (readiness === 'off') {
        resolve(record.id, { ok: false, reason: 'spotify-off' });
        continue;
      }
      if (!record.query) {
        resolve(record.id, { ok: false, reason: 'empty', video: record.kind === 'video' });
        continue;
      }
      inflight.add(record.id);
      void options
        .onRedemption({ id: record.id, user: record.user, query: record.query, kind: record.kind ?? 'song' })
        .then((outcome) => {
          if (outcome && running) resolve(record.id, outcome);
        })
        .catch(() => {
          if (running) resolve(record.id, { ok: false, reason: record.kind === 'video' ? 'youtube-failed' : 'spotify-failed' });
        })
        .finally(() => inflight.delete(record.id));
    }
  }

  function resolve(id: string, outcome: RequestOutcome): void {
    const record = log.records[id];
    if (!record) return;
    const text = chatText(record.user, outcome, record.query);
    setLog(outcome.ok ? rl.accept(log, id, text, now()) : rl.refund(log, id, outcome.reason, text, now()));
  }

  /** Адна задача з журнала: статус у Twitch або паведамленне ў чат. */
  async function runTask(task: rl.Task): Promise<void> {
    const id = task.record.id;
    if (task.kind === 'status') {
      try {
        await api.setRedemptionStatus(broadcasterId, task.record.rewardId, id, task.status);
        setLog(rl.statusDone(log, id, now()));
      } catch (e) {
        if (e instanceof TwitchApiError && (e.kind === 'not-found' || e.kind === 'forbidden' || e.kind === 'bad-request')) {
          // Заказ ужо не «чакае» (стрымер вырашыў сам у Twitch) або ўзнагарода не наша — паведамляць няма пра што.
          setLog(rl.statusDone(log, id, now(), false));
        } else if (e instanceof TwitchApiError && e.kind === 'auth') {
          // Уваход састарэў — loggedOut ужо выкліканы.
        } else {
          setLog(rl.statusFailed(log, id, now(), e instanceof TwitchApiError && e.kind === 'rate' ? RATE_WAIT_MS : undefined));
        }
      }
      return;
    }
    setLog(rl.chatStarted(log, id, now()));
    try {
      const sent = await api.sendChat(broadcasterId, task.text);
      setLog(sent ? rl.chatDone(log, id, now()) : rl.chatFailed(log, id, now(), 0, true));
    } catch (e) {
      const rate = e instanceof TwitchApiError && e.kind === 'rate';
      const final = e instanceof TwitchApiError && (e.kind === 'forbidden' || e.kind === 'bad-request' || e.kind === 'auth');
      setLog(rl.chatFailed(log, id, now(), rate ? RATE_WAIT_MS : 5000, final));
    }
  }

  /** Паўза ўзнагароды, калі бот не можа браць заказы, кошт і назва з налад. */
  function rewardPatch(kind: RewardKind, t0: number): Record<string, unknown> | null {
    const reward = rewards[kind];
    if (!reward) return null;
    const patch: Record<string, unknown> = {};
    const cost = Math.max(1, Math.round(options.price(kind)));
    if (reward.cost !== cost) patch.cost = cost;
    const title = t(SPECS[kind].title);
    if (reward.title !== title) patch.title = title;
    const ready = options.readiness(kind) === 'ready';
    if (ready !== lastReady[kind]) {
      lastReady[kind] = ready;
      readySince[kind] = t0;
    }
    if (t0 - startedAt >= PAUSE_SYNC_DELAY_MS && t0 - readySince[kind] >= PAUSE_STABLE_MS && reward.isPaused === ready) patch.is_paused = !ready;
    if (!reward.isEnabled) patch.is_enabled = true;
    return Object.keys(patch).length ? patch : null;
  }

  /** Адзін крок: што самае важнае зараз — праверка токена, узнагароды, падпіска, даганялка, статусы, чат. */
  async function step(t0: number): Promise<void> {
    if (!broadcasterId || t0 - validatedAt >= VALIDATE_EVERY_MS) {
      if (!(await validate())) return;
    }
    for (const kind of REWARD_KINDS) {
      if (!rewards[kind] && !(await ensureReward(kind))) return;
    }
    if (info.status !== 'ok' || info.problem) setInfo({ status: 'ok', problem: '' });
    if (eventsub.status === 'off') eventsub.start();
    if (session && eventsub.status === 'ok') {
      const id = session;
      session = '';
      try {
        await subscribe(id);
      } catch (e) {
        if (e instanceof TwitchApiError && e.kind === 'auth') return;
        eventsub.restart();
        throw e;
      }
      catchUpNeeded = Boolean(id);
    }
    if (catchUpNeeded && eventsub.status === 'ok') {
      catchUpNeeded = false;
      await catchUp();
    }
    for (const kind of REWARD_KINDS) {
      const reward = rewards[kind];
      const patch = rewardPatch(kind, t0);
      if (!patch || !reward) continue;
      const updated = await api.updateReward(broadcasterId, reward.id, patch);
      rewardCheckedAt[kind] = now();
      setReward(
        kind,
        updated ?? {
          ...reward,
          ...('cost' in patch ? { cost: patch.cost as number } : {}),
          ...('title' in patch ? { title: patch.title as string } : {}),
          ...('is_paused' in patch ? { isPaused: patch.is_paused as boolean } : {}),
        },
      );
      return;
    }
    for (const kind of REWARD_KINDS) {
      const reward = rewards[kind];
      if (!reward || t0 - rewardCheckedAt[kind] < REWARD_CHECK_EVERY_MS) continue;
      rewardCheckedAt[kind] = t0;
      const current = (await api.getRewards(broadcasterId, [reward.id]).catch((e) => {
        if (e instanceof TwitchApiError && e.kind === 'not-found') return [];
        throw e;
      }))[0];
      if (!current) writeReward(storage, SPECS[kind].key, null);
      setReward(kind, current ?? null);
      return;
    }
    const task = rl.nextTask(log, t0);
    if (task) await runTask(task);
  }

  function stop(): void {
    running = false;
    eventsub.stop();
    inflight.clear();
    setInfo({ ...initialTwitchInfo('off'), lastEventAt: info.lastEventAt });
  }

  /** Паставіць на паўзу ўсе нашы ўзнагароды, якія яшчэ не на паўзе. */
  function pauseAll(keepalive: boolean): Promise<unknown>[] {
    if (!broadcasterId) return [];
    return REWARD_KINDS.map((k) => rewards[k])
      .filter((r): r is Reward => Boolean(r && !r.isPaused))
      .map((r) => api.updateReward(broadcasterId, r.id, { is_paused: true }, keepalive).catch(() => null));
  }

  return {
    get info() {
      return info;
    },

    start(): void {
      if (running) return;
      running = true;
      startedAt = now();
      lastReady.song = null;
      lastReady.video = null;
      broadcasterId = '';
      rewards.song = null;
      rewards.video = null;
      validatedAt = 0;
      nextStepAt = 0;
      const resumed = rl.resume(rl.loadLog(storage), now());
      log = resumed.log;
      rl.saveLog(storage, log);
      setInfo({ ...initialTwitchInfo('connecting'), pending: rl.pendingCount(log), lastEventAt: info.lastEventAt });
    },

    /** Спыненне лідара. `pause: true` — старонка зачыняецца: паставіць узнагароды на паўзу (запыт ідзе і пасля выгрузкі). */
    stop(pause = false): void {
      if (pause) void Promise.all(pauseAll(true));
      stop();
    },

    /** Стрымер адключае Twitch: узнагароды — на паўзу, токены выдаляюцца. */
    async disconnect(): Promise<void> {
      running = false;
      eventsub.stop();
      await Promise.all(pauseAll(false));
      clearTokens(storage);
      stop();
    },

    get running() {
      return running;
    },

    /** Таймер мозгу. Зверка з чаргой — кожны раз (без запытаў), размова з Twitch — па адным кроку. */
    tick(t0 = now()): void {
      if (!running) return;
      eventsub.tick(t0);
      const checked = rl.reconcile(log, options.player(), t0);
      setLog(checked.log);
      // Песня знікла з чаргі, не пачаўшы граць (сапсаваны стан) — апрацуем заказ нанова, а другі раз — вернем баллы.
      for (const lost of checked.lost) {
        if (lost.requeued) resolve(lost.id, { ok: false, reason: 'lost' });
        else setLog({ records: { ...log.records, [lost.id]: { ...lost, stage: 'processing', requeued: true, updatedAt: t0 } } });
      }
      if (t0 - prunedAt >= PRUNE_EVERY_MS) {
        prunedAt = t0;
        setLog(rl.prune(log, t0));
      }
      if (broadcasterId && rewards.song) processWaiting();
      if (busy || t0 < nextStepAt) return;
      busy = true;
      void step(t0)
        .catch((e) => {
          if (running) fail(problemOf(e), e instanceof TwitchApiError && e.kind === 'rate' ? RATE_WAIT_MS : ERROR_RETRY_MS);
        })
        .finally(() => {
          busy = false;
        });
    },

    /** Стрымер выдаліў песню з чаргі (✕) — вярнуць баллы гледачу. */
    removed(redemptionId: string, title: string): void {
      const record = log.records[redemptionId];
      if (!record || record.stage !== 'queued') return;
      const video = record.kind === 'video';
      setLog(rl.refund(log, redemptionId, 'removed', chatText(record.user, { ok: false, reason: 'removed', title, video }), now()));
    },

    /** Відэа так і не паказалася ў оверлэі або перад ім рэклама (ADR-020) — вярнуць баллы гледачу. */
    failed(redemptionId: string, title: string, reason: 'video-error' | 'video-ad' = 'video-error'): void {
      const record = log.records[redemptionId];
      if (!record || record.stage !== 'queued') return;
      setLog(rl.refund(log, redemptionId, reason, chatText(record.user, { ok: false, reason, title, video: true }), now()));
    },
  };
}

export type TwitchLink = ReturnType<typeof createTwitchLink>;
