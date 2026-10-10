// Укладка «Налады»: Spotify, Twitch, OBS, крыніца гуку, адрас оверлея, правілы заказаў.

import { useState } from 'preact/hooks';
import type { RequestRules } from '../../core/rules';
import { safeLocalStorage, SIMULATED_AUDIO } from '../../core/settings';
import { t, type MessageKey } from '../../i18n';
import { readLoginResult } from '../../providers/spotify/auth';
import type { SpotifyInfo } from '../../providers/spotify/sync';
import { isTwitchClientId, readLoginResult as readTwitchLoginResult } from '../../sources/twitch/auth';
import type { TwitchInfo } from '../../sources/twitch/twitch';
import { useStore } from '../shared/hooks';
import { clock } from '../shared/leader';
import { isClientId, type DockController } from './controller';
import { Section } from './Section';

export function SettingsTab({ controller }: { controller: DockController }) {
  const settings = useStore(controller.settings);
  const obs = useStore(controller.obs);
  const mode = useStore(controller.channel).mode;

  const connected = obs.status === 'connected' || obs.status === 'connecting' || obs.status === 'error';

  const setObs = (patch: Partial<typeof settings.obs>) =>
    controller.updateSettings((s) => ({ ...s, obs: { ...s.obs, ...patch } }));
  const setRules = (patch: Partial<RequestRules>) =>
    controller.updateSettings((s) => ({ ...s, rules: { ...s.rules, ...patch } }));

  const overlayUrl = new URL('overlay.html', location.href);
  if (mode === 'broadcast') {
    overlayUrl.hash = new URLSearchParams({ obs: settings.obs.url, pw: settings.obs.password }).toString();
  }

  return (
    <div class="settings">
      <SpotifySection controller={controller} />

      <TwitchSection controller={controller} />

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
            <button class="btn" onClick={controller.disconnectObs}>
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
        <CopyRow value={overlayUrl.toString()} />
      </Section>

      <Section title={t('settings.rules')} help={t('settings.rules.help')}>
        <NumberField label={t('settings.rules.price')} value={settings.rules.price} step={50} onChange={(price) => setRules({ price })} />
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
    </div>
  );
}

function AudioSection({ controller }: { controller: DockController }) {
  const settings = useStore(controller.settings);
  const meters = useStore(controller.meters);
  const obsStatus = useStore(controller.obs).status;
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

/**
 * Лікавае поле. Пакуль стрымер піша, тэкст трымаецца ў самім полі (`draft`): док часта перамалёўваецца
 * (узровень гуку ~20 разоў/с), і без гэтага поле вярталася б да старога значэння. Захоўваецца па Enter або пры выхадзе з поля.
 */
function NumberField({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    if (Number.isInteger(n) && n > 0 && n !== value) onChange(n);
    setDraft(null);
  };
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="number"
        // Аснова кроку — мінімум: з крокам 50 стрэлкі даюць 50, 100, 150…
        min={step > 1 ? step : 1}
        step={step}
        value={draft ?? String(value)}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        // Стрэлкі і кола мышы — адразу захаваць новае значэнне.
        onChange={(e) => {
          if (document.activeElement !== e.currentTarget) return;
          const n = Number(e.currentTarget.value);
          if (Number.isInteger(n) && n > 0) onChange(n);
        }}
      />
    </label>
  );
}

/** Падключэнне Spotify (ADR-016): Client ID, адрас вяртання, уваход, стан. */
function SpotifySection({ controller }: { controller: DockController }) {
  const clientId = useStore(controller.settings).spotify.clientId;
  const info = useStore(controller.spotify);
  const connected = info.status !== 'off';
  const login = connected ? null : readLoginResult(safeLocalStorage());

  return (
    <Section title={t('settings.spotify')} help={t('settings.spotify.help')}>
      {connected ? (
        <>
          <p class={`small ${info.status === 'ok' ? 'good' : info.status === 'connecting' ? '' : 'bad'}`}>{spotifyStatusText(info)}</p>
          {info.status === 'ok' && (
            <p class={`small ${info.problem ? 'bad' : 'muted'}`}>
              {info.problem
                ? t(`settings.spotify.problem.${info.problem}`)
                : info.device
                  ? t('settings.spotify.device', { device: info.device })
                  : t('settings.spotify.noDevice')}
            </p>
          )}
          <div class="row-actions">
            <button class="btn" onClick={controller.disconnectSpotify}>
              {t('settings.spotify.disconnect')}
            </button>
          </div>
        </>
      ) : (
        <>
          <label class="field">
            <span>{t('settings.spotify.clientId')}</span>
            <input
              value={clientId}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => {
                const value = e.currentTarget.value.trim();
                controller.updateSettings((s) => ({ ...s, spotify: { ...s.spotify, clientId: value } }));
              }}
            />
          </label>
          {clientId && !isClientId(clientId) && <p class="small bad">{t('settings.spotify.badClientId')}</p>}
          <div class="field">
            <span>{t('settings.spotify.redirect')}</span>
            <CopyRow value={controller.spotifyRedirectUri} />
          </div>
          <div class="row-actions">
            <button class="btn primary" disabled={!isClientId(clientId)} onClick={() => void controller.connectSpotify()}>
              {t('settings.spotify.connect')}
            </button>
          </div>
          {login && !login.ok && <p class="small bad">{loginErrorText(login.error ?? '')}</p>}
        </>
      )}
    </Section>
  );
}

