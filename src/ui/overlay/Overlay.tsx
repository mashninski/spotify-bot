// Оверлей для OBS Browser Source: толькі малюе тое, што прысылае док.

import { useEffect, useRef, useState } from 'preact/hooks';
import { safeLocalStorage } from '../../core/settings';
import type { OverlayState } from '../../core/types';
import { formatDuration, t } from '../../i18n';
import { simulatedLevel } from '../../obs/audio';
import { listenForDock, type ReceiveChannel } from '../../obs/channel';
import { DIAG_MARKER_KEY, obsBrowserInfo, readJson } from '../shared/diag';
import { useNow } from '../shared/hooks';
import { SpotifyLogo, UserIcon } from '../shared/icons';
import { Waveline } from './Waveline';

export interface OverlayOptions {
  debug: boolean;
  /** Паказаць тэставыя даныя без дока (для размяшчэння ў сцэне і праверкі выгляду). */
  demo: boolean;
  /** Запасны шлях: падключэнне да OBS самім оверлеем (пароль з #hash адраса). */
  obs?: { url: string; password: string };
}

const DEMO_STATE: OverlayState = {
  current: { key: 'demo-1', title: 'Начны горад', artist: 'Ліпень' },
  isPlaying: true,
  upcoming: [
    { key: 'demo-2', title: 'Песня для чата', artist: 'Зубр і Сябры', requestedBy: 'zubr_gamer' },
    { key: 'demo-3', title: 'Кава а трэцяй ночы', artist: 'Сонны Кот', requestedBy: 'kasia_bel' },
    { key: 'demo-4', title: 'Дождж па шыбах', artist: 'Сіні Туман' },
  ],
};

interface DebugInfo {
  channel: ReceiveChannel | '';
  lastMessageAt: number;
  lastPingAt: number;
  obsStatus: string;
}

export function Overlay({ options }: { options: OverlayOptions }) {
  const [state, setState] = useState<OverlayState | null>(options.demo ? DEMO_STATE : null);
  const levelRef = useRef(0);
  const [debug, setDebug] = useState<DebugInfo>({ channel: '', lastMessageAt: 0, lastPingAt: 0, obsStatus: '' });

  useEffect(() => {
    if (options.demo) {
      let frame = 0;
      const loop = () => {
        levelRef.current = simulatedLevel(Date.now());
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(frame);
    }
    return listenForDock(
      (env, channel) => {
        const msg = env.msg;
        if (msg.type === 'state') setState(msg.state);
        else if (msg.type === 'level') levelRef.current = msg.level;
        if (options.debug && msg.type !== 'level') {
          setDebug((d) => ({
            ...d,
            channel,
            lastMessageAt: Date.now(),
            lastPingAt: msg.type === 'ping' ? Date.now() : d.lastPingAt,
          }));
        }
      },
      {
        obs: options.obs,
        onObsStatus: (obsStatus) => setDebug((d) => ({ ...d, obsStatus })),
      },
    );
  }, [options]);

  const current = state?.current;

  return (
    <div class="overlay">
      {current && state && (
        <>
          <div class={`strip${state.isPlaying ? '' : ' paused'}`}>
            <div class="logo">
              <SpotifyLogo size={30} />
            </div>
            <div class="meta" key={current.key}>
              <div class="title">{current.title}</div>
              <div class="artist">
                {current.artist}
                {current.requestedBy && (
                  <span class="by">
                    <UserIcon /> {current.requestedBy}
                  </span>
                )}
              </div>
            </div>
            <Waveline levelRef={levelRef} playing={state.isPlaying} width={112} height={36} />
          </div>
          {state.upcoming.length > 0 && (
            <ol class="upcoming">
              {state.upcoming.map((item) => (
                <li key={item.key}>
                  <span class="up-title">{item.title}</span>
                  <span class="up-artist"> · {item.artist}</span>
                  {item.requestedBy && (
                    <span class="by">
                      <UserIcon /> {item.requestedBy}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {options.debug && <DebugPanel info={debug} hasState={Boolean(state)} />}
    </div>
  );
}

function DebugPanel({ info, hasState }: { info: DebugInfo; hasState: boolean }) {
  const now = useNow(1000);
  const marker = readJson<number>(safeLocalStorage(), DIAG_MARKER_KEY);
  const env = obsBrowserInfo();
  return (
    <div class="debug">
      <div>{env.inObs ? `${t('diag.env.obs')} ${env.version}` : t('diag.env.notObs')}</div>
      {!hasState && <div>{t('overlay.debug.waiting')}</div>}
      {info.channel && <div>{t('overlay.debug.channel', { channel: info.channel })}</div>}
      {info.lastMessageAt > 0 && <div>{t('overlay.debug.age', { age: formatDuration(now - info.lastMessageAt) })}</div>}
      {info.lastPingAt > 0 && <div>{t('overlay.debug.ping', { age: formatDuration(now - info.lastPingAt) })}</div>}
      <div>{marker ? t('overlay.debug.storage.seen') : t('overlay.debug.storage.notSeen')}</div>
      {info.obsStatus && <div>{t('overlay.debug.obs', { status: info.obsStatus })}</div>}
    </div>
  );
}

