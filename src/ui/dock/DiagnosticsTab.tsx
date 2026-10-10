// Укладка «Праверка»: рызыкі ADR-009 (схаваны док, перанакіраванне) і стан канала да оверлея.

import { safeLocalStorage } from '../../core/settings';
import { formatDuration, t } from '../../i18n';
import { obsBrowserInfo, readJson, REDIRECT_RESULT_KEY, type RedirectResult } from '../shared/diag';
import { useNow, useStore } from '../shared/hooks';
import type { DockController } from './controller';
import { Section } from './Section';

const clock = (ms: number) => new Date(ms).toLocaleTimeString('be-BY');

export function DiagnosticsTab({ controller }: { controller: DockController }) {
  useNow(1000);
  const monitor = useStore(controller.monitor.state);
  const mode = useStore(controller.channelMode);
  const obs = useStore(controller.obsStatus);
  const env = obsBrowserInfo();
  const redirect = readJson<RedirectResult>(safeLocalStorage(), REDIRECT_RESULT_KEY);
  const stats = controller.sender.stats;

  return (
    <div class="diagnostics">
      <Section title={t('diag.env')} help={t('diag.env.help')}>
        <p class="small">{env.inObs ? `${t('diag.env.obs')} ${env.version}` : t('diag.env.notObs')}</p>
        <p class="small">
          {t('diag.channel')}: <b>{t(`settings.obs.channel.${mode}`)}</b> · {t('diag.channel.stats', { sent: stats.sent, errors: stats.errors })}
        </p>
        {obs.version && <p class="small">{t('diag.obsVersion', { version: obs.version })}</p>}
        {stats.lastError && <p class="muted small mono">{stats.lastError}</p>}
      </Section>

      <Section title={t('diag.hidden')} help={t('diag.hidden.help')}>
        <p class="small">
          {t('diag.hidden.visibility')}: <b>{monitor.visible ? t('diag.hidden.visible') : t('diag.hidden.hiddenNow')}</b>
        </p>
        <p class="small">
          {monitor.previousAliveAt
            ? t('diag.hidden.session', { loaded: clock(monitor.loadedAt), prev: clock(monitor.previousAliveAt) })
            : t('diag.hidden.firstLoad', { loaded: clock(monitor.loadedAt) })}
        </p>
        <p class="small">
          {t('diag.hidden.overall', {
            main: formatDuration(monitor.mainMaxGapMs),
            worker: formatDuration(monitor.workerMaxGapMs),
          })}
        </p>
        {monitor.periods.length === 0 ? (
          <p class="muted small">{t('diag.hidden.none')}</p>
        ) : (
          <ul class="periods">
            {monitor.periods.map((p) => (
              <li key={p.start}>
                <b>
                  {clock(p.start)} · {t('diag.hidden.period', { duration: formatDuration(p.end - p.start) })}
                </b>
                <div>{t('diag.hidden.mainGap', { gap: formatDuration(p.mainMaxGapMs) })}</div>
                <div>{t('diag.hidden.workerGap', { gap: formatDuration(p.workerMaxGapMs) })}</div>
                <div>{t('diag.hidden.obsEvents', { n: p.obsEvents })}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('diag.redirect')} help={t('diag.redirect.help')}>
        <button class="btn primary" onClick={controller.runRedirectTest}>
          {t('diag.redirect.run')}
        </button>
        <p class={`small ${redirect ? (redirect.ok ? 'good' : 'bad') : 'muted'}`}>
          {!redirect
            ? t('diag.redirect.never')
            : redirect.ok
              ? t('diag.redirect.ok', { host: redirect.via, at: clock(redirect.at) })
              : t('diag.redirect.lost', { at: clock(redirect.at) })}
        </p>
      </Section>

      <Section title={t('diag.popup')} help={t('diag.popup.help')}>
        <button class="btn" onClick={controller.runPopupTest}>
          {t('diag.popup.run')}
        </button>
      </Section>
    </div>
  );
}
