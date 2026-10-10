// Укладка «Налады»: OBS, крыніца гуку, адрас оверлея, правілы заказаў, падключэнні.

import { useState } from 'preact/hooks';
import type { RequestRules } from '../../core/rules';
import { SIMULATED_AUDIO } from '../../core/settings';
import { t } from '../../i18n';
import { useStore } from '../shared/hooks';
import type { DockController } from './controller';
import { Section } from './Section';

export function SettingsTab({ controller }: { controller: DockController }) {
  const settings = useStore(controller.settings);
  const obs = useStore(controller.obsStatus);
  const mode = useStore(controller.channelMode);
  const [copied, setCopied] = useState(false);

  const connected = obs.status === 'connected' || obs.status === 'connecting' || obs.status === 'error';

  const setObs = (patch: Partial<typeof settings.obs>) =>
    controller.updateSettings((s) => ({ ...s, obs: { ...s.obs, ...patch } }));
  const setRules = (patch: Partial<RequestRules>) =>
    controller.updateSettings((s) => ({ ...s, rules: { ...s.rules, ...patch } }));

  const overlayUrl = new URL('overlay.html', location.href);
  if (mode === 'broadcast') {
    overlayUrl.hash = new URLSearchParams({ obs: settings.obs.url, pw: settings.obs.password }).toString();
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Калі буфер абмену недаступны, адрас можна выдзеліць у полі і скапіяваць Ctrl+C.
    }
  };

  return (
    <div class="settings">
      <Section title={t('settings.obs')} help={t('settings.obs.help')}>
        <label class="field">
          <span>{t('settings.obs.url')}</span>
          <input value={settings.obs.url} onChange={(e) => setObs({ url: e.currentTarget.value.trim() })} spellcheck={false} />
        </label>
        <label class="field">
          <span>{t('settings.obs.password')}</span>
          <input
            type="password"
            value={settings.obs.password}
            autocomplete="off"
            onChange={(e) => setObs({ password: e.currentTarget.value })}
          />
        </label>
        <div class="row-actions">
          {connected ? (
            <button
              class="btn"
              onClick={() => {
                controller.disconnectObs();
                setObs({ autoConnect: false });
              }}
            >
              {t('settings.obs.disconnect')}
            </button>
          ) : (
            <button class="btn primary" onClick={controller.connectObs}>
              {t('settings.obs.connect')}
            </button>
          )}
          <span class={`status ${obs.status}`}>{t(`obs.status.${obs.status}`)}</span>
        </div>
      </Section>

      <AudioSection controller={controller} />

      <Section title={t('settings.overlay')} help={t('settings.overlay.help')}>
        <div class="copy-row">
          <input readOnly value={overlayUrl.toString()} onFocus={(e) => e.currentTarget.select()} />
          <button class="btn" onClick={() => copy(overlayUrl.toString())}>
            {copied ? t('settings.overlay.copied') : t('settings.overlay.copy')}
          </button>
        </div>
      </Section>

      <Section title={t('settings.rules')} help={t('settings.rules.help')}>
        <NumberField label={t('settings.rules.price')} value={settings.rules.price} onChange={(price) => setRules({ price })} />
        <NumberField
          label={t('settings.rules.maxDuration')}
          value={settings.rules.maxDurationMin}
          onChange={(maxDurationMin) => setRules({ maxDurationMin })}
        />
        <NumberField
          label={t('settings.rules.maxPerUser')}
          value={settings.rules.maxPerUser}
          onChange={(maxPerUser) => setRules({ maxPerUser })}
        />
        <label class="check">
          <input
            type="checkbox"
            checked={settings.rules.allowExplicit}
            onChange={(e) => setRules({ allowExplicit: e.currentTarget.checked })}
          />
          <span>{t('settings.rules.allowExplicit')}</span>
        </label>
      </Section>

      <Section title={t('settings.accounts')} help={t('settings.accounts.help')}>
        <div class="row-actions">
          <button class="btn" disabled>
            {t('settings.accounts.spotify')}
          </button>
          <button class="btn" disabled>
            {t('settings.accounts.twitch')}
          </button>
        </div>
      </Section>
    </div>
  );
}

function AudioSection({ controller }: { controller: DockController }) {
  const settings = useStore(controller.settings);
  const meters = useStore(controller.meters);
  const obsStatus = useStore(controller.obsStatus).status;
  const names = Object.keys(meters);
  const selected = settings.audioSource;
  // Выбраная крыніца застаецца ў спісе, нават калі OBS пра яе зараз не паведамляе.
  if (selected && selected !== SIMULATED_AUDIO && !names.includes(selected)) names.unshift(selected);

  return (
    <Section title={t('settings.audio')} help={t('settings.audio.help')}>
      <label class="field">
        <span>{t('settings.audio.source')}</span>
        <select
          value={selected}
          onChange={(e) => controller.updateSettings((s) => ({ ...s, audioSource: e.currentTarget.value }))}
        >
          <option value="">{t('settings.audio.none')}</option>
          <option value={SIMULATED_AUDIO}>{t('settings.audio.simulated')}</option>
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {names.length > 0 ? (
        <ul class="meters">
          {names.map((name) => (
            <li key={name} class={name === selected ? 'selected' : ''}>
              <span class="meter-name">{name}</span>
              <span class="meter">
                <span class="meter-fill" style={{ width: `${(meters[name] ?? 0) * 100}%` }} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">
          {obsStatus === 'connected' ? t('settings.audio.waiting') : t('settings.audio.connectFirst')}
        </p>
      )}
    </Section>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="number"
        min={1}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isInteger(n) && n > 0) onChange(n);
          else e.currentTarget.value = String(value);
        }}
      />
    </label>
  );
}
