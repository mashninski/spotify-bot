// Док для OBS: укладкі «Плэер», «Налады», «Праверка».

import { useEffect, useState } from 'preact/hooks';
import { t, type MessageKey } from '../../i18n';
import { useStore } from '../shared/hooks';
import type { DockController } from './controller';
import { DiagnosticsTab } from './DiagnosticsTab';
import { PlayerTab } from './PlayerTab';
import { SettingsTab } from './SettingsTab';

const TABS = [
  { id: 'player', label: 'tab.player' },
  { id: 'settings', label: 'tab.settings' },
  { id: 'diagnostics', label: 'tab.diagnostics' },
] as const satisfies readonly { id: string; label: MessageKey }[];

type TabId = (typeof TABS)[number]['id'];

const tabFromHash = (): TabId => {
  const id = location.hash.slice(1);
  return TABS.some((tab) => tab.id === id) ? (id as TabId) : 'player';
};

export function App({ controller }: { controller: DockController }) {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const obs = useStore(controller.obsStatus);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = (id: TabId) => {
    history.replaceState(null, '', `#${id}`);
    setTab(id);
  };

  return (
    <div class="dock">
      <header class="topbar">
        <nav class="tabs" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              class={tab === item.id ? 'tab active' : 'tab'}
              onClick={() => select(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </nav>
        <button
          class={`obs-dot ${obs.status}`}
          title={t(`obs.status.${obs.status}`)}
          aria-label={t(`obs.status.${obs.status}`)}
          onClick={() => select('settings')}
        />
      </header>
      <main class="content">
        {tab === 'player' && <PlayerTab controller={controller} />}
        {tab === 'settings' && <SettingsTab controller={controller} />}
        {tab === 'diagnostics' && <DiagnosticsTab controller={controller} />}
      </main>
    </div>
  );
}
