// Оверлей для OBS Browser Source: малюе тое, што прысылае бот (ён можа працаваць і ў гэтай жа старонцы, ADR-015).
// Падчас відэа YouTube (ADR-020) над палоскай з’яўляецца плашка з відэа, а ўвесь оверлэй становіцца чырвоным.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BrainNode } from '../../brain/node';
import { emptyPlayerState } from '../../core/queue';
import { defaultSettings, safeLocalStorage } from '../../core/settings';
import { createStore, type Store } from '../../core/store';
import type { OverlayState, OverlayTrack, PlayerState } from '../../core/types';
import { currentVideo } from '../../core/video';
import { formatDuration, t } from '../../i18n';
import { simulatedLevel } from '../../obs/audio';
import { listenForBrain, type ReceiveChannel } from '../../obs/channel';
import { DIAG_MARKER_KEY, obsBrowserInfo, readJson } from '../shared/diag';
import { useNow, useStore } from '../shared/hooks';
import { leaderText } from '../shared/leader';
import { SourceIcon, SpotifyLogo, UserIcon, YouTubeLogo } from '../shared/icons';
import { createVideoPlayer, type VideoTarget } from './video-player';
import { Waveline } from './Waveline';

export interface OverlayOptions {
  debug: boolean;
  /** Паказаць тэставыя даныя без бота (для размяшчэння ў сцэне і праверкі выгляду): песня або відэа. */
  demo: 'song' | 'video' | null;
  /** Відэа для `?demo=video` (па змаўчанні — Rick Astley). */
  demoVideoId?: string;
  /** Запасны шлях: падключэнне да OBS самім оверлеем (пароль з #hash адраса). */
  obs?: { url: string; password: string };
}

const DEMO_UPCOMING: OverlayTrack[] = [
  { key: 'demo-2', title: 'Песня для чата', artist: 'Зубр і Сябры', requestedBy: 'zubr_gamer' },
  { key: 'demo-3', title: 'Never Gonna Give You Up', artist: 'Rick Astley', requestedBy: 'kasia_bel', source: 'youtube' },
  { key: 'demo-4', title: 'Кава а трэцяй ночы', artist: 'Сонны Кот', requestedBy: 'ales_m' },
  { key: 'demo-5', title: 'Дождж па шыбах', artist: 'Сіні Туман' },
  { key: 'demo-6', title: 'Белыя ночы', artist: 'Ліпень' },
];

const DEMO_STATE: OverlayState = {
  current: { key: 'demo-1', title: 'Начны горад', artist: 'Ліпень' },
  isPlaying: true,
  upcoming: DEMO_UPCOMING,
};

/** Тэставае відэа для размяшчэння оверлэя ў сцэне: грае без гуку. */
const DEMO_VIDEO_ID = 'dQw4w9WgXcQ';
const DEMO_VIDEO_STATE: OverlayState = {
  current: { key: 'demo-video', title: 'Rick Astley - Never Gonna Give You Up', artist: 'Rick Astley', requestedBy: 'kasia_bel', source: 'youtube' },
  isPlaying: true,
  upcoming: DEMO_UPCOMING.filter((u) => u.key !== 'demo-3'),
};

interface DebugInfo {
  channel: ReceiveChannel | '';
  lastMessageAt: number;
  lastPingAt: number;
  obsStatus: string;
}

export function Overlay({ options, node, videoOwner }: { options: OverlayOptions; node: BrainNode | null; videoOwner: Store<boolean> }) {
  const demoState = options.demo === 'video' ? DEMO_VIDEO_STATE : options.demo === 'song' ? DEMO_STATE : null;
  const [state, setState] = useState<OverlayState | null>(demoState);
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
  const isVideo = current?.source === 'youtube';

  return (
    <div class={`overlay${isVideo ? ' yt' : ''}`}>
      <VideoCard node={node} demo={options.demo === 'video'} demoVideoId={options.demoVideoId ?? DEMO_VIDEO_ID} owner={videoOwner} />
      {current && state && (
        <>
          <div class={`strip${state.isPlaying ? '' : ' paused'}`}>
            <div class="logos" aria-hidden="true">
              <span class="logo logo-spotify">
                <SpotifyLogo size={30} />
              </span>
              <span class="logo logo-youtube">
                <YouTubeLogo size={32} />
              </span>
            </div>
            <TrackMeta current={current} />
            <Waveline levelRef={levelRef} playing={state.isPlaying} video={isVideo} width={112} height={36} />
          </div>
          {state.upcoming.length > 0 && <Upcoming items={state.upcoming} />}
        </>
      )}
      {options.debug && <DebugPanel info={debug} hasState={Boolean(state)} node={node} />}
    </div>
  );
}

