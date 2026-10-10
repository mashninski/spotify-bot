// Twitch у лідары (ADR-018): праверка токена, узнагарода «Заказаць песню», EventSub, даганялка прапушчаных заказаў,
// «выканана» / вяртанне баллаў і паведамленні ў чат. Час кіруецца звонку праз `tick(now)` — ад таймера мозгу.
// Сам пошук песні і правілы — у мозгу (`onRedemption`), тут — толькі размова з Twitch і журнал заказаў.

import type { PlayerState } from '../../core/types';
import { t, type MessageKey } from '../../i18n';
import { createTwitchApi, parseRedemption, parseReward, RATE_WAIT_MS, TwitchApiError, type Redemption, type Reward } from './api';
import { clearTokens, hasScopes, loadTokens, saveLoginResult, TwitchAuthError, validateToken, type FetchLike } from './auth';
import { createEventSub, type EventSubStatus, type SocketFactory } from './eventsub';
import * as rl from './redemptions';

export const REWARD_KEY = 'spotify-bot:twitch:reward:v1';

/** Узнагарода, якую стварае прыкладанне. Назва — да 45 сімвалаў, падказка — да 200 (правілы Twitch). */
export const REWARD_COLOR = '#1DB954';
/** Ранейшыя назвы ўзнагароды: калі бот страціў яе id, знаходзіць яе і па старой назве (і перайменоўвае). */
const LEGACY_TITLES = ['Заказаць песню'];
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
export type TwitchProblem = '' | 'network' | 'not-affiliate' | 'duplicate-title' | 'scopes' | 'rate' | 'other';

export interface TwitchInfo {
  status: TwitchStatus;
  /** Канал стрымера (імя для ўваходу). */
  login: string;
  problem: TwitchProblem;
  /** Узнагарода ў Twitch (`null` — яшчэ не створана або невядома). */
  reward: { cost: number; paused: boolean } | null;
  events: EventSubStatus;
  /** Колькі заказаў чакаюць адказу ад Twitch (статус або паведамленне ў чат). */
  pending: number;
  /** Калі прыйшоў апошні заказ ад Twitch. */
  lastEventAt: number;
}

export function initialTwitchInfo(status: TwitchStatus = 'off'): TwitchInfo {
  return { status, login: '', problem: '', reward: null, events: 'off', pending: 0, lastEventAt: 0 };
}

/** Што мозг зрабіў з заказам. */
export type RequestOutcome =
  | { ok: true; title: string; artist?: string; n: number }
  | { ok: false; reason: rl.RefundReason; title?: string; max?: number };

export interface TwitchRequest {
  id: string;
  user: string;
  query: string;
}

export interface TwitchLinkOptions {
  storage: StorageLike | null;
  fetch?: FetchLike;
  createSocket?: SocketFactory;
  eventSubUrl?: string;
  now?: () => number;
  /** Цана заказу з налад. */
  price(): number;
  /**
   * Ці можа бот зараз браць заказы: `ready` — так; `wait` — хутка (Spotify падключаецца), заказы пачакаюць;
   * `off` — не (Spotify не падключаны): баллы вяртаюцца.
   */
  readiness(): 'ready' | 'wait' | 'off';
  /** Пошук песні і правілы. `null` — мозг спыніўся, заказ апрацуе наступны лідар. */
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

function readReward(storage: StorageLike | null): StoredReward | null {
  try {
    const raw = JSON.parse(storage?.getItem(REWARD_KEY) ?? 'null');
    return isObject(raw) && typeof raw.rewardId === 'string' && typeof raw.broadcasterId === 'string' ? (raw as StoredReward) : null;
  } catch {
    return null;
  }
}

function writeReward(storage: StorageLike | null, value: StoredReward | null): void {
  try {
    if (value) storage?.setItem(REWARD_KEY, JSON.stringify(value));
    else storage?.removeItem(REWARD_KEY);
  } catch {
    // Не крытычна: узнагароду знойдзем па назве.
  }
}

const shorten = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s);

