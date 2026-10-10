// Пратакол obs-websocket 5.x (убудаваны ў OBS 28+).
// Дакументацыя: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md

export const RPC_VERSION = 1;

export const OpCode = {
  Hello: 0,
  Identify: 1,
  Identified: 2,
  Event: 5,
  Request: 6,
  RequestResponse: 7,
} as const;

/** Бітавыя маскі падпіскі на падзеі. */
export const EventSubscription = {
  General: 1 << 0,
  Inputs: 1 << 3,
  /** Узровень гуку крыніц кожныя ~50 мс. Не ўваходзіць у «усе» — падпісваемся асобна. */
  InputVolumeMeters: 1 << 16,
} as const;

/** Коды закрыцця WebSocket, якія адпраўляе OBS. */
export const CloseCode = {
  AuthenticationFailed: 4009,
  UnsupportedRpcVersion: 4010,
} as const;

export interface HelloData {
  obsWebSocketVersion: string;
  rpcVersion: number;
  authentication?: { challenge: string; salt: string };
}

export interface RequestStatus {
  result: boolean;
  code: number;
  comment?: string;
}

export interface RequestResponseData {
  requestType: string;
  requestId: string;
  requestStatus: RequestStatus;
  responseData?: Record<string, unknown>;
}

export interface EventData {
  eventType: string;
  eventIntent: number;
  eventData?: Record<string, unknown>;
}

export interface InputVolumeMetersEvent {
  inputs: { inputName: string; inputUuid?: string; inputLevelsMul: number[][] }[];
}

function toBase64(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

async function sha256Base64(text: string): Promise<string> {
  return toBase64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * Радок аўтэнтыфікацыі obs-websocket:
 * secret = base64(sha256(password + salt)); auth = base64(sha256(secret + challenge)).
 * Сам пароль па сетцы не перадаецца.
 */
export async function computeAuth(password: string, salt: string, challenge: string): Promise<string> {
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}
