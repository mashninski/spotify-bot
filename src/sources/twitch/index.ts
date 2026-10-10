// Крыніца заказаў. На Этапе 2 — толькі тэставая; баллы канала Twitch (EventSub) — на Этапе 4 (ADR-011).

export interface SongRequest {
  /** Нік гледача. */
  user: string;
  /** Тое, што напісаў глядач: спасылка на трэк або назва. */
  query: string;
  /** Ідэнтыфікатар выкупу ўзнагароды Twitch (каб вярнуць баллы). У тэставым рэжыме адсутнічае. */
  redemptionId?: string;
}

export interface RequestSource {
  readonly id: string;
  start(onRequest: (request: SongRequest) => void): void;
  stop(): void;
}

/** Тэставая крыніца: заказы ствараюцца ўручную кнопкай у доку праз `simulate`. */
export function createMockRequestSource(): RequestSource & { simulate(request: SongRequest): void } {
  let handler: ((request: SongRequest) => void) | null = null;
  return {
    id: 'mock',
    start(onRequest) {
      handler = onRequest;
    },
    stop() {
      handler = null;
    },
    simulate(request) {
      handler?.(request);
    },
  };
}
