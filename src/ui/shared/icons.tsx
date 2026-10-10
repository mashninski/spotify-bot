// SVG-значкі. Колер бярэцца з `currentColor`.

interface IconProps {
  size?: number;
}

/** Значок у стылі Spotify: круг з трыма дугамі. */
export function SpotifyLogo({ size = 28 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#1ed760" />
      <path
        d="M6.2 9.2c3.9-1.1 8.4-.8 11.6 1.1M6.8 12.4c3.2-.9 6.8-.6 9.5 1M7.4 15.4c2.5-.7 5.2-.5 7.3.8"
        fill="none"
        stroke="#121212"
        stroke-width="1.7"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function PlayIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
    </svg>
  );
}

export function PauseIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

export function NextIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5.5v13l9-6.5z" fill="currentColor" />
      <rect x="16" y="5.5" width="2.5" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

export function PreviousIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 5.5v13l-9-6.5z" fill="currentColor" />
      <rect x="5.5" y="5.5" width="2.5" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
    </svg>
  );
}

export function UserIcon({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4.5" fill="currentColor" />
      <path d="M3.5 21c.8-4.6 4.3-7 8.5-7s7.7 2.4 8.5 7z" fill="currentColor" />
    </svg>
  );
}
