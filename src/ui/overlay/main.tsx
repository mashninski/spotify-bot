import { render } from 'preact';
import { createBrainNode } from '../../brain/node';
import { Overlay, type OverlayOptions } from './Overlay';
import './overlay.css';

// Параметры адраса: ?debug=1 — дыягностыка, ?demo=1 — тэставыя даныя без бота,
// #obs=ws://…&pw=… — запаснае падключэнне да OBS (толькі калі канал obs-browser не працуе).
const search = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1));

const options: OverlayOptions = {
  debug: search.get('debug') === '1',
  demo: search.get('demo') === '1',
  obs: hash.has('pw') || hash.has('obs') ? { url: hash.get('obs') || 'ws://127.0.0.1:4455', password: hash.get('pw') ?? '' } : undefined,
};

// Оверлей — таксама кандыдат на «мозг» (ADR-015): бот працуе, нават калі док не адкрыты.
// Дэманстрацыйны оверлей толькі паказвае выгляд і ў выбары не ўдзельнічае.
const node = options.demo ? null : createBrainNode({ page: 'overlay' });
if (node) {
  node.start();
  window.addEventListener('pagehide', () => node.stop());
}

render(<Overlay options={options} node={node} />, document.getElementById('app')!);
