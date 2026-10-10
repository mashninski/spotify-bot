// Агульныя тыпы даных прыкладання. Не залежаць ад Spotify, Twitch і OBS.

/** Трэк з крыніцы музыкі (Spotify; пазней — іншыя крыніцы). */
export interface Track {
  /** Ідэнтыфікатар трэка ў крыніцы (у Spotify — track id). */
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  explicit: boolean;
}

/** Адзін запіс у чарзе. Адзін і той жа трэк можа сустракацца ў розных запісах, таму ёсць `key`. */
export interface QueueItem {
  /** Унікальны ключ запісу (не трэка). */
  key: string;
  track: Track;
  /** Нік гледача, калі песня заказана. */
  requestedBy?: string;
}

/** Стан плэера і чаргі, якім кіруе док (ADR-007). */
export interface PlayerState {
  current: QueueItem | null;
  isPlaying: boolean;
  /** Колькі мілісекунд бягучай песні ўжо прайграна. */
  progressMs: number;
  /** Наша чарга заказаў гледачоў. */
  requests: QueueItem[];
  /** Наступныя трэкі з кантэксту крыніцы (плэйліст, альбом), калі заказаў няма. */
  context: QueueItem[];
  /** Ужо прайграныя запісы (апошні — у канцы). */
  history: QueueItem[];
}

/** Тое, што патрэбна оверлею для малявання. Без лішніх даных. */
export interface OverlayTrack {
  key: string;
  title: string;
  artist: string;
  requestedBy?: string;
}

export interface OverlayState {
  current: OverlayTrack | null;
  isPlaying: boolean;
  upcoming: OverlayTrack[];
}
