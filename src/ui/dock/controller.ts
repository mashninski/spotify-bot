// Док: удзельнік «мозгу» (ADR-015) плюс тое, што ёсць толькі ў доку — уваход у Spotify (ADR-016) і Twitch (ADR-018),
// і адзнака для debug-оверлэя. Стан і каманды — праз BrainNode: мозг можа працаваць тут або ў оверлэі.

import { safeLocalStorage } from '../../core/settings';
import { createStore } from '../../core/store';
import { isTwitchClientId, startDeviceLogin, type DeviceCode } from '../../sources/twitch/auth';
import { createBrainNode } from '../../brain/node';
import { redirectUriFor, startLogin } from '../../providers/spotify/auth';
import { DIAG_MARKER_KEY, writeJson } from '../shared/diag';

export function createDockController() {
  const storage = safeLocalStorage();
  const node = createBrainNode({ page: 'dock', storage });

  /** Пераход усёй старонкі дока на ўваход у Spotify; Spotify верне на callback.html (ADR-016). */
  async function connectSpotify(): Promise<void> {
    const clientId = node.settings.get().spotify.clientId;
    if (!isClientId(clientId)) return;
    location.href = await startLogin(storage, clientId, redirectUriFor(location.href));
  }

  /** Уваход у Twitch (Device Code Flow): док паказвае код, стрымер пацвярджае яго на twitch.tv у сваім браўзеры. */
  const twitchLogin = createStore<TwitchLoginState>({ phase: 'idle' });
  let cancelLogin: (() => void) | null = null;

  function connectTwitch(): void {
    const clientId = node.settings.get().twitch.clientId;
    if (!isTwitchClientId(clientId)) return;
    cancelLogin?.();
    twitchLogin.set({ phase: 'starting' });
    const login = startDeviceLogin({
      storage,
      fetch: (url, init) => fetch(url, init),
      clientId,
      onCode: (code) => {
        twitchLogin.set({ phase: 'code', code });
        openTwitchActivate(code);
      },
      onDone: () => {
        cancelLogin = null;
        twitchLogin.set({ phase: 'idle' });
      },
    });
    cancelLogin = login.cancel;
  }

  function cancelTwitchLogin(): void {
    cancelLogin?.();
    cancelLogin = null;
    twitchLogin.set({ phase: 'idle' });
  }

  /** З дока OBS адкрывае новыя акны ў сістэмным браўзеры — там стрымер ужо ўвайшоў у Twitch (ADR-009). */
  function openTwitchActivate(code: DeviceCode): void {
    window.open(code.verificationUri, '_blank');
  }

  return {
    ...node,

    start() {
      writeJson(storage, DIAG_MARKER_KEY, Date.now());
      node.start();
    },

    stop() {
      cancelLogin?.();
      node.stop();
    },

    connectSpotify,
    twitchLogin,
    connectTwitch,
    cancelTwitchLogin,
    openTwitchActivate,
    spotifyRedirectUri: redirectUriFor(location.href),
  };
}

/** Client ID прыкладання Spotify — 32 шаснаццатковыя сімвалы. */
export function isClientId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value);
}

export type TwitchLoginState = { phase: 'idle' } | { phase: 'starting' } | { phase: 'code'; code: DeviceCode };

export type DockController = ReturnType<typeof createDockController>;
