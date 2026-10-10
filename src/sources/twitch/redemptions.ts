// Журнал заказаў за баллы канала (ADR-018). Чыстыя функцыі: атрымліваюць журнал і вяртаюць новы.
// Журнал захоўваецца ў localStorage: новы лідар (ADR-015) ведае, якія заказы ўжо апрацаваны, каму яшчэ трэба
// вярнуць баллы або паставіць «выканана» і якое паведамленне ў чат яшчэ не адпраўлена. Так заказ не губляецца
// і не апрацоўваецца двойчы — ні пры змене лідара, ні пры паўторнай дастаўцы падзеі ад Twitch.
//
// Этапы заказу:
//   processing — падзея атрымана, ідзе пошук песні (калі лідар знік — новы лідар пачне нанова);
//   queued     — песня ў нашай чарзе, Twitch пакуль «чакае» (баллы яшчэ можна вярнуць, калі стрымер выдаліць песню);
//   fulfill    — песня пачала граць: трэба паставіць FULFILLED;
//   refund     — адмова: трэба паставіць CANCELED (Twitch вяртае баллы);
//   done       — Twitch ведае вынік.

import type { PlayerState, QueueItem } from '../../core/types';

export const LOG_KEY = 'spotify-bot:twitch:redemptions:v1';

/** Колькі заказ павінен граць, каб лічыцца выкананым (калі «прайграць зараз» не атрымаецца, ён вернецца ў чаргу). */
export const FULFILL_AFTER_MS = 3000;
/** Паўзы паміж спробамі змяніць статус у Twitch пасля памылкі. */
export const RETRY_DELAYS = [5000, 15_000, 60_000, 300_000];
/** Колькі разоў спрабаваць адправіць паведамленне ў чат. */
export const CHAT_ATTEMPTS = 3;
/** Скончаныя запісы захоўваюцца столькі (каб паўторная дастаўка старой падзеі не стала новым заказам). */
const KEEP_DONE_MS = 3 * 24 * 3600_000;
const MAX_RECORDS = 500;

export type Stage = 'processing' | 'queued' | 'fulfill' | 'refund' | 'done';

/** Чаму вяртаем баллы (ключ тэксту ў чаце). */
export type RefundReason =
  | 'not-found'
  | 'spotify-failed'
  | 'spotify-off'
  | 'too-long'
  | 'explicit'
  | 'user-limit'
  | 'duplicate'
  | 'removed'
  | 'offline'
  | 'empty'
  /** Песня знікла з чаргі другі раз, не пачаўшы граць. */
  | 'lost';

export interface RedemptionRecord {
  id: string;
  rewardId: string;
  /** Нік гледача (як у чаце). */
  user: string;
  query: string;
  redeemedAt: number;
  stage: Stage;
  reason?: RefundReason;
  /** Паведамленне ў чат, якое яшчэ трэба адправіць. */
  chat?: string;
  /** Калі пачалі адпраўляць паведамленне (новы лідар яго не паўторыць). */
  chatStartedAt?: number;
  chatAttempts?: number;
  /** Спробы змяніць статус у Twitch і калі паспрабаваць зноў. */
  attempts: number;
  nextAt: number;
  /** Калі заказ стаў бягучай песняй. */
  playingSince?: number;
  /** Заказ ужо адзін раз апрацоўваўся нанова пасля таго, як песня знікла з чаргі. */
  requeued?: boolean;
  updatedAt: number;
}

export interface RedemptionLog {
  records: Record<string, RedemptionRecord>;
}

export const emptyLog = (): RedemptionLog => ({ records: {} });

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const STAGES: Stage[] = ['processing', 'queued', 'fulfill', 'refund', 'done'];

