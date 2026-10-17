// Плэер відэа ў оверлэі (ADR-020). Мозг кажа, якое відэа павінна граць, з якога месца і ці на паўзе;
// плэер выконвае гэта і (калі гэты оверлэй — уладальнік плэера) раз у секунду паведамляе мозгу, як ідзе відэа.
// Іншыя оверлэі паказваюць тое ж відэа без гуку і падцягваюць пазіцыю.

import type { VideoPlayerState, VideoReport } from '../../core/video';
import { loadYouTubeApi, playerVars, PlayerState, type YTPlayer } from '../../youtube/iframe-api';

/** Што павінна адбывацца зараз (з стану мозгу). */
export interface VideoTarget {
  key: string;
  videoId: string;
  /** Пазіцыя па стане мозгу, мс. */
  positionMs: number;
  playing: boolean;
  /** Лічыльнік перамоткі мозгу: змяніўся — перамотваем на `positionMs`. */
  seek: number;
}

export interface VideoPlayerOptions {
  /** Элемент, у які ўстаўляецца iframe плэера. */
  host: HTMLElement;
  /** Паведамленне мозгу (толькі ў уладальніка плэера). */
  onReport(report: VideoReport): void;
  /** Плэер мясцова скончыў або не можа паказаць відэа — оверлэй хавае плашку, не чакаючы мозгу. */
  onLocalEnd(key: string): void;
}

const REPORT_MS = 1000;
const IDLE_REPORT_MS = 5000;
/** Не-ўладальнік падцягвае пазіцыю, калі разышоўся з уладальнікам больш чым на столькі. */
const MIRROR_DRIFT_MS = 3000;
/** Калі відэа так доўга не пачынаецца (браўзер не дае ўключыць з гукам) — уключаем без гуку, каб хоць было відаць. */
const AUTOPLAY_FALLBACK_MS = 4000;

function stateName(code: number): VideoPlayerState {
  switch (code) {
    case PlayerState.PLAYING:
      return 'playing';
    case PlayerState.PAUSED:
      return 'paused';
    case PlayerState.BUFFERING:
      return 'buffering';
    case PlayerState.ENDED:
      return 'ended';
    default:
      return 'loading';
  }
}

