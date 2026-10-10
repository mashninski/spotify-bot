// Загаловак акна Spotify праз OBS (ADR-016, дапаўненне): у дадатку Spotify для Windows загаловак акна —
// «Выканаўца - Назва», а на паўзе — «Spotify Premium». OBS умее паказваць спіс акон у наладах крыніц
// «Захват звука приложения» і «Захват окна». Чытаць гэты спіс праз obs-websocket бясплатна (без запытаў да Spotify),
// таму змену загалоўка выкарыстоўваем як сігнал «апытаць Spotify зараз». Без такой крыніцы ў OBS усё працуе як раней.

/** Крыніцы OBS, у наладах якіх ёсць спіс акон (уласцівасць `window`). */
export const WINDOW_SOURCE_KINDS = ['wasapi_process_output_capture', 'window_capture', 'game_capture'];

export interface PropertyItem {
  itemName?: unknown;
  itemValue?: unknown;
}

/**
 * Шукае акно Spotify у спісе акон OBS. Элемент спісу: `itemName` — «[Spotify.exe]: Загаловак»,
 * `itemValue` — «Загаловак:Клас:Spotify.exe». Вяртае загаловак або `null`, калі акна Spotify няма.
 */
export function spotifyTitleFromItems(items: PropertyItem[]): string | null {
  let found: string | null = null;
  for (const item of items) {
    const name = typeof item.itemName === 'string' ? item.itemName : '';
    const value = typeof item.itemValue === 'string' ? item.itemValue : '';
    const isSpotify = /^\[spotify\.exe\]/i.test(name) || /:spotify\.exe$/i.test(value);
    if (!isSpotify) continue;
    const title = name.replace(/^\[[^\]]*\]:\s*/, '').trim();
    // У Spotify можа быць некалькі акон; галоўнае — з класам Chrome_WidgetWin_0 і непустым загалоўкам.
    if (/:Chrome_WidgetWin_0:/i.test(value) && title) return title;
    if (found === null || (!found && title)) found = title;
  }
  return found;
}

/** Тое, што патрэбна ад кліента obs-websocket (дазваляе падставіць падробку ў тэстах). */
export interface ObsCaller {
  call(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export type WindowWatchStatus =
  /** Яшчэ не правяралі або OBS не падключаны. */
  | 'unknown'
  /** У OBS няма крыніцы са спісам акон. */
  | 'no-source'
  /** Крыніцы ёсць, але акна Spotify няма (Spotify закрыты або згорнуты ў трэй). */
  | 'no-window'
  | 'ok';

export interface WindowWatchResult {
  status: WindowWatchStatus;
  title: string | null;
}

/** Чытае загаловак акна Spotify. Памятае крыніцу, праз якую атрымалася, каб наступным разам пачынаць з яе. */
export function createSpotifyWindowReader(obs: ObsCaller) {
  let preferred = '';

  async function sources(): Promise<string[]> {
    const res = await obs.call('GetInputList');
    const inputs = Array.isArray(res.inputs) ? (res.inputs as Record<string, unknown>[]) : [];
    const names = inputs
      .filter((i) => WINDOW_SOURCE_KINDS.includes(String(i.unversionedInputKind ?? i.inputKind ?? '')))
      .map((i) => String(i.inputName ?? ''))
      .filter(Boolean);
    // Спачатку тая крыніца, што спрацавала мінулы раз.
    return preferred && names.includes(preferred) ? [preferred, ...names.filter((n) => n !== preferred)] : names;
  }

  return {
    async read(): Promise<WindowWatchResult> {
      const names = await sources();
      if (names.length === 0) return { status: 'no-source', title: null };
      for (const inputName of names) {
        try {
          const res = await obs.call('GetInputPropertiesListPropertyItems', { inputName, propertyName: 'window' });
          const items = Array.isArray(res.propertyItems) ? (res.propertyItems as PropertyItem[]) : [];
          const title = spotifyTitleFromItems(items);
          if (title !== null) {
            preferred = inputName;
            return { status: 'ok', title };
          }
          // Спіс акон адзін для ўсіх крыніц — калі Spotify няма ў адной, няма і ў іншых.
          if (items.length > 0) return { status: 'no-window', title: null };
        } catch {
          // Крыніца без уласцівасці `window` (напрыклад, іншы рэжым захопу гульні) — спрабуем наступную.
        }
      }
      return { status: 'no-window', title: null };
    },
  };
}