export function loadLog(storage: StorageLike | null): RedemptionLog {
  let raw: unknown;
  try {
    const text = storage?.getItem(LOG_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    return emptyLog();
  }
  if (!isObject(raw) || !isObject(raw.records)) return emptyLog();
  const records: Record<string, RedemptionRecord> = {};
  for (const [id, r] of Object.entries(raw.records)) {
    if (!isObject(r) || r.id !== id || typeof r.rewardId !== 'string' || !STAGES.includes(r.stage)) continue;
    records[id] = {
      ...(r as RedemptionRecord),
      user: typeof r.user === 'string' ? r.user : '',
      query: typeof r.query === 'string' ? r.query : '',
      attempts: typeof r.attempts === 'number' ? r.attempts : 0,
      nextAt: typeof r.nextAt === 'number' ? r.nextAt : 0,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      redeemedAt: typeof r.redeemedAt === 'number' ? r.redeemedAt : 0,
    };
  }
  return { records };
}

export function saveLog(storage: StorageLike | null, log: RedemptionLog): void {
  try {
    storage?.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    // Без localStorage журнал жыве толькі ў памяці лідара.
  }
}

function patch(log: RedemptionLog, id: string, change: Partial<RedemptionRecord>, now: number): RedemptionLog {
  const r = log.records[id];
  if (!r) return log;
  return { records: { ...log.records, [id]: { ...r, ...change, updatedAt: now } } };
}

/** Новая падзея ад Twitch. `null` — гэты заказ ужо вядомы (паўторная дастаўка або даганялка). */
export function track(
  log: RedemptionLog,
  r: { id: string; rewardId: string; user: string; query: string; redeemedAt: number },
  now: number,
): RedemptionLog | null {
  if (log.records[r.id]) return null;
  const record: RedemptionRecord = { ...r, stage: 'processing', attempts: 0, nextAt: 0, updatedAt: now };
  return { records: { ...log.records, [r.id]: record } };
}

/** Песня ў чарзе: Twitch пакуль не чапаем, у чат — «дададзена». */
export const accept = (log: RedemptionLog, id: string, chat: string, now: number) =>
  patch(log, id, { stage: 'queued', chat, chatStartedAt: undefined, chatAttempts: 0 }, now);

/** Адмова: вярнуць баллы, потым паведамленне ў чат з прычынай. */
export function refund(log: RedemptionLog, id: string, reason: RefundReason, chat: string, now: number): RedemptionLog {
  const r = log.records[id];
  if (!r || r.stage === 'done' || r.stage === 'fulfill' || r.stage === 'refund') return log;
  return patch(log, id, { stage: 'refund', reason, chat, chatStartedAt: undefined, chatAttempts: 0, attempts: 0, nextAt: now }, now);
}

export function fulfill(log: RedemptionLog, id: string, now: number): RedemptionLog {
  const r = log.records[id];
  if (!r || (r.stage !== 'queued' && r.stage !== 'processing')) return log;
  return patch(log, id, { stage: 'fulfill', attempts: 0, nextAt: now }, now);
}

export type Task =
  | { kind: 'status'; record: RedemptionRecord; status: 'FULFILLED' | 'CANCELED' }
  | { kind: 'chat'; record: RedemptionRecord; text: string };

/** Наступнае, што трэба зрабіць у Twitch (найстарэйшае спачатку). Паведамленне пра адмову — толькі пасля вяртання баллаў. */
export function nextTask(log: RedemptionLog, now: number): Task | null {
  const records = Object.values(log.records).sort((a, b) => a.updatedAt - b.updatedAt || a.redeemedAt - b.redeemedAt);
  for (const r of records) {
    if ((r.stage === 'fulfill' || r.stage === 'refund') && r.nextAt <= now) {
      return { kind: 'status', record: r, status: r.stage === 'fulfill' ? 'FULFILLED' : 'CANCELED' };
    }
  }
  for (const r of records) {
    if (r.chat && r.chatStartedAt === undefined && (r.stage === 'queued' || r.stage === 'fulfill' || r.stage === 'done') && r.nextAt <= now) {
      return { kind: 'chat', record: r, text: r.chat };
    }
  }
  return null;
}

/** Twitch прыняў статус. `keepChat: false` — паведамленне не адпраўляць (напрыклад, вынік ужо зрабіў сам стрымер). */
export function statusDone(log: RedemptionLog, id: string, now: number, keepChat = true): RedemptionLog {
  return patch(log, id, { stage: 'done', attempts: 0, nextAt: 0, ...(keepChat ? {} : { chat: undefined }) }, now);
}

export function statusFailed(log: RedemptionLog, id: string, now: number, waitMs?: number): RedemptionLog {
  const r = log.records[id];
  if (!r) return log;
  const wait = waitMs ?? RETRY_DELAYS[Math.min(r.attempts, RETRY_DELAYS.length - 1)];
  return patch(log, id, { attempts: r.attempts + 1, nextAt: now + wait }, now);
}

export const chatStarted = (log: RedemptionLog, id: string, now: number) => patch(log, id, { chatStartedAt: now }, now);
export const chatDone = (log: RedemptionLog, id: string, now: number) => patch(log, id, { chat: undefined, chatStartedAt: undefined }, now);

/** Не атрымалася адправіць: паспрабаваць пазней або (пасля некалькіх спроб) адмовіцца ад паведамлення. */
export function chatFailed(log: RedemptionLog, id: string, now: number, waitMs: number, giveUp = false): RedemptionLog {
  const r = log.records[id];
  if (!r) return log;
  const attempts = (r.chatAttempts ?? 0) + 1;
  if (giveUp || attempts >= CHAT_ATTEMPTS) return chatDone(log, id, now);
  return patch(log, id, { chatStartedAt: undefined, chatAttempts: attempts, nextAt: now + waitMs }, now);
}

/**
 * Новы лідар пачынае працу з журналам папярэдняга. Паведамленне, якое папярэдні лідар ужо пачаў адпраўляць,
 * не паўтараем (лепш адно страціць, чым напісаць у чат двойчы). Вяртае заказы, якія трэба апрацаваць нанова.
 */
export function resume(log: RedemptionLog, now: number): { log: RedemptionLog; reprocess: RedemptionRecord[] } {
  let next = log;
  for (const r of Object.values(log.records)) {
    if (r.chat && r.chatStartedAt !== undefined) next = chatDone(next, r.id, now);
  }
  return { log: next, reprocess: Object.values(next.records).filter((r) => r.stage === 'processing') };
}

/** Запіс чаргі з гэтым заказам (у заказах, бягучай песні або гісторыі). */
export function findItem(state: PlayerState, id: string): { item: QueueItem; where: 'requests' | 'current' | 'history' } | null {
  const request = state.requests.find((r) => r.redemptionId === id);
  if (request) return { item: request, where: 'requests' };
  if (state.current?.redemptionId === id) return { item: state.current, where: 'current' };
  const past = state.history.find((r) => r.redemptionId === id);
  return past ? { item: past, where: 'history' } : null;
}

/**
 * Зверка журнала з чаргой. Заказ пачаў граць (і грае ўжо `FULFILL_AFTER_MS`) або ўжо прайграны — «выканана».
 * Заказ знік з чаргі, так і не пачаўшы граць (сапсаваны або сцёрты стан плэера), — вяртаецца ў `lost`:
 * мозг дадасць яго ў чаргу нанова, каб глядач не страціў баллы.
 */
export function reconcile(log: RedemptionLog, state: PlayerState, now: number): { log: RedemptionLog; lost: RedemptionRecord[] } {
  let next = log;
  const lost: RedemptionRecord[] = [];
  for (const r of Object.values(log.records)) {
    if (r.stage !== 'queued') continue;
    const found = findItem(state, r.id);
    if (found?.where === 'requests') {
      if (r.playingSince !== undefined) next = patch(next, r.id, { playingSince: undefined }, now);
    } else if (found?.where === 'current') {
      if (r.playingSince === undefined) next = patch(next, r.id, { playingSince: now }, now);
      else if (now - r.playingSince >= FULFILL_AFTER_MS) next = fulfill(next, r.id, now);
    } else if (found?.where === 'history' || r.playingSince !== undefined) {
      next = fulfill(next, r.id, now);
    } else {
      lost.push(r);
    }
  }
  return { log: next, lost };
}

/** Колькі заказаў яшчэ чакаюць адказу ад Twitch (для «Праверкі»). */
export function pendingCount(log: RedemptionLog): number {
  return Object.values(log.records).filter((r) => r.stage === 'fulfill' || r.stage === 'refund' || r.chat).length;
}

/** Выдаліць старыя скончаныя запісы. */
export function prune(log: RedemptionLog, now: number): RedemptionLog {
  const all = Object.values(log.records);
  let keep = all.filter((r) => !(r.stage === 'done' && !r.chat && now - r.updatedAt > KEEP_DONE_MS));
  if (keep.length > MAX_RECORDS) {
    const active = keep.filter((r) => r.stage !== 'done' || r.chat);
    const done = keep.filter((r) => r.stage === 'done' && !r.chat).sort((a, b) => b.updatedAt - a.updatedAt);
    keep = [...active, ...done.slice(0, Math.max(0, MAX_RECORDS - active.length))];
  }
  if (keep.length === all.length) return log;
  return { records: Object.fromEntries(keep.map((r) => [r.id, r])) };
}
