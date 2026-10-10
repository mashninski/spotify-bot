// Старонка вяртання. Зараз — для праверкі перанакіравання ў доку (ADR-009);
// на Этапе 3 сюды вернецца ўваход у Spotify (PKCE).

import { safeLocalStorage } from '../../core/settings';
import { t } from '../../i18n';
import { readJson, REDIRECT_PENDING_KEY, REDIRECT_RESULT_KEY, REDIRECT_SERVICE, writeJson, type RedirectResult } from '../shared/diag';

const storage = safeLocalStorage();
const params = new URLSearchParams(location.search);
const message = document.getElementById('message')!;
document.title = t('callback.title');

const test = params.get('test');
if (test === 'redirect') {
  const pending = readJson<{ nonce: string }>(storage, REDIRECT_PENDING_KEY);
  const result: RedirectResult = {
    ok: Boolean(pending) && pending?.nonce === params.get('nonce'),
    storageKept: Boolean(pending),
    at: Date.now(),
    via: new URL(REDIRECT_SERVICE).host,
  };
  writeJson(storage, REDIRECT_RESULT_KEY, result);
  try {
    storage?.removeItem(REDIRECT_PENDING_KEY);
  } catch {
    // Не крытычна.
  }
  message.textContent = t('callback.redirect');
  location.replace(new URL('dock.html#diagnostics', location.href).toString());
} else if (test === 'popup') {
  message.textContent = t('callback.popup');
} else {
  message.textContent = t('callback.unknown');
}
