// Спасылкі на відэа YouTube (ADR-020): глядач дасылае толькі спасылку, пошуку па назве няма (без ключоў API).

/** Ідэнтыфікатар відэа YouTube — 11 сімвалаў: літары, лічбы, `-` і `_`. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/i;

/**
 * Ідэнтыфікатар відэа са спасылкі: `youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…`, `/embed/…`, `/live/…`,
 * `m.` і `music.youtube.com`, `youtube-nocookie.com`. Спасылка можа быць сярод іншага тэксту і без `https://`.
 * `null` — у тэксце няма спасылкі на відэа YouTube.
 */
export function parseYouTubeLink(text: string): string | null {
  // Перад адрасам — не літара і не кропка: «notyoutube.com» — не YouTube.
  const match = text.match(/(?<![\w.-])(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\/[^\s<>"'«»]*/i);
  if (!match) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | null = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') id = parts[0] ?? null;
  else if (HOSTS.test(host)) {
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v', 'e'].includes(parts[0] ?? '')) id = parts[1] ?? null;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** Ці ёсць у тэксце спасылка на YouTube (любая: відэа, канал, плэйліст) — для падказкі гледачу. */
export function mentionsYouTube(text: string): boolean {
  return /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(text);
}

/** Спасылка на відэа для паведамленняў і oEmbed. */
export const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
