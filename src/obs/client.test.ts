import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ObsClient } from './client';
import { computeAuth, OpCode } from './protocol';

/** Падробны WebSocket: запісвае адпраўленае і дазваляе тэсту «адказваць ад імя OBS». */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  sent: any[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.onclose?.({ code, reason: '' });
  }
  receive(op: number, d: unknown) {
    this.onmessage?.({ data: JSON.stringify({ op, d }) });
  }
}

/** Identify адпраўляецца пасля асінхроннага SHA-256, таму чакаем па ўмове, а не фіксаваны час. */
const identifySent = (ws: FakeWebSocket) => vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

function makeClient(password = '') {
  const client = new ObsClient({
    url: 'ws://127.0.0.1:4455',
    password,
    eventSubscriptions: 1,
    reconnect: false,
    WebSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
  });
  client.connect();
  return { client, ws: FakeWebSocket.last! };
}

describe('аўтэнтыфікацыя obs-websocket', () => {
  it('супадае з алгарытмам з дакументацыі', async () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('base64');
    const expected = sha(sha('пароль' + 'salt') + 'challenge');
    expect(await computeAuth('пароль', 'salt', 'challenge')).toBe(expected);
  });
});

describe('кліент obs-websocket', () => {
  it('падключэнне з паролем, запыт і адказ', async () => {
    const { client, ws } = makeClient('secret');
    expect(client.getStatus()).toBe('connecting');
    ws.receive(OpCode.Hello, { obsWebSocketVersion: '5.6.3', rpcVersion: 1, authentication: { salt: 's', challenge: 'c' } });
    await identifySent(ws);
    expect(ws.sent[0].op).toBe(OpCode.Identify);
    expect(ws.sent[0].d.authentication).toBe(await computeAuth('secret', 's', 'c'));
    expect(ws.sent[0].d.eventSubscriptions).toBe(1);

    ws.receive(OpCode.Identified, { negotiatedRpcVersion: 1 });
    expect(client.getStatus()).toBe('connected');
    expect(client.obsWebSocketVersion).toBe('5.6.3');

    const result = client.call('GetVersion');
    const request = ws.sent[1];
    expect(request.op).toBe(OpCode.Request);
    ws.receive(OpCode.RequestResponse, {
      requestType: 'GetVersion',
      requestId: request.d.requestId,
      requestStatus: { result: true, code: 100 },
      responseData: { obsVersion: '32.2.2' },
    });
    await expect(result).resolves.toEqual({ obsVersion: '32.2.2' });
  });

  it('памылка запыту і падзеі', async () => {
    const { client, ws } = makeClient();
    ws.receive(OpCode.Hello, { obsWebSocketVersion: '5', rpcVersion: 1 });
    await identifySent(ws);
    expect(ws.sent[0].d.authentication).toBeUndefined();
    ws.receive(OpCode.Identified, {});

    const events: unknown[] = [];
    client.on('CustomEvent', (d) => events.push(d));
    ws.receive(OpCode.Event, { eventType: 'CustomEvent', eventIntent: 1, eventData: { x: 1 } });
    expect(events).toEqual([{ x: 1 }]);

    const failing = client.call('CallVendorRequest');
    ws.receive(OpCode.RequestResponse, {
      requestType: 'CallVendorRequest',
      requestId: ws.sent[1].d.requestId,
      requestStatus: { result: false, code: 600, comment: 'no vendor' },
    });
    await expect(failing).rejects.toThrow('600');
  });

  it('няправільны пароль', async () => {
    const { client, ws } = makeClient('bad');
    ws.close(4009);
    expect(client.getStatus()).toBe('auth-failed');
  });

  it('запыт без падключэння адхіляецца', async () => {
    const { client } = makeClient();
    await expect(client.call('GetVersion')).rejects.toThrow('not connected');
  });
});