/** Без бота (тэставы оверлэй) — пустыя сховішчы. */
const NO_PLAYER = createStore<PlayerState>(emptyPlayerState());
const NO_SETTINGS = createStore(defaultSettings());

/** Відэа, якое павінна граць зараз, па стане мозгу. */
function videoTarget(player: PlayerState): VideoTarget | null {
  const video = currentVideo(player);
  if (!video?.track.videoId || !player.video) return null;
  return { key: video.key, videoId: video.track.videoId, positionMs: player.progressMs, playing: player.isPlaying, seek: player.video.seek };
}

/**
 * Плашка з відэа над палоскай. Плэер ствараецца адзін раз і застаецца ў старонцы, плашка плаўна
 * з’яўляецца і знікае. Калі відэа скончылася ў плэеры, плашка хаваецца адразу, не чакаючы мозгу.
 */
function VideoCard({ node, demo, demoVideoId, owner }: { node: BrainNode | null; demo: boolean; demoVideoId: string; owner: Store<boolean> }) {
  const host = useRef<HTMLDivElement>(null);
  const control = useRef<ReturnType<typeof createVideoPlayer> | null>(null);
  const [endedKey, setEndedKey] = useState('');
  /** Відэа, для якога плашку ўжо можна паказаць (YouTube схаваў свой інтэрфейс). */
  const [revealedKey, setRevealedKey] = useState('');
  const isOwner = useStore(owner);
  const player = useStore(node?.player ?? NO_PLAYER);
  const { volume, skipAds } = useStore(node?.settings ?? NO_SETTINGS).video;

  const target: VideoTarget | null = demo
    ? { key: 'demo-video', videoId: demoVideoId, positionMs: 0, playing: true, seek: 0 }
    : videoTarget(player);
  /**
   * Не-ўладальнік (другая крыніца з оверлэем) відэа не грае, а паказвае вокладку: два плэеры з адным акаўнтам
   * YouTube Premium YouTube лічыць праглядам у двух месцах і спыняе адзін з іх (відэа абрывалася праз некалькі секунд).
   */
  const mirror = !demo && !isOwner;
  const visible = Boolean(target && target.key !== endedKey && (mirror || target.key === revealedKey));

  useEffect(() => {
    if (!host.current) return;
    // Плэер не павінен атрымліваць фокус: з фокусам YouTube трымае на экране свой інтэрфейс.
    host.current.setAttribute('inert', '');
    host.current.tabIndex = -1;
    const p = createVideoPlayer({
      host: host.current,
      onReport: (report) => node?.reportVideo(report),
      onLocalEnd: (key) => setEndedKey(key),
      onReveal: (key) => setRevealedKey(key),
    });
    control.current = p;
    return () => {
      p.destroy();
      control.current = null;
    };
  }, [node]);

  useEffect(() => {
    // Тэставае відэа грае само па сабе (без бота паведамляць няма каму) і без гуку.
    control.current?.setOwner(demo || isOwner);
  }, [isOwner, demo]);

  useEffect(() => {
    control.current?.setVolume(demo ? 0 : volume);
  }, [volume, demo]);

  useEffect(() => {
    control.current?.setSkipAds(skipAds);
  }, [skipAds]);

  useEffect(() => {
    control.current?.setTarget(target && target.key !== endedKey && !mirror ? target : null);
  }, [target?.key, target?.videoId, target?.playing, target?.seek, Math.floor((target?.positionMs ?? 0) / 1000), endedKey, mirror]);

  return (
    <div class="video-slot">
      <div class={`video-card${visible ? ' shown' : ''}`}>
        <div class="video-frame">
          <div class="video-host" ref={host} />
          {mirror && target && <img class="video-thumb" src={`https://i.ytimg.com/vi/${target.videoId}/hqdefault.jpg`} alt="" />}
        </div>
      </div>
    </div>
  );
}

