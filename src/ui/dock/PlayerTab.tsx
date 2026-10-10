// Укладка «Плэер»: што грае, кіраванне, чарга заказаў.

import { useEffect } from 'preact/hooks';
import type { QueueItem } from '../../core/types';
import { formatClock, t } from '../../i18n';
import { useStore } from '../shared/hooks';
import { CloseIcon, NextIcon, PauseIcon, PlayIcon, PreviousIcon, UserIcon } from '../shared/icons';
import type { DockController } from './controller';

export function PlayerTab({ controller }: { controller: DockController }) {
  const state = useStore(controller.player);
  const notice = useStore(controller.notice);
  const current = state.current;

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => controller.notice.set(null), 5000);
    return () => clearTimeout(id);
  }, [notice, controller]);

  const progress = current ? Math.min(1, state.progressMs / current.track.durationMs) : 0;

  return (
    <div class="player">
      <p class="hint">{t('player.testMode')}</p>

      <section class="now">
        {current ? (
          <>
            <div class="now-title">{current.track.title}</div>
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
        ) : (
          <div class="now-title muted">{t('player.nothing')}</div>
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
      </section>

      {notice && <div class={`notice ${notice.kind}`}>{notice.text}</div>}

      <section>
        <div class="section-head">
          <h2>{t('player.requests')}</h2>
          <button class="text-btn" onClick={controller.addTestRequest}>
            {t('player.addTestRequest')}
          </button>
        </div>
        {state.requests.length === 0 ? (
          <p class="muted small">{t('player.requests.empty')}</p>
        ) : (
          <ol class="queue">
            {state.requests.map((item, i) => (
              <QueueRow key={item.key} item={item} index={i + 1} controller={controller} />
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2>{t('player.context')}</h2>
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
        <p class="muted small">{t('player.context.hint')}</p>
      </section>
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
