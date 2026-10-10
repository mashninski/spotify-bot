// Уваход у Spotify праз Authorization Code + PKCE (ADR-016). Без Client Secret: усё ў браўзеры OBS.
// Токены захоўваюцца ў localStorage, агульным для дока і оверлея (ADR-009, ADR-015).

export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/** Правы, якія просім у стрымера. Ніякіх лішніх: толькі плэер і «Любімыя трэкі». */
export const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'user-library-read',
  'user-library-modify',
] as const;

export const TOKENS_KEY = 'spotify-bot:spotify:tokens:v1';
export const PENDING_KEY = 'spotify-bot:spotify:pending';
/** Вынік апошняга ўваходу (паказвае док пасля вяртання са Spotify). */
export const LOGIN_RESULT_KEY = 'spotify-bot:spotify:login-result';

/** Абнаўляем access token крыху загадзя, каб ён не скончыўся пасярэдзіне запыту. */
const REFRESH_MARGIN_MS = 60_000;
/** Незавершаны ўваход лічыцца састарэлым праз гэты час. */
const PENDING_TTL_MS = 15 * 60_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  /** Калі скончыцца access token (мс). */
  expiresAt: number;
  scope: string;
  /** Client ID, якім выдадзены токены: ім жа і абнаўляем. */
  clientId: string;
  /** Калі стрымер увайшоў (refresh token дзейнічае 6 месяцаў ад гэтага моманту). */
  authorizedAt: number;
}

interface PendingLogin {
  verifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  at: number;
}

export interface LoginResult {
  ok: boolean;
  /** Код памылкі ад Spotify (`access_denied`, `invalid_client`…) або наш (`state`, `network`). */
  error?: string;
  at: number;
}

/** Памылка ўваходу або абнаўлення токена. `invalid_grant` — трэба ўвайсці нанова. */
export class SpotifyAuthError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'SpotifyAuthError';
  }
}

/** Адрас старонкі вяртання для старонкі `href` (без параметраў і #). Яго стрымер устаўляе ў Spotify Dashboard. */
export function redirectUriFor(href: string): string {
  const url = new URL('callback.html', href);
  url.search = '';
  url.hash = '';
  return url.toString();
}

const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Выпадковы радок для PKCE (43–128 сімвалаў з дазволенага набору). */
export function randomVerifier(length = 64): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += VERIFIER_CHARS[b % VERIFIER_CHARS.length];
  return out;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** code_challenge = base64url(SHA-256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function buildAuthorizeUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: p.challenge,
    state: p.state,
    scope: SCOPES.join(' '),
  });
  return `${AUTHORIZE_URL}?${params}`;
}

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
    // Без localStorage уваход не захаваецца — док пакажа, што Spotify не падключаны.
  }
}

function remove(storage: StorageLike | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Не крытычна.
  }
}

/** Рыхтуе ўваход: захоўвае verifier і state, вяртае адрас старонкі ўваходу Spotify. */
export async function startLogin(storage: StorageLike | null, clientId: string, redirectUri: string, now = Date.now()): Promise<string> {
  const verifier = randomVerifier();
  const state = randomVerifier(24);
  writeJson(storage, PENDING_KEY, { verifier, state, clientId, redirectUri, at: now } satisfies PendingLogin);
  remove(storage, LOGIN_RESULT_KEY);
  return buildAuthorizeUrl({ clientId, redirectUri, challenge: await codeChallenge(verifier), state });
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function loadTokens(storage: StorageLike | null): SpotifyTokens | null {
  const raw = readJson<unknown>(storage, TOKENS_KEY);
  if (!isObject(raw)) return null;
  const { accessToken, refreshToken, expiresAt, scope, clientId, authorizedAt } = raw;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || !refreshToken) return null;
  if (typeof expiresAt !== 'number' || typeof clientId !== 'string') return null;
  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope: typeof scope === 'string' ? scope : '',
    clientId,
    authorizedAt: typeof authorizedAt === 'number' ? authorizedAt : 0,
  };
}

export function saveTokens(storage: StorageLike | null, tokens: SpotifyTokens): void {
  writeJson(storage, TOKENS_KEY, tokens);
}

export function clearTokens(storage: StorageLike | null): void {
  remove(storage, TOKENS_KEY);
}

export function hasTokens(storage: StorageLike | null): boolean {
  return loadTokens(storage) !== null;
}

export function saveLoginResult(storage: StorageLike | null, result: LoginResult): void {
  writeJson(storage, LOGIN_RESULT_KEY, result);
}

export function readLoginResult(storage: StorageLike | null): LoginResult | null {
  return readJson<LoginResult>(storage, LOGIN_RESULT_KEY);
}

async function tokenRequest(fetchFn: FetchLike, body: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new SpotifyAuthError('network');
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // Пусты або не-JSON адказ.
  }
  if (!response.ok) {
    const code = isObject(json) && typeof json.error === 'string' ? json.error : `http-${response.status}`;
    throw new SpotifyAuthError(code);
  }
  if (!isObject(json) || typeof json.access_token !== 'string') throw new SpotifyAuthError('bad-response');
  return json;
}

function expiresAt(json: Record<string, unknown>, now: number): number {
  const seconds = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  return now + seconds * 1000;
}

/**
 * Завяршае ўваход на старонцы вяртання: правярае `state`, абменьвае код на токены і захоўвае іх.
 * Вынік заўсёды запісваецца ў localStorage — док пакажа яго пасля вяртання.
 */
export async function completeLogin(
  storage: StorageLike | null,
  params: URLSearchParams,
  fetchFn: FetchLike,
  now = Date.now(),
): Promise<LoginResult> {
  const pending = readJson<PendingLogin>(storage, PENDING_KEY);
  remove(storage, PENDING_KEY);
  const finish = (result: LoginResult) => {
    writeJson(storage, LOGIN_RESULT_KEY, result);
    return result;
  };
  const error = params.get('error');
  if (error) return finish({ ok: false, error, at: now });
  const code = params.get('code');
  if (!pending || !code || pending.state !== params.get('state') || now - pending.at > PENDING_TTL_MS) {
    return finish({ ok: false, error: 'state', at: now });
  }
  try {
    const json = await tokenRequest(fetchFn, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    });
    if (typeof json.refresh_token !== 'string') throw new SpotifyAuthError('bad-response');
    saveTokens(storage, {
      accessToken: json.access_token as string,
      refreshToken: json.refresh_token,
      expiresAt: expiresAt(json, now),
      scope: typeof json.scope === 'string' ? json.scope : '',
      clientId: pending.clientId,
      authorizedAt: now,
    });
    return finish({ ok: true, at: now });
  } catch (e) {
    return finish({ ok: false, error: e instanceof SpotifyAuthError ? e.code : 'network', at: now });
  }
}

/** Новы access token па refresh token. Калі Spotify не вярнуў новы refresh token — застаецца стары. */
export async function refreshTokens(tokens: SpotifyTokens, fetchFn: FetchLike, now = Date.now()): Promise<SpotifyTokens> {
  const json = await tokenRequest(fetchFn, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId,
  });
  return {
    ...tokens,
    accessToken: json.access_token as string,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : tokens.refreshToken,
    expiresAt: expiresAt(json, now),
    scope: typeof json.scope === 'string' ? json.scope : tokens.scope,
  };
}

export function needsRefresh(tokens: SpotifyTokens, now = Date.now()): boolean {
  return tokens.expiresAt - REFRESH_MARGIN_MS <= now;
}
