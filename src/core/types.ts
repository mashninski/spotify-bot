// Агульныя тыпы даных прыкладання. Не залежаць ад Spotify, Twitch і OBS.

/** Адкуль запіс: песня Spotify (па змаўчанні) або відэа YouTube (ADR-020). */
export type TrackSource = 'spotify' | 'youtube';

/** Трэк з крыніцы музыкі: песня Spotify або відэа YouTube (ADR-020). */
export interface Track {
  /** Ідэнтыфікатар трэка ў крыніцы (у Spotify — track id, у YouTube — `yt:<videoId>`). */
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  explicit: boolean;
  /** Spotify URI (`spotify:track:…`): патрэбны, каб кіраваць трэкам у Spotify. У тэставых трэкаў і відэа няма. */
  uri?: string;
  /** `youtube` — відэа (тады `artist` — канал). Без поля — песня. */
  source?: TrackSource;
  /** Ідэнтыфікатар відэа YouTube (11 сімвалаў). */
  videoId?: string;
}

/** Ці гэта відэа YouTube (ADR-020). */
export const isVideo = (track: Pick<Track, 'source'> | null | undefined): boolean => track?.source === 'youtube';

/** Адзін запіс у чарзе. Адзін і той жа трэк можа сустракацца ў розных запісах, таму ёсць `key`. */
export interface QueueItem {
  /** Унікальны ключ запісу (не трэка). */
  key: string;
  track: Track;
  /** Нік гледача, калі песня заказана. */
  requestedBy?: string;
  /** Заказ ужо адпраўлены ў чаргу Spotify (ADR-017): час адпраўкі. */
  sentAt?: number;
  /** Выкуп узнагароды Twitch, за які заказана песня (ADR-018): па ім бот ставіць «выканана» або вяртае баллы. */
  redemptionId?: string;
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
  /**
   * Заказ, які выдалілі ўжо пасля адпраўкі ў Spotify (адтуль выдаліць нельга): калі ён пачне граць,
   * бот адразу пераключыць на наступную (ADR-017).
   */
  skip?: { uri: string; at: number } | null;
  /** Відэа YouTube, якое зараз бягучае (ADR-020): як працягнуць Spotify пасля яго і ці жывы плэер у оверлэі. */
  video?: VideoState | null;
}

/** Як працягнуць Spotify, калі відэа скончыцца. */
export type SpotifyResume =
  /** «Наступная»: песня, якая грала да відэа, ужо скончылася або яе перабілі. */
  | 'next'
  /** Spotify паспеў перайсці да новай песні — яна пачнецца з пачатку. */
  | 'restart'
  /** Spotify не трэба чапаць (ён не падключаны або нічога не грала). */
  | 'none';

export interface VideoState {
  /** Ключ бягучага запісу (`current.key`) — відэа, да якога адносіцца стан. */
  key: string;
  resume: SpotifyResume;
  /** Калі відэа стала бягучым. */
  startedAt: number;
  /** Калі плэер оверлэя апошні раз паведаміў пра гэтае відэа (0 — яшчэ ні разу). */
  reportAt: number;
  /** Павялічваецца, калі бот сам пераносіць відэа («Папярэдняя» — з пачатку): плэер перамотвае. */
  seek: number;
  /** Spotify пацвердзіў паўзу (пасля гэтага «грае» ад Spotify азначае, што стрымер сам уключыў музыку). */
  spotifyPaused: boolean;
  /**
   * Плэер сапраўды пачаў паказваць відэа. Да гэтага замова за балы не лічыцца выкананай:
   * калі відэа так і не зайграла, балы вяртаюцца.
   */
  started: boolean;
}

/** Тое, што патрэбна оверлею для малявання. Без лішніх даных. */
export interface OverlayTrack {
  key: string;
  title: string;
  artist: string;
  requestedBy?: string;
  /** `youtube` — відэа; без поля — песня. */
  source?: TrackSource;
}

export interface OverlayState {
  current: OverlayTrack | null;
  isPlaying: boolean;
  upcoming: OverlayTrack[];
}
