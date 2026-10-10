// Дыягностыка рызыкі ADR-009: ці працуе док, калі ён схаваны або закрыты ў OBS.
// Параўноўвае звычайны таймер (яго браўзер запавольвае на схаваных старонках) з worker-таймерам
// і лічыць падзеі ад OBS. Вынікі захоўваюцца ў localStorage, каб іх было відаць і пасля перазагрузкі дока.

import { createStore, type Store } from '../../core/store';
import { startTicker } from '../../core/ticker';

export interface HiddenPeriod {
  start: number;
  end: number;
  mainMaxGapMs: number;
  workerMaxGapMs: number;
  obsEvents: number;
}

export interface HiddenMonitorState {
  visible: boolean;
  periods: HiddenPeriod[];
  mainMaxGapMs: number;
  workerMaxGapMs: number;
  loadedAt: number;
  /** Калі папярэдняя загрузка дока апошні раз была жывая (null — першы запуск). */
  previousAliveAt: number | null;
}

const PERIODS_KEY = 'spotify-bot:diag:hidden-periods';
const ALIVE_KEY = 'spotify-bot:diag:alive-at';
const MAX_PERIODS = 10;

export class HiddenMonitor {
  readonly state: Store<HiddenMonitorState>;
  private current: HiddenPeriod | null = null;
  private lastMain = Date.now();
  private lastWorker = Date.now();
  private stopFns: (() => void)[] = [];

  constructor(private readonly storage: Storage | null) {
    const now = Date.now();
    this.state = createStore<HiddenMonitorState>({
      visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
      periods: this.readPeriods(),
      mainMaxGapMs: 0,
      workerMaxGapMs: 0,
      loadedAt: now,
      previousAliveAt: this.readNumber(ALIVE_KEY),
    });
  }

  start(): void {
    const mainId = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastMain;
      this.lastMain = now;
      if (this.current) this.current.mainMaxGapMs = Math.max(this.current.mainMaxGapMs, gap);
      this.state.set((s) => (gap > s.mainMaxGapMs ? { ...s, mainMaxGapMs: gap } : s));
    }, 1000);
    const worker = startTicker(1000, () => {
      const now = Date.now();
      const gap = now - this.lastWorker;
      this.lastWorker = now;
      if (this.current) this.current.workerMaxGapMs = Math.max(this.current.workerMaxGapMs, gap);
      this.state.set((s) => (gap > s.workerMaxGapMs ? { ...s, workerMaxGapMs: gap } : s));
      this.write(ALIVE_KEY, now);
    });
    const onVisibility = () => this.onVisibility(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    this.stopFns.push(
      () => clearInterval(mainId),
      () => worker.stop(),
      () => document.removeEventListener('visibilitychange', onVisibility),
    );
    if (document.visibilityState === 'hidden') this.onVisibility(false);
  }

  stop(): void {
    for (const f of this.stopFns.splice(0)) f();
  }

  /** Выклікаць на кожную падзею ад OBS. */
  countObsEvent(): void {
    if (this.current) this.current.obsEvents++;
  }

  private onVisibility(visible: boolean): void {
    const now = Date.now();
    if (!visible && !this.current) {
      this.current = { start: now, end: now, mainMaxGapMs: 0, workerMaxGapMs: 0, obsEvents: 0 };
    } else if (visible && this.current) {
      const period = { ...this.current, end: now };
      this.current = null;
      const periods = [period, ...this.state.get().periods].slice(0, MAX_PERIODS);
      this.write(PERIODS_KEY, periods);
      this.state.set((s) => ({ ...s, periods }));
    }
    this.state.set((s) => (s.visible === visible ? s : { ...s, visible }));
  }

  private readPeriods(): HiddenPeriod[] {
    try {
      const parsed = JSON.parse(this.storage?.getItem(PERIODS_KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed.slice(0, MAX_PERIODS) : [];
    } catch {
      return [];
    }
  }

  private readNumber(key: string): number | null {
    try {
      const n = Number(this.storage?.getItem(key));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): void {
    try {
      this.storage?.setItem(key, JSON.stringify(value));
    } catch {
      // Без захавання дыягностыка ўсё роўна працуе ў памяці.
    }
  }
}
