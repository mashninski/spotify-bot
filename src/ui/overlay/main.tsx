import { render } from 'preact';
import { electLeader, getLockManager, VIDEO_LOCK } from '../../brain/leader';
import { createBrainNode } from '../../brain/node';
import { createStore } from '../../core/store';
import { currentVideo } from '../../core/video';
import { watchForUpdates } from '../shared/update';
import { Overlay, type OverlayOptions } from './Overlay';
import './overlay.css';

// Параметры адраса: ?debug=1 — дыягностыка, ?demo=1 — тэставыя даныя без бота, ?demo=video — тэставае відэа
// (&v=<id відэа YouTube> — любое іншае),
// #obs=ws://…&pw=… — запаснае падключэнне да OBS (толькі калі канал obs-browser не працуе).
const search = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1));
const demo = search.get('demo');

const options: OverlayOptions = {
  debug: search.get('debug') === '1',
  demo: demo === '1' ? 'song' : demo === 'video' ? 'video' : null,
  demoVideoId: /^[A-Za-z0-9_-]{11}$/.test(search.get('v') ?? '') ? search.get('v')! : undefined,
  obs: hash.has('pw') || hash.has('obs') ? { url: hash.get('obs') || 'ws://127.0.0.1:4455', password: hash.get('pw') ?? '' } : undefined,
};

// Оверлей — таксама кандыдат на «мозг» (ADR-015): бот працуе, нават калі док не адкрыты.
// Дэманстрацыйны оверлей толькі паказвае выгляд і ў выбары не ўдзельнічае.
const node = options.demo ? null : createBrainNode({ page: 'overlay' });

/**
 * Уладальнік плэера відэа (ADR-020): з гукам грае толькі адзін оверлэй — той, што трымае Web Lock.
 * Без Web Locks кожны оверлэй лічыць сябе ўладальнікам (у OBS 32 замкі ёсць).
 */
const videoOwner = createStore(false);
if (node) {
  node.start();
  const locks = getLockManager();
  const election = locks ? electLeader(locks, () => videoOwner.set(true), VIDEO_LOCK) : null;
  if (!locks) videoOwner.set(true);
  // Раз у 5 с — мозгу пра сябе: «Стан» паказвае, колькі оверлэяў адкрыта і якой яны версіі.
  const status = () => node.reportOverlay(videoOwner.get(), __APP_VERSION__);
  status();
  const statusTimer = setInterval(status, 5000);
  // Новая версія — перазагрузка, але не пасярэдзіне відэа.
  watchForUpdates(() => !currentVideo(node.player.get()));
  window.addEventListener('pagehide', () => {
    clearInterval(statusTimer);
    election?.stop();
    node.stop();
  });
}

render(<Overlay options={options} node={node} videoOwner={videoOwner} />, document.getElementById('app')!);
