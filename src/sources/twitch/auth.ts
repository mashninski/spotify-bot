// Уваход у Twitch праз Device Code Flow для прыкладання тыпу Public (ADR-018). Без Client Secret і без адраса вяртання:
// стрымер уводзіць код на twitch.tv/activate у любым браўзеры. Токены — у localStorage, агульным для дока і оверлея (ADR-009).
// Refresh token у Public-прыкладання аднаразовы і дзейнічае 30 дзён: абнаўляе толькі лідар (ADR-015) і адразу захоўвае новы.

export const ID_URL = 'https://id.twitch.tv/oauth2';
export const DEVICE_URL = `${ID_URL}/device`;
export const TOKEN_URL = `${ID_URL}/token`;
export const VALIDATE_URL = `${ID_URL}/validate`;
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Мінімальныя правы (ADR-011): кіраваць узнагародай і заказамі (уключае чытанне), пісаць у чат ад імя стрымера. */
export const SCOPES = ['channel:manage:redemptions', 'user:write:chat'] as const;

export const TOKENS_KEY = 'spotify-bot:twitch:tokens:v1';
/** Вынік апошняга ўваходу або выхаду (напрыклад, «уваход састарэў») — паказвае док. */
export const LOGIN_RESULT_KEY = 'spotify-bot:twitch:login-result';

/** Абнаўляем access token крыху загадзя (ён дзейнічае 4 гадзіны). */
const REFRESH_MARGIN_MS = 5 * 60_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TwitchTokens {
  accessToken: string;
  refreshToken: string;
  /** Калі скончыцца access token (мс). */
  expiresAt: number;
  scopes: string[];
  /** Client ID, якім выдадзены токены. */
  clientId: string;
  /** Канал стрымера: ідэнтыфікатар і імя для ўваходу (з `/oauth2/validate`). */
  userId: string;
  login: string;
  authorizedAt: number;
}

export interface LoginResult {
  ok: boolean;
  /** `expired` — уваход састарэў або адкліканы; астатняе — паведамленне Twitch. */
  error?: string;
  at: number;
}

/** Памылка ўваходу або абнаўлення токена. `code` — паведамленне Twitch (`invalid refresh token`…) або наша (`network`). */
export class TwitchAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(code);
    this.name = 'TwitchAuthError';
  }
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

function readJson<T>(storage: StorageLike | null, key: string): T | null {
  try {
    const text = storage?.getItem(key);
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: StorageLike | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Без localStorage уваход не захаваецца — док пакажа, што Twitch не падключаны.
  }
}

function remove(storage: StorageLike | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Не крытычна.
  }
}

export function loadTokens(storage: StorageLike | null): TwitchTokens | null {
  const raw = readJson<unknown>(storage, TOKENS_KEY);
  if (!isObject(raw)) return null;
  const { accessToken, refreshToken, expiresAt, clientId, userId, login } = raw;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || !refreshToken) return null;
  if (typeof expiresAt !== 'number' || typeof clientId !== 'string' || typeof userId !== 'string' || !userId) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((s: unknown): s is string => typeof s === 'string') : [],
    clientId,
    userId,
    login: typeof login === 'string' ? login : '',
    authorizedAt: typeof raw.authorizedAt === 'number' ? raw.authorizedAt : 0,
  };
}

export const saveTokens = (storage: StorageLike | null, tokens: TwitchTokens) => writeJson(storage, TOKENS_KEY, tokens);
export const clearTokens = (storage: StorageLike | null) => remove(storage, TOKENS_KEY);
export const hasTokens = (storage: StorageLike | null) => loadTokens(storage) !== null;
export const saveLoginResult = (storage: StorageLike | null, result: LoginResult) => writeJson(storage, LOGIN_RESULT_KEY, result);
export const readLoginResult = (storage: StorageLike | null) => readJson<LoginResult>(storage, LOGIN_RESULT_KEY);

export function needsRefresh(tokens: TwitchTokens, now = Date.now()): boolean {
  return tokens.expiresAt - REFRESH_MARGIN_MS <= now;
}