/** Тэкст паведамлення ў чат пра вынік заказу (ADR-011, па-беларуску праз i18n). */
export function chatText(user: string, outcome: RequestOutcome, query = ''): string {
  if (outcome.ok) {
    // «Гурт — Назва стала ў чаргу»: без ніка і нумара (просьба аўтара).
    const song = outcome.artist ? `${shorten(outcome.artist)} — ${shorten(outcome.title)}` : shorten(outcome.title);
    return t('chat.added', { user, song, n: outcome.n });
  }
  return t(`chat.refund.${outcome.reason}` as MessageKey, {
    user,
    title: shorten(outcome.title ?? ''),
    query: shorten(query),
    max: outcome.max ?? 0,
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
  let reward: Reward | null = null;
  let validatedAt = 0;
  let rewardCheckedAt = 0;
  let prunedAt = 0;
  let startedAt = 0;
  /** Адна аперацыя з Twitch за раз (праверка, узнагарода, статус, паведамленне) — каб не перасягнуць ліміты. */
  let busy = false;
  let nextStepAt = 0;
  let readySince = 0;
  let lastReady: boolean | null = null;
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
      reward = null;
      eventsub.stop();
    }
    broadcasterId = v.userId;
    clientId = tokens.clientId;
    setInfo({ login: v.login || tokens.login });
    return true;
  }

  function rewardBody(): Record<string, unknown> {
    return {
      title: t('twitch.reward.title'),
      prompt: t('twitch.reward.prompt'),
      cost: Math.max(1, Math.round(options.price())),
      is_user_input_required: true,
      background_color: REWARD_COLOR,
      // Заказы павінны ісці праз чаргу Twitch: толькі тады бот можа вярнуць баллы (ADR-008).
      should_redemptions_skip_request_queue: false,
    };
  }

  /** Знайсці сваю ўзнагароду (па захаваным id або па назве) або стварыць новую. */
  async function ensureReward(): Promise<void> {
    const stored = readReward(storage);
    let found: Reward | null = null;
    if (stored && stored.broadcasterId === broadcasterId && stored.clientId === clientId) {
      try {
        found = (await api.getRewards(broadcasterId, [stored.rewardId]))[0] ?? null;
      } catch (e) {
        if (!(e instanceof TwitchApiError && e.kind === 'not-found')) throw e;
      }
    }
    if (!found) {
      const titles = [t('twitch.reward.title'), ...LEGACY_TITLES];
      found = (await api.getRewards(broadcasterId)).find((r) => titles.includes(r.title)) ?? null;
    }
    if (!found) {
      try {
        found = await api.createReward(broadcasterId, rewardBody());
      } catch (e) {
        if (e instanceof TwitchApiError && e.kind === 'forbidden') return fail('not-affiliate', VALIDATE_EVERY_MS);
        if (e instanceof TwitchApiError && e.kind === 'bad-request' && /title|unique|duplicate/i.test(e.reason)) {
          // Узнагарода з такой назвай ёсць, але яе стварыў не бот (уручную або іншае прыкладанне).
          return fail('duplicate-title', 60_000);
        }
        throw e;
      }
    }
    reward = found;
    rewardCheckedAt = now();
    writeReward(storage, { broadcasterId, clientId, rewardId: found.id });
    setInfo({ reward: { cost: found.cost, paused: found.isPaused } });
  }

  async function subscribe(id: string): Promise<void> {
    if (!reward) return;
    const condition = { broadcaster_user_id: broadcasterId, reward_id: reward.id };
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
    if (!reward) return;
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const { items, cursor: next } = await api.unfulfilled(broadcasterId, reward.id, cursor);
      for (const r of items) receive(r, true);
      if (!next || items.length === 0) break;
      cursor = next;
    }
  }

  // --- Заказы ---

  function onNotification(type: string, event: unknown): void {
    if (type === 'channel.channel_points_custom_reward_redemption.add') {
      const r = parseRedemption(event);
      if (r && (!reward || r.rewardId === reward.id)) {
        setInfo({ lastEventAt: now() });
        receive(r, false);
      }
    } else if (type === 'channel.channel_points_custom_reward.update') {
      const r = parseReward(event);
      if (r && reward && r.id === reward.id) {
        reward = { ...reward, cost: r.cost, title: r.title, isPaused: r.isPaused };
        setInfo({ reward: { cost: r.cost, paused: r.isPaused } });
      }
    } else if (type === 'channel.channel_points_custom_reward.remove') {
      // Стрымер выдаліў узнагароду ў Twitch — створым нанова на наступным кроку.
      reward = null;
      writeReward(storage, null);
      setInfo({ reward: null });
      eventsub.stop();
    }
  }

  function receive(r: Redemption, fromCatchUp: boolean): void {
    if (r.status && r.status !== 'UNFULFILLED') return;
    const t0 = now();
    const tracked = rl.track(log, { id: r.id, rewardId: r.rewardId, user: r.userName, query: r.userInput.trim(), redeemedAt: r.redeemedAt || t0 }, t0);
    if (!tracked) return; // паўтор
    setLog(tracked);
    // Журнал сцёрты, а песня ўжо ў чарзе — проста аднаўляем запіс.
    const found = rl.findItem(options.player(), r.id);
    if (found) return setLog(rl.accept(log, r.id, '', t0));
    if (fromCatchUp && r.redeemedAt && t0 - r.redeemedAt > STALE_MS) {
      return resolve(r.id, { ok: false, reason: 'offline' });
    }
  }

  /** Апрацаваць заказы этапу `processing`, калі бот гатовы (або вярнуць баллы, калі Spotify не падключаны). */
  function processWaiting(): void {
    const readiness = options.readiness();
    if (readiness === 'wait') return;
    for (const record of Object.values(log.records)) {
      if (record.stage !== 'processing' || inflight.has(record.id)) continue;
      if (rl.findItem(options.player(), record.id)) {
        setLog(rl.accept(log, record.id, '', now()));
        continue;
      }
      if (readiness === 'off') {
        resolve(record.id, { ok: false, reason: 'spotify-off' });
        continue;
      }
      if (!record.query) {
        resolve(record.id, { ok: false, reason: 'empty' });
        continue;
      }
      inflight.add(record.id);
      void options
        .onRedemption({ id: record.id, user: record.user, query: record.query })
        .then((outcome) => {
          if (outcome && running) resolve(record.id, outcome);
        })
        .catch(() => {
          if (running) resolve(record.id, { ok: false, reason: 'spotify-failed' });
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

  /** Паўза ўзнагароды, калі бот не можа браць заказы, і цана з налад. */
  function rewardPatch(t0: number): Record<string, unknown> | null {
    if (!reward) return null;
    const patch: Record<string, unknown> = {};
    const cost = Math.max(1, Math.round(options.price()));
    if (reward.cost !== cost) patch.cost = cost;
    const title = t('twitch.reward.title');
    if (reward.title !== title) patch.title = title;
    const ready = options.readiness() === 'ready';
    if (ready !== lastReady) {
      lastReady = ready;
      readySince = t0;
    }
    if (t0 - startedAt >= PAUSE_SYNC_DELAY_MS && t0 - readySince >= PAUSE_STABLE_MS && reward.isPaused === ready) patch.is_paused = !ready;
    if (!reward.isEnabled) patch.is_enabled = true;
    return Object.keys(patch).length ? patch : null;
  }

  /** Адзін крок: што самае важнае зараз — праверка токена, узнагарода, падпіска, даганялка, статусы, чат. */
  async function step(t0: number): Promise<void> {
    if (!broadcasterId || t0 - validatedAt >= VALIDATE_EVERY_MS) {
      if (!(await validate())) return;
    }
    if (!reward) {
      await ensureReward();
      if (!reward) return;
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
    const patch = rewardPatch(t0);
    if (patch && reward) {
      const updated = await api.updateReward(broadcasterId, reward.id, patch);
      reward = updated ?? {
        ...reward,
        ...('cost' in patch ? { cost: patch.cost as number } : {}),
        ...('title' in patch ? { title: patch.title as string } : {}),
        ...('is_paused' in patch ? { isPaused: patch.is_paused as boolean } : {}),
      };
      rewardCheckedAt = now();
      setInfo({ reward: { cost: reward.cost, paused: reward.isPaused } });
      return;
    }
    if (t0 - rewardCheckedAt >= REWARD_CHECK_EVERY_MS && reward) {
      rewardCheckedAt = t0;
      const current = (await api.getRewards(broadcasterId, [reward.id]).catch((e) => {
        if (e instanceof TwitchApiError && e.kind === 'not-found') return [];
        throw e;
      }))[0];
      if (!current) {
        reward = null;
        writeReward(storage, null);
        eventsub.stop();
        return;
      }
      reward = current;
      setInfo({ reward: { cost: current.cost, paused: current.isPaused } });
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

  return {
    get info() {
      return info;
    },

    start(): void {
      if (running) return;
      running = true;
      startedAt = now();
      lastReady = null;
      broadcasterId = '';
      reward = null;
      validatedAt = 0;
      nextStepAt = 0;
      const resumed = rl.resume(rl.loadLog(storage), now());
      log = resumed.log;
      rl.saveLog(storage, log);
      setInfo({ ...initialTwitchInfo('connecting'), pending: rl.pendingCount(log), lastEventAt: info.lastEventAt });
    },

    /** Спыненне лідара. `pause: true` — старонка зачыняецца: паставіць узнагароду на паўзу (запыт ідзе і пасля выгрузкі). */
    stop(pause = false): void {
      if (pause && reward && !reward.isPaused && broadcasterId) void api.updateReward(broadcasterId, reward.id, { is_paused: true }, true);
      stop();
    },

    /** Стрымер адключае Twitch: узнагароду — на паўзу, токены выдаляюцца. */
    async disconnect(): Promise<void> {
      running = false;
      eventsub.stop();
      if (reward && broadcasterId && !reward.isPaused) await api.updateReward(broadcasterId, reward.id, { is_paused: true }).catch(() => null);
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
      if (broadcasterId && reward) processWaiting();
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
      setLog(rl.refund(log, redemptionId, 'removed', chatText(record.user, { ok: false, reason: 'removed', title }), now()));
    },
  };
}

export type TwitchLink = ReturnType<typeof createTwitchLink>;
