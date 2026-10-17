// Waveline: хваля, якая рэагуе на ўзровень гуку (ADR-009: гучнасць/рытм, не спектр).

import { useEffect, useRef } from 'preact/hooks';
import { smoothLevel } from '../../obs/audio';

interface Props {
  /** Апошні ўзровень гуку 0…1; чытаецца кожны кадр без перамалёўкі кампанента. */
  levelRef: { current: number };
  playing: boolean;
  /** Падчас відэа YouTube хваля чырвоная (ADR-020); колер мяняецца плаўна. */
  video?: boolean;
  width: number;
  height: number;
}

const LINES = [
  { alpha: 1, width: 2.2, speed: 1, phase: 0, freq: 1 },
  { alpha: 0.45, width: 1.6, speed: -0.7, phase: 2.1, freq: 1.4 },
  { alpha: 0.22, width: 1.2, speed: 0.45, phase: 4.2, freq: 0.8 },
];

/** Колеры хвалі: Spotify і YouTube (тое ж, што `--accent` у overlay.css). */
const GREEN = [30, 215, 96];
const RED = [255, 64, 64];
/** Колькі ідзе змена колеру (тое ж, што пераход `--accent`). */
const COLOR_MS = 900;

export function Waveline({ levelRef, playing, video = false, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const videoRef = useRef(video);
  videoRef.current = video;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let frame = 0;
    let last = performance.now();
    let level = 0;
    let time = 0;
    /** 0 — зялёная, 1 — чырвоная. */
    let mix = videoRef.current ? 1 : 0;

    const draw = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      const target = playingRef.current ? levelRef.current : 0;
      level = smoothLevel(level, target, dt);
      // Хваля рухаецца хутчэй, калі гучней; на паўзе амаль спыняецца.
      time += (dt / 1000) * (playingRef.current ? 1.2 + level * 3 : 0.25);

      const goal = videoRef.current ? 1 : 0;
      mix += Math.sign(goal - mix) * Math.min(Math.abs(goal - mix), dt / COLOR_MS);
      const ease = mix * mix * (3 - 2 * mix);
      const rgb = GREEN.map((g, i) => Math.round(g + (RED[i] - g) * ease)).join(', ');

      ctx.clearRect(0, 0, width, height);
      const mid = height / 2;
      const amp = (0.06 + 0.94 * level) * (height / 2 - 2);
      for (const line of LINES) {
        ctx.beginPath();
        for (let x = 0; x <= width; x += 2) {
          const u = x / width;
          const envelope = Math.sin(Math.PI * u) ** 2;
          const k = u * Math.PI * 2 * line.freq;
          const wave =
            0.62 * Math.sin(k * 2 + time * 3 * line.speed + line.phase) +
            0.28 * Math.sin(k * 4.6 - time * 4.2 * line.speed) +
            0.1 * Math.sin(k * 9.3 + time * 6.5);
          const y = mid + amp * envelope * wave;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(${rgb}, ${line.alpha})`;
        ctx.lineWidth = line.width;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [width, height, levelRef]);

  return <canvas ref={canvasRef} class="waveline" style={{ width: `${width}px`, height: `${height}px` }} />;
}
