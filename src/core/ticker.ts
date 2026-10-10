// Таймер, які працуе і ў схаваным доку.
// Браўзеры запавольваюць setInterval на схаваных старонках (да 1 разу ў секунду, а праз 5 хвілін —
// да 1 разу ў хвіліну). Таймеры ўнутры Web Worker так не абмяжоўваюцца, таму асноўны «гадзіннік»
// дока жыве ў worker. Калі worker недаступны (тэсты), выкарыстоўваецца звычайны setInterval.

export interface Ticker {
  stop(): void;
  /** `true`, калі працуе праз Web Worker. */
  readonly usesWorker: boolean;
}

const WORKER_SOURCE = 'let t;onmessage=(e)=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data)};';

export function startTicker(intervalMs: number, onTick: () => void): Ticker {
  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      const worker = new Worker(url);
      worker.onmessage = () => onTick();
      worker.postMessage(intervalMs);
      return {
        usesWorker: true,
        stop() {
          worker.terminate();
          URL.revokeObjectURL(url);
        },
      };
    } catch {
      // Працягваем са звычайным таймерам ніжэй.
    }
  }
  const id = setInterval(onTick, intervalMs);
  return { usesWorker: false, stop: () => clearInterval(id) };
}
