import { render } from 'preact';
import { Overlay, type OverlayOptions } from './Overlay';
import './overlay.css';

// Параметры адраса: ?debug=1 — дыягностыка, ?demo=1 — тэставыя даныя без дока,
// #obs=ws://…&pw=… — запаснае падключэнне да OBS (толькі калі канал obs-browser не працуе).
const search = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1));

const options: OverlayOptions = {
  debug: search.get('debug') === '1',
  demo: search.get('demo') === '1',
  obs: hash.has('pw') || hash.has('obs') ? { url: hash.get('obs') || 'ws://127.0.0.1:4455', password: hash.get('pw') ?? '' } : undefined,
};

render(<Overlay options={options} />, document.getElementById('app')!);