export function createVideoPlayer(options: VideoPlayerOptions) {
  let player: YTPlayer | null = null;
  let creating = false;
  let ready = false;
  let target: VideoTarget | null = null;
  /** Відэа, загружанае ў плэер зараз. */
  let loadedKey = '';
  let loadedAt = 0;
  let lastSeek = 0;
  let owner = false;
  let volume = 40;
  let endedKey = '';
  let fallbackMuted = false;
  let destroyed = false;

  const timer = setInterval(() => tick(), REPORT_MS);
  let lastIdleAt = 0;

  function report(state: VideoPlayerState, code?: number): void {
    if (!owner || !target) return;
    const positionMs = player && ready ? Math.max(0, Math.round((player.getCurrentTime() || 0) * 1000)) : target.positionMs;
    options.onReport({ key: target.key, state, positionMs, ...(code !== undefined ? { code } : {}) });
  }

  /** Субтытры, уключаныя аўтарам відэа, закрываюць карцінку на стрыме — выключаем (калі YouTube дазваляе). */
  function hideCaptions(): void {
    try {
      player?.unloadModule?.('captions');
    } catch {
      // Няма такога модуля — нічога страшнага.
    }
  }

  function applySound(): void {
    if (!player || !ready) return;
    if (!owner || fallbackMuted) {
      player.mute();
      return;
    }
    player.setVolume(volume);
    if (volume > 0) player.unMute();
    else player.mute();
  }

  async function create(t: VideoTarget): Promise<void> {
    creating = true;
    try {
      const YT = await loadYouTubeApi();
      if (destroyed) return;
      const el = document.createElement('div');
      options.host.replaceChildren(el);
      loadedKey = t.key;
      loadedAt = Date.now();
      lastSeek = t.seek;
      player = new YT.Player(el, {
        width: '100%',
        height: '100%',
        videoId: t.videoId,
        // Не-ўладальнік з першага кадра без гуку (гук павінен быць адзін на ўсе оверлэі).
        playerVars: playerVars({ autoplay: t.playing ? 1 : 0, start: Math.floor(t.positionMs / 1000), mute: owner && volume > 0 ? 0 : 1 }),
        events: {
          onReady: () => {
            ready = true;
            applySound();
            sync();
          },
          onStateChange: (e) => {
            if (e.data === PlayerState.ENDED && target && endedKey !== target.key) {
              endedKey = target.key;
              report('ended');
              options.onLocalEnd(target.key);
            } else if (e.data === PlayerState.PLAYING || e.data === PlayerState.PAUSED) {
              if (e.data === PlayerState.PLAYING) hideCaptions();
              report(stateName(e.data));
            }
          },
          onError: (e) => {
            if (!target) return;
            report('error', e.data);
            options.onLocalEnd(target.key);
          },
        },
      });
    } catch {
      // Скрыпт YouTube не загрузіўся — паспрабуем пры наступным змяненні; мозг заўважыць маўчанне плэера.
      player = null;
    } finally {
      creating = false;
    }
  }

  /** Прывесці плэер да `target`. */
  function sync(): void {
    const t = target;
    if (!t) {
      if (player && ready && loadedKey) {
        player.stopVideo();
        loadedKey = '';
      }
      return;
    }
    if (!player) {
      if (!creating) void create(t);
      return;
    }
    if (!ready) return;
    if (loadedKey !== t.key) {
      loadedKey = t.key;
      loadedAt = Date.now();
      lastSeek = t.seek;
      endedKey = '';
      fallbackMuted = false;
      applySound();
      const start = { videoId: t.videoId, startSeconds: Math.floor(t.positionMs / 1000) };
      if (t.playing) player.loadVideoById(start);
      else player.cueVideoById(start);
      return;
    }
    if (t.seek !== lastSeek) {
      lastSeek = t.seek;
      player.seekTo(t.positionMs / 1000, true);
    } else if (!owner) {
      const own = (player.getCurrentTime() || 0) * 1000;
      if (Math.abs(own - t.positionMs) > MIRROR_DRIFT_MS) player.seekTo(t.positionMs / 1000, true);
    }
    const state = player.getPlayerState();
    if (t.playing && state !== PlayerState.PLAYING && state !== PlayerState.BUFFERING && state !== PlayerState.ENDED) player.playVideo();
    if (!t.playing && state === PlayerState.PLAYING) player.pauseVideo();
  }

  function tick(): void {
    const now = Date.now();
    if (!target) {
      // Плэер жывы, але нічога не паказвае — мозг ведае, што оверлэй ёсць («Стан» у доку).
      if (owner && now - lastIdleAt >= IDLE_REPORT_MS) {
        lastIdleAt = now;
        options.onReport({ key: '', state: 'idle', positionMs: 0 });
      }
      return;
    }
    if (!player || !ready) {
      // Плэер яшчэ ствараецца: мозг павінен ведаць, што оверлэй ёсць і рыхтуе відэа.
      report('loading');
      return;
    }
    const state = player.getPlayerState();
    if (target.playing && loadedKey === target.key && (state === PlayerState.UNSTARTED || state === PlayerState.CUED) && now - loadedAt > AUTOPLAY_FALLBACK_MS && !fallbackMuted) {
      fallbackMuted = true;
      applySound();
      player.playVideo();
    }
    if (endedKey === target.key) return;
    sync();
    report(stateName(state));
  }

  return {
    /** Што павінна граць (`null` — нічога). */
    setTarget(next: VideoTarget | null): void {
      target = next;
      sync();
    },
    /** Гэты оверлэй грае з гукам і паведамляе мозгу. */
    setOwner(value: boolean): void {
      owner = value;
      applySound();
    },
    setVolume(value: number): void {
      volume = Math.max(0, Math.min(100, Math.round(value)));
      applySound();
    },
    destroy(): void {
      destroyed = true;
      clearInterval(timer);
      try {
        player?.destroy();
      } catch {
        // Плэер ужо выдалены.
      }
      player = null;
    },
  };
}