/** Client ID прыкладання Twitch: 30 сімвалаў, лічбы і малыя лацінскія літары (з запасам на іншую даўжыню). */
export function isTwitchClientId(value: string): boolean {
  return /^[a-z0-9]{20,40}$/.test(value);
}

async function post(fetchFn: FetchLike, url: string, body: Record<string, string>): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new TwitchAuthError('network');
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // Пусты або не-JSON адказ.
  }
  return { status: response.status, json };
}

const message = (json: unknown, status: number) =>
  isObject(json) && typeof json.message === 'string' ? json.message.toLowerCase() : `http-${status}`;

export interface DeviceCode {
  deviceCode: string;
  /** Код, які стрымер бачыць у доку і пацвярджае на twitch.tv. */
  userCode: string;
  /** Старонка Twitch для пацверджання (ужо з кодам у адрасе). */
  verificationUri: string;
  expiresAt: number;
  /** Як часта пытацца пра вынік, мс. */
  intervalMs: number;
}

/** Крок 1: атрымаць код для стрымера. */
export async function requestDeviceCode(fetchFn: FetchLike, clientId: string, now = Date.now()): Promise<DeviceCode> {
  const { status, json } = await post(fetchFn, DEVICE_URL, { client_id: clientId, scopes: SCOPES.join(' ') });
  if (status !== 200 || !isObject(json) || typeof json.device_code !== 'string' || typeof json.user_code !== 'string') {
    throw new TwitchAuthError(message(json, status), status);
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: typeof json.verification_uri === 'string' ? json.verification_uri : 'https://www.twitch.tv/activate',
    expiresAt: now + (typeof json.expires_in === 'number' ? json.expires_in : 1800) * 1000,
    intervalMs: (typeof json.interval === 'number' && json.interval > 0 ? json.interval : 5) * 1000,
  };
}

export type DevicePoll =
  | { status: 'pending' }
  /** Twitch просіць пытацца радзей. */
  | { status: 'slow-down' }
  | { status: 'ok'; tokens: Omit<TwitchTokens, 'userId' | 'login'> }
  /** Код састарэў, стрымер адмовіў або Client ID няправільны. */
  | { status: 'failed'; error: string };

/** Крок 2: спытаць, ці пацвердзіў стрымер код. */
export async function pollDeviceToken(fetchFn: FetchLike, clientId: string, code: DeviceCode, now = Date.now()): Promise<DevicePoll> {
  let reply: { status: number; json: unknown };
  try {
    reply = await post(fetchFn, TOKEN_URL, {
      client_id: clientId,
      scopes: SCOPES.join(' '),
      device_code: code.deviceCode,
      grant_type: DEVICE_GRANT,
    });
  } catch {
    // Сеткі няма — паспрабуем пры наступным апытанні.
    return { status: 'pending' };
  }
  const { status, json } = reply;
  if (status === 200 && isObject(json) && typeof json.access_token === 'string' && typeof json.refresh_token === 'string') {
    return { status: 'ok', tokens: tokensFrom(json, clientId, json.refresh_token, now) };
  }
  const error = message(json, status);
  if (error.includes('authorization_pending')) return { status: 'pending' };
  if (error.includes('slow_down')) return { status: 'slow-down' };
  if (status >= 500) return { status: 'pending' };
  return { status: 'failed', error };
}

function tokensFrom(json: Record<string, any>, clientId: string, refreshToken: string, now: number) {
  return {
    accessToken: json.access_token as string,
    refreshToken,
    expiresAt: now + (typeof json.expires_in === 'number' ? json.expires_in : 4 * 3600) * 1000,
    scopes: Array.isArray(json.scope) ? json.scope.filter((s: unknown): s is string => typeof s === 'string') : [],
    clientId,
    authorizedAt: now,
  };
}