function spotifyStatusText(info: SpotifyInfo): string {
  switch (info.status) {
    case 'connecting':
      return t('settings.spotify.connecting');
    case 'limited':
      return t('settings.spotify.limited', { time: clock(info.limitedUntil) });
    case 'error':
      return t(`settings.spotify.problem.${info.problem || 'other'}`);
    default:
      return info.user ? t('settings.spotify.connected', { user: info.user }) : t('settings.spotify.connectedNoName');
  }
}

const LOGIN_ERRORS = ['expired', 'access_denied', 'invalid_client', 'state'] as const;

function loginErrorText(code: string): string {
  return (LOGIN_ERRORS as readonly string[]).includes(code)
    ? t(`settings.spotify.error.${code}` as MessageKey)
    : t('settings.spotify.error.other', { code });
}

/** Падключэнне Twitch (ADR-018): Client ID, код для twitch.tv/activate, стан канала і ўзнагароды. */
function TwitchSection({ controller }: { controller: DockController }) {
  const clientId = useStore(controller.settings).twitch.clientId;
  const info = useStore(controller.twitch);
  const login = useStore(controller.twitchLogin);
  const connected = info.status !== 'off';
  const result = connected || login.phase !== 'idle' ? null : readTwitchLoginResult(safeLocalStorage());

  if (connected) {
    return (
      <Section title={t('settings.twitch')} help={t('settings.twitch.help')}>
        <p class={`small ${info.status === 'ok' ? 'good' : info.status === 'connecting' ? '' : 'bad'}`}>{twitchStatusText(info)}</p>
        {info.status === 'ok' && <p class={`small ${info.reward?.paused === false ? '' : 'muted'}`}>{rewardText(info)}</p>}
        <div class="row-actions">
          <button class="btn" onClick={controller.disconnectTwitch}>
            {t('settings.twitch.disconnect')}
          </button>
        </div>
      </Section>
    );
  }

  return (
    <Section title={t('settings.twitch')} help={t('settings.twitch.help')}>
      {login.phase === 'idle' ? (
        <>
          <label class="field">
            <span>{t('settings.twitch.clientId')}</span>
            <input
              value={clientId}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => {
                const value = e.currentTarget.value.trim();
                controller.updateSettings((s) => ({ ...s, twitch: { ...s.twitch, clientId: value } }));
              }}
            />
          </label>
          {clientId && !isTwitchClientId(clientId) && <p class="small bad">{t('settings.twitch.badClientId')}</p>}
          <div class="row-actions">
            <button class="btn primary" disabled={!isTwitchClientId(clientId)} onClick={controller.connectTwitch}>
              {t('settings.twitch.connect')}
            </button>
          </div>
          {result && !result.ok && <p class="small bad">{twitchLoginErrorText(result.error ?? '')}</p>}
        </>
      ) : login.phase === 'starting' ? (
        <p class="small muted">{t('settings.twitch.starting')}</p>
      ) : (
        <>
          <div class="field">
            <span>{t('settings.twitch.code')}</span>
            <div class="device-code">{login.code.userCode}</div>
          </div>
          <div class="row-actions">
            <button class="btn primary" onClick={() => controller.openTwitchActivate(login.code)}>
              {t('settings.twitch.open')}
            </button>
            <button class="btn" onClick={controller.cancelTwitchLogin}>
              {t('settings.twitch.cancel')}
            </button>
          </div>
          <p class="small muted">{t('settings.twitch.waiting')}</p>
        </>
      )}
    </Section>
  );
}

function twitchStatusText(info: TwitchInfo): string {
  if (info.status === 'connecting') return t('settings.twitch.connecting');
  if (info.status === 'error') return t(`settings.twitch.problem.${info.problem || 'other'}`);
  return info.login ? t('settings.twitch.connected', { login: info.login }) : t('settings.twitch.connectedNoName');
}

function rewardText(info: TwitchInfo): string {
  if (!info.reward) return t('settings.twitch.reward.none');
  return info.reward.paused ? t('settings.twitch.reward.paused') : t('settings.twitch.reward.active', { cost: info.reward.cost });
}

function twitchLoginErrorText(code: string): string {
  if (code === 'expired') return t('settings.twitch.error.expired');
  if (code === 'expired-code' || code.includes('device code')) return t('settings.twitch.error.expired-code');
  if (code.includes('client')) return t('settings.twitch.error.invalid-client');
  if (code.includes('denied') || code.includes('declined')) return t('settings.twitch.error.denied');
  if (code === 'network') return t('settings.twitch.error.network');
  return t('settings.twitch.error.other', { code });
}

/** Поле толькі для чытання з кнопкай «Капіяваць». */
function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Калі буфер абмену недаступны, адрас можна выдзеліць у полі і скапіяваць Ctrl+C.
    }
  };
  return (
    <div class="copy-row">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
      <button class="btn" onClick={copy}>
        {copied ? t('settings.overlay.copied') : t('settings.overlay.copy')}
      </button>
    </div>
  );
}
