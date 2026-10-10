// Док: удзельнік «мозгу» (ADR-015) плюс тое, што ёсць толькі ў доку — дыягностыка схаванага дока
// і праверка перанакіравання. Стан і каманды — праз BrainNode: мозг можа працаваць тут або ў оверлеі.

import { randomId } from '../../core/id';
import { safeLocalStorage } from '../../core/settings';
import { createBrainNode } from '../../brain/node';
import { DIAG_MARKER_KEY, REDIRECT_PENDING_KEY, REDIRECT_SERVICE, writeJson } from '../shared/diag';
import { HiddenMonitor } from './hidden-monitor';

export function createDockController() {
  const storage = safeLocalStorage();
  const monitor = new HiddenMonitor(storage);
  const node = createBrainNode({ page: 'dock', storage, onObsEvent: () => monitor.countObsEvent() });

  function runRedirectTest(): void {
    const nonce = randomId();
    writeJson(storage, REDIRECT_PENDING_KEY, { nonce, at: Date.now() });
    const back = new URL(`callback.html?test=redirect&nonce=${nonce}`, location.href).toString();
    location.href = `${REDIRECT_SERVICE}?url=${encodeURIComponent(back)}`;
  }

  function runPopupTest(): void {
    window.open(new URL('callback.html?test=popup', location.href).toString(), '_blank');
  }

  return {
    ...node,
    monitor,

    start() {
      writeJson(storage, DIAG_MARKER_KEY, Date.now());
      monitor.start();
      node.start();
    },

    stop() {
      node.stop();
      monitor.stop();
    },

    runRedirectTest,
    runPopupTest,
  };
}

export type DockController = ReturnType<typeof createDockController>;