/** Новы access token. Стары refresh token пасля гэтага не дзейнічае — новы трэба захаваць адразу. */
export async function refreshTokens(tokens: TwitchTokens, fetchFn: FetchLike, now = Date.now()): Promise<TwitchTokens> {
  const { status, json } = await post(fetchFn, TOKEN_URL, {
    client_id: tokens.clientId,
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  });
  if (status !== 200 || !isObject(json) || typeof json.access_token !== 'string') throw new TwitchAuthError(message(json, status), status);
  const fresh = tokensFrom(json, tokens.clientId, typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : tokens.refreshToken, now);
  return { ...tokens, ...fresh, scopes: fresh.scopes.length ? fresh.scopes : tokens.scopes, authorizedAt: tokens.authorizedAt };
}

export interface Validation {
  clientId: string;
  userId: string;
  login: string;
  scopes: string[];
}

/**
 * Праверка токена: Twitch патрабуе рабіць яе пры старце і кожную гадзіну.
 * `null` — токен не дзейнічае (401). Сетка — `TwitchAuthError('network')`.
 */
export async function validateToken(fetchFn: FetchLike, accessToken: string): Promise<Validation | null> {
  let response: Response;
  try {
    response = await fetchFn(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}` } });
  } catch {
    throw new TwitchAuthError('network');
  }
  if (response.status === 401) return null;
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // Не-JSON адказ.
  }
  if (!response.ok || !isObject(json) || typeof json.user_id !== 'string') throw new TwitchAuthError(message(json, response.status), response.status);
  return {
    clientId: typeof json.client_id === 'string' ? json.client_id : '',
    userId: json.user_id,
    login: typeof json.login === 'string' ? json.login : '',
    scopes: Array.isArray(json.scopes) ? json.scopes.filter((s: unknown): s is string => typeof s === 'string') : [],
  };
}

/** Ці ёсць усе патрэбныя правы (стрымер мог увайсці старой версіяй прыкладання). */
export function hasScopes(scopes: string[]): boolean {
  return SCOPES.every((s) => scopes.includes(s));
}

/**
 * Уваход у доку: код → апытанне → праверка токена → захаванне ў localStorage. Лідар (дзе б ён ні быў) убачыць
 * токены на наступным сігнале «жывы» і падключыцца. Скасаваць — `cancel()`.
 */
export function startDeviceLogin(options: {
  storage: StorageLike | null;
  fetch: FetchLike;
  clientId: string;
  onCode(code: DeviceCode): void;
  onDone(result: LoginResult): void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (result: LoginResult) => {
    if (cancelled) return;
    cancelled = true;
    saveLoginResult(options.storage, result);
    options.onDone(result);
  };

  void (async () => {
    let code: DeviceCode;
    try {
      code = await requestDeviceCode(options.fetch, options.clientId, now());
    } catch (e) {
      return finish({ ok: false, error: e instanceof TwitchAuthError ? e.code : 'network', at: now() });
    }
    if (cancelled) return;
    options.onCode(code);
    let interval = code.intervalMs;
    const poll = async () => {
      timer = null;
      if (cancelled) return;
      if (now() > code.expiresAt) return finish({ ok: false, error: 'expired-code', at: now() });
      const result = await pollDeviceToken(options.fetch, options.clientId, code, now());
      if (cancelled) return;
      if (result.status === 'failed') return finish({ ok: false, error: result.error, at: now() });
      if (result.status === 'ok') {
        try {
          const v = await validateToken(options.fetch, result.tokens.accessToken);
          if (!v) return finish({ ok: false, error: 'invalid access token', at: now() });
          saveTokens(options.storage, { ...result.tokens, scopes: v.scopes, userId: v.userId, login: v.login });
          return finish({ ok: true, at: now() });
        } catch (e) {
          return finish({ ok: false, error: e instanceof TwitchAuthError ? e.code : 'network', at: now() });
        }
      }
      if (result.status === 'slow-down') interval += 5000;
      timer = setTimeout(() => void poll(), interval);
    };
    timer = setTimeout(() => void poll(), interval);
  })();

  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}
