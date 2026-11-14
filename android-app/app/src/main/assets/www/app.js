// Режим работы: десктопное приложение с локальным сервером или автономный клиент (Android / file://)
const isStandaloneApp = window.location.protocol === 'file:' || 
                        window.location.hostname === 'appassets.androidplatform.net' || 
                        navigator.userAgent.includes('DodoMusicAndroid');

// Нативный HTML5 Audio + HLS.js + Web Audio API анализатор баса
const audioPlayer = new Audio();
audioPlayer.crossOrigin = 'anonymous';
audioPlayer.preload = 'auto';

// Автоматическое восстановление при сетевых ошибках или блокировках потока
audioPlayer.addEventListener('error', async () => {
    const rawSrc = audioPlayer.getAttribute('src');
    if (!rawSrc) return;
    const track = getActiveTrack();
    if (!track) return;
    const errReqId = playbackRequestCounter;
    console.warn('[AudioPlayer] Playback error encountered on track:', track.title, audioPlayer.error);
    if (track._hadPlaybackError) {
        showSystemNotification('Ошибка трека', `Не удалось воспроизвести «${decodeHtml(track.title)}»`, 'warn');
        return;
    }
    track._hadPlaybackError = true;

    // Резервная попытка через локальный прокси на ПК
    if (!isStandaloneApp && rawSrc && !rawSrc.includes('/api/stream-proxy')) {
        try {
            if (errReqId !== playbackRequestCounter) return;
            audioPlayer.src = `/api/stream-proxy?url=${encodeURIComponent(rawSrc)}`;
            await audioPlayer.play();
            return;
        } catch (_) {}
    }

    // Резервная попытка через Audius (если ещё играет этот же запрос)
    try {
        if (errReqId !== playbackRequestCounter) return;
        const query = `${track.artist || ''} ${track.title || ''}`.trim();
        if (query) {
            const audMatches = await searchAudiusDirectly(query);
            if (errReqId !== playbackRequestCounter) return;
            if (audMatches.length > 0 && audMatches[0].streamUrl) {
                audioPlayer.src = audMatches[0].streamUrl;
                await audioPlayer.play();
                showSystemNotification('Резервный поток', `Воспроизведение через Audius: ${decodeHtml(track.title)}`, 'info');
                return;
            }
        }
    } catch (_) {}
});

let currentHls = null;
let audioCtx = null;
let analyser = null;
let freqData = null;

function initAudioAnalyser() {
    if (audioCtx) return;
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass();
        const source = audioCtx.createMediaElementSource(audioPlayer);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.78;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        freqData = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
        console.warn('Web Audio API init warning:', e);
    }
}

// SVG иконки для кнопок воспроизведения
const SVG_PLAY = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const SVG_PAUSE = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

let discoverTracks = [];
let currentQueue = [];
let currentIndex = -1;
let currentTrack = null;
let playbackRequestCounter = 0;
let activeLyricsRequestId = 0;
let activeArtistRequestId = 0;
let isPlaying = false;
let isShuffle = false;
let isRepeat = false;
let isAutoWave = true;
let isFetchingRelated = false;
let waveQueue = [];
let lastRelatedTrackId = null;

function getActiveTrack() {
    return currentTrack || (currentIndex >= 0 ? currentQueue[currentIndex] : null) || null;
}

const defaultSettings = {
    wallpaper: 'aurora',
    accentColor: '#1ed760',
    moveOnMusic: true,
    autoColor: true,
    bassIntensity: 130,
    glassOpacity: 62,
    language: 'ru',
};

let userSettings = {
    ...defaultSettings,
    ...JSON.parse(localStorage.getItem('dodomusic_settings') || '{}'),
};

// ==========================================
// МНОГОЯЗЫЧНЫЙ ИНТЕРФЕЙС (i18n: RU / EN)
// ==========================================
const I18N = {
    ru: {
        nav_discover: 'Главная',
        nav_wave: 'Моя волна',
        nav_favorites: 'Мне нравится',
        nav_history: 'История',
        nav_settings: 'Настройки',
        vibe_ready: 'Готов к воспроизведению',
        vibe_playing: 'Воспроизведение',
        search_placeholder: 'Поиск треков, альбомов и исполнителей...',
        search_btn: 'Найти',
        search_history_title: 'История поиска',
        clear_history_btn: 'Очистить всё',
        taste_dna_title: 'ДНК Вашего Вкуса (Анализ предпочтений)',
        update_badge_ok: 'Актуально',
        chart_top_hits: '🟢 Мировой ТОП хитов',
        chart_russia_hits: '🔥 Главный хит-парад',
        tag_hit_day: 'ХИТ ДНЯ',
        tag_top_hits: 'ТОП ХИТЫ',
        tag_trends: 'ТРЕНДЫ',
        tag_world_top: 'МИРОВОЙ ТОП',
        results_heading_top: 'Популярные треки',
        results_subtitle: 'Нажмите на обложку для воспроизведения',
        smart_wave_active: 'Умная волна активна • Играет микс похожих треков',
        wave_pill: 'Бесконечная волна • Умный рандом',
        wave_title: 'Моя Волна: Рандом по песням',
        wave_desc: 'Выберите любой трек (например, «девочка в каре» или «сайт») или воспользуйтесь поиском ниже, а плеер сам подберёт бесконечную цепочку похожих композиций, артистов и ритмов без остановки.',
        wave_search_start_btn: 'Найти и запустить',
        wave_chips_label: 'Жанры волны:',
        start_wave_btn: 'Запустить волну',
        refresh_wave_btn: 'Обновить подборку',
        wave_queue_heading: 'В очереди волны',
        wave_queue_sub: 'Следующие композиции волны (нажмите ✕ на карточке, чтобы удалить трек)',
        clear_wave_btn: 'Очистить волну',
        artist_badge: 'Исполнитель',
        artist_stats: 'Официальная дискография',
        play_all_btn: 'Слушать всё',
        artist_wave_btn: 'Волна артиста',
        source_btn: 'Источник',
        artist_all_tracks: 'Все треки артиста',
        artist_top_tracks: 'Популярные композиции',
        fav_heading: 'Мне нравится',
        fav_subtitle: 'Ваша коллекция любимых песен',
        hist_heading: 'Недавно прослушано',
        hist_subtitle: 'История воспроизведения',
        settings_heading: 'Настройки и Видео-обои',
        settings_sub: 'Персонализация DodoMusic',
        settings_wallpapers: 'Анимированные видео-обои',
        settings_wallpapers_hint: 'Выберите живую видео-сцену для фона приложения',
        wp_aurora: 'Северное Сияние',
        wp_dodo: 'Огненный Пульс',
        wp_synth: 'Киберпанк Сетка',
        wp_galaxy: 'Глубокий Космос',
        wp_phonk: 'Ночной Фонк',
        settings_color_music: 'Цвет и реакция на музыку',
        settings_move_on_music: 'Движение обоев только когда играет музыка',
        settings_move_on_music_sub: 'Обои оживают и пульсируют под реальный бас песни во время воспроизведения',
        settings_auto_color: 'Автоматически подбирать цвет интерфейса под видео-обои',
        settings_auto_color_sub: 'Кнопки, подсветка карточек, ползунки и эквалайзер окрашиваются в тон обоев',
        settings_accent_color: 'Свой цвет акцента',
        settings_accent_color_sub: 'Выберите любой фирменный оттенок вручную',
        settings_bass_intensity: 'Сила басовой пульсации обоев',
        settings_bass_intensity_sub: 'Насколько сильно видео-обои реагируют на бит песни',
        settings_glass_opacity: 'Прозрачность стеклянного интерфейса',
        settings_glass_sub: 'Регулирует видимость живых видео-обоев сквозь панели',
        settings_lang: 'Язык интерфейса / Interface Language',
        settings_lang_hint: 'Выберите основной язык приложения',
        settings_legal: 'Правовая информация и конфиденциальность',
        settings_legal_hint: 'Защита товарных знаков, политика приватности и отказ от ответственности',
        legal_summary: '<b>DodoMusic</b> — полностью независимый проект с открытым исходным кодом. Не аффилирован и не связан со Third-Party Services или Dodo Brands. Ваши данные хранятся на 100% локально на вашем ПК (Zero Telemetry).',
        open_privacy_btn: 'Политика конфиденциальности',
        open_disclaimer_btn: 'Товарные знаки и Disclaimer',
        settings_updates: 'Обновления DodoMusic',
        settings_updates_hint: 'Проверка новых версий и релизов на GitHub',
        version_chip: 'Версия v1.5',
        update_status_ok: 'Актуальная версия',
        update_notes: 'DodoMusic v1.5 — Точный поиск текстов с проверкой исполнителя, защита очереди от сбоев при поиске и скачивание треков внутри приложения.',
        check_updates_btn: 'Проверить обновления',
        github_releases_btn: 'Релизы на GitHub',
        player_select_track: 'Выберите песню',
        legal_close_btn: 'Понятно',
        lyrics_modal_title: 'Текст песни',
        lyrics_status_synced: 'Караоке синхронизация',
        lyrics_status_plain: 'Текст песни',
        lyrics_now_playing: 'Сейчас играет',
        lyrics_not_playing: 'Не играет',
        lyrics_play_sync: 'Слушать с текстом',
        lyrics_edit_query: 'Уточнить текст',
        lyrics_autoscroll_on: 'Автопрокрутка: ВКЛ',
        lyrics_autoscroll_off: 'Автопрокрутка: ВЫКЛ',
        lyrics_loading: 'Поиск синхронизированного текста песни...',
        lyrics_empty_title: 'Текст песни пока не найден',
        lyrics_empty_desc: 'Для данного трека текст в базе пока отсутствует или исполнитель указан иначе. Нажмите «Уточнить текст», чтобы найти вручную.',
        lyrics_hint: '💡 Нажмите на любую строчку текста, чтобы перейти к этому моменту в песне',
        lyrics_btn_title: 'Текст песни и караоке (L)',
    },
    en: {
        nav_discover: 'Discover',
        nav_wave: 'My Wave',
        nav_favorites: 'Favorites',
        nav_history: 'History',
        nav_settings: 'Settings',
        vibe_ready: 'Ready to play',
        vibe_playing: 'Now playing',
        search_placeholder: 'Search tracks, albums and artists...',
        search_btn: 'Search',
        search_history_title: 'Recent Searches',
        clear_history_btn: 'Clear All',
        taste_dna_title: 'Taste DNA (Preference Analysis)',
        update_badge_ok: 'Up to date',
        chart_top_hits: '🟢 Top Chart Hits',
        chart_russia_hits: '🔥 Chart Hit Parade',
        tag_hit_day: 'HIT OF THE DAY',
        tag_top_hits: 'TOP HITS',
        tag_trends: 'TRENDING',
        tag_world_top: 'WORLD TOP',
        results_heading_top: 'Trending Tracks',
        results_subtitle: 'Click on album cover to play',
        smart_wave_active: 'Smart Wave active • Mixing similar tracks',
        wave_pill: 'Infinite Wave • Smart Random',
        wave_title: 'My Wave: Smart Song Flow',
        wave_desc: 'Select any track or genre, or use the search bar below, and DodoMusic will automatically synthesize an infinite stream of matching artists, rhythms and melodies without interruptions.',
        wave_search_start_btn: 'Search & Launch Wave',
        wave_chips_label: 'Wave Genres:',
        start_wave_btn: 'Start Wave',
        refresh_wave_btn: 'Refresh Mix',
        wave_queue_heading: 'Wave Queue',
        wave_queue_sub: 'Next wave tracks (click ✕ on any card to remove it)',
        clear_wave_btn: 'Clear Wave',
        artist_badge: 'Artist',
        artist_stats: 'Official Discography',
        play_all_btn: 'Play All',
        artist_wave_btn: 'Artist Wave',
        source_btn: 'Source',
        artist_all_tracks: 'All Artist Tracks',
        artist_top_tracks: 'Popular tracks',
        fav_heading: 'Favorites',
        fav_subtitle: 'Your personal collection of favorite tracks',
        hist_heading: 'Recently Played',
        hist_subtitle: 'Listening history',
        settings_heading: 'Settings & Live Wallpapers',
        settings_sub: 'Customize your DodoMusic experience',
        settings_wallpapers: 'Animated Live Wallpapers',
        settings_wallpapers_hint: 'Select dynamic video background for the application',
        wp_aurora: 'Northern Lights',
        wp_dodo: 'Fire Pulse',
        wp_synth: 'Cyberpunk Grid',
        wp_galaxy: 'Deep Space',
        wp_phonk: 'Night Phonk',
        settings_color_music: 'Colors & Music Reactivity',
        settings_move_on_music: 'Animate background only while playing music',
        settings_move_on_music_sub: 'Wallpaper pulsates and dances to the live bass of the current track',
        settings_auto_color: 'Automatically match interface accent to wallpaper',
        settings_auto_color_sub: 'Buttons, card glows, sliders and equalizer adapt to the wallpaper colors',
        settings_accent_color: 'Custom Accent Color',
        settings_accent_color_sub: 'Select your preferred brand accent manually',
        settings_bass_intensity: 'Bass Reactivity Intensity',
        settings_bass_intensity_sub: 'Control how strongly the visualizer reacts to drum beats',
        settings_glass_opacity: 'Glass UI Opacity',
        settings_glass_sub: 'Adjust transparency of panels over the live video scene',
        settings_lang: 'Interface Language / Язык интерфейса',
        settings_lang_hint: 'Select the primary application language',
        settings_legal: 'Legal Information & Privacy Policy',
        settings_legal_hint: 'Trademark protection, disclaimer and privacy notices',
        legal_summary: '<b>DodoMusic</b> is a fully independent open-source desktop client. It is NOT affiliated with, sponsored by, or endorsed by Third-Party Services or Dodo Brands. All user data is stored 100% locally on your computer (Zero Telemetry).',
        open_privacy_btn: 'Privacy Policy',
        open_disclaimer_btn: 'Trademarks & Disclaimer',
        settings_updates: 'DodoMusic Updates',
        settings_updates_hint: 'Check GitHub releases for new updates',
        version_chip: 'Version v1.5',
        update_status_ok: 'Up to date',
        update_notes: 'DodoMusic v1.5 — Strict artist-verified lyrics matching, isolated search vs. playback queue, and in-app track downloads.',
        check_updates_btn: 'Check for Updates',
        github_releases_btn: 'GitHub Releases',
        player_select_track: 'Select a track',
        legal_close_btn: 'Got it',
        lyrics_modal_title: 'Song Lyrics',
        lyrics_status_synced: 'Karaoke Synced',
        lyrics_status_plain: 'Song Lyrics',
        lyrics_now_playing: 'Now playing',
        lyrics_not_playing: 'Not playing',
        lyrics_play_sync: 'Play with Lyrics',
        lyrics_edit_query: 'Refine Search',
        lyrics_autoscroll_on: 'Autoscroll: ON',
        lyrics_autoscroll_off: 'Autoscroll: OFF',
        lyrics_loading: 'Searching for synchronized lyrics...',
        lyrics_empty_title: 'Lyrics not found',
        lyrics_empty_desc: 'No matching lyrics found for this artist and title yet. Click "Refine Search" above to search manually.',
        lyrics_hint: '💡 Click any line to jump to that moment in the song',
        lyrics_btn_title: 'Lyrics & Karaoke (L)',
    }
};

