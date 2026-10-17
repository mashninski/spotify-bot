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

/** Значок у стылі YouTube: чырвоны скруглены прамавугольнік з белым трохвугольнікам (ADR-020). */
export function YouTubeLogo({ size = 28 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="0.5" y="4" width="23" height="16" rx="4.8" fill="#ff0000" />
      <path d="M9.6 8.4v7.2l6.2-3.6z" fill="#ffffff" />
    </svg>
  );
}

/** Маленькі значок крыніцы каля песні або відэа ў чарзе. */
export function SourceIcon({ source, size = 11 }: IconProps & { source?: 'spotify' | 'youtube' }) {
  return source === 'youtube' ? <YouTubeLogo size={size} /> : <SpotifyLogo size={size} />;
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

/** «+» у крузе: дадаць у «Любімыя трэкі» (як у Spotify). */
export function PlusCircleIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  );
}

/** Зялёная галачка ў крузе: песня ўжо ў «Любімых трэках». */
export function CheckCircleIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#1ed760" />
      <path d="M7.5 12.3l3 3 6-6.3" fill="none" stroke="#121212" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Гучнасць: дынамік з хвалямі (колькасць хваль залежыць ад гучнасці, як у Spotify). */
export function VolumeIcon({ size = 18, level = 100 }: IconProps & { level?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
      {level === 0 ? (
        <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      ) : (
        <>
          <path d="M15 9.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          {level > 50 && <path d="M17.6 6.8a7.5 7.5 0 0 1 0 10.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />}
        </>
      )}
    </svg>
  );
}
