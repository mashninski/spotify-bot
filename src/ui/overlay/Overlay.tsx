// Оверлей для OBS Browser Source: малюе тое, што прысылае бот (ён можа працаваць і ў гэтай жа старонцы, ADR-015).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { BrainNode } from '../../brain/node';
import { safeLocalStorage } from '../../core/settings';
import type { OverlayState, OverlayTrack } from '../../core/types';
import { formatDuration, t } from '../../i18n';
import { simulatedLevel } from '../../obs/audio';
import { listenForBrain, type ReceiveChannel } from '../../obs/channel';
import { DIAG_MARKER_KEY, obsBrowserInfo, readJson } from '../shared/diag';
import { useNow, useStore } from '../shared/hooks';
import { leaderText } from '../shared/leader';
import { SpotifyLogo, UserIcon } from '../shared/icons';
import { Waveline } from './Waveline';

export interface OverlayOptions {
  debug: boolean;
  /** Паказаць тэставыя даныя без бота (для размяшчэння ў сцэне і праверкі выгляду). */
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

export function Overlay({ options, node }: { options: OverlayOptions; node: BrainNode | null }) {
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
    return listenForBrain(
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
            <TrackMeta current={current} />
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
      {options.debug && <DebugPanel info={debug} hasState={Boolean(state)} node={node} />}
    </div>
  );
}

function DebugPanel({ info, hasState, node }: { info: DebugInfo; hasState: boolean; node: BrainNode | null }) {
  const now = useNow(1000);
  const marker = readJson<number>(safeLocalStorage(), DIAG_MARKER_KEY);
  const env = obsBrowserInfo();
  return (
    <div class="debug">
      <div>{env.inObs ? `${t('diag.env.obs')} ${env.version}` : t('diag.env.notObs')}</div>
      {node && <BrainInfo node={node} />}
      {!hasState && <div>{t('overlay.debug.waiting')}</div>}
      {info.channel && <div>{t('overlay.debug.channel', { channel: info.channel })}</div>}
      {info.lastMessageAt > 0 && <div>{t('overlay.debug.age', { age: formatDuration(now - info.lastMessageAt) })}</div>}
      {info.lastPingAt > 0 && <div>{t('overlay.debug.ping', { age: formatDuration(now - info.lastPingAt) })}</div>}
      <div>{marker ? t('overlay.debug.storage.seen') : t('overlay.debug.storage.notSeen')}</div>
      {info.obsStatus && <div>{t('overlay.debug.obs', { status: info.obsStatus })}</div>}
    </div>
  );
}


function BrainInfo({ node }: { node: BrainNode }) {
  const leader = useStore(node.leader);
  const conflicts = useStore(node.conflicts);
  return (
    <>
      <div>
        {leaderText(leader, node.id, 'overlay')} · {node.locksSupported ? t('overlay.debug.locks.yes') : t('overlay.debug.locks.no')}
      </div>
      {conflicts > 0 && <div>{t('overlay.debug.conflicts', { n: conflicts })}</div>}
    </>
  );
}

/** Колькі старая песня плаўна знікае (тое ж, што `track-out` у overlay.css). */
const LEAVE_MS = 450;

/**
 * Назва і выканаўца. Пры змене песні старая плаўна сыходзіць уверх, а новая ўзнікае знізу —
 * абедзве некаторы час на экране адна над адной, без рэзкага пераскоку.
 */
function TrackMeta({ current }: { current: OverlayTrack }) {
  const previous = useRef<OverlayTrack>(current);
  const [leaving, setLeaving] = useState<OverlayTrack | null>(null);

  useEffect(() => {
    const old = previous.current;
    previous.current = current;
    if (old.key === current.key) return;
    setLeaving(old);
    const id = setTimeout(() => setLeaving(null), LEAVE_MS);
    return () => clearTimeout(id);
  }, [current.key]);

  return (
    <div class="meta-box">
      {leaving && <MetaLines track={leaving} class="meta leaving" key={`out-${leaving.key}`} />}
      <MetaLines track={current} class="meta" key={current.key} />
    </div>
  );
}

function MetaLines({ track, class: className }: { track: OverlayTrack; class: string }) {
  return (
    <div class={className}>
      <div class="title">{track.title}</div>
      <div class="artist">
        {track.artist}
        {track.requestedBy && (
          <span class="by">
            <UserIcon /> {track.requestedBy}
          </span>
        )}
      </div>
    </div>
  );
}
