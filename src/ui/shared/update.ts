// Аўтаабнаўленне старонак (ADR-020): GitHub Pages аддае старонкі з кэшам на 10 хвілін, і OBS доўга паказваў
// старую версію. Док і оверлэй раз у хвіліну чытаюць version.json (без кэша) і, калі выйшла новая версія,
// загружаюцца нанова — тады, калі гэта нікому не перашкодзіць (`canReload`).

import { busy } from '../../core/busy';

const CHECK_MS = 60_000;

/** Пачаць сачыць за новай версіяй. `canReload` — ці можна перазагрузіць старонку зараз. */
export function watchForUpdates(canReload: () => boolean): () => void {
  // Пры распрацоўцы (dev-сервер) version.json няма — нічога не робім.
  if (import.meta.env.DEV || typeof window === 'undefined') return () => undefined;
  let latest = '';
  const check = async () => {
    try {
      const response = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const body = (await response.json()) as { version?: unknown };
      if (typeof body.version === 'string' && body.version) latest = body.version;
    } catch {
      // Няма сеткі — праверым пазней.
    }
  };
  const tryReload = () => {
    // Не пасярэдзіне абнаўлення ўваходу ў Twitch / Spotify — інакш уваход прападзе.
    if (!latest || latest === __APP_VERSION__ || busy() || !canReload()) return;
    // Новы адрас (?v=…) — каб браўзер не ўзяў старую старонку з кэша.
    const url = new URL(location.href);
    url.searchParams.set('v', latest);
    location.replace(url.toString());
  };
  void check();
  const checkTimer = setInterval(() => void check(), CHECK_MS);
  const reloadTimer = setInterval(tryReload, 2000);
  return () => {
    clearInterval(checkTimer);
    clearInterval(reloadTimer);
  };
}
