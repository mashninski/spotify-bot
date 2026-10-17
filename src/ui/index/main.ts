// Галоўная старонка распрацоўкі: спасылкі на док і оверлей.

import { t } from '../../i18n';

document.title = t('index.title');
const links: [string, string][] = [
  ['dock.html', t('index.dock')],
  ['overlay.html', t('index.overlay')],
  ['overlay.html?debug=1', t('index.overlayDebug')],
  ['overlay.html?demo=1', t('index.overlayDemo')],
  ['overlay.html?demo=video', t('index.overlayDemoVideo')],
];

const root = document.getElementById('app')!;
const h1 = document.createElement('h1');
h1.textContent = t('index.title');
root.append(h1);
const list = document.createElement('ul');
for (const [href, label] of links) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = href;
  a.textContent = label;
  const code = document.createElement('code');
  code.textContent = new URL(href, location.href).toString();
  li.append(a, document.createElement('br'), code);
  list.append(li);
}
root.append(list);