const LEGAL_DOCS = {
    ru: {
        privacy: `
            <h3>Политика конфиденциальности DodoMusic</h3>
            <p style="color:var(--text-secondary); font-size:12px; margin-bottom:14px;">Редакция от 8 ноября 2026 г. • Zero Telemetry Standard</p>
            <h4>1. Принцип нулевой телеметрии (Zero Telemetry)</h4>
            <p>DodoMusic не собирает, не профилирует, не анализирует и не передает на какие-либо удаленные серверы ваши личные данные, IP-адреса, историю запросов или диагностическую телеметрию.</p>
            <h4>2. 100% локальное хранение данных</h4>
            <p>Вся ваша медиатека, история прослушиваний, плейлисты и отметки «Мне нравится» хранятся <b>исключительно локально</b> в файле <code>dodomusic_library.json</code> в папке вашего профиля Windows (<code>%APPDATA%\\DodoMusic</code>). Вы имеете полный суверенный контроль над своими данными.</p>
            <h4>3. Воспроизведение и проксирование</h4>
            <p>Приложение воспроизводит аудиопотоки напрямую из открытых публичных веб-источников (SoundCloud, Audius, публичные превью) через локальный встроенный прокси-сервер на вашем ПК. Никакие рекламные трекеры, cookie или персональные идентификаторы не используются.</p>
        `,
        disclaimer: `
            <h3>Товарные знаки и отказ от ответственности</h3>
            <p style="color:var(--text-secondary); font-size:12px; margin-bottom:14px;">Уведомление о правовом статусе и защите интеллектуальной собственности</p>
            <h4>1. Полная независимость от Third-Party Services и Dodo Brands</h4>
            <p><b>DodoMusic</b> является независимым проектом с открытым исходным кодом (Open Source), созданным исключительно в исследовательских и образовательных целях.</p>
            <p>Проект <b>НЕ ЯВЛЯЕТСЯ</b> официальным продуктом, не аффилирован, не спонсируется, не одобряется и никак не связан с корпорацией <b>Third-Party Services</b>, сервисом Chart или компанией <b>Dodo Brands</b>.</p>
            <h4>2. Товарные знаки и добросовестное использование (Nominative Fair Use)</h4>
            <p>«Chart», логотипы Chart и фирменный визуальный стиль являются зарегистрированными товарными знаками компании <b>Third-Party Services</b>. Название «Dodo» и связанный бренд являются собственностью <b>Dodo Brands</b>.</p>
            <p>Название «DodoMusic» является оригинальным фантазийным наименованием (отсылка к редкой птице Додо как символу уникальности и звуковым точкам воспроизведения «spots»). Любые упоминания сторонних брендов в интерфейсе носят строго описательный характер (Nominative Fair Use) для информирования пользователя об открытых источниках каталогов.</p>
            <h4>3. DMCA и связь с автором</h4>
            <p>DodoMusic не осуществляет хостинг и хранение защищённых аудиофайлов на внешних серверах. Все аудиопотоки доставляются через публичные легальные API. Контакт для правообладателей: <b>foridorpo@gmail.com</b>.</p>
        `
    },
    en: {
        privacy: `
            <h3>DodoMusic Privacy Policy</h3>
            <p style="color:var(--text-secondary); font-size:12px; margin-bottom:14px;">Effective Date: November 8, 2026 • Zero Telemetry Standard</p>
            <h4>1. Zero Telemetry Principle</h4>
            <p>DodoMusic is engineered around strict privacy standards. The application does not collect, track, profile, log, or transmit any user behavior, IP addresses, search queries, or telemetry data to any external servers.</p>
            <h4>2. 100% Local-First Storage</h4>
            <p>All your favorite tracks, playback history, preferences, and queue data are stored <b>100% locally</b> in <code>dodomusic_library.json</code> within your Windows user profile (<code>%APPDATA%\\DodoMusic</code>). You retain absolute control of your files.</p>
            <h4>3. Streaming & Local Proxying</h4>
            <p>Audio playback is performed by querying public streaming endpoints (SoundCloud, Audius, public previews) via a local loopback server on your machine. No third-party tracking cookies or advertising SDKs are present.</p>
        `,
        disclaimer: `
            <h3>Trademarks & Legal Disclaimer</h3>
            <p style="color:var(--text-secondary); font-size:12px; margin-bottom:14px;">Notice of Non-Affiliation and Intellectual Property Rights</p>
            <h4>1. Non-Affiliation with Third-Party Services or Dodo Brands</h4>
            <p><b>DodoMusic</b> is an independent, non-commercial, open-source desktop client created for educational and personal entertainment purposes.</p>
            <p>DodoMusic is <b>NOT affiliated with, sponsored by, authorized by, endorsed by, or in any way officially connected with Third-Party Services</b>, Chart, or Dodo Brands.</p>
            <h4>2. Trademark Notice & Nominative Fair Use</h4>
            <p>The name "Chart", the Chart logo, and related trademarks are registered trademarks of <b>Third-Party Services</b>. The name "Dodo" and related trademarks are properties of <b>Dodo Brands</b>.</p>
            <p>The project name "DodoMusic" is an independent creation (joining the extinct Dodo bird as an emblem of individuality and "spot" referencing acoustic cue points). References to third-party services are made strictly for identification purposes under Nominative Fair Use.</p>
            <h4>3. Copyright & DMCA Inquiries</h4>
            <p>DodoMusic does not host, distribute, or store copyrighted music files. Media streams originate from publicly accessible provider APIs. For intellectual property inquiries: <b>foridorpo@gmail.com</b>.</p>
        `
    }
};

function applyLanguage(lang) {
    const dict = I18N[lang] || I18N.ru;

    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.dataset.i18n;
        if (dict[key]) {
            el.innerHTML = dict[key];
        }
    });

    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
        const key = el.dataset.i18nPh;
        if (dict[key]) {
            el.placeholder = dict[key];
        }
    });

    document.querySelectorAll('.lang-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    document.title = `DodoMusic - ${lang === 'ru' ? 'Свободная музыка' : 'Free Music Player'}`;
}

let favorites = JSON.parse(localStorage.getItem('dodomusic_favorites') || '[]');
let historyList = JSON.parse(localStorage.getItem('dodomusic_history') || '[]');

// DOM элементы
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const tracksContainer = document.getElementById('tracksContainer');
const favoritesContainer = document.getElementById('favoritesContainer');
const historyContainer = document.getElementById('historyContainer');
const resultsHeading = document.getElementById('resultsHeading');
const resultsCount = document.getElementById('resultsCount');
const vibeStatusText = document.getElementById('vibeStatusText');

const autoWaveBtn = document.getElementById('autoWaveBtn');
const smartWaveBanner = document.getElementById('smartWaveBanner');
const smartWaveStatusText = document.getElementById('smartWaveStatusText');
const waveTracksContainer = document.getElementById('waveTracksContainer');
const startSmartWaveBtn = document.getElementById('startSmartWaveBtn');
const refreshWaveBtn = document.getElementById('refreshWaveBtn');
const waveTitle = document.getElementById('waveTitle');
const waveDesc = document.getElementById('waveDesc');

const playerCover = document.getElementById('playerCover');
const playerTitle = document.getElementById('playerTitle');
const playerArtist = document.getElementById('playerArtist');
const likeCurrentBtn = document.getElementById('likeCurrentBtn');
const openSourceBtn = document.getElementById('openSourceBtn');
const playPauseBtn = document.getElementById('playPauseBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const repeatBtn = document.getElementById('repeatBtn');
const seekBar = document.getElementById('seekBar');
const currentTimeEl = document.getElementById('currentTimeEl');
const durationTimeEl = document.getElementById('durationTimeEl');
const volumeBar = document.getElementById('volumeBar');
const muteBtn = document.getElementById('muteBtn');

// Страница артиста
const tabArtist = document.getElementById('tab-artist');
const artistHeroBg = document.getElementById('artistHeroBg');
const artistAvatar = document.getElementById('artistAvatar');
const artistNameTitle = document.getElementById('artistNameTitle');
const artistStats = document.getElementById('artistStats');
const artistSourceLink = document.getElementById('artistSourceLink');
const playAllArtistBtn = document.getElementById('playAllArtistBtn');
const radioArtistBtn = document.getElementById('radioArtistBtn');
const artistTracksContainer = document.getElementById('artistTracksContainer');
const artistTracksCount = document.getElementById('artistTracksCount');
const mainContent = document.querySelector('.main-content');

function updateSliderFill(slider) {
    if (!slider) return;
    const val = Number(slider.value) || 0;
    const max = Number(slider.max) || 100;
    const min = Number(slider.min) || 0;
    const pct = ((val - min) / (max - min)) * 100;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#1ed760';
    slider.style.background = `linear-gradient(to right, ${accent} ${pct}%, rgba(255, 255, 255, 0.2) ${pct}%)`;
}

function syncPlayPauseUI() {
    const activeTrack = getActiveTrack();
    const actuallyPlaying = Boolean(!audioPlayer.paused && !audioPlayer.ended && audioPlayer.readyState > 1);
    isPlaying = actuallyPlaying || (!audioPlayer.paused && audioPlayer.currentTime > 0);

    playPauseBtn.innerHTML = isPlaying ? SVG_PAUSE : SVG_PLAY;

    document.querySelectorAll('.track-card').forEach((card) => {
        const isCurrent = activeTrack && card.dataset.trackid === activeTrack.id;
        card.classList.toggle('playing', Boolean(isCurrent));
        const overlay = card.querySelector('.play-overlay');
        if (overlay) {
            overlay.innerHTML = isCurrent && isPlaying ? SVG_PAUSE : SVG_PLAY;
        }
    });

    if (vibeStatusText) {
        if (isPlaying) {
            vibeStatusText.textContent = 'Воспроизведение • Обои активны';
        } else if (activeTrack) {
            vibeStatusText.textContent = userSettings.moveOnMusic
                ? 'На паузе • Обои замерли'
                : 'На паузе';
        } else {
            vibeStatusText.textContent = 'Готов к воспроизведению';
        }
    }

    if (typeof updateLyricsPlaySyncButtonState === 'function') {
        updateLyricsPlaySyncButtonState();
    }

    // Синхронизация с системным виджетом экрана блокировки и шторки Android
    if (window.AndroidBridge && typeof window.AndroidBridge.updateMediaNotification === 'function') {
        if (activeTrack) {
            window.AndroidBridge.updateMediaNotification(
                activeTrack.title || 'DodoMusic',
                activeTrack.artist || 'Свободная музыка',
                activeTrack.thumbnail || '',
                Boolean(isPlaying)
            );
        } else {
            if (typeof window.AndroidBridge.closeMediaNotification === 'function') {
                window.AndroidBridge.closeMediaNotification();
            }
        }
    }
}

const savedVolume = localStorage.getItem('dodomusic_volume');
if (savedVolume !== null && !isNaN(Number(savedVolume)) && volumeBar) {
    volumeBar.value = savedVolume;
}
audioPlayer.volume = Number(volumeBar.value) / 100;
updateSliderFill(volumeBar);
updateSliderFill(seekBar);

// События HTML5 Audio с жесткой синхронизацией состояния плеера
audioPlayer.addEventListener('play', () => {
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    syncPlayPauseUI();
});

audioPlayer.addEventListener('playing', syncPlayPauseUI);
audioPlayer.addEventListener('pause', syncPlayPauseUI);
audioPlayer.addEventListener('waiting', syncPlayPauseUI);

audioPlayer.addEventListener('timeupdate', () => {
    const current = audioPlayer.currentTime || 0;
    const track = getActiveTrack();
    const dur = (audioPlayer.duration && !isNaN(audioPlayer.duration) && audioPlayer.duration > 0)
        ? audioPlayer.duration
        : (track?.durationSeconds || 180);

    if (dur > 0) {
        seekBar.value = ((current / dur) * 100).toFixed(2);
        currentTimeEl.textContent = formatTime(current);
        durationTimeEl.textContent = formatTime(dur);
        updateSliderFill(seekBar);
    }

    syncLyricsWithTime(current);
});

audioPlayer.addEventListener('ended', () => {
    if (isRepeat) {
        audioPlayer.currentTime = 0;
        audioPlayer.play();
    } else {
        playNext();
    }
});

function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ==========================================
// ИСТОРИЯ ПОИСКА (SEARCH HISTORY)
// ==========================================
function getSearchHistory() {
    try {
        const raw = localStorage.getItem('dodomusic_search_history');
        return raw ? JSON.parse(raw) : [];
    } catch (_) {
        return [];
    }
}

function saveSearchHistoryQuery(query) {
    const q = (query || '').trim();
    if (!q || q.length < 2) return;
    let list = getSearchHistory();
    list = list.filter(item => item.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    if (list.length > 12) list = list.slice(0, 12);
    try {
        localStorage.setItem('dodomusic_search_history', JSON.stringify(list));
    } catch (_) {}
}

function deleteSearchHistoryQuery(query) {
    let list = getSearchHistory();
    list = list.filter(item => item.toLowerCase() !== (query || '').toLowerCase());
    try {
        localStorage.setItem('dodomusic_search_history', JSON.stringify(list));
    } catch (_) {}
}

function clearAllSearchHistory() {
    try {
        localStorage.removeItem('dodomusic_search_history');
    } catch (_) {}
}

function renderSearchHistoryDropdown(dropdownEl, listEl, inputEl, onSearch) {
    if (!dropdownEl || !listEl) return;
    const historyList = getSearchHistory();

    if (!historyList || historyList.length === 0) {
        listEl.innerHTML = `<div class="search-history-empty">История поиска пуста</div>`;
        dropdownEl.style.display = 'block';
        return;
    }

    listEl.innerHTML = historyList.map(q => `
        <div class="search-history-item" data-query="${encodeURIComponent(q)}">
            <svg class="search-history-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            <span class="search-history-text">${escapeHtml(decodeHtml(q))}</span>
            <button type="button" class="search-history-delete-btn" title="Удалить из истории">✕</button>
        </div>
    `).join('');

    listEl.querySelectorAll('.search-history-item').forEach(item => {
        const qText = decodeURIComponent(item.dataset.query);
        const textSpan = item.querySelector('.search-history-text');
        const delBtn = item.querySelector('.search-history-delete-btn');

        textSpan?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (inputEl) inputEl.value = qText;
            dropdownEl.style.display = 'none';
            if (onSearch) onSearch(qText);
        });

        delBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteSearchHistoryQuery(qText);
            renderSearchHistoryDropdown(dropdownEl, listEl, inputEl, onSearch);
        });
    });

    dropdownEl.style.display = 'block';
}

// ==========================================
// СИСТЕМА АНАЛИЗА ВКУСА (USER TASTE PROFILER)
// ==========================================
function getUserTasteProfile() {
    const artistScores = {};
    const genreScores = {
        'Рэп / Хип-Хоп': 0,
        'Фонк / Drift': 0,
        'Поп / Тренды': 0,
        'Рок / Альтернатива': 0,
        'Chill / Lo-Fi': 0,
        'Мировые хиты': 0
    };

    (favorites || []).forEach(t => {
        if (!t) return;
        const art = (t.artist || '').trim();
        if (art) artistScores[art] = (artistScores[art] || 0) + 3;

        const text = `${t.artist} ${t.title}`.toLowerCase();
        if (text.includes('phonk') || text.includes('drift')) genreScores['Фонк / Drift'] += 3;
        else if (text.includes('рэп') || text.includes('rap') || text.includes('kme') || text.includes('macan') || text.includes('miyagi') || text.includes('buda')) genreScores['Рэп / Хип-Хоп'] += 3;
        else if (text.includes('рок') || text.includes('rock') || text.includes('metal')) genreScores['Рок / Альтернатива'] += 3;
        else if (text.includes('lofi') || text.includes('chill')) genreScores['Chill / Lo-Fi'] += 3;
        else if (text.includes('weeknd') || text.includes('travis') || text.includes('scott')) genreScores['Мировые хиты'] += 3;
        else genreScores['Поп / Тренды'] += 2;
    });

    (historyList || []).forEach(t => {
        if (!t) return;
        const art = (t.artist || '').trim();
        if (art) artistScores[art] = (artistScores[art] || 0) + 1;

        const text = `${t.artist} ${t.title}`.toLowerCase();
        if (text.includes('phonk') || text.includes('drift')) genreScores['Фонк / Drift'] += 1;
        else if (text.includes('рэп') || text.includes('rap') || text.includes('kme') || text.includes('macan') || text.includes('miyagi') || text.includes('buda')) genreScores['Рэп / Хип-Хоп'] += 1;
        else if (text.includes('рок') || text.includes('rock') || text.includes('metal')) genreScores['Рок / Альтернатива'] += 1;
        else if (text.includes('lofi') || text.includes('chill')) genreScores['Chill / Lo-Fi'] += 1;
        else if (text.includes('weeknd') || text.includes('travis') || text.includes('scott')) genreScores['Мировые хиты'] += 1;
        else genreScores['Поп / Тренды'] += 1;
    });

    const sHist = getSearchHistory();
    sHist.forEach(q => {
        const lower = q.toLowerCase();
        if (lower.includes('phonk') || lower.includes('фонк')) genreScores['Фонк / Drift'] += 2;
        else if (lower.includes('рэп') || lower.includes('rap') || lower.includes('хип')) genreScores['Рэп / Хип-Хоп'] += 2;
        else if (lower.includes('рок') || lower.includes('rock')) genreScores['Рок / Альтернатива'] += 2;
        else if (lower.includes('lofi') || lower.includes('chill')) genreScores['Chill / Lo-Fi'] += 2;
        else genreScores['Поп / Тренды'] += 1;
    });

    const topArtists = Object.entries(artistScores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(entry => entry[0]);

    const totalScore = Object.values(genreScores).reduce((a, b) => a + b, 0) || 1;
    const topGenres = Object.entries(genreScores)
        .map(([name, score]) => ({ name, percent: Math.round((score / totalScore) * 100) }))
        .sort((a, b) => b.percent - a.percent);

    let disliked = [];
    try {
        disliked = JSON.parse(localStorage.getItem('dodomusic_disliked_ids') || '[]');
    } catch (_) {}

    return {
        topArtists,
        topGenres,
        dislikedIds: disliked,
        recentSearches: sHist.slice(0, 5)
    };
}

function renderTasteAnalysisUI() {
    const tasteTagsRow = document.getElementById('tasteTagsRow');
    const tasteArtistsText = document.getElementById('tasteArtistsText');
    const tasteStatusText = document.getElementById('tasteStatusText');
    if (!tasteTagsRow) return;

    const profile = getUserTasteProfile();
    const activeGenres = profile.topGenres.filter(g => g.percent > 0).slice(0, 3);

    if (activeGenres.length === 0) {
        tasteTagsRow.innerHTML = `
            <span class="taste-tag highlight">⚡ AI Taste Profiler</span>
            <span class="taste-tag">Слушайте треки, чтобы система обучилась вашему вкусу</span>
        `;
        if (tasteArtistsText) {
            tasteArtistsText.textContent = 'Умная волна адаптируется под каждый прослушанный трек и генерирует рандом без повторов.';
        }
    } else {
        tasteTagsRow.innerHTML = activeGenres.map(g => `
            <span class="taste-tag ${g.percent >= 25 ? 'highlight' : ''}">
                ${g.name} (${g.percent}%)
            </span>
        `).join('');

        if (tasteArtistsText) {
            const favStr = profile.topArtists.length > 0
                ? `Любимые артисты в ротации: ${profile.topArtists.slice(0, 5).join(', ')}`
                : 'Поток строится на основе ваших лайков и прослушиваний';
            tasteArtistsText.textContent = favStr;
        }
    }
}

async function generateClientTasteWave(seedTrack) {
    try {
        const artist = seedTrack.artist || '';
        const title = seedTrack.title || '';
        const queries = [artist, `${artist} feat`, `${artist} remix`, title].filter(Boolean);
        const query = queries[Math.floor(Math.random() * queries.length)] || 'хиты 2024';
        const tracks = await searchMusicDirectly(query);
        return tracks.filter(t => t.id !== seedTrack.id).slice(0, 15);
    } catch (_) {
        return [];
    }
}

async function fetchTasteWaveForTrack(seedTrack) {
    if (!seedTrack) return;
    const tasteProfile = getUserTasteProfile();

    if (smartWaveBanner) {
        smartWaveBanner.style.display = 'inline-flex';
        smartWaveStatusText.textContent = `Умная волна: анализируем вкус под «${decodeHtml(seedTrack.title)}»...`;
    }

    try {
        let tasteTracks = [];
        if (!isStandaloneApp) {
            try {
                const res = await fetch('/api/taste-wave', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        seedTrack: {
                            id: seedTrack.id,
                            title: seedTrack.title,
                            artist: seedTrack.artist,
                            source: seedTrack.source
                        },
                        tasteProfile
                    }),
                    signal: AbortSignal.timeout(6000)
                });
                if (res.ok) {
                    const data = await res.json();
                    tasteTracks = data.tracks || [];
                }
            } catch (_) {}
        }

        if (tasteTracks.length === 0) {
            tasteTracks = await generateClientTasteWave(seedTrack);
        }

        if (tasteTracks.length > 0) {
            const active = getActiveTrack();
            if (active && active.id !== seedTrack.id) return;
            waveQueue = tasteTracks;
            currentTrack = seedTrack;
            currentQueue = [seedTrack].concat(tasteTracks);
            currentIndex = 0;
            renderWaveQueueView();
            renderTasteAnalysisUI();

            if (waveTitle) {
                waveTitle.textContent = `Моя Волна: в стиле «${decodeHtml(seedTrack.title)}»`;
            }
            if (waveDesc) {
                waveDesc.textContent = `Персонализированный автомикс: подобрано ${tasteTracks.length} треков с учётом ваших любимых артистов и стилей.`;
            }
            if (smartWaveBanner) {
                smartWaveStatusText.textContent = `Умная волна активна • В очереди: +${tasteTracks.length} треков по вкусу`;
            }
        }
    } catch (err) {
        console.warn('Ошибка taste-wave, резервный подбор:', err);
        fetchRelatedTracksForCurrent(seedTrack, true);
    }
}

