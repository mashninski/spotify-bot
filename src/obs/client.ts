// Невялікі кліент obs-websocket 5.x без знешніх залежнасцей (ADR-012).

import {
  CloseCode,
  computeAuth,
  OpCode,
  RPC_VERSION,
  type EventData,
  type HelloData,
  type RequestResponseData,
} from './protocol';

export type ObsStatus = 'disconnected' | 'connecting' | 'connected' | 'auth-failed' | 'error';

export interface ObsClientOptions {
  url: string;
  password: string;
  eventSubscriptions: number;
  /** Аўтаматычна перападключацца пасля разрыву (па змаўчанні — так). */
  reconnect?: boolean;
  /** Для тэстаў: падмена класа WebSocket. */
  WebSocketImpl?: new (url: string) => WebSocket;
  /** Колькі чакаць адказу на запыт, мс. */
  requestTimeoutMs?: number;
}

export class ObsRequestError extends Error {
  constructor(
    readonly requestType: string,
    readonly code: number,
    comment?: string,
  ) {
    super(`${requestType}: ${code}${comment ? ` ${comment}` : ''}`);
  }
}

type EventHandler = (data: Record<string, unknown>) => void;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

export class ObsClient {
  private ws: WebSocket | null = null;
  private status: ObsStatus = 'disconnected';
  private statusDetail = '';
  private wanted = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRequestId = 0;
  private pending = new Map<string, { resolve: (d: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private statusHandlers = new Set<(status: ObsStatus, detail: string) => void>();
  /** Версія obs-websocket, якую паведаміў OBS. */
  obsWebSocketVersion = '';

  constructor(private readonly options: ObsClientOptions) {}

  getStatus(): ObsStatus {
    return this.status;
  }

  getStatusDetail(): string {
    return this.statusDetail;
  }

  onStatus(handler: (status: ObsStatus, detail: string) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  on(eventType: string, handler: EventHandler): () => void {
    let set = this.eventHandlers.get(eventType);
    if (!set) this.eventHandlers.set(eventType, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  connect(): void {
    this.wanted = true;
    this.reconnectAttempt = 0;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.clearReconnect();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    this.failPending(new Error('disconnected'));
    this.setStatus('disconnected');
  }

  /** Выклікае запыт obs-websocket і вяртае `responseData`. */
  call(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || this.status !== 'connected') return Promise.reject(new Error('not connected'));
    const requestId = String(++this.nextRequestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${requestType}: timeout`));
      }, this.options.requestTimeoutMs ?? 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ op: OpCode.Request, d: { requestType, requestId, requestData } }));
    });
  }

  private open(): void {
    this.clearReconnect();
    this.setStatus('connecting');
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.options.url);
    } catch (e) {
      this.setStatus('error', String(e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      void this.handleMessage(ws, ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending(new Error('connection closed'));
      if (ev.code === CloseCode.AuthenticationFailed) {
        this.wanted = false;
        this.setStatus('auth-failed', ev.reason);
        return;
      }
      if (ev.code === CloseCode.UnsupportedRpcVersion) {
        this.wanted = false;
        this.setStatus('error', ev.reason || 'unsupported rpc version');
        return;
      }
      this.setStatus(this.wanted ? 'error' : 'disconnected', ev.reason);
      this.scheduleReconnect();
    };
  }

  private async handleMessage(ws: WebSocket, data: unknown): Promise<void> {
    let msg: { op?: number; d?: any };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.op) {
      case OpCode.Hello: {
        const hello = msg.d as HelloData;
        this.obsWebSocketVersion = hello.obsWebSocketVersion ?? '';
        const identify: Record<string, unknown> = {
          rpcVersion: RPC_VERSION,
          eventSubscriptions: this.options.eventSubscriptions,
        };
        if (hello.authentication) {
          identify.authentication = await computeAuth(
            this.options.password,
            hello.authentication.salt,
            hello.authentication.challenge,
          );
        }
        if (this.ws === ws) ws.send(JSON.stringify({ op: OpCode.Identify, d: identify }));
        break;
      }
      case OpCode.Identified:
        this.reconnectAttempt = 0;
        this.setStatus('connected');
        break;
      case OpCode.Event: {
        const ev = msg.d as EventData;
        const handlers = this.eventHandlers.get(ev.eventType);
        if (handlers) for (const h of [...handlers]) h(ev.eventData ?? {});
        break;
      }
      case OpCode.RequestResponse: {
        const res = msg.d as RequestResponseData;
        const p = this.pending.get(res.requestId);
        if (!p) return;
        this.pending.delete(res.requestId);
        clearTimeout(p.timer);
        if (res.requestStatus?.result) p.resolve(res.responseData ?? {});
        else p.reject(new ObsRequestError(res.requestType, res.requestStatus?.code ?? 0, res.requestStatus?.comment));
        break;
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.options.reconnect === false) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private failPending(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private setStatus(status: ObsStatus, detail = ''): void {
    if (status === this.status && detail === this.statusDetail) return;
    this.status = status;
    this.statusDetail = detail;
    for (const h of [...this.statusHandlers]) h(status, detail);
  }
}
