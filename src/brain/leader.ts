// Выбар лідара паміж старонкамі прыкладання (ADR-015).
// Усе старонкі (док, оверлеі) просяць адзін і той жа Web Lock. Трымае яго толькі адна — яна і ёсць лідар.
// Калі лідар знікае (старонка зачынена або перазагружана), браўзер сам аддае замок наступнай старонцы ў чарзе.

export const LEADER_LOCK = 'spotify-bot:leader';

/** Частка Web Locks API, якая нам патрэбна (дазваляе падставіць падробку ў тэстах). */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

export interface LeaderElection {
  isLeader(): boolean;
  /** Адмовіцца ад лідарства або выйсці з чаргі. */
  stop(): void;
}

/** Web Locks API браўзера або `null`, калі яго няма (стары браўзер, не secure context). */
export function getLockManager(): LockManagerLike | null {
  try {
    return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
  } catch {
    return null;
  }
}

/**
 * Становіцца ў чаргу на замок. `onLeader` выклікаецца адзін раз, калі старонка стала лідарам.
 * Страціць лідарства без `stop()` нельга: замок трымаецца, пакуль старонка жывая.
 */
export function electLeader(locks: LockManagerLike, onLeader: () => void, name = LEADER_LOCK): LeaderElection {
  const abort = new AbortController();
  let release: (() => void) | null = null;
  let leader = false;
  let stopped = false;

  locks
    .request(name, { mode: 'exclusive', signal: abort.signal }, () => {
      if (stopped) return Promise.resolve();
      leader = true;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      onLeader();
      return held;
    })
    .catch(() => {
      // AbortError: stop() выкліканы, пакуль старонка чакала ў чарзе.
    });

  return {
    isLeader: () => leader,
    stop() {
      if (stopped) return;
      stopped = true;
      leader = false;
      abort.abort();
      release?.();
    },
  };
}