// Поиск музыки (полные треки)

// =======================================================================
// STANDALONE DIRECT CLIENT MUSIC ENGINE (SoundCloud + Audius)
// Provides 100% offline-server capability for Android and PC fallback
// =======================================================================
let currentScClientId = '39AVoiZVrdvJEMFLH8T0c5WGshQaAPRJ';
let lastScClientIdFetch = Date.now();
const BACKUP_SC_CLIENT_IDS = [
    '39AVoiZVrdvJEMFLH8T0c5WGshQaAPRJ'
];

async function getLiveSoundCloudClientId() {
    if (currentScClientId && (Date.now() - lastScClientIdFetch < 3600000)) {
        return currentScClientId;
    }
    try {
        const res = await fetch('https://soundcloud.com', { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
            const html = await res.text();
            const urls = html.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g) || [];
            for (const u of urls.slice(-8)) {
                try {
                    const jsRes = await fetch(u, { signal: AbortSignal.timeout(4000) });
                    if (jsRes.ok) {
                        const js = await jsRes.text();
                        const m = js.match(/client_id[:=]"([a-zA-Z0-9]{32})"/);
                        if (m && m[1]) {
                            currentScClientId = m[1];
                            lastScClientIdFetch = Date.now();
                            return currentScClientId;
                        }
                    }
                } catch (_) {}
            }
        }
    } catch (_) {}
    return currentScClientId || BACKUP_SC_CLIENT_IDS[0];
}

function cleanTrackTitleAndArtist(rawTitle, rawUser) {
    let title = (rawTitle || 'Без названия').replace(/\.(mp3|wav|flac|m4a|ogg)$/i, '').trim();
    let artist = (rawUser || 'Неизвестный исполнитель').trim();

    // Формат "Артист - Название" или "Артист — Название"
    const match = title.match(/^(.+?)\s+[-—–|]\s+(.+)$/);
    if (match && match[1].trim().length >= 2 && match[2].trim().length >= 1) {
        artist = match[1].trim();
        title = match[2].trim();
    }
    return { artist, title };
}

function mapSoundCloudTrack(t) {
    const transcodings = t.media?.transcodings || [];
    const prog = transcodings.find(x => x.format?.protocol === 'progressive');
    const aacHls = transcodings.find(x => x.format?.protocol === 'hls' && x.format?.mime_type?.includes('mp4a'));
    const mpegHls = transcodings.find(x => x.format?.protocol === 'hls' && x.format?.mime_type?.includes('mpeg'));
    const chosen = prog || aacHls || mpegHls || transcodings[0];
    const rawArtwork = t.artwork_url || t.user?.avatar_url || 'icon.png';
    const artwork = rawArtwork.replace('-large.', '-t500x500.');
    const durationSec = Math.round((t.duration || 0) / 1000);

    const { artist, title } = cleanTrackTitleAndArtist(t.title, t.user?.username || t.user?.name);

    return {
        id: 'sc_' + t.id,
        trackId: t.id,
        source: 'soundcloud',
        title: title || 'Без названия',
        artist: artist || 'Неизвестный исполнитель',
        duration: formatTime(durationSec),
        durationSeconds: durationSec,
        thumbnail: artwork,
        transcodingUrl: chosen ? chosen.url : '',
        progressiveUrl: prog ? prog.url : '',
        mpegHlsUrl: mpegHls ? mpegHls.url : '',
        trackAuthorization: t.track_authorization || '',
        protocol: chosen && chosen.format?.protocol === 'hls' ? 'hls' : 'progressive',
        permalinkUrl: t.permalink_url || '#',
        genre: t.genre || '',
        likesCount: t.likes_count || 0,
        playbackCount: t.playback_count || 0
    };
}

// Универсальный сетевой запрос (в браузере обычный fetch, на Android - через нативный мост без CORS)
async function networkFetchText(url, timeoutMs = 7000) {
    if (window.AndroidBridge && typeof window.AndroidBridge.fetchUrl === 'function') {
        try {
            const res = window.AndroidBridge.fetchUrl(url);
            if (res && res.length > 0) return res;
        } catch (e) {
            console.warn('[AndroidBridge fetchUrl warn]', e);
        }
    }
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
}

async function networkFetchJson(url, timeoutMs = 7000) {
    const text = await networkFetchText(url, timeoutMs);
    return JSON.parse(text);
}

async function searchSoundCloudDirectly(query) {
    if (!query || !query.trim()) return [];
    const qLower = query.trim().toLowerCase();
    const wantsRemix = qLower.includes('remix') || qLower.includes('ремикс');
    const wantsSlowed = qLower.includes('slowed') || qLower.includes('bass');

    const cids = [...new Set([
        currentScClientId,
        '39AVoiZVrdvJEMFLH8T0c5WGshQaAPRJ'
    ].filter(Boolean))];

    for (const cid of cids) {
        try {
            const url = 'https://api-v2.soundcloud.com/search/tracks?q=' + encodeURIComponent(query.trim()) + '&client_id=' + cid + '&limit=30';
            const data = await networkFetchJson(url, 6000);
            const items = data?.collection || [];
            if (!items.length) continue;

            const mapped = items
                .filter(t => t.id && t.duration >= 35000 && t.duration <= 900000 && t.media?.transcodings?.length)
                .map(mapSoundCloudTrack);

            // Умная сортировка по максимальной релевантности запросу пользователя
            mapped.sort((a, b) => {
                const aTitle = a.title.toLowerCase();
                const bTitle = b.title.toLowerCase();
                const aArtist = a.artist.toLowerCase();
                const bArtist = b.artist.toLowerCase();
                const aFull = `${aArtist} ${aTitle}`;
                const bFull = `${bArtist} ${bTitle}`;

                let scoreA = 0;
                let scoreB = 0;

                // Точное совпадение
                if (aTitle === qLower) scoreA += 100;
                if (bTitle === qLower) scoreB += 100;

                // Вхождение в название
                if (aTitle.includes(qLower)) scoreA += 60;
                if (bTitle.includes(qLower)) scoreB += 60;

                // Вхождение артиста
                if (aArtist.includes(qLower)) scoreA += 40;
                if (bArtist.includes(qLower)) scoreB += 40;

                // Префиксное совпадение
                if (aTitle.startsWith(qLower)) scoreA += 30;
                if (bTitle.startsWith(qLower)) scoreB += 30;

                // Штраф за ремиксы если пользователь не просил ремикс
                if (!wantsRemix && (aFull.includes('remix') || aFull.includes('ремикс'))) scoreA -= 30;
                if (!wantsRemix && (bFull.includes('remix') || bFull.includes('ремикс'))) scoreB -= 30;

                // Штраф за slowed / reverb / bassboosted если не просили
                if (!wantsSlowed && (aFull.includes('slowed') || aFull.includes('bassboosted') || aFull.includes('reverb'))) scoreA -= 35;
                if (!wantsSlowed && (bFull.includes('slowed') || bFull.includes('bassboosted') || bFull.includes('reverb'))) scoreB -= 35;

                return scoreB - scoreA;
            });

            currentScClientId = cid;
            return mapped;
        } catch (_) {}
    }
    return [];
}

async function searchAudiusDirectly(query) {
    if (!query || !query.trim()) return [];
    try {
        const url = 'https://discoveryprovider.audius.co/v1/tracks/search?query=' + encodeURIComponent(query.trim()) + '&app_name=DODOMUSIC';
        const data = await networkFetchJson(url, 6000);
        const items = data?.data || [];
        return items
            .filter(t => t.id && !t.is_unlisted && (t.duration || 0) >= 30)
            .map(t => {
                const durSec = Math.round(t.duration || 0);
                return {
                    id: 'aud_' + t.id,
                    trackId: t.id,
                    source: 'audius',
                    title: t.title || 'Без названия',
                    artist: t.user?.name || 'Неизвестный исполнитель',
                    duration: formatTime(durSec),
                    durationSeconds: durSec,
                    thumbnail: t.artwork ? (t.artwork['480x480'] || t.artwork['150x150'] || 'icon.png') : 'icon.png',
                    streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/' + t.id + '/stream?app_name=DODOMUSIC',
                    protocol: 'progressive',
                    permalinkUrl: 'https://audius.co' + (t.permalink || ''),
                    genre: t.genre || '',
                    likesCount: t.favorite_count || 0,
                    playbackCount: t.play_count || 0
                };
            });
    } catch (e) {
        console.warn('[Direct Audius Search] Warn:', e.message);
        return [];
    }
}

async function searchMusicDirectly(query) {
    // 1. Сначала ищем в основном источнике с точным соответствием
    const scList = await searchSoundCloudDirectly(query);
    if (scList.length >= 2) {
        return scList;
    }
    // 2. Если в основном источнике мало треков, дополняем через Audius
    const audList = await searchAudiusDirectly(query);
    if (scList.length > 0) {
        return scList.concat(audList);
    }
    return audList;
}

async function resolveStreamDirectly(track) {
    if (!track) throw new Error('Трек не указан');

    if (track.streamUrl) {
        return {
            streamUrl: track.streamUrl,
            protocol: 'progressive'
        };
    }

    // Если у трека нет прямой ссылки, ищем его стрим в SoundCloud по названию
    if (!track.transcodingUrl) {
        try {
            const found = await searchSoundCloudDirectly(`${track.artist || ''} ${track.title || ''}`.trim());
            if (found && found.length > 0 && found[0].transcodingUrl) {
                track.transcodingUrl = found[0].transcodingUrl;
                track.trackAuthorization = found[0].trackAuthorization || '';
                track.protocol = found[0].protocol;
            }
        } catch (_) {}
    }

    const buildTcUrl = (base, cid, auth) => {
        const sep = base.includes('?') ? '&' : '?';
        let u = `${base}${sep}client_id=${cid}`;
        if (auth) u += `&track_authorization=${encodeURIComponent(auth)}`;
        return u;
    };

    if (track.transcodingUrl) {
        try {
            let cid = await getLiveSoundCloudClientId();
            let transUrl = buildTcUrl(track.transcodingUrl, cid, track.trackAuthorization);
            let transData = null;
            try {
                transData = await networkFetchJson(transUrl, 6000);
            } catch (_) {
                lastScClientIdFetch = 0;
                cid = await getLiveSoundCloudClientId();
                transUrl = buildTcUrl(track.transcodingUrl, cid, track.trackAuthorization);
                transData = await networkFetchJson(transUrl, 6000);
            }
            if (transData && transData.url) {
                return {
                    streamUrl: transData.url,
                    protocol: track.transcodingUrl.includes('/hls') ? 'hls' : 'progressive'
                };
            }
        } catch (e) {
            console.warn('[Direct Stream Resolve] Transcoding error:', e.message);
        }
    }

    const query = ((track.artist || '') + ' ' + (track.title || '')).trim();
    if (query) {
        const matches = await searchSoundCloudDirectly(query);
        if (matches.length > 0 && matches[0].transcodingUrl) {
            const best = matches[0];
            const cid = await getLiveSoundCloudClientId();
            const res = await fetch(buildTcUrl(best.transcodingUrl, cid, best.trackAuthorization));
            if (res.ok) {
                const data = await res.json();
                if (data.url) {
                    return {
                        streamUrl: data.url,
                        protocol: best.protocol || (best.transcodingUrl.includes('/hls') ? 'hls' : 'progressive')
                    };
                }
            }
        }

        // Резервная попытка через Audius при сбое SoundCloud
        try {
            const audMatches = await searchAudiusDirectly(query);
            if (audMatches.length > 0 && audMatches[0].streamUrl) {
                return {
                    streamUrl: audMatches[0].streamUrl,
                    protocol: 'progressive'
                };
            }
        } catch (_) {}
    }

    if (track.previewUrl || track.audioPreview) {
        return {
            streamUrl: track.previewUrl || track.audioPreview,
            protocol: 'progressive'
        };
    }

    throw new Error('Не удалось разрешить аудиопоток');
}

async function searchMusic(rawQuery) {
    if (!rawQuery?.trim()) return;
    const rawTrimmed = rawQuery.trim();
    let directQuery = rawTrimmed;
    if (directQuery === 'chart:top') directQuery = 'The Weeknd Travis Scott Dua Lipa';
    if (directQuery === 'chart:russia') directQuery = 'Miyagi Macan Дора';

    if (!rawTrimmed.startsWith('chart:')) {
        saveSearchHistoryQuery(rawTrimmed);
    }
    searchBtn.disabled = true;
    searchBtn.textContent = 'Поиск...';
    resultsHeading.textContent = rawTrimmed.startsWith('chart:')
        ? (rawTrimmed === 'chart:russia' ? 'Главный хит-парад' : 'Мировой ТОП хитов')
        : rawTrimmed;
    resultsCount.textContent = 'Поиск треков...';

    let foundTracks = null;
    let cleanQuery = resultsHeading.textContent;

    // 1. Попытка через локальный сервер (если приложение на ПК с локальным сервером)
    if (!isStandaloneApp) {
        try {
            const res = await fetch('/api/search-music', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: rawTrimmed }),
                signal: AbortSignal.timeout(5500)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.tracks && data.tracks.length > 0) {
                    foundTracks = data.tracks;
                    cleanQuery = data.cleanQuery || cleanQuery;
                }
            }
        } catch (_) {}
    }

    // 2. Fallback: Прямой поиск в SoundCloud + Audius
    if (!foundTracks || foundTracks.length === 0) {
        try {
            foundTracks = await searchMusicDirectly(directQuery);
        } catch (err) {
            console.warn('[Direct search error]', err);
        }
    }

    // 3. Если ничего не найдено по многословному запросу, пробуем по ключевому слову
    if (!foundTracks || foundTracks.length === 0) {
        const words = directQuery.split(/\s+/);
        if (words.length > 1) {
            try {
                foundTracks = await searchMusicDirectly(words[0]);
            } catch (_) {}
        }
    }

    // ВАЖНО: Не перезаписываем currentQueue при поиске! Играющая очередь сохраняется до клика по треку.
    discoverTracks = foundTracks || [];
    resultsHeading.textContent = cleanQuery;
    resultsCount.textContent = discoverTracks.length > 0 ? `Найдено: ${discoverTracks.length} (онлайн)` : 'Песни не найдены';
    renderTracksGrid(tracksContainer, discoverTracks);

    searchBtn.disabled = false;
    searchBtn.textContent = 'Найти';
}

