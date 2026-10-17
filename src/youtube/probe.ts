// Схаваны плэер для праверкі відэа (ADR-020): стварае плэер з `videoId`, чытае даўжыню і стан у `onReady`
// (відэа пры гэтым не грае) і адразу выдаляе плэер. Працуе ў старонцы-лідары: у доку або ў оверлэі.

import { loadYouTubeApi, playerVars } from './iframe-api';
import type { ProbeResult } from './lookup';

const PROBE_TIMEOUT_MS = 15_000;
/** Пасля `onReady` крыху чакаем `onError`: YouTube паведамляе пра забарону ўбудавання амаль адначасова. */
const ERROR_GRACE_MS = 400;

/** Адна праверка за раз: схаваных плэераў не павінна быць шмат. */
let chain: Promise<unknown> = Promise.resolve();

export function probeVideo(videoId: string): Promise<ProbeResult> {
  const run = chain.then(() => probeOnce(videoId));
  chain = run.catch(() => undefined);
  return run;
}

async function probeOnce(videoId: string): Promise<ProbeResult> {
  let YT;
  try {
    YT = await loadYouTubeApi();
  } catch {
    return { status: 'timeout' };
  }
  const host = document.createElement('div');
  // Па-за экранам і празрысты: у оверлэі гледачы яго не ўбачаць.
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;opacity:0;pointer-events:none;';
  const target = document.createElement('div');
  host.appendChild(target);
  document.body.appendChild(host);

  return new Promise<ProbeResult>((resolve) => {
    let done = false;
    let player: { destroy(): void } | null = null;
    const finish = (result: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setTimeout(() => {
        try {
          player?.destroy();
        } catch {
          // Плэер ужо выдалены.
        }
        host.remove();
      }, 0);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), PROBE_TIMEOUT_MS);
    try {
      player = new YT.Player(target, {
        width: 320,
        height: 180,
        videoId,
        playerVars: playerVars({ autoplay: 0, mute: 1 }),
        events: {
          onReady: (e) => {
            setTimeout(() => {
              const data = e.target.getVideoData() ?? {};
              finish({
                status: 'ok',
                durationMs: Math.round((e.target.getDuration() || 0) * 1000),
                title: data.title ?? '',
                live: data.isLive === true,
                playable: data.isPlayable !== false,
              });
            }, ERROR_GRACE_MS);
          },
          onError: (e) => finish({ status: 'error', code: e.data }),
        },
      });
    } catch {
      finish({ status: 'timeout' });
    }
  });
}
