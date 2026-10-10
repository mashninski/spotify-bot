// Старонка вяртання: сюды Spotify вяртае док пасля ўваходу (ADR-016). Яна абменьвае код на токены,
// захоўвае іх у localStorage і вяртае док на ўкладку «Налады». Таксама — праверка перанакіравання (ADR-009).

import { safeLocalStorage } from '../../core/settings';
import { t } from '../../i18n';
import { completeLogin } from '../../providers/spotify/auth';
import { readJson, REDIRECT_PENDING_KEY, REDIRECT_RESULT_KEY, REDIRECT_SERVICE, writeJson, type RedirectResult } from '../shared/diag';

const storage = safeLocalStorage();
const params = new URLSearchParams(location.search);
const message = document.getElementById('message')!;
document.title = t('callback.title');

const backToDock = (tab: string) => location.replace(new URL(`dock.html#${tab}`, location.href).toString());

const test = params.get('test');
if (params.has('code') || params.has('error')) {
  message.textContent = t('callback.spotify');
  // Код ад Spotify больш не патрэбны ў адрасе — каб ён не застаўся ў гісторыі старонкі.
  history.replaceState(null, '', location.pathname);
  void completeLogin(storage, params, (url, init) => fetch(url, init)).finally(() => backToDock('settings'));
} else if (test === 'redirect') {
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
  backToDock('diagnostics');
} else if (test === 'popup') {
  message.textContent = t('callback.popup');
} else {
  message.textContent = t('callback.unknown');
}