function decodeHtml(html) {
    const txt = document.createElement('textarea');
    txt.innerHTML = html || '';
    return txt.value;
}

// Отрисовка карточек песен
function renderTracksGrid(container, list, options = {}) {
    container.innerHTML = '';
    if (!list || list.length === 0) {
        container.innerHTML = `<div class="empty-state">${options.isWaveView ? 'Очередь волны свободна' : 'Песни не найдены. Введите название трека или артиста в поиске выше.'}</div>`;
        return;
    }

    const activeTrack = getActiveTrack();

    list.forEach((track, idx) => {
        const card = document.createElement('div');
        const isCurrent = activeTrack && activeTrack.id === track.id;
        card.className = `track-card ${isCurrent ? 'playing' : ''}`;
        card.dataset.trackid = track.id;

        const cleanTitle = decodeHtml(track.title);
        const cleanArtist = decodeHtml(track.artist);
        const safeTitleAttr = escapeHtml(cleanTitle);
        const safeArtistAttr = escapeHtml(cleanArtist);
        const safeThumb = escapeHtml(track.thumbnail || 'icon.png');
        const durationText = track.duration || '';
        const isChart = track.source === 'chart' || track.isChart;
        const platformBadge = isChart
            ? '<span class="platform-pill-badge chart" style="position:absolute; top:8px; left:8px; z-index:3; font-size:10px; padding:3px 7px; border-radius:6px; background:#1ed760; color:#000; font-weight:800; box-shadow:0 2px 8px rgba(30,215,96,0.5);">Chart</span>'
            : (track.source === 'audius' ? '<span class="platform-pill-badge audius" style="position:absolute; top:8px; left:8px; z-index:3; font-size:10px; padding:3px 7px; border-radius:6px; background:#cc33ff; color:#fff; font-weight:800;">Audius</span>' : '');

        const removeBtnHtml = options.isWaveView
            ? `<button class="card-remove-btn" title="Удалить из волны">
                   <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none">
                       <line x1="18" y1="6" x2="6" y2="18"></line>
                       <line x1="6" y1="6" x2="18" y2="18"></line>
                   </svg>
               </button>`
            : '';

        card.innerHTML = `
            <div class="cover-wrapper">
                <img src="${safeThumb}" alt="${safeTitleAttr}" onerror="this.onerror=null;this.src='icon.png';" loading="lazy" draggable="false" />
                ${platformBadge}
                ${durationText ? `<span class="duration-badge">${escapeHtml(durationText)}</span>` : ''}
                <div class="play-overlay">${isCurrent && isPlaying ? SVG_PAUSE : SVG_PLAY}</div>
                ${removeBtnHtml}
                <button class="card-lyrics-btn" title="Текст песни и караоке">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                        <line x1="12" y1="19" x2="12" y2="23"></line>
                        <line x1="8" y1="23" x2="16" y2="23"></line>
                    </svg>
                </button>
                <button class="card-radio-btn" title="Запустить волну по этой песне">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none">
                        <path d="M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h-2"/>
                    </svg>
                </button>
                <button class="card-like-btn ${isTrackLiked(track.id) ? 'liked' : ''}" title="Сохранить в 'Мне нравится'">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="${isTrackLiked(track.id) ? 'currentColor' : 'none'}">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                </button>
            </div>
            <div class="track-title" title="${safeTitleAttr}">${safeTitleAttr}</div>
            <div class="track-channel" title="${safeArtistAttr}">${safeArtistAttr}</div>
        `;

        const likeBtn = card.querySelector('.card-like-btn');
        if (likeBtn) {
            likeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleTrackLike(track);
            });
        }

        const removeBtn = card.querySelector('.card-remove-btn');
        if (removeBtn) {
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeTrackFromWave(track.id);
            });
        }

        const cardLyricsBtn = card.querySelector('.card-lyrics-btn');
        if (cardLyricsBtn) {
            cardLyricsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openLyricsForTrack(track);
            });
        }

        const radioBtn = card.querySelector('.card-radio-btn');
        if (radioBtn) {
            radioBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                startSmartWaveFromTrack(track);
            });
        }

        const channelEl = card.querySelector('.track-channel');
        if (channelEl) {
            channelEl.addEventListener('click', (e) => {
                e.stopPropagation();
                openArtistPage(track.artist);
            });
        }

        card.addEventListener('click', () => {
            const active = getActiveTrack();
            if (active && active.id === track.id) {
                if (!audioPlayer.paused) {
                    audioPlayer.pause();
                } else {
                    audioPlayer.play().catch(() => {});
                }
                return;
            }
            if (options.isWaveView) {
                const foundIndex = currentQueue.findIndex(t => t.id === track.id);
                if (foundIndex >= 0) {
                    playTrackAtIndex(foundIndex);
                } else {
                    currentQueue.splice(currentIndex + 1, 0, track);
                    playTrackAtIndex(currentIndex + 1);
                }
            } else {
                currentQueue = list.slice();
                playTrackAtIndex(idx);
            }
        });

        container.appendChild(card);
    });
}

// Удаление песни из Моей волны
function removeTrackFromWave(trackId) {
    const track = waveQueue.find(t => t.id === trackId) || currentQueue.find(t => t.id === trackId);
    const trackName = track ? decodeHtml(track.title) : 'Песня';

    waveQueue = waveQueue.filter(t => t.id !== trackId);

    if (currentIndex >= 0 && currentIndex < currentQueue.length) {
        const nextPart = currentQueue.slice(currentIndex + 1).filter(t => t.id !== trackId);
        currentQueue = currentQueue.slice(0, currentIndex + 1).concat(nextPart);
    } else {
        currentQueue = currentQueue.filter(t => t.id !== trackId);
    }

    renderWaveQueueView();
    showSystemNotification('Моя волна', `Трек «${trackName}» удалён из волны`, 'info');
}

/**
 * Умная волна (Smart Autoplay & Radio):
 * Бесконечный подбор треков на основе выбранной песни (например: «девочка в каре», «сайт»)
 */
async function fetchRelatedTracksForCurrent(track, forceRefresh = false) {
    if (!track || !isAutoWave) return;
    if (!forceRefresh && lastRelatedTrackId === track.id) return;
    if (isFetchingRelated) return;

    isFetchingRelated = true;
    lastRelatedTrackId = track.id;

    if (smartWaveBanner) {
        smartWaveBanner.style.display = 'inline-flex';
        smartWaveStatusText.textContent = `Умная волна: подбираем треки в стиле «${decodeHtml(track.title)}»...`;
    }

    try {
        const res = await fetch('/api/related-tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                trackId: track.id,
                artist: track.artist || '',
                title: track.title || '',
            }),
        });

        if (!res.ok) throw new Error('Ошибка получения рекомендаций');
        const data = await res.json();
        const related = data.relatedTracks || [];

        if (related.length > 0) {
            const existingIds = new Set(currentQueue.map((t) => t.id));
            const existingSigs = new Set(
                currentQueue.map((t) => `${(t.artist || '').toLowerCase()}__${(t.title || '').toLowerCase()}`)
            );

            const newTracks = [];
            for (const t of related) {
                const sig = `${(t.artist || '').toLowerCase()}__${(t.title || '').toLowerCase()}`;
                if (!existingIds.has(t.id) && !existingSigs.has(sig)) {
                    existingIds.add(t.id);
                    existingSigs.add(sig);
                    newTracks.push(t);
                }
            }

            if (newTracks.length > 0) {
                currentQueue = currentQueue.concat(newTracks);
                waveQueue = currentQueue.slice(currentIndex + 1);

                if (smartWaveBanner) {
                    const nextTrack = waveQueue[0] || currentQueue[currentIndex + 1];
                    const nextInfo = nextTrack
                        ? `Далее: ${decodeHtml(nextTrack.artist)} - ${decodeHtml(nextTrack.title)}`
                        : `В очереди: +${newTracks.length} треков`;
                    smartWaveStatusText.textContent = `Умная волна активна • В стиле «${decodeHtml(track.title)}» • ${nextInfo}`;
                }

                renderWaveQueueView();
                if (waveTitle) {
                    waveTitle.textContent = `Моя Волна: в стиле «${decodeHtml(track.title)}»`;
                }
                if (waveDesc) {
                    waveDesc.textContent = `Бесконечный автомикс похожих песен на основе «${decodeHtml(track.artist)} - ${decodeHtml(track.title)}». Треки продолжают играть автоматически.`;
                }
            }
        }
    } catch (err) {
        console.warn('Ошибка загрузки рекомендаций волны:', err);
    } finally {
        isFetchingRelated = false;
    }
}

