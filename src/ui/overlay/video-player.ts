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
  /**
   * Пара паказаць плашку: відэа ўжо грае, і YouTube схаваў свой інтэрфейс (назва, кнопкі, «Другие видео»),
   * які ён паказвае першыя секунды.
   */
  onReveal(key: string): void;
}

const REPORT_MS = 1000;
const IDLE_REPORT_MS = 5000;
/**
 * Не-ўладальнік падцягвае пазіцыю, толькі калі разышоўся з уладальнікам вельмі моцна, і не часта: пасля кожнай
 * перамоткі YouTube зноў паказвае свой інтэрфейс (назва, кнопкі) — частыя перамоткі трымалі яго на экране.
 */
const MIRROR_DRIFT_MS = 10_000;
const MIRROR_SEEK_EVERY_MS = 30_000;
/** Калі відэа так доўга не пачынаецца (браўзер не дае ўключыць з гукам) — уключаем без гуку, каб хоць было відаць. */
const AUTOPLAY_FALLBACK_MS = 4000;
/**
 * Колькі сапраўды прайгралася відэа (па часе самога відэа), калі YouTube ужо схаваў свой інтэрфейс:
 * без мышы назва, кнопкі і «Другие видео» знікаюць праз 2–3 с прайгравання. Па часе відэа, а не па падзеях
 * плэера: загрузка і буферызацыя ў пачатку гэты час не з’ядаюць.
 */
const REVEAL_PLAYED_MS = 4000;
/**
 * Калі відэа за столькі пасля загрузкі так і не пачало ісці (рэклама перад відэа, памылка YouTube), плашка
 * ўсё роўна з’яўляецца: рэкламу і памылкі мы не хаваем (правілы YouTube забараняюць схаваны плэер).
 */
const REVEAL_NOT_STARTED_MS = 8000;
const REVEAL_CHECK_MS = 250;

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
  let revealedKey = '';
  let skipAds = true;
  /** Час відэа (с), калі само відэа (не рэклама) пачало граць; `null` — яшчэ не пачало. */
  let mainStart: number | null = null;
  /** YouTube паказвае (паказаў) рэкламу перад гэтым відэа. */
  let adSeen = false;
  /** Апошні час плэера, пакуль ён «не запушчаны»: калі ён ідзе — гэта рэклама. */
  let unstartedTime: number | null = null;

  const timer = setInterval(() => tick(), REPORT_MS);
  const watchTimer = setInterval(() => watch(), REVEAL_CHECK_MS);
  let lastIdleAt = 0;
  let lastMirrorSeekAt = 0;

  /** Новае відэа ў плэеры: пачынаем назіранне нанова. */
  function resetWatch(): void {
    mainStart = null;
    adSeen = false;
    unstartedTime = null;
  }

  /**
   * Раз у 250 мс: ці пачала граць само відэа, ці не рэклама гэта, ці пара паказаць плашку.
   * Рэклама: плэер кажа «не запушчана» (-1), а час ідзе (праверана 2026-10-17 на сапраўдных прэ-ролах).
   */
  function watch(): void {
    const t = target;
    if (!t || !player || !ready || loadedKey !== t.key || endedKey === t.key) return;
    let state: number;
    let time: number;
    try {
      state = player.getPlayerState();
      time = player.getCurrentTime() || 0;
    } catch {
      return;
    }
    if (state === PlayerState.PLAYING) {
      if (mainStart === null) {
        mainStart = time;
        applySound();
      }
    } else if (state === PlayerState.UNSTARTED) {
      if (unstartedTime !== null && time > unstartedTime + 0.15 && !adSeen) onAd(t.key);
      unstartedTime = time;
    }
    if (revealedKey === t.key) return;
    // Плашка — калі само відэа ідзе 4 с: YouTube ужо схаваў назву, кнопкі і «Другие видео».
    const played = mainStart === null ? 0 : (time - mainStart) * 1000;
    const nothing = mainStart === null && !adSeen && Date.now() - loadedAt >= REVEAL_NOT_STARTED_MS;
    if ((state === PlayerState.PLAYING && played >= REVEAL_PLAYED_MS) || nothing) doReveal(t.key);
  }

  function doReveal(key: string): void {
    revealedKey = key;
    options.onReveal(key);
  }

  /**
   * YouTube уключыў рэкламу. Калі рэкламу не паказваем — відэа спыняецца адразу (плашка яшчэ схаваная, гук
   * выключаны), мозг адменіць замову і працягне музыку. Калі паказваем — плашка і гук адразу: рэкламу не хаваем.
   */
  function onAd(key: string): void {
    adSeen = true;
    report('ad');
    if (skipAds) {
      endedKey = key;
      try {
        player?.stopVideo();
      } catch {
        // Плэер ужо спынены.
      }
      options.onLocalEnd(key);
      return;
    }
    applySound();
    doReveal(key);
  }

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
    // Гук — толькі калі пайшло само відэа (або рэклама, калі яе паказваем): рэклама не павінна мільгнуць гукам у эфіры.
    const allowed = mainStart !== null || (adSeen && !skipAds);
    if (!owner || fallbackMuted || !allowed) {
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
      resetWatch();
      player = new YT.Player(el, {
        width: '100%',
        height: '100%',
        videoId: t.videoId,
        // Без гуку з першага кадра: гук уключаецца, калі пайшло само відэа (не рэклама), і толькі ва ўладальніка.
        playerVars: playerVars({ autoplay: t.playing ? 1 : 0, start: Math.floor(t.positionMs / 1000), mute: 1 }),
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
      resetWatch();
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
    } else if (!owner && mainStart !== null && Date.now() - lastMirrorSeekAt >= MIRROR_SEEK_EVERY_MS) {
      const own = (player.getCurrentTime() || 0) * 1000;
      if (Math.abs(own - t.positionMs) > MIRROR_DRIFT_MS) {
        lastMirrorSeekAt = Date.now();
        player.seekTo(t.positionMs / 1000, true);
      }
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
    if (target.playing && loadedKey === target.key && (state === PlayerState.UNSTARTED || state === PlayerState.CUED) && now - loadedAt > AUTOPLAY_FALLBACK_MS && !fallbackMuted && !adSeen) {
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
    /** Рэкламу не паказваем: відэа з рэкламай спыняецца (налада дока). */
    setSkipAds(value: boolean): void {
      skipAds = value;
    },
    setVolume(value: number): void {
      volume = Math.max(0, Math.min(100, Math.round(value)));
      applySound();
    },
    destroy(): void {
      destroyed = true;
      clearInterval(timer);
      clearInterval(watchTimer);
      try {
        player?.destroy();
      } catch {
        // Плэер ужо выдалены.
      }
      player = null;
    },
  };
}
