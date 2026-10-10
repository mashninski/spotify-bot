import { render } from 'preact';
import { App } from './App';
import { createDockController } from './controller';
import './dock.css';

const controller = createDockController();
void controller.start();
window.addEventListener('pagehide', () => controller.stop());

render(<App controller={controller} />, document.getElementById('app')!);