function renderWaveQueueView() {
    if (!waveTracksContainer) return;
    const waveQueueSub = document.getElementById('waveQueueSub');

    if (waveQueue && waveQueue.length > 0) {
        if (waveQueueSub) {
            waveQueueSub.textContent = `В очереди волны: ${waveQueue.length} треков`;
        }
        renderTracksGrid(waveTracksContainer, waveQueue, { isWaveView: true });
    } else {
        if (waveQueueSub) {
            waveQueueSub.textContent = 'Очередь свободна';
        }
        waveTracksContainer.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1; padding: 48px 24px; text-align: center;">
                <div style="font-size: 46px; margin-bottom: 12px;">🌊</div>
                <h3 style="font-size: 19px; margin-bottom: 8px; color: #fff; font-weight: 700;">Очередь волны свободна</h3>
                <p style="color: #a7a7a7; max-width: 440px; margin: 0 auto 20px; font-size: 14px; line-height: 1.5;">
                    Введите название песни или жанра в поиск выше, либо нажмите кнопку ниже, чтобы запустить бесконечный поток музыки!
                </p>
                <button id="waveStartEmptyBtn" class="primary-btn" style="margin: 0 auto; display: inline-flex;">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    <span>Запустить волну</span>
                </button>
            </div>
        `;
        document.getElementById('waveStartEmptyBtn')?.addEventListener('click', () => {
            if (startSmartWaveBtn) startSmartWaveBtn.click();
        });
    }
}

function startSmartWaveFromTrack(track) {
    isAutoWave = true;
    autoWaveBtn?.classList.add('active');
    if (smartWaveBanner) smartWaveBanner.style.display = 'inline-flex';
    currentQueue = [track];
    waveQueue = [];
    playTrackAtIndex(0);
    renderWaveQueueView();
    fetchTasteWaveForTrack(track);
    const waveTabBtn = document.querySelector('[data-tab="wave"]');
    if (waveTabBtn) waveTabBtn.click();
}

function highlightActiveCards() {
    syncPlayPauseUI();
}

// Воспроизведение полной песни (3-6 минут)
async function playTrackAtIndex(index) {
    if (index < 0 || index >= currentQueue.length) return;
    initAudioAnalyser();

    const reqId = ++playbackRequestCounter;
    currentIndex = index;
    currentTrack = currentQueue[currentIndex];
    const track = currentTrack;
    delete track._hadPlaybackError;

    // Немедленно останавливаем предыдущее воспроизведение до загрузки нового потока
    if (currentHls) {
        currentHls.destroy();
        currentHls = null;
    }
    try {
        audioPlayer.pause();
        audioPlayer.removeAttribute('src');
        audioPlayer.load();
    } catch (_) {}

    const cleanTitle = decodeHtml(track.title);
    const cleanArtist = decodeHtml(track.artist);

    playerCover.src = track.thumbnail || 'icon.png';
    playerTitle.textContent = cleanTitle;
    playerArtist.textContent = cleanArtist;
    currentTimeEl.textContent = '0:00';
    durationTimeEl.textContent = track.duration || '3:00';
    seekBar.value = '0';
    updateSliderFill(seekBar);

    updateLikeButtonState(track.id);
    addToHistory(track);
    highlightActiveCards();

    if (lyricsModal?.classList.contains('visible')) {
        openLyricsForTrack(track);
    } else {
        updateLyricsPlaySyncButtonState();
    }

    // Системный медиа-оверлей Windows SMTC и медиа-клавиши
    if ('mediaSession' in navigator) {
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: cleanTitle,
                artist: cleanArtist,
                album: 'DodoMusic',
                artwork: [
                    { src: track.thumbnail || 'icon.png', sizes: '512x512', type: 'image/png' },
                ],
            });
            navigator.mediaSession.playbackState = 'playing';
        } catch (_) {}
    }

    if (window.AndroidBridge && typeof window.AndroidBridge.updateMediaNotification === 'function') {
        try {
            window.AndroidBridge.updateMediaNotification(
                cleanTitle || 'DodoMusic',
                cleanArtist || 'Свободная музыка',
                track.thumbnail || '',
                true
            );
        } catch (_) {}
    }

    // Запускаем подбор умной волны для этого трека
    if (isAutoWave) {
        waveQueue = currentQueue.slice(currentIndex + 1);
        renderWaveQueueView();
        fetchRelatedTracksForCurrent(track);
    }

    try {
        // Разрешаем прямую ссылку на полный аудио-поток
        const params = new URLSearchParams({
            id: track.id,
            trackId: track.id,
            source: track.source || (track.isChart ? 'chart' : 'soundcloud'),
            transcodingUrl: track.transcodingUrl || '',
            progressiveUrl: track.progressiveUrl || '',
            mpegHlsUrl: track.mpegHlsUrl || '',
            trackAuthorization: track.trackAuthorization || '',
            streamUrl: track.streamUrl || '',
            previewUrl: track.previewUrl || track.audioPreview || '',
            artist: track.artist || '',
            title: track.title || '',
        });

        let fullStreamUrl = null;
        let streamProtocol = 'progressive';

        if (!isStandaloneApp) {
            try {
                const res = await fetch(`/api/resolve-stream?${params.toString()}`, { signal: AbortSignal.timeout(6500) });
                if (reqId !== playbackRequestCounter) return;
                if (res.ok) {
                    const data = await res.json();
                    fullStreamUrl = data.streamUrl;
                    streamProtocol = data.protocol || 'progressive';
                }
            } catch (_) {}
        }

        if (reqId !== playbackRequestCounter) return;

        if (!fullStreamUrl) {
            try {
                const directRes = await resolveStreamDirectly(track);
                if (reqId !== playbackRequestCounter) return;
                fullStreamUrl = directRes.streamUrl;
                streamProtocol = directRes.protocol;
            } catch (err) {
                if (reqId !== playbackRequestCounter) return;
                console.error('Ошибка прямого разрешения потока:', err);
                showSystemNotification('Ошибка воспроизведения', 'Не удалось загрузить аудиопоток', 'warn');
                return;
            }
        }

        if (reqId !== playbackRequestCounter || !fullStreamUrl) return;

        if (streamProtocol === 'hls' && window.Hls && Hls.isSupported()) {
            currentHls = new Hls({
                maxBufferLength: 45,
                maxMaxBufferLength: 120,
            });
            currentHls.loadSource(fullStreamUrl);
            currentHls.attachMedia(audioPlayer);
            currentHls.on(Hls.Events.MANIFEST_PARSED, () => {
                if (reqId !== playbackRequestCounter) return;
                audioPlayer.play().catch(() => {});
            });
            currentHls.on(Hls.Events.ERROR, (event, errData) => {
                if (reqId !== playbackRequestCounter) return;
                if (errData.fatal) {
                    console.warn('HLS fatal error:', errData.type);
                    if (errData.type === Hls.ErrorTypes.NETWORK_ERROR) {
                        currentHls.startLoad();
                    } else {
                        currentHls.destroy();
                    }
                }
            });
        } else {
            audioPlayer.src = fullStreamUrl;
            audioPlayer.play().catch(() => {});
        }
    } catch (err) {
        if (reqId === playbackRequestCounter) {
            console.error('Ошибка воспроизведения полного трека:', err);
        }
    }
}

function playNext() {
    if (!currentQueue.length) return;

    if (isShuffle) {
        if (currentIndex >= currentQueue.length - 4 && isAutoWave) {
            fetchTasteWaveForTrack(getActiveTrack());
        }
        let nextIdx = 0;
        if (currentQueue.length > 1) {
            do {
                nextIdx = Math.floor(Math.random() * currentQueue.length);
            } while (nextIdx === currentIndex);
        }
        playTrackAtIndex(nextIdx);
    } else {
        const nextIdx = currentIndex + 1;
        if (nextIdx < currentQueue.length) {
            playTrackAtIndex(nextIdx);
        } else if (isAutoWave) {
            const active = getActiveTrack();
            fetchTasteWaveForTrack(active).then(() => {
                if (currentIndex + 1 < currentQueue.length) {
                    playTrackAtIndex(currentIndex + 1);
                } else {
                    playTrackAtIndex(0);
                }
            });
        } else {
            playTrackAtIndex(0);
        }
    }
}

function playPrev() {
    if (!currentQueue.length) return;
    const prevIdx = (currentIndex - 1 + currentQueue.length) % currentQueue.length;
    playTrackAtIndex(prevIdx);
}

// Любимые треки и история с перманентным сохранением на диске
function isTrackLiked(id) {
    if (!id) return false;
    return favorites.some((t) => t.id === id);
}

function updateLikeButtonState(id) {
    const liked = isTrackLiked(id);
    if (likeCurrentBtn) {
        likeCurrentBtn.classList.toggle('liked', liked);
        const svg = likeCurrentBtn.querySelector('svg');
        if (svg) svg.setAttribute('fill', liked ? 'currentColor' : 'none');
    }
    const badge = document.getElementById('favCountBadge');
    if (badge) badge.textContent = favorites.length;
}

function updateAllCardsLikeUI() {
    document.querySelectorAll('.track-card').forEach((card) => {
        const tid = card.dataset.trackid;
        const btn = card.querySelector('.card-like-btn');
        if (btn) {
            const liked = isTrackLiked(tid);
            btn.classList.toggle('liked', liked);
            const svg = btn.querySelector('svg');
            if (svg) svg.setAttribute('fill', liked ? 'currentColor' : 'none');
        }
    });
}

function saveLibraryToDisk() {
    try {
        localStorage.setItem('dodomusic_favorites', JSON.stringify(favorites));
        localStorage.setItem('dodomusic_history', JSON.stringify(historyList));
    } catch (_) {}

    const badge = document.getElementById('favCountBadge');
    if (badge) badge.textContent = favorites.length;

    // Перманентное сохранение в JSON-файл базы данных через бэкенд
    fetch('/api/library/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorites, history: historyList }),
    }).catch(() => {});
}

async function loadLibraryFromDisk() {
    try {
        const res = await fetch('/api/library');
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.favorites) && data.favorites.length > 0) {
                favorites = data.favorites;
            }
            if (Array.isArray(data.history) && data.history.length > 0) {
                historyList = data.history;
            }
        }
    } catch (_) {}

    const badge = document.getElementById('favCountBadge');
    if (badge) badge.textContent = favorites.length;
    renderTracksGrid(favoritesContainer, favorites);
    renderTracksGrid(historyContainer, historyList);
    updateAllCardsLikeUI();
    const current = getActiveTrack();
    if (current) updateLikeButtonState(current.id);
}

function toggleTrackLike(track) {
    if (!track) return;
    const isLiked = isTrackLiked(track.id);
    if (isLiked) {
        favorites = favorites.filter((t) => t.id !== track.id);
        showSystemNotification('Удалено из избранного', `«${decodeHtml(track.title)}» убрана из «Мне нравится»`, 'info');
    } else {
        favorites.unshift(track);
        showSystemNotification('Сохранено в избранное ❤️', `«${decodeHtml(track.title)}» сохранена в «Мне нравится»`, 'success');
    }

    saveLibraryToDisk();
    updateLikeButtonState(track.id);
    updateAllCardsLikeUI();
    if (favoritesContainer) {
        renderTracksGrid(favoritesContainer, favorites);
    }
}

function addToHistory(track) {
    if (!track) return;
    historyList = [track, ...historyList.filter((t) => t.id !== track.id)].slice(0, 30);
    saveLibraryToDisk();
    renderTracksGrid(historyContainer, historyList);
}

likeCurrentBtn?.addEventListener('click', () => {
    const current = getActiveTrack();
    if (!current) return;
    toggleTrackLike(current);
});

// Скачивание текущего трека (внутри приложения, без открытия внешнего браузера)
const downloadCurrentBtn = document.getElementById('downloadCurrentBtn');
if (downloadCurrentBtn) {
    downloadCurrentBtn.addEventListener('click', () => {
        const track = getActiveTrack();
        if (!track) return;
        showSystemNotification('Скачивание трека', `Загрузка «${decodeHtml(track.title)}»...`, 'music', track.thumbnail || 'icon.png');
        const params = new URLSearchParams({
            trackId: track.id,
            source: track.source || (track.isChart ? 'chart' : 'soundcloud'),
            transcodingUrl: track.transcodingUrl || '',
            progressiveUrl: track.progressiveUrl || '',
            mpegHlsUrl: track.mpegHlsUrl || '',
            trackAuthorization: track.trackAuthorization || '',
            streamUrl: track.streamUrl || '',
            previewUrl: track.previewUrl || track.audioPreview || '',
            title: track.title || 'Track',
            artist: track.artist || 'DodoMusic',
        });
        const downloadUrl = `/api/download-track?${params.toString()}`;
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `${track.artist || 'DodoMusic'} - ${track.title || 'Track'}.mp3`.replace(/[\\/:*?"<>|]/g, '_');
        document.body.appendChild(a);
        a.click();
        a.remove();
    });
}

// Управление плеером и глобальные вызовы для Android Lock Screen виджета
function togglePlayPause() {
    if (currentIndex === -1 && currentQueue.length > 0) {
        playTrackAtIndex(0);
        return;
    }
    if (!audioPlayer.paused) {
        audioPlayer.pause();
    } else {
        audioPlayer.play().catch(() => {});
    }
}

function stopPlayback() {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    if (window.AndroidBridge && typeof window.AndroidBridge.closeMediaNotification === 'function') {
        window.AndroidBridge.closeMediaNotification();
    }
}

// Экспорт функций для управления с экрана блокировки и Bluetooth
window.togglePlayPause = togglePlayPause;
window.playNextTrack = playNext;
window.playPrevTrack = playPrev;
window.stopPlayback = stopPlayback;

playPauseBtn.addEventListener('click', togglePlayPause);

nextBtn.addEventListener('click', playNext);
prevBtn.addEventListener('click', playPrev);

if (autoWaveBtn) {
    autoWaveBtn.addEventListener('click', () => {
        isAutoWave = !isAutoWave;
        autoWaveBtn.classList.toggle('active', isAutoWave);
        if (isAutoWave) {
            if (smartWaveBanner) smartWaveBanner.style.display = 'inline-flex';
            const activeTrack = getActiveTrack();
            if (activeTrack) fetchRelatedTracksForCurrent(activeTrack, true);
        } else {
            if (smartWaveBanner) smartWaveBanner.style.display = 'none';
        }
    });
}

if (startSmartWaveBtn) {
    startSmartWaveBtn.addEventListener('click', () => {
        const activeTrack = getActiveTrack();
        if (activeTrack) {
            if (!isPlaying) audioPlayer.play().catch(() => {});
            fetchRelatedTracksForCurrent(activeTrack, true);
        } else if (favorites.length > 0) {
            startSmartWaveFromTrack(favorites[0]);
        } else if (discoverTracks.length > 0) {
            startSmartWaveFromTrack(discoverTracks[0]);
        } else {
            searchMusic('девочка в каре').then(() => {
                if (discoverTracks[0]) startSmartWaveFromTrack(discoverTracks[0]);
            });
        }
    });
}

if (refreshWaveBtn) {
    refreshWaveBtn.addEventListener('click', () => {
        const activeTrack = getActiveTrack();
        if (activeTrack) {
            fetchRelatedTracksForCurrent(activeTrack, true);
        }
    });
}

const clearWaveBtn = document.getElementById('clearWaveBtn');
if (clearWaveBtn) {
    clearWaveBtn.addEventListener('click', () => {
        waveQueue = [];
        const active = getActiveTrack();
        if (active) {
            currentQueue = [active];
            currentIndex = 0;
        } else {
            currentQueue = [];
            currentIndex = -1;
        }
        renderWaveQueueView();
        showSystemNotification('Моя волна', 'Очередь волны полностью очищена', 'info');
    });
}

// Поиск и быстрый запуск в Моей волне
const waveSearchInput = document.getElementById('waveSearchInput');
const waveSearchClearBtn = document.getElementById('waveSearchClearBtn');
const waveSearchBtn = document.getElementById('waveSearchBtn');

async function startWaveFromSearchQuery(query) {
    if (!query || !query.trim()) return;
    const cleanQ = query.trim();
    saveSearchHistoryQuery(cleanQ);
    showSystemNotification('Моя волна', `Поиск трека: «${cleanQ}»...`, 'info');

    try {
        let tracks = [];
        if (!isStandaloneApp) {
            try {
                const res = await fetch('/api/search-music', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: cleanQ }),
                    signal: AbortSignal.timeout(5000)
                });
                if (res.ok) {
                    const data = await res.json();
                    tracks = Array.isArray(data) ? data : (data.tracks || []);
                }
            } catch (_) {}
        }

        if (tracks.length === 0) {
            tracks = await searchMusicDirectly(cleanQ);
        }

        if (tracks.length > 0) {
            const first = tracks[0];
            // Включаем песню пользователя
            currentQueue = [first];
            currentIndex = 0;
            playTrackAtIndex(0);

            // А дальше генерируем настоящий умный рандом по вкусу (а не остальные результаты поиска!)
            fetchTasteWaveForTrack(first);

            const waveTabBtn = document.querySelector('[data-tab="wave"]');
            if (waveTabBtn) waveTabBtn.click();
            showSystemNotification('Моя волна', `Волна запущена! Играет «${decodeHtml(first.title)}»`, 'play');
        } else {
            showSystemNotification('Моя волна', `Ничего не найдено по запросу «${cleanQ}»`, 'warn');
        }
    } catch (err) {
        console.error('Ошибка запуска волны по поиску:', err);
        showSystemNotification('Моя волна', 'Ошибка сети при поиске треков', 'warn');
    }
}

if (waveSearchInput) {
    waveSearchInput.addEventListener('input', () => {
        if (waveSearchClearBtn) {
            waveSearchClearBtn.style.display = waveSearchInput.value ? 'block' : 'none';
        }
    });

    waveSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            startWaveFromSearchQuery(waveSearchInput.value.trim());
        }
    });
}

if (waveSearchClearBtn) {
    waveSearchClearBtn.addEventListener('click', () => {
        waveSearchInput.value = '';
        waveSearchClearBtn.style.display = 'none';
        waveSearchInput.focus();
    });
}

if (waveSearchBtn) {
    waveSearchBtn.addEventListener('click', () => {
        if (waveSearchInput && waveSearchInput.value.trim()) {
            startWaveFromSearchQuery(waveSearchInput.value.trim());
        } else {
            if (startSmartWaveBtn) startSmartWaveBtn.click();
        }
    });
}

// Быстрые жанровые кнопки в Моей волне
document.querySelectorAll('.wave-chip-btn').forEach((chip) => {
    chip.addEventListener('click', () => {
        const seed = chip.dataset.seed;
        if (seed) {
            if (waveSearchInput) {
                waveSearchInput.value = seed;
                if (waveSearchClearBtn) waveSearchClearBtn.style.display = 'block';
            }
            startWaveFromSearchQuery(seed);
        }
    });
});

// ==========================================
// ИНИЦИАЛИЗАЦИЯ ВЫПАДАЮЩЕЙ ИСТОРИИ ПОИСКА
// ==========================================
const searchHistoryDropdown = document.getElementById('searchHistoryDropdown');
const searchHistoryList = document.getElementById('searchHistoryList');
const clearAllSearchHistoryBtn = document.getElementById('clearAllSearchHistoryBtn');

const waveSearchHistoryDropdown = document.getElementById('waveSearchHistoryDropdown');
const waveSearchHistoryList = document.getElementById('waveSearchHistoryList');
const clearAllWaveHistoryBtn = document.getElementById('clearAllWaveHistoryBtn');

if (searchInput) {
    searchInput.addEventListener('focus', () => {
        renderSearchHistoryDropdown(searchHistoryDropdown, searchHistoryList, searchInput, (q) => {
            searchMusic(q);
        });
    });
    searchInput.addEventListener('click', () => {
        renderSearchHistoryDropdown(searchHistoryDropdown, searchHistoryList, searchInput, (q) => {
            searchMusic(q);
        });
    });
}

if (clearAllSearchHistoryBtn) {
    clearAllSearchHistoryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearAllSearchHistory();
        if (searchHistoryDropdown) searchHistoryDropdown.style.display = 'none';
        showSystemNotification('Поиск', 'Вся история поиска очищена', 'info');
    });
}

if (waveSearchInput) {
    waveSearchInput.addEventListener('focus', () => {
        renderSearchHistoryDropdown(waveSearchHistoryDropdown, waveSearchHistoryList, waveSearchInput, (q) => {
            startWaveFromSearchQuery(q);
        });
    });
    waveSearchInput.addEventListener('click', () => {
        renderSearchHistoryDropdown(waveSearchHistoryDropdown, waveSearchHistoryList, waveSearchInput, (q) => {
            startWaveFromSearchQuery(q);
        });
    });
}

if (clearAllWaveHistoryBtn) {
    clearAllWaveHistoryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearAllSearchHistory();
        if (waveSearchHistoryDropdown) waveSearchHistoryDropdown.style.display = 'none';
        showSystemNotification('Моя волна', 'История запросов волны очищена', 'info');
    });
}

document.addEventListener('click', (e) => {
    const sForm = document.getElementById('searchForm');
    const wBox = document.querySelector('.wave-search-box');

    if (searchHistoryDropdown && !sForm?.contains(e.target)) {
        searchHistoryDropdown.style.display = 'none';
    }
    if (waveSearchHistoryDropdown && !wBox?.contains(e.target)) {
        waveSearchHistoryDropdown.style.display = 'none';
    }
});

shuffleBtn.addEventListener('click', () => {
    isShuffle = !isShuffle;
    shuffleBtn.classList.toggle('active', isShuffle);
});

repeatBtn.addEventListener('click', () => {
    isRepeat = !isRepeat;
    repeatBtn.classList.toggle('active', isRepeat);
});

seekBar.addEventListener('input', () => {
    const track = getActiveTrack();
    const dur = (audioPlayer.duration && !isNaN(audioPlayer.duration) && audioPlayer.duration > 0)
        ? audioPlayer.duration
        : (track?.durationSeconds || 180);

    if (dur > 0) {
        audioPlayer.currentTime = (Number(seekBar.value) / 100) * dur;
    }
    updateSliderFill(seekBar);
});

volumeBar.addEventListener('input', () => {
    const vol = Number(volumeBar.value) / 100;
    audioPlayer.volume = vol;
    audioPlayer.muted = vol === 0;
    localStorage.setItem('dodomusic_volume', String(volumeBar.value));
    updateSliderFill(volumeBar);
});

muteBtn.addEventListener('click', () => {
    audioPlayer.muted = !audioPlayer.muted;
    muteBtn.classList.toggle('active', audioPlayer.muted);
});

// Клик по артисту в нижней панели плеера (переход на страницу профиля артиста)
if (playerArtist) {
    playerArtist.addEventListener('click', (e) => {
        e.stopPropagation();
        const track = getActiveTrack();
        if (track?.artist) {
            closeLyricsModal();
            openArtistPage(track.artist);
        }
    });
}

// Открыть трек на SoundCloud / Audius
if (openSourceBtn) {
    openSourceBtn.addEventListener('click', () => {
        const track = getActiveTrack();
        if (track?.permalinkUrl) {
            window.open(track.permalinkUrl, '_blank');
        } else if (track) {
            window.open(`https://soundcloud.com/search?q=${encodeURIComponent(track.artist + ' ' + track.title)}`, '_blank');
        }
    });
}

// Фиксация окна от нежелательной прокрутки viewport
window.addEventListener('scroll', () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
    }
});

/**
 * Открытие страницы артиста: биография, аватарка и все треки
 */
async function openArtistPage(artistName) {
    if (!artistName) return;
    const reqId = ++activeArtistRequestId;
    const cleanName = decodeHtml(artistName).trim();

    // Переключаем вкладку на страницу артиста
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tabArtist?.classList.add('active');
    if (mainContent) mainContent.scrollTop = 0;

    // Сбрасываем предыдущие данные артиста сразу
    if (artistNameTitle) artistNameTitle.textContent = cleanName;
    if (artistAvatar) artistAvatar.src = 'icon.png';
    if (artistHeroBg) artistHeroBg.src = 'icon.png';
    if (artistStats) artistStats.textContent = 'Загрузка профиля и композиций...';
    if (artistTracksCount) artistTracksCount.textContent = '...';
    if (artistTracksContainer) artistTracksContainer.innerHTML = '<div class="empty-state">Загружаем композиции...</div>';

    try {
        let data = null;
        if (!isStandaloneApp) {
            try {
                const res = await fetch(`/api/artist-profile?artist=${encodeURIComponent(cleanName)}`, { signal: AbortSignal.timeout(7000) });
                if (res.ok) data = await res.json();
            } catch (_) {}
        }
        if (reqId !== activeArtistRequestId) return;

        if (!data || !data.tracks || data.tracks.length === 0) {
            const directTracks = await searchMusicDirectly(cleanName);
            if (reqId !== activeArtistRequestId) return;
            data = {
                artist: {
                    name: cleanName,
                    avatar: directTracks[0]?.thumbnail || 'icon.png',
                    permalinkUrl: `https://soundcloud.com/search/people?q=${encodeURIComponent(cleanName)}`,
                    followersCount: 0,
                },
                tracks: directTracks,
            };
        }

        const artist = data.artist || { name: cleanName, avatar: 'icon.png', permalinkUrl: '#' };
        if (artistNameTitle) artistNameTitle.textContent = artist.name;
        if (artistAvatar) artistAvatar.src = artist.avatar || 'icon.png';
        if (artistHeroBg) artistHeroBg.src = artist.avatar || 'icon.png';
        if (artistStats) {
            const followers = artist.followersCount ? `${Number(artist.followersCount).toLocaleString('ru-RU')} подписчиков • ` : '';
            artistStats.textContent = `${followers}${data.tracks?.length || 0} треков`;
        }
        if (artistSourceLink) {
            artistSourceLink.href = artist.permalinkUrl || `https://soundcloud.com/search/people?q=${encodeURIComponent(cleanName)}`;
        }

        const artistTracks = data.tracks || [];
        if (artistTracksCount) {
            artistTracksCount.textContent = `${artistTracks.length} композиций`;
        }
        renderTracksGrid(artistTracksContainer, artistTracks);

        if (playAllArtistBtn) {
            playAllArtistBtn.onclick = () => {
                if (artistTracks.length > 0) {
                    currentQueue = artistTracks.slice();
                    playTrackAtIndex(0);
                }
            };
        }

        if (radioArtistBtn) {
            radioArtistBtn.onclick = () => {
                if (artistTracks.length > 0) {
                    startSmartWaveFromTrack(artistTracks[0]);
                }
            };
        }
    } catch (err) {
        if (reqId === activeArtistRequestId) {
            console.error('Artist profile error:', err);
            if (artistStats) artistStats.textContent = 'Официальная страница артиста';
        }
    }
}

