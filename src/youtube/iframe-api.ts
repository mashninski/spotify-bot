// Загрузка YouTube IFrame Player API (ADR-020): скрыпт `https://www.youtube.com/iframe_api` аднойчы на старонку.
// Тут — толькі тая частка API, якой мы карыстаемся.

export const PlayerState = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export interface YTPlayer {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoData(): { video_id?: string; title?: string; author?: string; isPlayable?: boolean; isLive?: boolean };
  destroy(): void;
}

export interface YTPlayerOptions {
  width?: number | string;
  height?: number | string;
  videoId?: string;
  host?: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (e: { target: YTPlayer }) => void;
    onStateChange?: (e: { data: number; target: YTPlayer }) => void;
    onError?: (e: { data: number; target: YTPlayer }) => void;
  };
}

interface YTNamespace {
  Player: new (element: HTMLElement | string, options: YTPlayerOptions) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;

/** Загрузіць API (адзін раз). Калі скрыпт не загрузіўся за `timeoutMs` — памылка (наступны выклік паспрабуе зноў). */
export function loadYouTubeApi(timeoutMs = 15_000): Promise<YTNamespace> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  loading ??= new Promise<YTNamespace>((resolve, reject) => {
    const timer = setTimeout(() => {
      loading = null;
      reject(new Error('YouTube API timeout'));
    }, timeoutMs);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      clearTimeout(timer);
      if (window.YT?.Player) resolve(window.YT);
    };
    if (!document.querySelector('script[data-youtube-api]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.youtubeApi = '1';
      script.onerror = () => {
        clearTimeout(timer);
        script.remove();
        loading = null;
        reject(new Error('YouTube API failed to load'));
      };
      document.head.appendChild(script);
    }
  });
  return loading;
}

/** Агульныя параметры плэера: без кнопак і падказак, без поўнаэкраннага рэжыму, з правільным origin. */
export function playerVars(extra: Record<string, string | number> = {}): Record<string, string | number> {
  return {
    controls: 0,
    disablekb: 1,
    fs: 0,
    iv_load_policy: 3,
    modestbranding: 1,
    playsinline: 1,
    rel: 0,
    origin: location.origin,
    ...extra,
  };
}
