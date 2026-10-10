// Старонка вяртання: сюды Spotify вяртае док пасля ўваходу (ADR-016). Яна абменьвае код на токены,
// захоўвае іх у localStorage і вяртае док на ўкладку «Налады».

import { safeLocalStorage } from '../../core/settings';
import { t } from '../../i18n';
import { completeLogin } from '../../providers/spotify/auth';

const storage = safeLocalStorage();
const params = new URLSearchParams(location.search);
const message = document.getElementById('message')!;
document.title = t('callback.title');

const backToDock = (tab: string) => location.replace(new URL(`dock.html#${tab}`, location.href).toString());

if (params.has('code') || params.has('error')) {
  message.textContent = t('callback.spotify');
  // Код ад Spotify больш не патрэбны ў адрасе — каб ён не застаўся ў гісторыі старонкі.
  history.replaceState(null, '', location.pathname);
  void completeLogin(storage, params, (url, init) => fetch(url, init)).finally(() => backToDock('settings'));
} else {
  message.textContent = t('callback.unknown');
}