// Навигация и карточки чартов
document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const tabId = `tab-${btn.dataset.tab}`;
        document.getElementById(tabId)?.classList.add('active');

        if (btn.dataset.tab === 'wave') {
            renderWaveQueueView();
            renderTasteAnalysisUI();
        }
    });
});

document.querySelectorAll('.mood-card').forEach((card) => {
    card.addEventListener('click', () => {
        const q = card.dataset.chart;
        searchInput.value = q;
        if (searchHistoryDropdown) searchHistoryDropdown.style.display = 'none';
        searchMusic(q);
    });
});

searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (searchHistoryDropdown) searchHistoryDropdown.style.display = 'none';
    document.querySelector('[data-tab="discover"]')?.click();
    searchMusic(searchInput.value);
});

// НАСТРОЙКИ И РЕАКТИВНЫЕ ВИДЕО-ОБОИ
const wpColors = {
    aurora: '#1ed760',
    dodo: '#ff6900',
    synthwave: '#d946ef',
    galaxy: '#3b82f6',
    phonk: '#ef4444',
};

function hexToRgba(hex, alpha) {
    const clean = (hex || '#1ed760').replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16) || 30;
    const g = parseInt(clean.substring(2, 4), 16) || 215;
    const b = parseInt(clean.substring(4, 6), 16) || 96;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applySettingsToDOM() {
    const color = userSettings.autoColor
        ? wpColors[userSettings.wallpaper] || '#1ed760'
        : userSettings.accentColor;

    document.documentElement.style.setProperty('--accent-color', color);
    document.documentElement.style.setProperty('--accent-glow', hexToRgba(color, 0.42));
    document.documentElement.style.setProperty('--surface-alpha', (userSettings.glassOpacity / 100).toFixed(2));

    document.querySelectorAll('.wp-card').forEach((card) => {
        card.classList.toggle('active', card.dataset.wp === userSettings.wallpaper);
    });

    document.getElementById('toggleMoveOnMusic').checked = Boolean(userSettings.moveOnMusic);
    document.getElementById('toggleAutoColor').checked = Boolean(userSettings.autoColor);
    document.getElementById('bassIntensitySlider').value = userSettings.bassIntensity;
    document.getElementById('glassOpacitySlider').value = userSettings.glassOpacity;

    applyLanguage(userSettings.language || 'ru');

    localStorage.setItem('dodomusic_settings', JSON.stringify(userSettings));
    updateSliderFill(volumeBar);
    updateSliderFill(seekBar);
}

document.querySelectorAll('.wp-card').forEach((card) => {
    card.addEventListener('click', () => {
        userSettings.wallpaper = card.dataset.wp;
        if (userSettings.autoColor) {
            userSettings.accentColor = card.dataset.color;
        }
        applySettingsToDOM();
    });
});

document.getElementById('toggleMoveOnMusic').addEventListener('change', (e) => {
    userSettings.moveOnMusic = e.target.checked;
    applySettingsToDOM();
});

document.getElementById('toggleAutoColor').addEventListener('change', (e) => {
    userSettings.autoColor = e.target.checked;
    applySettingsToDOM();
});

document.querySelectorAll('.swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
        userSettings.autoColor = false;
        userSettings.accentColor = btn.dataset.swatch;
        applySettingsToDOM();
    });
});

document.getElementById('bassIntensitySlider').addEventListener('input', (e) => {
    userSettings.bassIntensity = Number(e.target.value);
    applySettingsToDOM();
});

document.getElementById('glassOpacitySlider').addEventListener('input', (e) => {
    userSettings.glassOpacity = Number(e.target.value);
    applySettingsToDOM();
});

// Переключение языка интерфейса
document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        userSettings.language = lang;
        applyLanguage(lang);
        localStorage.setItem('dodomusic_settings', JSON.stringify(userSettings));
        saveLibraryToDisk();
    });
});

// Модальное окно политики конфиденциальности и товарных знаков
function openLegalModal(type) {
    const lang = userSettings.language || 'ru';
    const modal = document.getElementById('legalModal');
    const titleText = document.getElementById('legalModalTitleText');
    const icon = document.getElementById('legalModalIcon');
    const body = document.getElementById('legalModalBody');
    const bottomBtn = document.getElementById('closeLegalModalBottomBtn');
    if (!modal || !body) return;

    if (bottomBtn) bottomBtn.textContent = I18N[lang]?.legal_close_btn || (lang === 'ru' ? 'Понятно' : 'Got it');

    if (type === 'privacy') {
        if (icon) icon.textContent = '🛡️';
        if (titleText) titleText.textContent = lang === 'ru' ? 'Политика конфиденциальности' : 'Privacy Policy';
        body.innerHTML = LEGAL_DOCS[lang]?.privacy || LEGAL_DOCS.ru.privacy;
    } else {
        if (icon) icon.textContent = '⚖️';
        if (titleText) titleText.textContent = lang === 'ru' ? 'Товарные знаки и Disclaimer' : 'Trademarks & Disclaimer';
        body.innerHTML = LEGAL_DOCS[lang]?.disclaimer || LEGAL_DOCS.ru.disclaimer;
    }

    modal.classList.add('visible');
}

document.getElementById('openPrivacyModalBtn')?.addEventListener('click', () => openLegalModal('privacy'));
document.getElementById('openDisclaimerModalBtn')?.addEventListener('click', () => openLegalModal('disclaimer'));

document.getElementById('closeLegalModalBtn')?.addEventListener('click', () => {
    document.getElementById('legalModal')?.classList.remove('visible');
});

document.getElementById('closeLegalModalBottomBtn')?.addEventListener('click', () => {
    document.getElementById('legalModal')?.classList.remove('visible');
});

document.getElementById('legalModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'legalModal') {
        document.getElementById('legalModal')?.classList.remove('visible');
    }
});

// Защита от перетаскивания и призрачных картинок (User Photo 1)
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ДВИЖОК АНИМИРОВАННЫХ ВИДЕО-ОБОЕВ С АНАЛИЗОМ БАСА
const wpCanvas = document.getElementById('wallpaperCanvas');
const wpCtx = wpCanvas.getContext('2d');
const miniCanvas = document.getElementById('miniVisualizer');
const miniCtx = miniCanvas.getContext('2d');

function resizeCanvas() {
    wpCanvas.width = window.innerWidth;
    wpCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

let animPhase = 0;
const particles = Array.from({ length: 75 }, () => ({
    x: Math.random(),
    y: Math.random(),
    size: 1.5 + Math.random() * 3.5,
    speedX: (Math.random() - 0.5) * 0.002,
    speedY: -0.001 - Math.random() * 0.0025,
}));

function getRealBassEnergy() {
    if (!isPlaying) return 0;
    if (analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
        let sum = 0;
        for (let i = 0; i < 10; i++) {
            sum += freqData[i];
        }
        const avg = sum / (10 * 255);
        if (avg > 0.01) return avg;
    }
    return (Math.sin(animPhase * 4.5) * 0.5 + 0.5) * 0.65;
}

function renderLiveWallpaper() {
    // На мобильных устройствах и Android отключаем тяжёлый 60 FPS Canvas-рендеринг для максимальной плавности
    if (isStandaloneApp || window.innerWidth <= 768) {
        return;
    }

    const w = wpCanvas.width;
    const h = wpCanvas.height;

    const shouldAnimate = isPlaying || !userSettings.moveOnMusic;
    const bassScale = Number(userSettings.bassIntensity) / 100;
    const realBass = getRealBassEnergy() * bassScale;

    if (shouldAnimate) {
        animPhase += isPlaying ? 0.024 + realBass * 0.04 : 0.008;
    }

    const activeHex = userSettings.autoColor
        ? wpColors[userSettings.wallpaper] || '#1ed760'
        : userSettings.accentColor;

    wpCtx.fillStyle = '#06070b';
    wpCtx.fillRect(0, 0, w, h);

    const wp = userSettings.wallpaper;

    if (wp === 'aurora') {
        for (let band = 0; band < 4; band++) {
            wpCtx.beginPath();
            for (let x = 0; x <= w; x += 18) {
                const y =
                    h * (0.24 + band * 0.14) +
                    Math.sin(x * 0.004 + animPhase + band * 1.1) * (45 + realBass * 95);
                if (x === 0) wpCtx.moveTo(x, y);
                else wpCtx.lineTo(x, y);
            }
            wpCtx.lineTo(w, h);
            wpCtx.lineTo(0, h);
            wpCtx.closePath();
            const grad = wpCtx.createLinearGradient(0, h * 0.15, 0, h);
            grad.addColorStop(0, hexToRgba(activeHex, 0.25 + realBass * 0.22));
            grad.addColorStop(1, 'rgba(6, 7, 11, 0)');
            wpCtx.fillStyle = grad;
            wpCtx.fill();
        }
    } else if (wp === 'dodo' || wp === 'phonk') {
        const orbs = [
            { x: w * (0.28 + 0.14 * Math.sin(animPhase * 0.7)), y: h * (0.38 + 0.1 * Math.cos(animPhase * 0.5)), r: Math.max(w, h) * (0.36 + 0.14 * realBass) },
            { x: w * (0.72 + 0.12 * Math.cos(animPhase * 0.6)), y: h * (0.62 + 0.12 * Math.sin(animPhase * 0.8)), r: Math.max(w, h) * (0.32 + 0.14 * realBass) },
        ];
        orbs.forEach((orb) => {
            const grad = wpCtx.createRadialGradient(orb.x, orb.y, 10, orb.x, orb.y, orb.r);
            grad.addColorStop(0, hexToRgba(activeHex, 0.45 + realBass * 0.25));
            grad.addColorStop(0.5, hexToRgba(activeHex, 0.15));
            grad.addColorStop(1, 'rgba(6, 7, 11, 0)');
            wpCtx.fillStyle = grad;
            wpCtx.fillRect(0, 0, w, h);
        });

        wpCtx.strokeStyle = hexToRgba(activeHex, 0.4);
        wpCtx.lineWidth = 2.5;
        for (let line = 0; line < 3; line++) {
            wpCtx.beginPath();
            for (let x = 0; x <= w; x += 16) {
                const y =
                    h * 0.55 +
                    Math.sin(x * 0.006 + animPhase * (1.5 + line * 0.4)) * (30 + realBass * 85) +
                    line * 26;
                if (x === 0) wpCtx.moveTo(x, y);
                else wpCtx.lineTo(x, y);
            }
            wpCtx.stroke();
        }
    } else if (wp === 'synthwave') {
        const sunRadius = 110 + realBass * 55;
        const sunGrad = wpCtx.createRadialGradient(w * 0.5, h * 0.38, 10, w * 0.5, h * 0.38, sunRadius * 2.2);
        sunGrad.addColorStop(0, hexToRgba(activeHex, 0.68));
        sunGrad.addColorStop(0.5, 'rgba(244, 63, 94, 0.24)');
        sunGrad.addColorStop(1, 'rgba(6, 7, 11, 0)');
        wpCtx.fillStyle = sunGrad;
        wpCtx.fillRect(0, 0, w, h);

        wpCtx.strokeStyle = hexToRgba(activeHex, 0.35);
        wpCtx.lineWidth = 1.5;
        const horizon = h * 0.52;
        for (let i = -12; i <= 12; i++) {
            wpCtx.beginPath();
            wpCtx.moveTo(w * 0.5 + i * 30, horizon);
            wpCtx.lineTo(w * 0.5 + i * 180, h);
            wpCtx.stroke();
        }
        const offset = (animPhase * 45) % 40;
        for (let y = horizon; y < h; y += 32) {
            const drawY = y + offset * ((y - horizon) / (h - horizon));
            wpCtx.beginPath();
            wpCtx.moveTo(0, drawY);
            wpCtx.lineTo(w, drawY);
            wpCtx.stroke();
        }
    } else if (wp === 'galaxy') {
        const grad = wpCtx.createRadialGradient(w * 0.5, h * 0.5, 20, w * 0.5, h * 0.5, Math.max(w, h) * (0.48 + realBass * 0.15));
        grad.addColorStop(0, hexToRgba(activeHex, 0.42 + realBass * 0.25));
        grad.addColorStop(0.5, 'rgba(30, 58, 138, 0.2)');
        grad.addColorStop(1, 'rgba(6, 7, 11, 0)');
        wpCtx.fillStyle = grad;
        wpCtx.fillRect(0, 0, w, h);
    }

    particles.forEach((p) => {
        if (shouldAnimate) {
            p.x += p.speedX * (1 + realBass * 3.2);
            p.y += p.speedY * (1 + realBass * 3.2);
            if (p.y < 0) p.y = 1;
            if (p.x < 0) p.x = 1;
            if (p.x > 1) p.x = 0;
        }
        const px = p.x * w;
        const py = p.y * h;
        const radius = p.size * (1 + realBass * 0.85);
        wpCtx.beginPath();
        wpCtx.arc(px, py, radius, 0, Math.PI * 2);
        wpCtx.fillStyle = hexToRgba(activeHex, 0.6);
        wpCtx.fill();
    });

    const mw = miniCanvas.width;
    const mh = miniCanvas.height;
    miniCtx.clearRect(0, 0, mw, mh);
    const bars = 24;
    const barW = mw / bars - 3;
    for (let i = 0; i < bars; i++) {
        let amp = 0.1;
        if (isPlaying && freqData) {
            amp = Math.max(0.12, (freqData[i] || 0) / 255);
        } else if (isPlaying) {
            amp = Math.abs(Math.sin(animPhase * 3.2 + i * 0.45));
        }
        const barH = Math.max(4, amp * (mh - 6));
        miniCtx.fillStyle = activeHex;
        miniCtx.fillRect(i * (barW + 3), mh - barH, barW, barH);
    }

    requestAnimationFrame(renderLiveWallpaper);
}

// СИСТЕМНЫЕ УВЕДОМЛЕНИЯ И ТОСТЫ (WINDOWS + ACTION CENTER)
let toastTimer = null;

function showSystemNotification(title, body, type = 'info', icon = 'icon.png') {
    // 1. Нативное системное уведомление Windows (Windows Action Center Toast) через Electron
    try {
        fetch('/api/system-notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, body, icon }),
        }).catch(() => {});
    } catch (_) {}

    // 2. Нативное Web Notification API
    try {
        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                new Notification(title, { body, icon });
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then((perm) => {
                    if (perm === 'granted') new Notification(title, { body, icon });
                });
            }
        }
    } catch (_) {}

    // 3. Системный плавающий тост в интерфейсе (полная замена alert)
    const toastEl = document.getElementById('systemToast');
    const toastTitle = document.getElementById('toastTitle');
    const toastBody = document.getElementById('toastBody');
    const toastIconWrap = document.getElementById('toastIconWrap');

    if (toastEl && toastTitle && toastBody) {
        toastTitle.textContent = title;
        toastBody.textContent = body;

        toastEl.className = `system-toast ${type} visible`;

        if (toastIconWrap) {
            const iconSrc = icon || 'icon.png';
            toastIconWrap.innerHTML = `<img src="${iconSrc}" class="toast-brand-avatar" alt="DodoMusic" draggable="false" />`;
        }

        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl.classList.remove('visible');
        }, 4500);
    }
}

document.getElementById('toastCloseBtn')?.addEventListener('click', () => {
    document.getElementById('systemToast')?.classList.remove('visible');
});

// Экспорт плеера для системного трея Windows
window.audioPlayer = audioPlayer;
window.playNext = playNext;
window.playPrev = playPrev;

// Системные медиа-клавиши Windows (SMTC: Play, Pause, Next, Prev на клавиатуре)
if ('mediaSession' in navigator) {
    try {
        navigator.mediaSession.setActionHandler('play', () => audioPlayer.play().catch(() => {}));
        navigator.mediaSession.setActionHandler('pause', () => audioPlayer.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
        navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime && !isNaN(details.seekTime)) {
                audioPlayer.currentTime = details.seekTime;
            }
        });
    } catch (_) {}
}

