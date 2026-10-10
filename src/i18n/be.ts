// Беларускія тэксты прыкладання (ADR-010). Усе тэксты інтэрфейсу — толькі тут.
// Параметры ў фігурных дужках: {name}.
// Стыль (ADR-014): апошні сказ тэксту — без кропкі; падказкі (*.help) — паўнавартасныя тлумачэнні
// для чалавека, які не ведае тэхналогій, а не тэхнічныя заўвагі.

export const be = {
  'app.title': 'Spotify-бот',

  'tab.player': 'Плэер',
  'tab.settings': 'Налады',
  'tab.diagnostics': 'Праверка',

  'help.label': 'Падказка',

  'obs.status.connected': 'OBS падключаны',
  'obs.status.connecting': 'Падключэнне да OBS…',
  'obs.status.disconnected': 'OBS не падключаны',
  'obs.status.auth-failed': 'Няправільны пароль',
  'obs.status.error': 'Няма сувязі з OBS, спрабую зноў…',

  'player.now': 'Зараз грае',
  'player.now.help':
    'Песня, якая гучыць зараз, і колькі яе ўжо прайграна. Кнопкі пад ёй кіруюць плэерам: вярнуцца да папярэдняй песні, паставіць на паўзу або працягнуць, перайсці да наступнай. Гледачы бачаць тую ж песню ў оверлеі на стрыме',
  'player.nothing': 'Нічога не грае',
  'player.previous': 'Папярэдняя',
  'player.pause': 'Паўза',
  'player.play': 'Працягнуць',
  'player.next': 'Наступная',
  'player.requests': 'Заказы гледачоў',
  'player.requests.help':
    'Песні, якія гледачы заказалі за баллы канала. Яны граюць па чарзе і раней за ваш плэйліст. Кнопка ▶ адразу ўключае песню, а астатнія заказы застаюцца ў тым жа парадку. Кнопка ✕ прыбірае песню з чаргі. «+ Тэставы заказ» дадае выпадковы заказ ад выдуманага гледача — каб паглядзець, як усё выглядае',
  'player.requests.empty': 'Заказаў пакуль няма',
  'player.context': 'Далей з плэйліста',
  'player.context.help':
    'Калі заказы скончацца, будуць граць гэтыя песні — з плэйліста або альбома, які вы ўключылі ў Spotify. Парадак гэтых песень змяняецца ў самім Spotify',
  'player.playNow': 'Прайграць зараз',
  'player.remove': 'Выдаліць',
  'player.addTestRequest': '+ Тэставы заказ',
  'player.added': '{user}: «{title}» — №{n} у чарзе',
  'player.notFound': '{user}: не знайшоў «{query}»',
  'player.rejected.too-long': '{user}: «{title}» даўжэй за {max} хв',
  'player.rejected.explicit': '{user}: «{title}» — explicit забаронены',
  'player.rejected.user-limit': '{user}: ужо {max} песні ў чарзе',
  'player.rejected.duplicate': '{user}: «{title}» ужо ў чарзе',

  'settings.obs': 'Падключэнне да OBS',
  'settings.obs.help':
    'Док і оверлей працуюць унутры OBS, а размаўляюць з ім праз убудаваную функцыю OBS — сервер WebSocket. Праз яго док даведваецца, наколькі гучна іграе музыка, і перадае гэта хвалі ў оверлеі. Каб падключыцца: у OBS адкрыйце меню «Сервис» → «Настройки сервера WebSocket», пастаўце галачку «Включить сервер WebSocket», націсніце «Показать сведения о подключении», скапіруйце пароль у поле «Пароль» і націсніце «Падключыцца». Адрас звычайна змяняць не трэба. Пасля першага падключэння док будзе падключацца сам пры кожным запуску OBS',
  'settings.obs.url': 'Адрас',
  'settings.obs.password': 'Пароль',
  'settings.obs.connect': 'Падключыцца',
  'settings.obs.disconnect': 'Адключыцца',
  'settings.obs.channel.vendor': 'obs-browser (emit_event)',
  'settings.obs.channel.broadcast': 'BroadcastCustomEvent (оверлею патрэбны пароль у адрасе)',
  'settings.obs.channel.none': 'няма',
  'settings.audio': 'Хваля ў оверлеі',
  'settings.audio.help':
    'Хваля ў оверлеі рухаецца ў рытм музыкі. Выберыце крыніцу гуку з OBS, на якую яна будзе рэагаваць: зялёная палоска побач з назвай паказвае, што крыніца зараз гучыць. Лепш за ўсё — крыніца, дзе ёсць толькі музыка, напрыклад «Захват звука приложения» са Spotify. Калі выбраць гук працоўнага стала, хваля будзе рэагаваць на ўсе гукі камп’ютара, а калі мікрафон — на ваш голас. «Імітацыя рытму» рухае хвалю сама, без сапраўднага гуку',
  'settings.audio.source': 'Крыніца гуку',
  'settings.audio.none': 'Не выбрана',
  'settings.audio.simulated': 'Імітацыя рытму',
  'settings.audio.connectFirst': 'Каб выбраць крыніцу гуку, падключыцеся да OBS',
  'settings.audio.waiting': 'Чакаю гук ад OBS…',
  'settings.overlay': 'Оверлей',
  'settings.overlay.help':
    'Оверлей — гэта палоска з назвай песні, якую бачаць гледачы на стрыме. Каб дадаць яе: у OBS у спісе «Источники» націсніце «+», выберыце «Браузер», устаўце гэты адрас у поле URL, пастаўце шырыню 520 і вышыню 170. Пасля гэтага палоску можна перасоўваць і змяняць яе памер у кожнай сцэне, як любую іншую крыніцу',
  'settings.overlay.copy': 'Капіяваць',
  'settings.overlay.copied': 'Скапіявана',
  'settings.rules': 'Правілы заказаў',
  'settings.rules.help':
    'Як гледачы заказваюць песні за баллы канала Twitch. Цана — колькі баллаў каштуе адзін заказ. Максімальная даўжыня — даўжэйшыя песні не прымаюцца. Песень аднаго гледача — колькі заказаў аднаго чалавека можа адначасова чакаць у чарзе. Explicit — песні з пазнакай ненарматыўнага зместу. Калі заказ не падыходзіць пад правілы, баллы вяртаюцца гледачу аўтаматычна',
  'settings.rules.price': 'Цана, баллаў канала',
  'settings.rules.maxDuration': 'Максімальная даўжыня, хвілін',
  'settings.rules.maxPerUser': 'Песень аднаго гледача ў чарзе',
  'settings.rules.allowExplicit': 'Дазволіць explicit',
  'settings.accounts': 'Падключэнні',
  'settings.accounts.help':
    'Spotify патрэбны, каб док бачыў, што грае, і мог кіраваць музыкай. Twitch — каб прымаць заказы песень за баллы канала і адказваць гледачам у чаце ад вашага імя. Кнопкі запрацуюць у наступных версіях',
  'settings.accounts.spotify': 'Падключыць Spotify',
  'settings.accounts.twitch': 'Падключыць Twitch',

  'diag.brain': 'Дзе працуе бот',
  'diag.brain.help':
    'Бот — гэта частка прыкладання, якая вядзе чаргу песень, падключаецца да OBS і перадае хвалю ў оверлей. Ён працуе ў адной са старонак — у доку або ў оверлеі, таму не спыняецца, калі док закрыты. Калі старонка з ботам зачыняецца, яго адразу падхоплівае іншая, і чарга захоўваецца. Кнопкі дока працуюць аднолькава, дзе б ні быў бот',
  'diag.brain.since': 'з {time}',
  'diag.brain.locks': 'Выбар старонкі для бота: Web Locks',
  'diag.brain.noLocks': 'Браўзер не ўмее выбіраць старонку для бота, таму бот працуе толькі ў доку',
  'diag.brain.conflicts': 'Увага: заўважаны другі бот (паведамленняў: {n})',
  'brain.none': 'Бот зараз нідзе не працуе',
  'brain.here.dock': 'Бот працуе ў гэтым доку',
  'brain.here.overlay': 'Бот працуе ў гэтым оверлеі',
  'brain.in.dock': 'Бот працуе ў доку',
  'brain.in.overlay': 'Бот працуе ў оверлеі',
  'brain.in.otherOverlay': 'Бот працуе ў іншым оверлеі',

  'diag.env': 'Асяроддзе',
  'diag.env.help': 'Дзе адкрыты док і якім спосабам бот перадае даныя оверлею',
  'diag.env.obs': 'Браўзер OBS',
  'diag.env.notObs': 'Звычайны браўзер (не OBS)',
  'diag.channel': 'Канал да оверлея',
  'diag.channel.stats': 'адпраўлена: {sent}, памылак: {errors}',
  'diag.obsVersion': 'obs-websocket {version}',
  'diag.hidden': 'Ці працуе схаваны док',
  'diag.hidden.help':
    'Праверка, ці працуе док, калі яго не відаць. Закрыйце або схавайце док на 6–7 хвілін і глядзіце на оверлей: песні павінны мяняцца ў свой час, хваля — рухацца. Потым адкрыйце док і вярніцеся сюды: тут будзе запісана, ці спыняўся док і ці перазагружаў яго OBS',
  'diag.hidden.visibility': 'Стан старонкі зараз',
  'diag.hidden.visible': 'бачная',
  'diag.hidden.hiddenNow': 'схаваная',
  'diag.hidden.none': 'Док яшчэ ні разу не хаваўся',
  'diag.hidden.period': 'Схаваны {duration}',
  'diag.hidden.mainGap': 'звычайны таймер: найбольшы перапынак {gap}',
  'diag.hidden.workerGap': 'worker-таймер: {gap}',
  'diag.hidden.obsEvents': 'падзей ад OBS: {n}',
  'diag.hidden.session': 'Док загружаны ў {loaded}, папярэдні раз быў жывы да {prev}',
  'diag.hidden.firstLoad': 'Док загружаны ў {loaded} (першы запуск)',
  'diag.hidden.overall': 'За ўвесь час: звычайны таймер — да {main}, worker — да {worker}',
  'diag.redirect': 'Ці праходзіць перанакіраванне',
  'diag.redirect.help':
    'Уваход у Spotify і Twitch будзе працаваць так: док пераходзіць на іх сайт, а потым вяртаецца назад. Кнопка імітуе гэта праз тэставы сайт httpbin.org — док на секунду знікне і вернецца сюды',
  'diag.redirect.run': 'Праверыць перанакіраванне',
  'diag.redirect.ok': 'Працуе: док пайшоў на {host} і вярнуўся, даныя захаваліся ({at})',
  'diag.redirect.lost': 'Док вярнуўся, але даныя страціліся ({at})',
  'diag.redirect.never': 'Яшчэ не правяралася',
  'diag.popup': 'Акно з дока',
  'diag.popup.help': 'Паказвае, дзе OBS адкрывае новыя акны з дока — унутры OBS або ў звычайным браўзеры',
  'diag.popup.run': 'Адкрыць акно',

  'callback.title': 'Вяртанне ў док',
  'callback.redirect': 'Вяртаю ў док…',
  'callback.popup': 'Гэта акно адкрыта з дока. Яго можна закрыць',
  'callback.unknown': 'Тут нічога рабіць не трэба',

  'overlay.debug.waiting': 'Чакаю даныя ад бота…',
  'overlay.debug.channel': 'канал: {channel}',
  'overlay.debug.age': 'апошняе паведамленне: {age} таму',
  'overlay.debug.ping': 'сігнал бота: {age} таму',
  'overlay.debug.storage.seen': 'localStorage дока бачны',
  'overlay.debug.storage.notSeen': 'localStorage дока НЕ бачны',
  'overlay.debug.locks.yes': 'Web Locks ёсць',
  'overlay.debug.locks.no': 'Web Locks няма',
  'overlay.debug.conflicts': 'УВАГА: другі бот, {n}',
  'overlay.debug.obs': 'запасное падключэнне да OBS: {status}',

  'index.title': 'Spotify-бот для OBS',
  'index.dock': 'Док',
  'index.overlay': 'Оверлей',
  'index.overlayDebug': 'Оверлей з дыягностыкай',
  'index.overlayDemo': 'Оверлей з тэставымі данымі',

  'time.seconds': '{n} с',
  'time.minutes': '{m} хв {s} с',
} as const;

export type MessageKey = keyof typeof be;