function DebugPanel({ info, hasState, node }: { info: DebugInfo; hasState: boolean; node: BrainNode | null }) {
  const now = useNow(1000);
  const marker = readJson<number>(safeLocalStorage(), DIAG_MARKER_KEY);
  const env = obsBrowserInfo();
  return (
    <div class="debug">
      <div>
        {env.inObs ? `OBS ${env.version}` : t('diag.obs.notObs')} · {__APP_VERSION__}
      </div>
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

/** Колькі старая назва сыходзіць (тое ж, што `track-out` у overlay.css). */
const LEAVE_MS = 260;

const sameText = (a: OverlayTrack, b: OverlayTrack) =>
  a.title === b.title && a.artist === b.artist && a.requestedBy === b.requestedBy;

/**
 * Назва і выканаўца. Пры змене песні спачатку старая назва плаўна сыходзіць уверх, і толькі потым
 * знізу з’яўляецца новая — тэксты не накладваюцца. Калі песні мяняюцца адна за адной хутчэй
 * за анімацыю, сыходзіць тая назва, якую відаць, а з’яўляецца апошняя.
 */
function TrackMeta({ current }: { current: OverlayTrack }) {
  const shown = useRef<OverlayTrack>(current);
  // Стан анімацыі мяняецца ўжо падчас малявання, а не пасля яго: інакш на адзін кадр
  // з'яўляецца новая назва без анімацыі, а потым — старая, якая сыходзіць («рывок»).
  const anim = useRef<{ version: number; leaving: OverlayTrack | null }>({ version: 0, leaving: null });
  const [, rerender] = useState(0);

  if (!sameText(shown.current, current)) {
    // Калі старая назва ўжо сыходзіць, яна і сыходзіць далей, а з'яўляецца апошняя.
    if (!anim.current.leaving) anim.current.leaving = shown.current;
    anim.current.version++;
  }
  // Той жа тэкст пад іншым ключом (напрыклад, Spotify пацвердзіў песню) — без анімацыі.
  shown.current = current;
  const { version, leaving } = anim.current;

  useEffect(() => {
    if (!leaving) return;
    const id = setTimeout(() => {
      anim.current.leaving = null;
      rerender((n) => n + 1);
    }, LEAVE_MS);
    return () => clearTimeout(id);
  }, [leaving]);

  return (
    <div class="meta-box">
      {leaving && <MetaLines track={leaving} class="meta leaving" key={`out-${version}`} />}
      <MetaLines track={current} class={version > 0 ? 'meta entering' : 'meta'} key={`in-${version}`} />
    </div>
  );
}

function MetaLines({ track, class: className }: { track: OverlayTrack; class: string }) {
  return (
    <div class={className}>
      <div class="title">{track.title}</div>
      <div class="artist">
        <span class="artist-name">{track.artist}</span>
        {track.requestedBy && (
          <span class="by">
            <UserIcon /> {track.requestedBy}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Наступныя песні і відэа. Новы запіс у спісе плаўна з’яўляецца, а тыя, што засталіся, плаўна
 * пад’язджаюць на новае месца (калі першы пачаў граць), а не пераскокваюць.
 */
function Upcoming({ items }: { items: OverlayTrack[] }) {
  const list = useRef<HTMLOListElement>(null);
  const tops = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const next = new Map<string, number>();
    for (const li of Array.from(el.children) as HTMLElement[]) {
      const key = li.dataset.key ?? '';
      const top = li.offsetTop;
      next.set(key, top);
      const before = tops.current.get(key);
      if (before !== undefined && before !== top && typeof li.animate === 'function') {
        li.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], {
          duration: 420,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
      }
    }
    tops.current = next;
  });

  return (
    <ol class="upcoming" ref={list}>
      {items.map((item) => (
        <li key={item.key} data-key={item.key}>
          <span class="up-source">
            <SourceIcon source={item.source} size={11} />
          </span>
          <span class="up-title">{item.title}</span>
          <span class="up-artist">{item.artist}</span>
          {item.requestedBy && (
            <span class="by">
              <UserIcon /> {item.requestedBy}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