// СИСТЕМА ОБНОВЛЕНИЙ ЧЕРЕЗ GITHUB (v1.5)
async function checkAppUpdates(manual = false) {
    const updateBadgeBtn = document.getElementById('updateBadgeBtn');
    const updateBadgeLabel = document.getElementById('updateBadgeLabel');
    const updateStatusText = document.getElementById('updateStatusText');
    const updateNotesText = document.getElementById('updateNotesText');
    const checkUpdateBtn = document.getElementById('checkUpdateBtn');
    const githubRepoLink = document.getElementById('githubRepoLink');

    if (checkUpdateBtn) {
        checkUpdateBtn.disabled = true;
        checkUpdateBtn.innerHTML = `<span>Проверяем...</span>`;
    }

    try {
        const res = await fetch('/api/check-update');
        if (!res.ok) throw new Error('Сетевая ошибка при проверке');
        const data = await res.json();

        if (githubRepoLink && data.downloadUrl) {
            githubRepoLink.href = data.downloadUrl;
        }

        if (data.hasUpdate) {
            if (updateBadgeBtn) {
                updateBadgeBtn.classList.add('has-update');
                updateBadgeBtn.title = `Доступно обновление: ${data.latestVersion}! Нажмите для перехода`;
            }
            if (updateBadgeLabel) {
                updateBadgeLabel.textContent = `Доступно ${data.latestVersion}`;
                updateBadgeLabel.style.color = '#ff9800';
            }
            if (updateStatusText) {
                updateStatusText.className = 'update-status-badge available';
                updateStatusText.textContent = `Доступно обновление ${data.latestVersion}`;
            }
            if (updateNotesText) {
                updateNotesText.textContent = data.releaseNotes || `Новая версия ${data.latestVersion} готова к установке с GitHub.`;
            }
            if (manual) {
                showSystemNotification(
                    `Доступно обновление DodoMusic ${data.latestVersion}`,
                    data.releaseNotes || 'Новая версия готова к установке с GitHub.',
                    'update'
                );
            }
        } else {
            if (updateBadgeBtn) {
                updateBadgeBtn.classList.remove('has-update');
                updateBadgeBtn.title = 'У вас установлена последняя версия v1.5';
            }
            if (updateBadgeLabel) {
                updateBadgeLabel.textContent = 'Актуально';
                updateBadgeLabel.style.color = '';
            }
            if (updateStatusText) {
                updateStatusText.className = 'update-status-badge ok';
                updateStatusText.textContent = 'Установлена последняя версия v1.5';
            }
            if (updateNotesText) {
                updateNotesText.textContent = 'DodoMusic v1.5 — Точный поиск текстов с проверкой исполнителя, защита очереди от сбоев при поиске и скачивание треков внутри приложения.';
            }
            if (manual) {
                showSystemNotification(
                    'DodoMusic v1.5',
                    'У вас установлена самая актуальная версия! Обновлений не требуется.',
                    'success'
                );
            }
        }
    } catch (err) {
        console.warn('Update check error:', err);
        if (updateStatusText) {
            updateStatusText.textContent = 'v1.5 (Офлайн)';
        }
        if (manual) {
            showSystemNotification(
                'Проверка обновлений',
                'Не удалось связаться с сервером релизов GitHub. Проверьте интернет-соединение.',
                'info'
            );
        }
    } finally {
        if (checkUpdateBtn) {
            checkUpdateBtn.disabled = false;
            checkUpdateBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                <span>Проверить обновления</span>
            `;
        }
    }
}

document.getElementById('updateBadgeBtn')?.addEventListener('click', () => {
    document.querySelector('[data-tab="settings"]')?.click();
    checkAppUpdates(true);
});

document.getElementById('checkUpdateBtn')?.addEventListener('click', () => {
    checkAppUpdates(true);
});

const FALLBACK_POPULAR_TRACKS = [
    {
        id: 'sc_fallback_1',
        title: 'Minor',
        artist: 'Miyagi & Andy Panda',
        duration: '2:55',
        thumbnail: 'https://i1.sndcdn.com/artworks-9WzX8E2f5X7p-0-t500x500.jpg',
        genre: 'Hip-Hop'
    },
    {
        id: 'sc_fallback_2',
        title: 'Asphalt 8',
        artist: 'MACAN',
        duration: '2:34',
        thumbnail: 'https://i1.sndcdn.com/artworks-Yw2p8Q6a2F9h-0-t500x500.jpg',
        genre: 'Rap'
    },
    {
        id: 'sc_fallback_3',
        title: 'Дорадура',
        artist: 'дора',
        duration: '2:14',
        thumbnail: 'https://i1.sndcdn.com/artworks-5a9m6D9q3J2k-0-t500x500.jpg',
        genre: 'Pop-Rock'
    },
    {
        id: 'sc_fallback_4',
        title: 'Мне 20',
        artist: 'просто Лера',
        duration: '3:02',
        thumbnail: 'https://i1.sndcdn.com/artworks-3b7x9C1z4K8m-0-t500x500.jpg',
        genre: 'Indie'
    },
    {
        id: 'sc_fallback_5',
        title: 'Blinding Lights',
        artist: 'The Weeknd',
        duration: '3:20',
        thumbnail: 'https://i1.sndcdn.com/artworks-000676450099-wz9bvi-t500x500.jpg',
        genre: 'Synthpop'
    },
    {
        id: 'sc_fallback_6',
        title: 'Джентльмены',
        artist: 'KME (kme_dota)',
        duration: '2:22',
        thumbnail: 'https://i1.sndcdn.com/artworks-1X2Y3Z-0-t500x500.jpg',
        genre: 'Phonk'
    }
];

async function loadHomeFeed() {
    resultsHeading.textContent = 'Популярные треки';
    resultsCount.textContent = 'Загрузка рекомендаций...';

    // Мгновенно отображаем базовые популярные треки, чтобы экран не был пустым
    if (!discoverTracks || discoverTracks.length === 0) {
        discoverTracks = FALLBACK_POPULAR_TRACKS.slice();
        renderTracksGrid(tracksContainer, discoverTracks);
    }

    let tracks = null;
    if (!isStandaloneApp) {
        try {
            const res = await fetch('/api/search-music', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'Miyagi Macan Дора' }),
                signal: AbortSignal.timeout(4000)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.tracks && data.tracks.length > 0) {
                    tracks = data.tracks;
                }
            }
        } catch (_) {}
    }

    if (!tracks || tracks.length === 0) {
        try {
            tracks = await searchMusicDirectly('Miyagi Macan Дора');
        } catch (_) {}
    }

    if (tracks && tracks.length > 0) {
        discoverTracks = tracks;
        renderTracksGrid(tracksContainer, discoverTracks);
        resultsHeading.textContent = 'Популярные треки';
        resultsCount.textContent = `Треков: ${discoverTracks.length} (онлайн)`;
    } else {
        discoverTracks = FALLBACK_POPULAR_TRACKS.slice();
        renderTracksGrid(tracksContainer, discoverTracks);
        resultsHeading.textContent = 'Популярные треки';
        resultsCount.textContent = `Треков: ${discoverTracks.length} (онлайн)`;
    }
}

// ==========================================
// КАРАОКЕ И СИНХРОНИЗИРОВАННЫЙ ТЕКСТ ПЕСЕН (LYRICS ENGINE)
// ==========================================
let currentLyricsTrack = null;
let currentLyricsData = null;
let lyricsAutoScrollEnabled = true;
const lyricsCache = new Map();

const lyricsModal = document.getElementById('lyricsModal');
const lyricsAmbientGlow = document.getElementById('lyricsAmbientGlow');
const lyricsTrackCover = document.getElementById('lyricsTrackCover');
const lyricsTrackTitle = document.getElementById('lyricsTrackTitle');
const lyricsTrackArtist = document.getElementById('lyricsTrackArtist');
const lyricsMatchedMeta = document.getElementById('lyricsMatchedMeta');
const lyricsStatusBadge = document.getElementById('lyricsStatusBadge');
const lyricsStatusBadgeText = document.getElementById('lyricsStatusBadgeText');
const lyricsEditQueryBtn = document.getElementById('lyricsEditQueryBtn');
const lyricsEditQueryText = document.getElementById('lyricsEditQueryText');
const lyricsManualSearchRow = document.getElementById('lyricsManualSearchRow');
const lyricsQueryArtist = document.getElementById('lyricsQueryArtist');
const lyricsQueryTitle = document.getElementById('lyricsQueryTitle');
const lyricsManualSearchBtn = document.getElementById('lyricsManualSearchBtn');
const lyricsPlaySyncBtn = document.getElementById('lyricsPlaySyncBtn');
const lyricsPlaySyncText = document.getElementById('lyricsPlaySyncText');
const lyricsAutoscrollToggle = document.getElementById('lyricsAutoscrollToggle');
const lyricsAutoscrollText = document.getElementById('lyricsAutoscrollText');
const closeLyricsModalBtn = document.getElementById('closeLyricsModalBtn');
const lyricsBodyWrap = document.getElementById('lyricsBodyWrap');
const lyricsLoading = document.getElementById('lyricsLoading');
const lyricsEmpty = document.getElementById('lyricsEmpty');
const lyricsLinesContainer = document.getElementById('lyricsLinesContainer');
const lyricsPlainContainer = document.getElementById('lyricsPlainContainer');
const lyricsBtn = document.getElementById('lyricsBtn');
const playerTrackInfo = document.getElementById('playerTrackInfo');

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatSecondsToTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? '0' : ''}${rem}`;
}

function parseClientLrc(lrcString) {
    if (!lrcString || typeof lrcString !== 'string') return [];
    const lines = lrcString.split(/\r?\n/);
    const parsed = [];
    const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        if (/^\[(ti|ar|al|au|by|offset|length|re|ve):/i.test(trimmed)) continue;

        const times = [];
        let match;
        timeRegex.lastIndex = 0;
        while ((match = timeRegex.exec(trimmed)) !== null) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const msStr = (match[3] || '0').padEnd(3, '0').slice(0, 3);
            const ms = parseInt(msStr, 10);
            times.push(minutes * 60 + seconds + ms / 1000);
        }

        const text = trimmed.replace(timeRegex, '').trim();
        if (times.length > 0) {
            for (const time of times) {
                parsed.push({ time, text });
            }
        }
    }

    parsed.sort((a, b) => a.time - b.time);
    return parsed;
}

function translitClientCyrToLat(str) {
    const map = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z',
        'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
        'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
        'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
    };
    return (str || '').toLowerCase().replace(/[а-яё]/g, (ch) => map[ch] ?? ch);
}

function normalizeClientLyricsText(str) {
    return (str || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, ' ')
        .replace(/\b(feat|ft|prod|official|video|audio|lyric|lyrics|clip|remix|slowed|reverb|speed\s*up|bass\s*boosted|nightcore|instrumental|karaoke|клип|премьера|текст|ремикс|минус)\b\.?/gi, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractClientLyricsMeta(rawTitle = '', rawArtist = '') {
    let title = (rawTitle || '').replace(/\.(mp3|wav|flac|m4a|ogg)$/i, '').trim();
    let artist = (rawArtist || '').trim();
    const genericArtists = new Set(['исполнитель', 'неизвестный исполнитель', 'unknown', 'unknown artist', 'dodomusic', 'soundcloud', 'soundcloud artist', 'audius artist', 'chart artist', '']);
    const isGenericArtist = genericArtists.has(artist.toLowerCase());

    const dashMatch = title.match(/^(.+?)\s+[-—–|]\s+(.+)$/);
    if (dashMatch && isGenericArtist) {
        const left = dashMatch[1].trim();
        const right = dashMatch[2].trim();
        if (left.length >= 2 && right.length >= 1) {
            artist = left;
            title = right;
        }
    }

    const featMatches = [];
    const featRegex = /(?:feat\.?|ft\.?)\s+([^()[\]]+)/gi;
    let fm;
    while ((fm = featRegex.exec(title)) !== null) {
        featMatches.push(fm[1].trim());
    }

    const cleanTitle = title
        .replace(/\(.*?\)/g, ' ')
        .replace(/\[.*?\]/g, ' ')
        .replace(/\s+(?:feat|ft)\.?\s+.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim() || title;

    const cleanArtist = (genericArtists.has(artist.toLowerCase()) ? '' : artist)
        .replace(/\(.*?\)/g, ' ')
        .replace(/\[.*?\]/g, ' ')
        .replace(/\s+(?:feat|ft)\.?\s+.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();

    return {
        cleanTitle,
        cleanArtist,
        combinedArtistRaw: [cleanArtist, ...featMatches].filter(Boolean).join(', '),
        hasReliableArtist: Boolean(cleanArtist && !genericArtists.has(cleanArtist.toLowerCase()))
    };
}

function buildClientArtistTokens(artistStr) {
    const stop = new Set(['the', 'and', 'feat', 'ft', 'official', 'music', 'channel', 'prod', 'records', 'topic', 'vevo', 'dj', 'mc', 'x', 'и']);
    const normFull = normalizeClientLyricsText(artistStr);
    const parts = (artistStr || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .split(/\s*(?:,|&|feat\.?|ft\.?|vs\.?|×|\bx\b|\bи\b|\band\b|\/|\|)\s*/i)
        .map((p) => normalizeClientLyricsText(p))
        .filter((p) => p && p.length >= 2);
    const words = [];
    for (const w of normFull.split(' ')) {
        if (w.length >= 2 && !stop.has(w)) {
            words.push(w);
            const lat = translitClientCyrToLat(w);
            if (lat && lat !== w && lat.length >= 2) words.push(lat);
        }
    }
    return { full: normFull, fullLat: translitClientCyrToLat(normFull), parts: [...new Set(parts)], words: [...new Set(words)] };
}

function scoreClientLyricsCandidate(item, meta, duration = 0) {
    if (!item || (!item.syncedLyrics && !item.plainLyrics)) return -1;
    const candTitleNorm = normalizeClientLyricsText(item.trackName || item.name || '');
    const targetTitleNorm = normalizeClientLyricsText(meta.cleanTitle);
    if (!candTitleNorm || !targetTitleNorm) return -1;

    let titleScore = 0;
    const tWords = targetTitleNorm.split(' ').filter(Boolean);
    const cWords = candTitleNorm.split(' ').filter(Boolean);
    const cSet = new Set([...cWords, ...cWords.map(translitClientCyrToLat)]);

    if (candTitleNorm === targetTitleNorm || translitClientCyrToLat(candTitleNorm) === translitClientCyrToLat(targetTitleNorm)) {
        titleScore = 100;
    } else {
        let hits = 0;
        for (const w of tWords) {
            if (cSet.has(w) || cSet.has(translitClientCyrToLat(w))) hits++;
        }
        const coverage = tWords.length > 0 ? hits / tWords.length : 0;
        if (coverage < 0.65) return -1;
        titleScore = Math.round(coverage * 75);
        const extraRatio = Math.max(0, cWords.length - tWords.length) / Math.max(1, cWords.length);
        titleScore -= Math.round(extraRatio * 20);
    }

    const targetArt = buildClientArtistTokens(meta.combinedArtistRaw || meta.cleanArtist);
    const candArt = buildClientArtistTokens(item.artistName || '');
    let artistScore = 0;

    if (meta.hasReliableArtist && targetArt.words.length > 0) {
        if (!candArt.full) return -1;
        if (candArt.full === targetArt.full || candArt.fullLat === targetArt.fullLat) {
            artistScore = 130;
        } else {
            const partHit = targetArt.parts.some((tp) => {
                const tpLat = translitClientCyrToLat(tp);
                return candArt.parts.includes(tp) || candArt.full.includes(tp) || candArt.fullLat.includes(tpLat) || tp.includes(candArt.full);
            });
            if (partHit) {
                artistScore = 100;
            } else {
                const candWordSet = new Set(candArt.words);
                let sharedWords = 0;
                for (const tw of targetArt.words) {
                    if (candWordSet.has(tw)) sharedWords++;
                }
                if (sharedWords === 0) return -1;
                artistScore = 70 + Math.min(35, sharedWords * 15);
            }
        }
    } else {
        artistScore = 40;
    }

    let durScore = 0;
    if (duration > 0 && item.duration > 0) {
        const diff = Math.abs(Number(item.duration) - Number(duration));
        if (diff <= 5) durScore = 45;
        else if (diff <= 15) durScore = 25;
        else if (diff <= 30) durScore = 5;
        else if (diff > 60) durScore = -60;
    }

    const syncBonus = item.syncedLyrics ? 20 : 0;
    const total = titleScore + artistScore + durScore + syncBonus;
    const minThreshold = meta.hasReliableArtist ? 115 : 85;
    return total >= minThreshold ? total : -1;
}

async function fetchLrclibDirectly(rawTitle = '', rawArtist = '', duration = 0) {
    const meta = extractClientLyricsMeta(rawTitle, rawArtist);
    if (!meta.cleanTitle) {
        return { found: false, synced: false, lines: [], plainLyrics: '' };
    }

    const candidates = new Map();
    const addCandidate = (item) => {
        if (!item || (!item.syncedLyrics && !item.plainLyrics)) return;
        const id = item.id || `${item.artistName}::${item.trackName || item.name}::${item.duration}`;
        if (!candidates.has(id)) candidates.set(id, item);
    };

    if (meta.cleanTitle && meta.cleanArtist) {
        try {
            let getUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(meta.cleanTitle)}&artist_name=${encodeURIComponent(meta.cleanArtist)}`;
            if (duration > 0) getUrl += `&duration=${Math.round(duration)}`;
            addCandidate(await networkFetchJson(getUrl, 4500));
        } catch (_) {}
    }

    const searchUrls = [];
    const primaryArtistPart = buildClientArtistTokens(meta.cleanArtist).parts[0] || meta.cleanArtist;
    if (meta.hasReliableArtist) {
        searchUrls.push(`https://lrclib.net/api/search?track_name=${encodeURIComponent(meta.cleanTitle)}&artist_name=${encodeURIComponent(meta.cleanArtist)}`);
        if (primaryArtistPart && primaryArtistPart.toLowerCase() !== meta.cleanArtist.toLowerCase()) {
            searchUrls.push(`https://lrclib.net/api/search?track_name=${encodeURIComponent(meta.cleanTitle)}&artist_name=${encodeURIComponent(primaryArtistPart)}`);
        }
        searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(`${meta.cleanArtist} ${meta.cleanTitle}`)}`);
    } else {
        searchUrls.push(`https://lrclib.net/api/search?track_name=${encodeURIComponent(meta.cleanTitle)}`);
        searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(meta.cleanTitle)}`);
    }

    await Promise.all(
        searchUrls.map(async (u) => {
            try {
                const list = await networkFetchJson(u, 4500);
                if (Array.isArray(list)) {
                    for (const item of list.slice(0, 15)) addCandidate(item);
                }
            } catch (_) {}
        })
    );

    const scored = [];
    for (const item of candidates.values()) {
        const s = scoreClientLyricsCandidate(item, meta, duration);
        if (s >= 0) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
        const best = scored[0].item;
        return {
            found: true,
            synced: Boolean(best.syncedLyrics),
            lines: best.syncedLyrics ? parseClientLrc(best.syncedLyrics) : [],
            plainLyrics: best.plainLyrics || '',
            trackName: best.trackName || best.name || meta.cleanTitle,
            artistName: best.artistName || meta.cleanArtist,
            source: 'LRCLIB'
        };
    }

    if (meta.hasReliableArtist) {
        for (const artCandidate of [meta.cleanArtist, primaryArtistPart].filter(Boolean)) {
            try {
                const ovhData = await networkFetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artCandidate)}/${encodeURIComponent(meta.cleanTitle)}`, 4000);
                if (ovhData?.lyrics && ovhData.lyrics.trim().length > 20) {
                    return {
                        found: true,
                        synced: false,
                        lines: [],
                        plainLyrics: ovhData.lyrics.trim(),
                        trackName: meta.cleanTitle,
                        artistName: artCandidate,
                        source: 'Lyrics.ovh'
                    };
                }
            } catch (_) {}
        }
    }

    return { found: false, synced: false, lines: [], plainLyrics: '' };
}

