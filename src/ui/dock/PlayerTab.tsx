// Укладка «Плэер»: што грае ў Spotify, кіраванне, «+» у «Любімыя трэкі», чарга заказаў.

import { useEffect } from 'preact/hooks';
import type { QueueItem } from '../../core/types';
import { formatClock, t } from '../../i18n';
import { canSave } from '../../providers/spotify/map';
import { useStore } from '../shared/hooks';
import { CheckCircleIcon, CloseIcon, NextIcon, PauseIcon, PlayIcon, PlusCircleIcon, PreviousIcon, UserIcon } from '../shared/icons';
import type { DockController } from './controller';
import { Section } from './Section';

export function PlayerTab({ controller }: { controller: DockController }) {
  const state = useStore(controller.player);
  const notice = useStore(controller.notice);
  const spotify = useStore(controller.spotify);
  const spotifyOn = spotify.status !== 'off';
  const current = state.current;

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => controller.notice.set(null), 5000);
    return () => clearTimeout(id);
  }, [notice, controller]);

  const progress = current ? Math.min(1, state.progressMs / current.track.durationMs) : 0;

  return (
    <div class="player">
      <Section title={t('player.now')} help={t('player.now.help')}>
        {current ? (
          <>
            <div class="now-head">
              <div class="now-title">{current.track.title}</div>
              {spotifyOn && canSave(current.track) && <LikeButton controller={controller} uri={current.track.uri!} />}
            </div>
            <div class="now-artist">
              {current.track.artist}
              {current.requestedBy && (
                <span class="by">
                  <UserIcon /> {current.requestedBy}
                </span>
              )}
            </div>
            <div class="progress" aria-hidden="true">
              <div class="progress-fill" style={{ width: `${progress * 100}%` }} />
            </div>
            <div class="times">
              <span>{formatClock(state.progressMs)}</span>
              <span>{formatClock(current.track.durationMs)}</span>
            </div>
          </>
        ) : !spotifyOn ? (
          <div class="now-title muted">
            {t('player.spotifyOff')}{' '}
            <button class="text-btn" onClick={() => (location.hash = 'settings')}>
              {t('player.spotifyConnect')}
            </button>
          </div>
        ) : (
          <div class="now-title muted">{spotify.status === 'ok' && !spotify.device ? t('player.spotifyIdle') : t('player.nothing')}</div>
        )}
        <div class="controls">
          <button class="icon-btn" title={t('player.previous')} aria-label={t('player.previous')} onClick={controller.previous}>
            <PreviousIcon />
          </button>
          <button
            class="icon-btn primary"
            title={state.isPlaying ? t('player.pause') : t('player.play')}
            aria-label={state.isPlaying ? t('player.pause') : t('player.play')}
            onClick={controller.togglePlay}
            disabled={!current}
          >
            {state.isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
          </button>
          <button class="icon-btn" title={t('player.next')} aria-label={t('player.next')} onClick={controller.next}>
            <NextIcon />
          </button>
        </div>
      </Section>

      {notice && <div class={`notice ${notice.kind}`}>{notice.text}</div>}

      <Section
        title={t('player.requests')}
        help={t('player.requests.help')}
        actions={
          // Выдуманыя трэкі нельга адправіць у Spotify, таму тэставы заказ — толькі без Spotify (ADR-016).
          !spotifyOn && (
            <button class="text-btn" onClick={controller.addTestRequest}>
              {t('player.addTestRequest')}
            </button>
          )
        }
      >
        {state.requests.length === 0 ? (
          <p class="muted small">{t('player.requests.empty')}</p>
        ) : (
          <ol class="queue">
            {state.requests.map((item, i) => (
              <QueueRow key={item.key} item={item} index={i + 1} controller={controller} />
            ))}
          </ol>
        )}
      </Section>

      <Section title={t('player.context')} help={t('player.context.help')}>
        {state.context.length === 0 && <p class="muted small">{t('player.context.empty')}</p>}
        <ol class="queue context">
          {state.context.slice(0, 5).map((item) => (
            <li key={item.key} class="row">
              <div class="row-text">
                <div class="row-title">{item.track.title}</div>
                <div class="row-artist">{item.track.artist}</div>
              </div>
              <span class="row-time">{formatClock(item.track.durationMs)}</span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function QueueRow({ item, index, controller }: { item: QueueItem; index: number; controller: DockController }) {
  return (
    <li class="row">
      <span class="row-index">{index}</span>
      <div class="row-text">
        <div class="row-title">{item.track.title}</div>
        <div class="row-artist">
          {item.track.artist}
          {item.requestedBy && (
            <span class="by">
              <UserIcon /> {item.requestedBy}
            </span>
          )}
        </div>
      </div>
      <span class="row-time">{formatClock(item.track.durationMs)}</span>
      <button class="icon-btn small" title={t('player.playNow')} aria-label={t('player.playNow')} onClick={() => controller.playNow(item.key)}>
        <PlayIcon size={16} />
      </button>
      <button
        class="icon-btn small danger"
        title={t('player.remove')}
        aria-label={t('player.remove')}
        onClick={() => controller.removeRequest(item.key)}
      >
        <CloseIcon size={14} />
      </button>
    </li>
  );
}

/** «+»: дадаць бягучую песню ў «Любімыя трэкі» Spotify; калі ўжо там — зялёная галачка. */
function LikeButton({ controller, uri }: { controller: DockController; uri: string }) {
  const liked = useStore(controller.spotify).liked;
  const state = liked?.uri === uri ? liked : null;
  if (state?.saved) {
    return (
      <span class="like saved" title={t('player.saved')} aria-label={t('player.saved')}>
        <CheckCircleIcon />
      </span>
    );
  }
  return (
    <button
      class="icon-btn like"
      title={t('player.save')}
      aria-label={t('player.save')}
      disabled={state?.busy}
      onClick={controller.saveCurrent}
    >
      <PlusCircleIcon />
    </button>
  );
}
