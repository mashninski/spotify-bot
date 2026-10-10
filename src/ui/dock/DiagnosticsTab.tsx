// Укладка «Праверка»: стан бота, Spotify, Twitch і OBS — коратка, радкамі «назва — значэнне».

import type { ComponentChildren } from 'preact';
import { t, type MessageKey } from '../../i18n';
import { obsBrowserInfo } from '../shared/diag';
import { useNow, useStore } from '../shared/hooks';
import { clock } from '../shared/leader';
import type { DockController } from './controller';
import { Section } from './Section';

type Tone = '' | 'good' | 'bad' | 'muted';

function Row({ label, tone = '', children }: { label: string; tone?: Tone; children: ComponentChildren }) {
  return (
    <div class="kv">
      <span class="kv-label">{label}</span>
      <span class={`kv-value ${tone}`}>{children}</span>
    </div>
  );
}

export function DiagnosticsTab({ controller }: { controller: DockController }) {
  useNow(1000);
  const channel = useStore(controller.channel);
  const obs = useStore(controller.obs);
  const leader = useStore(controller.leader);
  const conflicts = useStore(controller.conflicts);
  const spotify = useStore(controller.spotify);
  const twitch = useStore(controller.twitch);
  const env = obsBrowserInfo();

  const where = !leader ? 'none' : leader.id === controller.id ? `here.${leader.page}` : leader.page;
  const windowTone: Tone = spotify.windowWatch === 'ok' ? 'good' : 'muted';
  const eventsTone: Tone = twitch.events === 'ok' ? 'good' : twitch.events === 'off' ? 'bad' : 'muted';

  return (
    <div class="diagnostics">
      <Section title={t('diag.brain')} help={t('diag.brain.help')}>
        <Row label={t('diag.brain.where')} tone={where === 'none' ? 'bad' : ''}>
          {t(`diag.brain.where.${where}` as MessageKey)}
        </Row>
        {leader && <Row label={t('diag.brain.since')}>{clock(leader.since)}</Row>}
        {!controller.locksSupported && (
          <Row label={t('diag.brain.choice')} tone="bad">
            {t('diag.brain.dockOnly')}
          </Row>
        )}
        {conflicts > 0 && (
          <Row label={t('diag.brain.conflicts')} tone="bad">
            {conflicts}
          </Row>
        )}
      </Section>

      {spotify.status !== 'off' && (
        <Section title={t('diag.spotify')} help={t('diag.spotify.help')}>
          <Row label={t('diag.spotify.requests')}>{spotify.requestsToday}</Row>
          <Row label={t('diag.spotify.window')} tone={windowTone}>
            {t(`diag.spotify.window.${spotify.windowWatch}`)}
          </Row>
        </Section>
      )}

      {twitch.status !== 'off' && (
        <Section title={t('diag.twitch')} help={t('diag.twitch.help')}>
          <Row label={t('diag.twitch.events')} tone={eventsTone}>
            {t(`diag.twitch.events.${twitch.events}`)}
          </Row>
          <Row label={t('diag.twitch.lastEvent')} tone={twitch.lastEventAt ? '' : 'muted'}>
            {twitch.lastEventAt ? clock(twitch.lastEventAt) : t('diag.none')}
          </Row>
          <Row label={t('diag.twitch.pending')} tone={twitch.pending ? 'bad' : ''}>
            {twitch.pending}
          </Row>
        </Section>
      )}

      <Section title={t('diag.obs')} help={t('diag.obs.help')}>
        <Row label={t('diag.obs.page')}>{env.inObs ? env.version : t('diag.obs.notObs')}</Row>
        <Row label="obs-websocket" tone={obs.version ? '' : 'muted'}>
          {obs.version || t('diag.none')}
        </Row>
        <Row label={t('diag.obs.channel')} tone={channel.mode === 'none' ? 'muted' : ''}>
          {t(`diag.obs.channel.${channel.mode}`)}
        </Row>
        <Row label={t('diag.obs.sent')}>{channel.sent}</Row>
        <Row label={t('diag.obs.errors')} tone={channel.errors ? 'bad' : ''}>
          {channel.errors}
        </Row>
        {channel.lastError && <p class="muted small mono">{channel.lastError}</p>}
      </Section>
    </div>
  );
}