async function openLyricsForTrack(track, overrideQuery = null) {
    if (!track) return;
    const reqId = ++activeLyricsRequestId;
    currentLyricsTrack = track;
    currentLyricsData = null;

    const searchTitle = overrideQuery?.title ?? decodeHtml(track.title || '');
    const searchArtist = overrideQuery?.artist ?? decodeHtml(track.artist || '');
    const lang = userSettings?.language || 'ru';

    lyricsModal?.classList.add('visible');

    if (lyricsTrackCover) lyricsTrackCover.src = track.thumbnail || 'icon.png';
    if (lyricsTrackTitle) lyricsTrackTitle.textContent = decodeHtml(track.title || 'Песня');
    if (lyricsTrackArtist) lyricsTrackArtist.textContent = decodeHtml(track.artist || 'DodoMusic');
    if (lyricsAmbientGlow) lyricsAmbientGlow.style.backgroundImage = `url('${track.thumbnail || 'icon.png'}')`;
    if (lyricsMatchedMeta) {
        lyricsMatchedMeta.style.display = 'none';
        lyricsMatchedMeta.textContent = '';
    }
    if (lyricsQueryArtist && !overrideQuery) lyricsQueryArtist.value = searchArtist;
    if (lyricsQueryTitle && !overrideQuery) lyricsQueryTitle.value = searchTitle;

    updateLyricsPlaySyncButtonState();

    // Скрываем бейдж караоке до момента пока текст реально не загрузится
    if (lyricsStatusBadge) lyricsStatusBadge.style.display = 'none';

    if (lyricsLoading) lyricsLoading.style.display = 'block';
    if (lyricsEmpty) lyricsEmpty.style.display = 'none';
    if (lyricsLinesContainer) {
        lyricsLinesContainer.style.display = 'none';
        lyricsLinesContainer.innerHTML = '';
    }
    if (lyricsPlainContainer) {
        lyricsPlainContainer.style.display = 'none';
        lyricsPlainContainer.innerHTML = '';
    }

    const cacheKey = `${searchTitle.trim().toLowerCase()}:::${searchArtist.trim().toLowerCase()}`;
    if (!overrideQuery && lyricsCache.has(cacheKey)) {
        if (reqId !== activeLyricsRequestId) return;
        currentLyricsData = lyricsCache.get(cacheKey);
        renderLyricsData(currentLyricsData);
        return;
    }

    let lyricsData = null;

    // 1. Попытка запроса через встроенный бэкенд
    if (!isStandaloneApp) {
        try {
            const queryParams = new URLSearchParams({
                title: searchTitle,
                artist: searchArtist,
                duration: track.durationSeconds || track.durationSec || 0
            });

            const res = await fetch(`/api/lyrics?${queryParams.toString()}`);
            if (reqId !== activeLyricsRequestId) return;
            if (res.ok) {
                const json = await res.json();
                if (json && json.found && (json.synced || json.plainLyrics)) {
                    lyricsData = json;
                }
            }
        } catch (_) {}
    }

    if (reqId !== activeLyricsRequestId) return;

    // 2. Прямой клиентский fallback на LRCLIB / Lyrics.ovh (для автономного режима или если сервер не смог)
    if (!lyricsData || !lyricsData.found) {
        try {
            lyricsData = await fetchLrclibDirectly(
                searchTitle,
                searchArtist,
                track.durationSeconds || track.durationSec || 0
            );
        } catch (_) {}
    }

    if (reqId !== activeLyricsRequestId) return;

    if (lyricsData && lyricsData.found && (lyricsData.synced || lyricsData.plainLyrics)) {
        currentLyricsData = lyricsData;
        lyricsCache.set(cacheKey, lyricsData);
        renderLyricsData(lyricsData);
    } else {
        if (lyricsLoading) lyricsLoading.style.display = 'none';
        if (lyricsEmpty) lyricsEmpty.style.display = 'block';
        if (lyricsStatusBadge) lyricsStatusBadge.style.display = 'none';
    }
}

function updateLyricsPlaySyncButtonState() {
    const active = getActiveTrack();
    const isThisTrackActive = active && currentLyricsTrack && active.id === currentLyricsTrack.id;
    const lang = userSettings?.language || 'ru';
    const dict = I18N[lang] || I18N.ru;

    if (lyricsPlaySyncBtn) {
        if (isThisTrackActive) {
            lyricsPlaySyncBtn.style.display = isPlaying ? 'none' : 'inline-flex';
            if (lyricsPlaySyncText) lyricsPlaySyncText.textContent = isPlaying ? 'Играет' : 'Продолжить играть';
        } else {
            lyricsPlaySyncBtn.style.display = 'inline-flex';
            if (lyricsPlaySyncText) lyricsPlaySyncText.textContent = dict.lyrics_play_sync || 'Слушать с текстом';
        }
    }
}

function renderLyricsData(data) {
    if (lyricsLoading) lyricsLoading.style.display = 'none';
    const lang = userSettings?.language || 'ru';
    const dict = I18N[lang] || I18N.ru;

    if (!data || !data.found || (!data.synced && !data.plainLyrics)) {
        if (lyricsEmpty) lyricsEmpty.style.display = 'block';
        if (lyricsStatusBadge) lyricsStatusBadge.style.display = 'none';
        if (lyricsMatchedMeta) lyricsMatchedMeta.style.display = 'none';
        if (lyricsLinesContainer) lyricsLinesContainer.style.display = 'none';
        if (lyricsPlainContainer) lyricsPlainContainer.style.display = 'none';
        return;
    }

    if (lyricsMatchedMeta) {
        const mArtist = data.artistName || currentLyricsTrack?.artist || '';
        const mTitle = data.trackName || currentLyricsTrack?.title || '';
        const src = data.source || 'LRCLIB';
        lyricsMatchedMeta.textContent = `Текст (${src}): ${mArtist} — ${mTitle}`;
        lyricsMatchedMeta.style.display = 'inline-flex';
    }

    // Если текст найден - прячем заглушку пустого состояния
    if (lyricsEmpty) lyricsEmpty.style.display = 'none';

    if (data.synced && Array.isArray(data.lines) && data.lines.length > 0) {
        if (lyricsStatusBadge) {
            lyricsStatusBadge.style.display = 'inline-flex';
            lyricsStatusBadge.className = 'lyrics-badge synced';
        }
        if (lyricsStatusBadgeText) lyricsStatusBadgeText.textContent = dict.lyrics_status_synced || 'Караоке синхронизация';
        if (lyricsPlainContainer) lyricsPlainContainer.style.display = 'none';
        if (lyricsLinesContainer) {
            lyricsLinesContainer.style.display = 'flex';
            lyricsLinesContainer.innerHTML = '';

            data.lines.forEach((line, idx) => {
                const lineEl = document.createElement('div');
                lineEl.className = 'lyric-line';
                lineEl.dataset.time = line.time;
                lineEl.dataset.idx = idx;

                const timeStr = formatSecondsToTime(line.time);
                lineEl.innerHTML = `
                    <span class="lyric-timestamp">${timeStr}</span>
                    <span class="lyric-text">${escapeHtml(line.text)}</span>
                    <span class="lyric-jump-icon">▶</span>
                `;

                lineEl.addEventListener('click', () => {
                    handleLyricLineClick(line.time);
                });

                lyricsLinesContainer.appendChild(lineEl);
            });
        }

        syncLyricsWithTime(audioPlayer?.currentTime || 0);
    } else if (data.plainLyrics) {
        if (lyricsStatusBadge) {
            lyricsStatusBadge.style.display = 'inline-flex';
            lyricsStatusBadge.className = 'lyrics-badge plain';
        }
        if (lyricsStatusBadgeText) lyricsStatusBadgeText.textContent = dict.lyrics_status_plain || 'Текст песни';
        if (lyricsPlainContainer) {
            lyricsPlainContainer.style.display = 'block';
            lyricsPlainContainer.textContent = data.plainLyrics;
        }
    }
}

function handleLyricLineClick(targetTime) {
    const active = getActiveTrack();
    const isThisTrackActive = active && currentLyricsTrack && active.id === currentLyricsTrack.id;

    if (!isThisTrackActive && currentLyricsTrack) {
        const trackIdx = currentQueue.findIndex(t => t.id === currentLyricsTrack.id);
        if (trackIdx !== -1) {
            playTrackAtIndex(trackIdx);
        } else {
            currentQueue.splice(currentIndex + 1, 0, currentLyricsTrack);
            playTrackAtIndex(currentIndex + 1);
        }
        setTimeout(() => {
            if (audioPlayer) {
                audioPlayer.currentTime = targetTime;
                audioPlayer.play().catch(() => {});
                syncPlayPauseUI();
            }
        }, 350);
        return;
    }

    if (audioPlayer) {
        audioPlayer.currentTime = targetTime;
        if (audioPlayer.paused) {
            audioPlayer.play().catch(() => {});
            syncPlayPauseUI();
        }
    }
    syncLyricsWithTime(targetTime);
}

function syncLyricsWithTime(currentTime) {
    if (!lyricsModal?.classList.contains('visible')) return;
    const active = getActiveTrack();
    const isThisTrackActive = active && currentLyricsTrack && active.id === currentLyricsTrack.id;
    if (!isThisTrackActive) return;

    if (!currentLyricsData?.synced || !Array.isArray(currentLyricsData.lines)) return;

    const lines = currentLyricsData.lines;
    let activeIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        if (currentTime >= lines[i].time) {
            activeIdx = i;
        } else {
            break;
        }
    }

    if (activeIdx === -1 && lines.length > 0) activeIdx = 0;

    const allLineEls = lyricsLinesContainer?.querySelectorAll('.lyric-line');
    if (!allLineEls || allLineEls.length === 0) return;

    let targetEl = null;
    allLineEls.forEach((el, idx) => {
        if (idx === activeIdx) {
            if (!el.classList.contains('active-line')) {
                el.classList.add('active-line');
            }
            targetEl = el;
        } else {
            el.classList.remove('active-line');
        }
    });

    if (targetEl && lyricsAutoScrollEnabled) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function closeLyricsModal() {
    lyricsModal?.classList.remove('visible');
}

closeLyricsModalBtn?.addEventListener('click', closeLyricsModal);
lyricsModal?.addEventListener('click', (e) => {
    if (e.target === lyricsModal) closeLyricsModal();
});

lyricsAutoscrollToggle?.addEventListener('click', () => {
    lyricsAutoScrollEnabled = !lyricsAutoScrollEnabled;
    const lang = userSettings?.language || 'ru';
    const dict = I18N[lang] || I18N.ru;
    lyricsAutoscrollToggle.classList.toggle('active', lyricsAutoScrollEnabled);
    if (lyricsAutoscrollText) {
        lyricsAutoscrollText.textContent = lyricsAutoScrollEnabled 
            ? (dict.lyrics_autoscroll_on || 'Автопрокрутка: ВКЛ')
            : (dict.lyrics_autoscroll_off || 'Автопрокрутка: ВЫКЛ');
    }
});

lyricsEditQueryBtn?.addEventListener('click', () => {
    if (!lyricsManualSearchRow) return;
    const isOpen = lyricsManualSearchRow.style.display !== 'none';
    lyricsManualSearchRow.style.display = isOpen ? 'none' : 'flex';
    if (!isOpen && currentLyricsTrack) {
        if (lyricsQueryArtist) lyricsQueryArtist.value = decodeHtml(currentLyricsTrack.artist || '');
        if (lyricsQueryTitle) lyricsQueryTitle.value = decodeHtml(currentLyricsTrack.title || '');
        lyricsQueryArtist?.focus();
    }
});

function triggerManualLyricsSearch() {
    if (!currentLyricsTrack) return;
    const qArtist = (lyricsQueryArtist?.value || '').trim();
    const qTitle = (lyricsQueryTitle?.value || '').trim();
    if (!qTitle && !qArtist) return;
    openLyricsForTrack(currentLyricsTrack, { artist: qArtist, title: qTitle });
}

lyricsManualSearchBtn?.addEventListener('click', triggerManualLyricsSearch);
lyricsQueryArtist?.addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerManualLyricsSearch(); });
lyricsQueryTitle?.addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerManualLyricsSearch(); });

lyricsPlaySyncBtn?.addEventListener('click', () => {
    if (currentLyricsTrack) {
        const active = getActiveTrack();
        if (active && active.id === currentLyricsTrack.id) {
            if (audioPlayer.paused) {
                audioPlayer.play().catch(() => {});
                syncPlayPauseUI();
            }
        } else {
            const trackIdx = currentQueue.findIndex(t => t.id === currentLyricsTrack.id);
            if (trackIdx !== -1) {
                playTrackAtIndex(trackIdx);
            } else {
                currentQueue.splice(currentIndex + 1, 0, currentLyricsTrack);
                playTrackAtIndex(currentIndex + 1);
            }
        }
        updateLyricsPlaySyncButtonState();
    }
});

playerTrackInfo?.addEventListener('click', (e) => {
    if (e.target.closest('#likeCurrentBtn') || e.target.closest('#playerArtist')) return;
    const current = getActiveTrack();
    if (current) {
        openLyricsForTrack(current);
    } else {
        showSystemToast('DodoMusic', 'Сначала включите трек для показа текста', 'info');
    }
});

// Клик по имени артиста в шапке окна текста также открывает профиль артиста
lyricsTrackArtist?.addEventListener('click', (e) => {
    e.stopPropagation();
    const track = currentLyricsTrack || getActiveTrack();
    if (track?.artist) {
        closeLyricsModal();
        openArtistPage(track.artist);
    }
});

lyricsBtn?.addEventListener('click', () => {
    const current = getActiveTrack();
    if (current) {
        if (lyricsModal?.classList.contains('visible') && currentLyricsTrack?.id === current.id) {
            closeLyricsModal();
        } else {
            openLyricsForTrack(current);
        }
    } else {
        showSystemToast('DodoMusic', 'Включите трек, чтобы смотреть караоке и текст', 'info');
    }
});

window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'Escape' && lyricsModal?.classList.contains('visible')) {
        closeLyricsModal();
        return;
    }
    if (e.key === 'l' || e.key === 'L' || e.key === 'д' || e.key === 'Д') {
        if (lyricsModal?.classList.contains('visible')) {
            closeLyricsModal();
        } else {
            const current = getActiveTrack();
            if (current) openLyricsForTrack(current);
        }
    }
});

if (!localStorage.getItem('dodomusic_avatar_theme_v2')) {
    userSettings.wallpaper = 'aurora';
    userSettings.accentColor = '#1ed760';
    localStorage.setItem('dodomusic_avatar_theme_v2', '1');
}

applySettingsToDOM();
requestAnimationFrame(renderLiveWallpaper);
loadLibraryFromDisk();
renderTasteAnalysisUI();
loadHomeFeed();
checkAppUpdates(false);
