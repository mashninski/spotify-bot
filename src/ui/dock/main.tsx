import { render } from 'preact';
import { App } from './App';
import { createDockController } from './controller';
import './dock.css';
import { watchForUpdates } from '../shared/update';

const controller = createDockController();
controller.start();
window.addEventListener('pagehide', () => controller.stop());
// Новая версія — перазагрузка, калі стрымер нічога не піша ў полі налад і не падключае Twitch (код на экране).
watchForUpdates(
  () =>
    controller.twitchLogin.get().phase === 'idle' &&
    !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement),
);

render(<App controller={controller} />, document.getElementById('app')!);
