// Кліент Twitch EventSub WebSocket (ADR-018). Працуе толькі ў лідары: адно злучэнне — адзін атрымальнік падзей.
// Правілы Twitch: пасля `session_welcome` ёсць 10 с, каб падпісацца; калі доўга няма ні падзей, ні keepalive —
// злучэнне страчана; `session_reconnect` — новае злучэнне па `reconnect_url` з тымі ж падпіскамі, старое закрываецца
// толькі пасля welcome на новым. Пры звычайным перападключэнні падпіскі трэба ствараць нанова, а падзеі,
// што прыйшлі ў перапынак, не вяртаюцца — іх даганяе `Get Custom Reward Redemption` (гл. twitch.ts).

export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
/** Як доўга Twitch можа маўчаць (10…600 с). Больш — менш keepalive-паведамленняў, але пазней заўважым страту сувязі. */
export const KEEPALIVE_S = 30;
/** Паўзы паміж спробамі перападключэння, мс. */
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000, 30_000];
/** Колькі ідэнтыфікатараў паведамленняў памятаць, каб не апрацаваць паўторную дастаўку. */
const SEEN_LIMIT = 300;

/** Тое, што патрэбна ад WebSocket (у тэстах — падробка). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number): void;
}

export type SocketFactory = (url: string) => SocketLike;

export const browserSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export type EventSubStatus = 'off' | 'connecting' | 'ok';

export interface EventSubOptions {
  createSocket?: SocketFactory;
  url?: string;
  now?: () => number;
  /** Новае злучэнне (не па `session_reconnect`): трэба падпісацца і дагнаць прапушчанае. */
  onWelcome(sessionId: string): void;
  onNotification(type: string, event: unknown): void;
  /** Twitch адклікаў падпіску (`authorization_revoked`, `user_removed`…). */
  onRevoked(type: string, status: string): void;
  onStatus(status: EventSubStatus): void;
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function createEventSub(options: EventSubOptions) {
  const createSocket = options.createSocket ?? browserSocket;
  const now = options.now ?? Date.now;
  const baseUrl = `${options.url ?? EVENTSUB_URL}?keepalive_timeout_seconds=${KEEPALIVE_S}`;

  let running = false;
  let socket: SocketLike | null = null;
  /** Злучэнне па `reconnect_url`, якое яшчэ не атрымала welcome. */
  let pending: SocketLike | null = null;
  let keepaliveMs = KEEPALIVE_S * 1000;
  let lastMessageAt = 0;
  let attempt = 0;
  let reconnectAt = 0;
  let welcomedAt = 0;
  let status: EventSubStatus = 'off';
  const seen: string[] = [];
  const seenSet = new Set<string>();

  function setStatus(next: EventSubStatus): void {
    if (status === next) return;
    status = next;
    options.onStatus(next);
  }

  function remember(id: string): boolean {
    if (seenSet.has(id)) return false;
    seenSet.add(id);
    seen.push(id);
    if (seen.length > SEEN_LIMIT) seenSet.delete(seen.shift()!);
    return true;
  }

  function detach(s: SocketLike | null): void {
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close(1000);
    } catch {
      // Ужо закрыта.
    }
  }

  function open(url: string, isReconnect: boolean): void {
    const s = createSocket(url);
    if (isReconnect) pending = s;
    else socket = s;
    s.onmessage = (ev) => handle(s, ev.data);
    s.onclose = () => {
      if (s === pending) {
        // Новае злучэнне не атрымалася — старое яшчэ жывое да свайго закрыцця, потым — звычайнае перападключэнне.
        pending = null;
        return;
      }
      if (s !== socket) return;
      socket = null;
      scheduleReconnect();
    };
    s.onerror = () => {
      // Пасля памылкі заўсёды прыходзіць close.
    };
  }

  function scheduleReconnect(): void {
    if (!running) return;
    setStatus('connecting');
    // Злучэнне працавала даўжэй за хвіліну — пачынаем паўзы спачатку.
    if (welcomedAt && now() - welcomedAt > 60_000) attempt = 0;
    welcomedAt = 0;
    reconnectAt = now() + RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    attempt++;
  }

  function handle(s: SocketLike, raw: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isObject(msg) || !isObject(msg.metadata)) return;
    const { message_type: type, message_id: id } = msg.metadata;
    const payload = isObject(msg.payload) ? msg.payload : {};
    lastMessageAt = now();
    if (typeof id === 'string' && id && !remember(id)) return; // паўторная дастаўка
    switch (type) {
      case 'session_welcome': {
        const session = isObject(payload.session) ? payload.session : {};
        if (typeof session.keepalive_timeout_seconds === 'number') keepaliveMs = session.keepalive_timeout_seconds * 1000;
        welcomedAt = now();
        if (s === pending) {
          // Пераход па `session_reconnect`: падпіскі ўжо на новым злучэнні.
          const old = socket;
          socket = s;
          pending = null;
          detach(old);
          setStatus('ok');
          return;
        }
        if (s !== socket || typeof session.id !== 'string') return;
        setStatus('ok');
        options.onWelcome(session.id);
        return;
      }
      case 'session_keepalive':
        return;
      case 'session_reconnect': {
        const session = isObject(payload.session) ? payload.session : {};
        if (s === socket && typeof session.reconnect_url === 'string' && !pending) open(session.reconnect_url, true);
        return;
      }
      case 'notification': {
        if (s !== socket && s !== pending) return;
        const sub = isObject(payload.subscription) ? payload.subscription : {};
        if (typeof sub.type === 'string') options.onNotification(sub.type, payload.event);
        return;
      }
      case 'revocation': {
        const sub = isObject(payload.subscription) ? payload.subscription : {};
        options.onRevoked(typeof sub.type === 'string' ? sub.type : '', typeof sub.status === 'string' ? sub.status : '');
        return;
      }
    }
  }

  return {
    get status() {
      return status;
    },

    start(): void {
      if (running) return;
      running = true;
      attempt = 0;
      setStatus('connecting');
      lastMessageAt = now();
      open(baseUrl, false);
    },

    stop(): void {
      running = false;
      detach(socket);
      detach(pending);
      socket = pending = null;
      reconnectAt = 0;
      setStatus('off');
    },

    /** Перападключыцца цалкам (напрыклад, падпіска не атрымалася). */
    restart(): void {
      if (!running) return;
      detach(socket);
      detach(pending);
      socket = pending = null;
      scheduleReconnect();
    },

    /** Выклікаецца таймерам мозгу: сочыць за ціхім злучэннем і перападключаецца. */
    tick(t = now()): void {
      if (!running) return;
      if (!socket && !pending && reconnectAt && t >= reconnectAt) {
        reconnectAt = 0;
        lastMessageAt = t;
        open(baseUrl, false);
        return;
      }
      // Twitch маўчыць даўжэй, чым абяцаў (з запасам 5 с) — злучэнне страчана.
      if (socket && t - lastMessageAt > keepaliveMs + 5000) {
        detach(socket);
        socket = null;
        scheduleReconnect();
      }
    },
  };
}

export type EventSub = ReturnType<typeof createEventSub>;
