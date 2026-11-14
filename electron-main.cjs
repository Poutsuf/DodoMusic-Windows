const { app, BrowserWindow, shell, Tray, Menu, Notification, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');

function logDebug(msg) {
    try {
        const logDir = app.getPath('userData');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'electron-debug.log'), msg);
    } catch (_) {}
}
logDebug(`[INIT] Process started at ${new Date().toISOString()}\n`);
process.on('uncaughtException', (err) => {
    logDebug(`[CRASH] uncaughtException: ${err && (err.stack || err)}\n`);
});
process.on('unhandledRejection', (reason) => {
    logDebug(`[CRASH] unhandledRejection: ${reason && (reason.stack || reason)}\n`);
});
process.on('exit', (code) => {
    logDebug(`[PROCESS_EXIT] code: ${code}\n`);
});
process.on('beforeExit', (code) => {
    logDebug(`[BEFORE_EXIT] code: ${code}\n`);
});

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.dodomusic.app');

let cachedScClientId = '39AVoiZVrdvJEMFLH8T0c5WGshQaAPRJ';
let lastClientIdFetch = 0;

async function getSoundCloudClientId() {
    const now = Date.now();
    if (cachedScClientId && now - lastClientIdFetch < 3600000) {
        return cachedScClientId;
    }
    try {
        const res = await fetch('https://soundcloud.com', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(6000),
        });
        const html = await res.text();
        const matches = html.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g) || [];
        for (const s of matches.slice(-6)) {
            const js = await (await fetch(s, { signal: AbortSignal.timeout(6000) })).text();
            const m = js.match(/client_id[:=]"([a-zA-Z0-9]{32})"/);
            if (m) {
                cachedScClientId = m[1];
                lastClientIdFetch = now;
                return cachedScClientId;
            }
        }
    } catch (_) {}
    return cachedScClientId;
}

function cleanUserQuery(rawQuery) {
    return (
        rawQuery
            .replace(/\b(скачать|песню|песня|слушать|онлайн|бесплатно|без рекламы|клип|mp3|shorts)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim() || rawQuery.trim()
    );
}

function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '3:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function cleanTitleAndArtist(rawTitle, rawUser) {
    let title = (rawTitle || '').replace(/\.(mp3|wav|flac|m4a|ogg)$/i, '').trim();
    let artist = (rawUser || 'Исполнитель').trim();

    const match = title.match(/^(.+?)\s+[-—–|]\s+(.+)$/);
    if (match && match[1].trim().length >= 2 && match[2].trim().length >= 1) {
        artist = match[1].trim();
        title = match[2].trim();
    }
    return { artist, title };
}

function normalizeMatchText(str) {
    return (str || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreTrackSearchRelevance(track, rawQuery) {
    const qNorm = normalizeMatchText(rawQuery);
    if (!qNorm) return 0;
    const qWords = qNorm.split(' ').filter((w) => w.length >= 2);
    const wantsRemix = /\b(remix|ремикс|bootleg|flip|edit)\b/i.test(rawQuery);
    const wantsSlowed = /\b(slowed|reverb|bass|nightcore|speed up|8d|instrumental|minus|минус|кавер|cover|live|acoustic)\b/i.test(rawQuery);

    const tNorm = normalizeMatchText(track.title);
    const aNorm = normalizeMatchText(track.artist);
    const fullNorm = `${aNorm} ${tNorm}`.trim();

    let score = 0;
    if (tNorm === qNorm || fullNorm === qNorm) score += 150;
    if (tNorm.includes(qNorm)) score += 70;
    if (aNorm.includes(qNorm)) score += 50;

    let matchedWords = 0;
    for (const w of qWords) {
        if (fullNorm.includes(w)) matchedWords++;
    }
    if (qWords.length > 0) {
        score += Math.round((matchedWords / qWords.length) * 80);
    }

    if (!wantsRemix && /\b(remix|ремикс|bootleg|flip)\b/i.test(fullNorm)) score -= 35;
    if (!wantsSlowed && /\b(slowed|reverb|bassboosted|bass boosted|nightcore|speed up|8d audio|instrumental|минус|karaoke|кавер|cover)\b/i.test(fullNorm)) {
        score -= 45;
    }

    const plays = Number(track.playbackCount || 0);
    if (plays > 100000) score += 15;
    else if (plays > 10000) score += 8;

    return score;
}

function pickSoundCloudTranscodings(media) {
    const list = media?.transcodings || [];
    if (!list.length) return { primary: null, progressive: null, mpegHls: null };
    const progressive = list.find((tc) => tc.format?.protocol === 'progressive');
    const aacHls = list.find((tc) => tc.format?.protocol === 'hls' && tc.format?.mime_type?.includes('mp4a'));
    const mpegHls = list.find((tc) => tc.format?.protocol === 'hls' && tc.format?.mime_type?.includes('mpeg'));
    const primary = progressive || aacHls || mpegHls || list[0];
    return { primary, progressive, mpegHls };
}

async function resolveSoundCloudStreamUrl(transcodingUrl, trackAuthorization = '') {
    if (!transcodingUrl) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt === 1) lastClientIdFetch = 0;
        const cid = await getSoundCloudClientId();
        const sep = transcodingUrl.includes('?') ? '&' : '?';
        let url = `${transcodingUrl}${sep}client_id=${cid}`;
        if (trackAuthorization) {
            url += `&track_authorization=${encodeURIComponent(trackAuthorization)}`;
        }
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                signal: AbortSignal.timeout(5500),
            });
            if (res.ok) {
                const data = await res.json();
                if (data?.url) return data.url;
            } else if (res.status !== 401 && res.status !== 403) {
                break;
            }
        } catch (_) {}
    }
    return null;
}

async function searchSoundCloudFullTracks(query) {
    try {
        const cid = await getSoundCloudClientId();
        const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${cid}&limit=24`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return [];
        const data = await res.json();
        const items = data.collection || [];

        const mapped = items
            .filter((t) => t.id && t.duration >= 35000 && t.duration <= 900000 && t.media?.transcodings?.length)
            .map((t) => {
                const totalSec = Math.round(t.duration / 1000);
                const { artist, title } = cleanTitleAndArtist(t.title, t.user?.username || t.user?.name);

                let cover = t.artwork_url || t.user?.avatar_url || '/icon.png';
                cover = cover.replace('-large', '-t500x500');

                const { primary, progressive, mpegHls } = pickSoundCloudTranscodings(t.media);

                return {
                    id: `sc_${t.id}`,
                    source: 'soundcloud',
                    title,
                    artist,
                    duration: formatDuration(totalSec),
                    durationSeconds: totalSec,
                    thumbnail: cover,
                    transcodingUrl: primary?.url || '',
                    progressiveUrl: progressive?.url || '',
                    mpegHlsUrl: mpegHls?.url || '',
                    trackAuthorization: t.track_authorization || '',
                    protocol: primary?.format?.protocol || 'hls',
                    playbackCount: t.playback_count || 0,
                    permalinkUrl: t.permalink_url || `https://soundcloud.com/search?q=${encodeURIComponent(artist + ' ' + title)}`,
                    isFullTrack: true,
                };
            });

        mapped.sort((a, b) => scoreTrackSearchRelevance(b, query) - scoreTrackSearchRelevance(a, query));
        return mapped;
    } catch (_) {
        return [];
    }
}

async function searchAudiusFullTracks(query) {
    try {
        const url = `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=dodomusic`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.data || [])
            .filter((item) => item.id && item.duration >= 35 && item.duration <= 900)
            .slice(0, 8)
            .map((item) => {
                const { artist, title } = cleanTitleAndArtist(item.title, item.user?.name);
                return {
                    id: `au_${item.id}`,
                    source: 'audius',
                    title,
                    artist,
                    duration: formatDuration(item.duration),
                    durationSeconds: item.duration,
                    thumbnail: item.artwork?.['480x480'] || item.artwork?.['150x150'] || '/icon.png',
                    streamUrl: `https://api.audius.co/v1/tracks/${item.id}/stream?app_name=dodomusic`,
                    protocol: 'progressive',
                    permalinkUrl: `https://audius.co${item.permalink || ''}`,
                    isFullTrack: true,
                };
            });
    } catch (_) {
        return [];
    }
}

async function searchFullMusicTracks(rawQuery) {
    const cleanQuery = cleanUserQuery(rawQuery);
    const [scTracks, auTracks] = await Promise.all([
        searchSoundCloudFullTracks(cleanQuery),
        searchAudiusFullTracks(cleanQuery),
    ]);

    const combined = [];
    const seen = new Set();

    for (const t of [...scTracks, ...auTracks]) {
        const key = `${t.artist.toLowerCase()}__${t.title.toLowerCase()}`;
        if (!seen.has(key)) {
            seen.add(key);
            combined.push(t);
        }
    }

    combined.sort((a, b) => scoreTrackSearchRelevance(b, cleanQuery) - scoreTrackSearchRelevance(a, cleanQuery));
    return combined.slice(0, 24);
}

/**
 * Получение похожих треков / Умный автомикс (Smart Radio)
 */
async function getRelatedMusicTracks({ trackId = '', artist = '', title = '' }) {
    const results = [];
    const seenIds = new Set();
    const seenSignatures = new Set();

    if (trackId) seenIds.add(trackId);
    if (artist && title) {
        seenSignatures.add(`${artist.toLowerCase()}__${title.toLowerCase()}`);
    }

    if (trackId && trackId.startsWith('sc_')) {
        const numId = trackId.replace('sc_', '');
        try {
            const cid = await getSoundCloudClientId();
            const res = await fetch(`https://api-v2.soundcloud.com/tracks/${numId}/related?client_id=${cid}&limit=20`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                signal: AbortSignal.timeout(8000),
            });
            if (res.ok) {
                const data = await res.json();
                for (const item of (data.collection || [])) {
                    if (!item || !item.media?.transcodings?.length) continue;
                    const durationSec = Math.round((item.duration || 0) / 1000);
                    if (durationSec < 45 || durationSec > 900) continue;

                    const { artist: itemArtist, title: itemTitle } = cleanTitleAndArtist(item.title, item.user?.username || 'SoundCloud Artist');

                    const sig = `${itemArtist.toLowerCase()}__${itemTitle.toLowerCase()}`;
                    const sid = `sc_${item.id}`;
                    if (seenIds.has(sid) || seenSignatures.has(sig)) continue;
                    seenIds.add(sid);
                    seenSignatures.add(sig);

                    const { primary, progressive, mpegHls } = pickSoundCloudTranscodings(item.media);

                    const artwork = item.artwork_url
                        ? item.artwork_url.replace('-large.', '-t500x500.')
                        : (item.user?.avatar_url || '/icon.png');

                    results.push({
                        id: sid,
                        source: 'soundcloud',
                        title: itemTitle,
                        artist: itemArtist,
                        duration: formatDuration(durationSec),
                        durationSeconds: durationSec,
                        thumbnail: artwork,
                        transcodingUrl: primary?.url || '',
                        progressiveUrl: progressive?.url || '',
                        mpegHlsUrl: mpegHls?.url || '',
                        trackAuthorization: item.track_authorization || '',
                        protocol: primary?.format?.protocol || 'hls',
                        permalinkUrl: item.permalink_url || '',
                        isFullTrack: true,
                    });
                }
            }
        } catch (err) {
            console.warn('[Related SoundCloud Warning]', err.message);
        }
    }

    if (results.length < 12) {
        try {
            const queryCandidates = [];
            if (artist && artist !== 'SoundCloud Artist' && artist !== 'Audius Artist') {
                queryCandidates.push(artist);
            }
            const cleanTitleWords = title
                .replace(/[()\[\]{}_]/g, ' ')
                .replace(/\b(feat|ft|official|audio|video|prod|remix|speed up|slowed|bass boosted)\b/gi, '')
                .trim();
            if (cleanTitleWords && cleanTitleWords !== artist) {
                queryCandidates.push(cleanTitleWords);
            }

            for (const q of queryCandidates.slice(0, 2)) {
                if (results.length >= 18) break;
                const moreTracks = await searchFullMusicTracks(q);
                for (const t of moreTracks) {
                    const sig = `${(t.artist || '').toLowerCase()}__${(t.title || '').toLowerCase()}`;
                    if (!seenIds.has(t.id) && !seenSignatures.has(sig)) {
                        seenIds.add(t.id);
                        seenSignatures.add(sig);
                        results.push(t);
                    }
                }
            }
        } catch (_) {}
    }

    return results;
}

/**
 * Получение профиля артиста, его дискографии и плейлистов
 */
async function getArtistProfileAndDiscography(artistName) {
    const cid = await getSoundCloudClientId();
    const cleanName = (artistName || '').trim();
    if (!cleanName) return null;

    const isKme = cleanName.toLowerCase().includes('kme');

    let artistProfile = {
        name: isKme ? 'KME' : cleanName,
        avatar: isKme ? 'https://i1.sndcdn.com/artworks-JIp3enfT7rTm-0-t500x500.jpg' : '/icon.png',
        permalinkUrl: `https://soundcloud.com/search/people?q=${encodeURIComponent(cleanName)}`,
        followersCount: 0,
        trackCount: 0,
        verified: true,
        bio: isKme
            ? 'Официальный профиль артиста KME (kme_dota). Популярные треки «Джентльмены», «Дагон», «Slam», «Солнечный день».'
            : `Официальная дискография и релизы артиста ${cleanName}`,
    };

    let tracks = [];
    let playlists = [];

    const searchQueries = isKme ? ['kme dota', 'KME'] : [cleanName];

    for (const q of searchQueries) {
        try {
            const uRes = await fetch(
                `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(q)}&client_id=${cid}&limit=3`,
                {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                    signal: AbortSignal.timeout(6000),
                }
            );
            if (uRes.ok) {
                const uData = await uRes.json();
                const topUser = uData.collection?.[0];
                if (topUser && !isKme) {
                    artistProfile.name = topUser.username || cleanName;
                    artistProfile.avatar = topUser.avatar_url
                        ? topUser.avatar_url.replace('-large', '-t500x500')
                        : '/icon.png';
                    artistProfile.permalinkUrl = topUser.permalink_url || artistProfile.permalinkUrl;
                    artistProfile.followersCount = topUser.followers_count || 0;
                    artistProfile.trackCount = topUser.track_count || 0;
                    if (topUser.description) artistProfile.bio = topUser.description.slice(0, 300);
                }

                if (topUser?.id) {
                    try {
                        const utRes = await fetch(
                            `https://api-v2.soundcloud.com/users/${topUser.id}/tracks?client_id=${cid}&limit=30`,
                            { signal: AbortSignal.timeout(6000) }
                        );
                        if (utRes.ok) {
                            const utData = await utRes.json();
                            for (const item of utData.collection || []) {
                                if (!item || !item.media?.transcodings?.length) continue;
                                const sec = Math.round((item.duration || 0) / 1000);
                                if (sec < 45 || sec > 1200) continue;

                                const { artist, title } = cleanTitleAndArtist(item.title, topUser.username);
                                const { primary, progressive, mpegHls } = pickSoundCloudTranscodings(item.media);

                                tracks.push({
                                    id: `sc_${item.id}`,
                                    source: 'soundcloud',
                                    title,
                                    artist: artist || cleanName,
                                    duration: formatDuration(sec),
                                    durationSeconds: sec,
                                    thumbnail: item.artwork_url
                                        ? item.artwork_url.replace('-large', '-t500x500')
                                        : artistProfile.avatar,
                                    transcodingUrl: primary?.url || '',
                                    progressiveUrl: progressive?.url || '',
                                    mpegHlsUrl: mpegHls?.url || '',
                                    trackAuthorization: item.track_authorization || '',
                                    protocol: primary?.format?.protocol || 'hls',
                                    permalinkUrl: item.permalink_url || '',
                                    isFullTrack: true,
                                });
                            }
                        }
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }

    // Дополняем прямым поиском всех треков артиста
    for (const q of searchQueries) {
        try {
            const searchTracks = await searchFullMusicTracks(q);
            const seen = new Set(tracks.map((t) => `${t.artist.toLowerCase()}__${t.title.toLowerCase()}`));
            for (const st of searchTracks) {
                const sig = `${(st.artist || '').toLowerCase()}__${(st.title || '').toLowerCase()}`;
                if (!seen.has(sig)) {
                    seen.add(sig);
                    tracks.push(st);
                }
            }
        } catch (_) {}
    }

    // Если аватар дефолтный — берем обложку самого первого трека
    if ((!artistProfile.avatar || artistProfile.avatar.includes('default_avatar')) && tracks[0]?.thumbnail) {
        artistProfile.avatar = tracks[0].thumbnail;
    }

    if (isKme) {
        tracks.sort((a, b) => {
            const aHit = a.title.toLowerCase().startsWith('джентльмены') ? 1 : 0;
            const bHit = b.title.toLowerCase().startsWith('джентльмены') ? 1 : 0;
            return bHit - aHit;
        });
    }

    return {
        artist: artistProfile,
        tracks: tracks.slice(0, 50),
    };
}

/**
 * Получение треков конкретного плейлиста или альбома
 */
async function getPlaylistTracks(playlistNumericId) {
    const cid = await getSoundCloudClientId();
    try {
        const res = await fetch(`https://api-v2.soundcloud.com/playlists/${playlistNumericId}?client_id=${cid}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        const tracks = [];
        for (const t of data.tracks || []) {
            if (!t || !t.id || !t.media?.transcodings?.length) continue;
            const sec = Math.round((t.duration || 0) / 1000);
            if (sec < 30) continue;

            const { artist, title } = cleanTitleAndArtist(t.title, t.user?.username);
            const { primary, progressive, mpegHls } = pickSoundCloudTranscodings(t.media);

            tracks.push({
                id: `sc_${t.id}`,
                source: 'soundcloud',
                title,
                artist,
                duration: formatDuration(sec),
                durationSeconds: sec,
                thumbnail: t.artwork_url
                    ? t.artwork_url.replace('-large', '-t500x500')
                    : t.user?.avatar_url || '/icon.png',
                transcodingUrl: primary?.url || '',
                progressiveUrl: progressive?.url || '',
                mpegHlsUrl: mpegHls?.url || '',
                trackAuthorization: t.track_authorization || '',
                protocol: primary?.format?.protocol || 'hls',
                permalinkUrl: t.permalink_url || '',
                isFullTrack: true,
            });
        }
        return tracks;
    } catch (e) {
        console.warn('Playlist tracks error:', e.message);
        return [];
    }
}

/**
 * Получение треков мировых и региональных хит-парадов
 */
async function getChartPlaylistTracks(chartKey = 'top') {
    const region = (chartKey === 'russia' || chartKey === '37i9dQZF1DXcZDD7cfEKhW') ? 'kz' : 'us';
    try {
        const res = await fetch(`https://itunes.apple.com/${region}/rss/topsongs/limit=25/json`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
            const data = await res.json();
            const entries = data?.feed?.entry || [];
            if (entries.length > 0) {
                return entries.map((e, index) => {
                    const trackId = e.id?.attributes?.['im:id'] || `chart_${index}`;
                    const title = e['im:name']?.label || e.title?.label || 'Unknown Title';
                    const artist = e['im:artist']?.label || 'Chart Artist';
                    const images = e['im:image'] || [];
                    const rawThumb = images[images.length - 1]?.label || '';
                    const thumb = rawThumb ? rawThumb.replace(/\d+x\d+bb/, '500x500bb') : '/icon.png';
                    const previewLink = Array.isArray(e.link)
                        ? e.link.find((l) => l.attributes?.rel === 'enclosure')?.attributes?.href || ''
                        : '';
                    const durMs = Number(
                        Array.isArray(e.link)
                            ? e.link.find((l) => l.attributes?.rel === 'enclosure')?.['im:duration']?.label || 180000
                            : 180000
                    );
                    const durationSec = Math.max(60, Math.round((isNaN(durMs) ? 180000 : durMs) / 1000));
                    return {
                        id: `chart_${trackId}`,
                        source: 'chart',
                        title,
                        artist,
                        duration: formatDuration(durationSec),
                        durationSeconds: durationSec,
                        thumbnail: thumb,
                        previewUrl: previewLink,
                        permalinkUrl: `https://soundcloud.com/search?q=${encodeURIComponent(artist + ' ' + title)}`,
                        isFullTrack: true,
                        isChart: true,
                    };
                });
            }
        }
    } catch (e) {
        console.warn('Chart RSS error:', e.message);
    }

    // Fallback на подборку SoundCloud
    const fallbackQ = region === 'kz' ? 'Miyagi Macan Дора Три дня дождя' : 'The Weeknd Travis Scott Dua Lipa';
    return await searchFullMusicTracks(fallbackQ);
}

/**
 * Парсер LRC текста с таймкодами [mm:ss.xx]
 */
function parseLrc(lrcString) {
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

function translitCyrToLat(str) {
    const map = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z',
        'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
        'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
        'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
    };
    return (str || '').toLowerCase().replace(/[а-яё]/g, (ch) => map[ch] ?? ch);
}

function normalizeLyricsText(str) {
    return (str || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, ' ')
        .replace(/\b(feat|ft|prod|official|video|audio|lyric|lyrics|clip|remix|slowed|reverb|speed\s*up|bass\s*boosted|nightcore|instrumental|karaoke|клип|премьера|текст|ремикс|минус)\b\.?/gi, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractLyricsMeta(rawTitle = '', rawArtist = '') {
    let title = (rawTitle || '').replace(/\.(mp3|wav|flac|m4a|ogg)$/i, '').trim();
    let artist = (rawArtist || '').trim();

    const genericArtists = new Set(['исполнитель', 'неизвестный исполнитель', 'unknown', 'unknown artist', 'dodomusic', 'soundcloud', 'soundcloud artist', 'audius artist', 'chart artist', '']);
    const isGenericArtist = genericArtists.has(artist.toLowerCase());

    const dashMatch = title.match(/^(.+?)\s+[-—–|]\s+(.+)$/);
    if (dashMatch && (isGenericArtist || !artist.toLowerCase().includes(dashMatch[1].trim().toLowerCase().slice(0, 4)))) {
        const left = dashMatch[1].trim();
        const right = dashMatch[2].trim();
        if (left.length >= 2 && right.length >= 1) {
            if (isGenericArtist || !normalizeLyricsText(artist).includes(normalizeLyricsText(left))) {
                if (!artist || isGenericArtist) {
                    artist = left;
                    title = right;
                }
            }
        }
    }

    // Извлекаем артистов из (feat. ... / ft. ...)
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

    const combinedArtistRaw = [cleanArtist, ...featMatches].filter(Boolean).join(', ');
    return {
        cleanTitle,
        cleanArtist,
        combinedArtistRaw,
        hasReliableArtist: Boolean(cleanArtist && !genericArtists.has(cleanArtist.toLowerCase()))
    };
}

function buildArtistTokens(artistStr) {
    const stop = new Set(['the', 'and', 'feat', 'ft', 'official', 'music', 'channel', 'prod', 'records', 'topic', 'vevo', 'dj', 'mc', 'x', 'и']);
    const normFull = normalizeLyricsText(artistStr);
    const parts = (artistStr || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .split(/\s*(?:,|&|feat\.?|ft\.?|vs\.?|×|\bx\b|\bи\b|\band\b|\/|\|)\s*/i)
        .map((p) => normalizeLyricsText(p))
        .filter((p) => p && p.length >= 2);
    const words = [];
    for (const w of normFull.split(' ')) {
        if (w.length >= 2 && !stop.has(w)) {
            words.push(w);
            const lat = translitCyrToLat(w);
            if (lat && lat !== w && lat.length >= 2) words.push(lat);
        }
    }
    return {
        full: normFull,
        fullLat: translitCyrToLat(normFull),
        parts: [...new Set(parts)],
        words: [...new Set(words)],
    };
}

function scoreLyricsCandidate(item, meta, duration = 0) {
    if (!item || (!item.syncedLyrics && !item.plainLyrics)) return -1;

    const candTitleNorm = normalizeLyricsText(item.trackName || item.name || '');
    const targetTitleNorm = normalizeLyricsText(meta.cleanTitle);
    if (!candTitleNorm || !targetTitleNorm) return -1;

    // 1. Проверка совпадения названия песни
    let titleScore = 0;
    const tWords = targetTitleNorm.split(' ').filter(Boolean);
    const cWords = candTitleNorm.split(' ').filter(Boolean);
    const cSet = new Set([...cWords, ...cWords.map(translitCyrToLat)]);

    if (candTitleNorm === targetTitleNorm || translitCyrToLat(candTitleNorm) === translitCyrToLat(targetTitleNorm)) {
        titleScore = 100;
    } else {
        let hits = 0;
        for (const w of tWords) {
            if (cSet.has(w) || cSet.has(translitCyrToLat(w))) hits++;
        }
        const coverage = tWords.length > 0 ? hits / tWords.length : 0;
        if (coverage < 0.65) return -1;
        titleScore = Math.round(coverage * 75);
        // Штраф за лишние несовпадающие слова (например, каверы / другие части песни)
        const extraRatio = Math.max(0, cWords.length - tWords.length) / Math.max(1, cWords.length);
        titleScore -= Math.round(extraRatio * 20);
    }

    // 2. Жёсткая проверка совпадения исполнителя
    const targetArt = buildArtistTokens(meta.combinedArtistRaw || meta.cleanArtist);
    const candArt = buildArtistTokens(item.artistName || '');
    let artistScore = 0;

    if (meta.hasReliableArtist && targetArt.words.length > 0) {
        if (!candArt.full) return -1;

        if (candArt.full === targetArt.full || candArt.fullLat === targetArt.fullLat) {
            artistScore = 130;
        } else {
            // Совпадение по одному из артистов (для фитов вроде "Miyagi & Эндшпиль")
            const partHit = targetArt.parts.some((tp) => {
                const tpLat = translitCyrToLat(tp);
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
                if (sharedWords === 0) {
                    // Ни одного совпадения по артисту — ОТКЛОНЯЕМ (чужой исполнитель!)
                    return -1;
                }
                artistScore = 70 + Math.min(35, sharedWords * 15);
            }
        }
    } else {
        artistScore = 40;
    }

    // 3. Проверка длительности трека
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

/**
 * Поиск синхронизированного или обычного текста песни со строгой проверкой артиста
 */
async function fetchTrackLyrics(title = '', artist = '', duration = 0) {
    const meta = extractLyricsMeta(title, artist);
    if (!meta.cleanTitle) {
        return { found: false, synced: false, lines: [], plainLyrics: '', searchedTitle: '', searchedArtist: meta.cleanArtist };
    }

    const lrcHeaders = { 'User-Agent': 'DodoMusic/1.5 (https://github.com/Poutsuf/DodoMusic-Windows)' };
    const candidates = new Map();

    const addCandidate = (item) => {
        if (!item || (!item.syncedLyrics && !item.plainLyrics)) return;
        const id = item.id || `${item.artistName}::${item.trackName || item.name}::${item.duration}`;
        if (!candidates.has(id)) {
            candidates.set(id, item);
        }
    };

    // 1. Точный запрос /api/get
    if (meta.cleanTitle && meta.cleanArtist) {
        try {
            let getUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(meta.cleanTitle)}&artist_name=${encodeURIComponent(meta.cleanArtist)}`;
            if (duration > 0) getUrl += `&duration=${Math.round(duration)}`;
            const res = await fetch(getUrl, { headers: lrcHeaders, signal: AbortSignal.timeout(4500) });
            if (res.ok) addCandidate(await res.json());
        } catch (_) {}
    }

    // 2. Структурированный и текстовый поиск в LRCLIB (только с указанием артиста, если он известен)
    const searchUrls = [];
    const primaryArtistPart = buildArtistTokens(meta.cleanArtist).parts[0] || meta.cleanArtist;

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
                const res = await fetch(u, { headers: lrcHeaders, signal: AbortSignal.timeout(4500) });
                if (res.ok) {
                    const list = await res.json();
                    if (Array.isArray(list)) {
                        for (const item of list.slice(0, 15)) addCandidate(item);
                    }
                }
            } catch (_) {}
        })
    );

    // Оценка всех кандидатов строгим фильтром
    const scored = [];
    for (const item of candidates.values()) {
        const score = scoreLyricsCandidate(item, meta, duration);
        if (score >= 0) {
            scored.push({ item, score });
        }
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
        const best = scored[0].item;
        return {
            found: true,
            synced: Boolean(best.syncedLyrics),
            lines: best.syncedLyrics ? parseLrc(best.syncedLyrics) : [],
            plainLyrics: best.plainLyrics || '',
            trackName: best.trackName || best.name || meta.cleanTitle,
            artistName: best.artistName || meta.cleanArtist,
            source: 'LRCLIB',
            searchedTitle: meta.cleanTitle,
            searchedArtist: meta.cleanArtist,
        };
    }

    // 3. Резервный точный поиск через Lyrics.ovh (строго по Артисту + Названию)
    if (meta.hasReliableArtist) {
        for (const artCandidate of [meta.cleanArtist, primaryArtistPart].filter(Boolean)) {
            try {
                const ovhUrl = `https://api.lyrics.ovh/v1/${encodeURIComponent(artCandidate)}/${encodeURIComponent(meta.cleanTitle)}`;
                const res = await fetch(ovhUrl, { signal: AbortSignal.timeout(4000) });
                if (res.ok) {
                    const data = await res.json();
                    if (data?.lyrics && data.lyrics.trim().length > 20) {
                        return {
                            found: true,
                            synced: false,
                            lines: [],
                            plainLyrics: data.lyrics.trim(),
                            trackName: meta.cleanTitle,
                            artistName: artCandidate,
                            source: 'Lyrics.ovh',
                            searchedTitle: meta.cleanTitle,
                            searchedArtist: meta.cleanArtist,
                        };
                    }
                }
            } catch (_) {}
        }
    }

    return {
        found: false,
        synced: false,
        lines: [],
        plainLyrics: '',
        searchedTitle: meta.cleanTitle,
        searchedArtist: meta.cleanArtist,
    };
}

function startEmbeddedServer() {
    return new Promise((resolve, reject) => {
        const exp = express();
        exp.use(cors());
        exp.use(express.json());
        exp.use(express.static(path.join(__dirname, 'public')));

        exp.get('/api/resolve-stream', async (req, res) => {
            const { transcodingUrl, trackAuthorization, source, streamUrl, previewUrl, artist, title, id } = req.query;

            if (source === 'audius' && streamUrl) {
                return res.json({ streamUrl, protocol: 'progressive' });
            }

            // Для треков SoundCloud сначала ВСЕГДА разрешаем точный поток выбранного трека
            if (transcodingUrl && source !== 'chart' && !(id && String(id).startsWith('sp_'))) {
                const resolvedUrl = await resolveSoundCloudStreamUrl(transcodingUrl, trackAuthorization || '');
                if (resolvedUrl) {
                    return res.json({
                        streamUrl: resolvedUrl,
                        protocol: transcodingUrl.includes('/hls') ? 'hls' : 'progressive',
                    });
                }
            }

            // Для чартов или при отказе прямой ссылки ищем точное совпадение
            if (artist || title) {
                try {
                    const query = `${artist || ''} ${title || ''}`.trim();
                    const searchResults = await searchFullMusicTracks(query);
                    if (searchResults && searchResults.length > 0) {
                        const targetA = normalizeMatchText(artist || '');
                        const targetT = normalizeMatchText(title || '');
                        const best = searchResults.find((r) => {
                            const rA = normalizeMatchText(r.artist);
                            const rT = normalizeMatchText(r.title);
                            return (!targetT || rT.includes(targetT) || targetT.includes(rT)) &&
                                   (!targetA || rA.includes(targetA) || targetA.includes(rA));
                        }) || searchResults[0];

                        if (best.transcodingUrl) {
                            const resolvedUrl = await resolveSoundCloudStreamUrl(best.transcodingUrl, best.trackAuthorization || '');
                            if (resolvedUrl) {
                                return res.json({
                                    streamUrl: resolvedUrl,
                                    protocol: best.protocol || (best.transcodingUrl.includes('/hls') ? 'hls' : 'progressive'),
                                });
                            }
                        } else if (best.streamUrl) {
                            return res.json({
                                streamUrl: best.streamUrl,
                                protocol: 'progressive',
                            });
                        }
                    }
                } catch (_) {}
            }

            if (previewUrl) {
                return res.json({ streamUrl: previewUrl, protocol: 'progressive' });
            }

            return res.status(400).json({ error: 'Не указаны параметры потока' });
        });

        // Локальный прокси для обхода блокировок CDN / CORS на компьютерах пользователей
        exp.get('/api/stream-proxy', async (req, res) => {
            const targetUrl = req.query?.url;
            if (!targetUrl) return res.status(400).send('No url');
            try {
                const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
                if (req.headers.range) {
                    headers['Range'] = req.headers.range;
                }
                const upstream = await fetch(targetUrl, { headers });
                res.status(upstream.status);
                for (const [k, v] of upstream.headers.entries()) {
                    if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(k.toLowerCase())) {
                        res.setHeader(k, v);
                    }
                }
                const reader = upstream.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                }
                res.end();
            } catch (e) {
                if (!res.headersSent) res.status(502).send(e.message);
            }
        });

        exp.all(['/api/chart-charts', '/api/top-charts'], async (req, res) => {
            const chart = req.query?.chart || req.body?.chart || 'top';
            try {
                const tracks = await getChartPlaylistTracks(chart);
                return res.json({ tracks });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        });

        exp.post('/api/search-music', async (req, res) => {
            const userQuery = req.body?.query?.trim();
            if (!userQuery) {
                return res.status(400).json({ error: 'Поисковый запрос пуст' });
            }

            try {
                const lower = userQuery.toLowerCase();
                if (userQuery.startsWith('chart:') || lower.includes('топ чарт') || lower.includes('хит-парад')) {
                    let chartKey = 'top';
                    let heading = 'Мировой ТОП хитов';
                    if (lower.includes('russia') || lower.includes('россия') || lower.includes('хит-парад')) {
                        chartKey = 'russia';
                        heading = 'Главный хит-парад';
                    } else if (lower.includes('global') || lower.includes('топ 50')) {
                        chartKey = 'global';
                    }
                    const chartTracks = await getChartPlaylistTracks(chartKey);
                    if (chartTracks.length > 0) {
                        return res.json({
                            cleanQuery: heading,
                            tracks: chartTracks,
                        });
                    }
                }

                const cleanQuery = cleanUserQuery(userQuery);
                const tracks = await searchFullMusicTracks(cleanQuery);
                return res.json({
                    cleanQuery,
                    tracks,
                });
            } catch (error) {
                return res.status(500).json({ error: error.message || 'Ошибка при поиске музыки' });
            }
        });

        exp.all('/api/related-tracks', async (req, res) => {
            const trackId = req.body?.trackId || req.query?.trackId || '';
            const artist = req.body?.artist || req.query?.artist || '';
            const title = req.body?.title || req.query?.title || '';

            try {
                const related = await getRelatedMusicTracks({ trackId, artist, title });
                return res.json({
                    trackId,
                    artist,
                    title,
                    relatedTracks: related,
                });
            } catch (err) {
                return res.status(500).json({ error: err.message || 'Ошибка рекомендаций' });
            }
        });

        exp.post('/api/taste-wave', async (req, res) => {
            const seedTrack = req.body?.seedTrack || {};
            const tasteProfile = req.body?.tasteProfile || {};
            try {
                const dislikedIds = new Set(tasteProfile.dislikedIds || []);
                const seenIds = new Set();
                const seenSignatures = new Set();
                if (seedTrack.id) seenIds.add(seedTrack.id);
                const seedArtist = (seedTrack.artist || '').trim();
                const seedTitle = (seedTrack.title || '').trim();
                if (seedArtist && seedTitle) {
                    seenSignatures.add(`${seedArtist.toLowerCase()}__${seedTitle.toLowerCase()}`);
                }

                const directRelated = await getRelatedMusicTracks({
                    trackId: seedTrack.id || '',
                    artist: seedArtist,
                    title: seedTitle,
                });

                const results = [];
                for (const t of directRelated) {
                    const sig = `${(t.artist || '').toLowerCase()}__${(t.title || '').toLowerCase()}`;
                    if (!seenIds.has(t.id) && !dislikedIds.has(t.id) && !seenSignatures.has(sig)) {
                        seenIds.add(t.id);
                        seenSignatures.add(sig);
                        results.push(t);
                    }
                }

                const favArtists = (tasteProfile.topArtists || []).filter((a) => a && a.toLowerCase() !== seedArtist.toLowerCase()).slice(0, 2);
                if (favArtists.length > 0 && results.length < 20) {
                    const batches = await Promise.all(favArtists.map((a) => searchFullMusicTracks(a).catch(() => [])));
                    for (const batch of batches) {
                        for (const t of batch.slice(0, 5)) {
                            const sig = `${(t.artist || '').toLowerCase()}__${(t.title || '').toLowerCase()}`;
                            if (!seenIds.has(t.id) && !dislikedIds.has(t.id) && !seenSignatures.has(sig)) {
                                seenIds.add(t.id);
                                seenSignatures.add(sig);
                                results.push(t);
                            }
                        }
                    }
                }

                return res.json({ tracks: results.slice(0, 25) });
            } catch (err) {
                return res.status(500).json({ error: err.message || 'Ошибка генерации волны' });
            }
        });

        exp.all('/api/artist-profile', async (req, res) => {
            const artist = req.body?.artist || req.query?.artist || '';
            if (!artist) return res.status(400).json({ error: 'Артист не указан' });

            try {
                const data = await getArtistProfileAndDiscography(artist);
                return res.json(data);
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        });

        exp.all('/api/playlist-tracks', async (req, res) => {
            const id = req.body?.id || req.query?.id || '';
            const numericId = String(id).replace('pl_', '');
            if (!numericId) return res.status(400).json({ error: 'ID плейлиста не указан' });

            try {
                const tracks = await getPlaylistTracks(numericId);
                return res.json({ tracks });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        });

        const CURRENT_APP_VERSION = 'v1.5';

        exp.all('/api/check-update', async (req, res) => {
            const repo = (req.body?.repo || req.query?.repo || 'Poutsuf/DodoMusic-Windows').trim();
            try {
                const ghRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
                    headers: {
                        'User-Agent': 'DodoMusic-Desktop-v1.5',
                        'Accept': 'application/vnd.github.v3+json',
                    },
                    signal: AbortSignal.timeout(5000),
                });

                if (ghRes.ok) {
                    const data = await ghRes.json();
                    const latestTag = data.tag_name || '';
                    const latestName = data.name || '';
                    const cleanTag = latestTag.toLowerCase().trim();

                    // Проверка версии
                    let hasUpdate = false;
                    const matchLatest = (latestTag + ' ' + latestName).match(/v?(\d+)\.(\d+)/);
                    if (matchLatest) {
                        const lMajor = parseInt(matchLatest[1], 10);
                        const lMinor = parseInt(matchLatest[2], 10);
                        hasUpdate = (lMajor > 1) || (lMajor === 1 && lMinor > 5);
                    } else {
                        hasUpdate = cleanTag !== 'v1.5' && cleanTag !== 'v1.0' && cleanTag !== 'dodomusic';
                    }

                    return res.json({
                        currentVersion: CURRENT_APP_VERSION,
                        latestVersion: latestName || latestTag || CURRENT_APP_VERSION,
                        hasUpdate,
                        releaseNotes: data.body || 'Новая версия доступна на GitHub.',
                        downloadUrl: data.html_url || `https://github.com/${repo}/releases`,
                        publishedAt: data.published_at,
                    });
                }
            } catch (_) {}

            return res.json({
                currentVersion: CURRENT_APP_VERSION,
                latestVersion: CURRENT_APP_VERSION,
                hasUpdate: false,
                message: 'У вас установлена актуальная версия DodoMusic (v1.5).',
                downloadUrl: `https://github.com/${repo}/releases`,
            });
        });

        exp.post('/api/system-notify', (req, res) => {
            const { title, body, icon } = req.body || {};
            try {
                if (Notification.isSupported()) {
                    const defaultIcon = path.join(__dirname, 'public', 'icon.png');
                    const iconPath = (icon && !String(icon).startsWith('http') && fs.existsSync(icon)) ? icon : defaultIcon;
                    const notif = new Notification({
                        title: title || 'DodoMusic v1.5',
                        body: body || '',
                        icon: fs.existsSync(iconPath) ? iconPath : undefined,
                    });
                    notif.on('click', () => {
                        if (mainWindow) {
                            if (mainWindow.isMinimized()) mainWindow.restore();
                            mainWindow.show();
                            mainWindow.focus();
                        }
                    });
                    notif.show();
                }
                return res.json({ ok: true });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        });

        // ПЕРМАНЕНТНАЯ БАЗА ДАННЫХ ПОЛЬЗОВАТЕЛЯ НА ДИСКЕ (ИЗБРАННОЕ И ИСТОРИЯ)
        const userDataDir = app.getPath('userData');
        if (!fs.existsSync(userDataDir)) {
            try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) {}
        }
        const libraryPath = path.join(userDataDir, 'dodomusic_library.json');

        exp.get('/api/library', (req, res) => {
            try {
                if (fs.existsSync(libraryPath)) {
                    const content = fs.readFileSync(libraryPath, 'utf8');
                    return res.json(JSON.parse(content));
                }
            } catch (_) {}
            return res.json({ favorites: [], history: [] });
        });

        exp.post('/api/library/save', (req, res) => {
            try {
                const data = req.body || {};
                fs.writeFileSync(libraryPath, JSON.stringify(data, null, 2), 'utf8');
                return res.json({ success: true });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        });

        // Скачивание трека (MP3 / Audio) с точным разрешением текущего трека
        exp.get('/api/download-track', async (req, res) => {
            const { transcodingUrl, progressiveUrl, mpegHlsUrl, trackAuthorization, source, streamUrl, previewUrl, title, artist } = req.query;
            try {
                let finalAudioUrl = streamUrl || '';
                const safeBase = `${artist || 'DodoMusic'} - ${title || 'Track'}`.replace(/[\\/:*?"<>|]/g, '_').trim();

                if (!finalAudioUrl && progressiveUrl) {
                    finalAudioUrl = await resolveSoundCloudStreamUrl(progressiveUrl, trackAuthorization || '');
                }
                if (!finalAudioUrl && mpegHlsUrl) {
                    finalAudioUrl = await resolveSoundCloudStreamUrl(mpegHlsUrl, trackAuthorization || '');
                }
                if (!finalAudioUrl && transcodingUrl && source !== 'chart') {
                    finalAudioUrl = await resolveSoundCloudStreamUrl(transcodingUrl, trackAuthorization || '');
                }
                if (!finalAudioUrl && (artist || title)) {
                    const searchResults = await searchFullMusicTracks(`${artist || ''} ${title || ''}`.trim());
                    if (searchResults && searchResults[0]) {
                        const best = searchResults[0];
                        const tcToUse = best.progressiveUrl || best.mpegHlsUrl || best.transcodingUrl;
                        if (tcToUse) {
                            finalAudioUrl = await resolveSoundCloudStreamUrl(tcToUse, best.trackAuthorization || '');
                        } else if (best.streamUrl) {
                            finalAudioUrl = best.streamUrl;
                        }
                    }
                }
                if (!finalAudioUrl && previewUrl) {
                    finalAudioUrl = previewUrl;
                }
                if (!finalAudioUrl) {
                    return res.status(400).send('Ссылка на трек недоступна для скачивания');
                }

                // Если это HLS плейлист .m3u8 — собираем сегменты в единый аудиофайл для скачивания
                if (finalAudioUrl.includes('.m3u8')) {
                    const m3u8Res = await fetch(finalAudioUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
                    if (m3u8Res.ok) {
                        const m3u8Text = await m3u8Res.text();
                        const segUrls = [];
                        const initMatch = m3u8Text.match(/#EXT-X-MAP:URI="([^"]+)"/);
                        if (initMatch && initMatch[1]) {
                            segUrls.push(new URL(initMatch[1], finalAudioUrl).toString());
                        }
                        for (const line of m3u8Text.split(/\r?\n/)) {
                            const t = line.trim();
                            if (t && !t.startsWith('#')) {
                                segUrls.push(new URL(t, finalAudioUrl).toString());
                            }
                        }
                        if (segUrls.length > 0) {
                            const isMp4 = Boolean(initMatch) || segUrls.some((u) => u.includes('.m4s') || u.includes('.mp4'));
                            const ext = isMp4 ? 'm4a' : 'mp3';
                            const encodedName = encodeURIComponent(`${safeBase}.${ext}`);
                            res.setHeader('Content-Type', isMp4 ? 'audio/mp4' : 'audio/mpeg');
                            res.setHeader('Content-Disposition', `attachment; filename="track.${ext}"; filename*=UTF-8''${encodedName}`);
                            for (const su of segUrls) {
                                const chunkRes = await fetch(su, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
                                if (chunkRes.ok) {
                                    const buf = Buffer.from(await chunkRes.arrayBuffer());
                                    res.write(buf);
                                }
                            }
                            return res.end();
                        }
                    }
                }

                const upstream = await fetch(finalAudioUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
                if (!upstream.ok) {
                    return res.redirect(finalAudioUrl);
                }
                const encodedName = encodeURIComponent(`${safeBase}.mp3`);
                res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
                res.setHeader('Content-Disposition', `attachment; filename="track.mp3"; filename*=UTF-8''${encodedName}`);
                const cl = upstream.headers.get('content-length');
                if (cl) res.setHeader('Content-Length', cl);
                const reader = upstream.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                }
                return res.end();
            } catch (err) {
                if (!res.headersSent) return res.status(500).send(err.message);
                return res.end();
            }
        });

        exp.get('/api/lyrics', async (req, res) => {
            const title = req.query.title || '';
            const artist = req.query.artist || '';
            const duration = parseFloat(req.query.duration || '0');

            try {
                const lyrics = await fetchTrackLyrics(title, artist, duration);
                return res.json(lyrics);
            } catch (err) {
                console.error('Error fetching lyrics:', err);
                return res.status(500).json({ error: err.message || 'Ошибка поиска текста' });
            }
        });

        // ФИКСИРОВАННЫЙ ПОРТ ДЛЯ СОХРАНЕНИЯ ОРИДЖИНА LOCALSTORAGE
        const PREFERRED_PORT = 58240;
        const srv = http.createServer(exp);

        srv.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                const fallback = http.createServer(exp);
                fallback.listen(0, '127.0.0.1', () => {
                    resolve({ server: fallback, port: fallback.address().port });
                });
                fallback.on('error', reject);
            } else {
                reject(err);
            }
        });

        srv.listen(PREFERRED_PORT, '127.0.0.1', () => {
            resolve({ server: srv, port: PREFERRED_PORT });
        });
    });
}

let mainWindow = null;
let serverInstance = null;
let tray = null;

function setupSystemTray() {
    try {
        const icoPath = path.join(__dirname, 'public', 'icon.ico');
        const pngPath = path.join(__dirname, 'public', 'icon.png');
        const trayIconPath = fs.existsSync(icoPath) ? icoPath : pngPath;
        if (!fs.existsSync(trayIconPath)) return;
        if (tray) return;

        tray = new Tray(trayIconPath);
        tray.setToolTip('DodoMusic v1.5');

        const contextMenu = Menu.buildFromTemplate([
            { label: 'DodoMusic v1.5', enabled: false },
            { type: 'separator' },
            {
                label: 'Показать / Скрыть плеер',
                click: () => {
                    if (!mainWindow) return;
                    if (mainWindow.isVisible()) {
                        mainWindow.hide();
                    } else {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                },
            },
            {
                label: 'Пауза / Воспроизведение',
                click: () => {
                    if (mainWindow) {
                        mainWindow.webContents.executeJavaScript(`
                            if (typeof window.togglePlayPause === 'function') {
                                window.togglePlayPause();
                            } else if (window.audioPlayer) {
                                if (window.audioPlayer.paused) window.audioPlayer.play();
                                else window.audioPlayer.pause();
                            }
                        `);
                    }
                },
            },
            {
                label: 'Следующий трек',
                click: () => {
                    if (mainWindow) {
                        mainWindow.webContents.executeJavaScript(`
                            if (typeof window.playNext === 'function') window.playNext();
                        `);
                    }
                },
            },
            {
                label: 'Предыдущий трек',
                click: () => {
                    if (mainWindow) {
                        mainWindow.webContents.executeJavaScript(`
                            if (typeof window.playPrev === 'function') window.playPrev();
                        `);
                    }
                },
            },
            { type: 'separator' },
            {
                label: 'Выход',
                click: () => {
                    app.isQuitting = true;
                    app.quit();
                },
            },
        ]);

        tray.setContextMenu(contextMenu);
        tray.on('click', () => {
            if (!mainWindow) return;
            if (mainWindow.isVisible()) {
                mainWindow.focus();
            } else {
                mainWindow.show();
                mainWindow.focus();
            }
        });
    } catch (err) {
        logDebug(`[TRAY_ERROR] ${err.message}\n`);
    }
}

async function createWindow() {
    logDebug(`[CREATE_WINDOW] Starting embedded server...\n`);
    const { server, port } = await startEmbeddedServer();
    serverInstance = server;
    logDebug(`[CREATE_WINDOW] Embedded server running on port ${port}\n`);

    const icoPath = path.join(__dirname, 'public', 'icon.ico');
    const pngIconPath = path.join(__dirname, 'public', 'icon.png');
    const iconFilePath = fs.existsSync(icoPath) ? icoPath : pngIconPath;
    const appIcon = nativeImage.createFromPath(iconFilePath);

    const winOptions = {
        width: 1320,
        height: 840,
        useContentSize: true,
        minWidth: 980,
        minHeight: 660,
        title: 'DodoMusic',
        backgroundColor: '#07080c',
        autoHideMenuBar: true,
        icon: iconFilePath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    };

    mainWindow = new BrowserWindow(winOptions);
    try {
        mainWindow.setIcon(iconFilePath);
    } catch (_) {}
    logDebug(`[CREATE_WINDOW] BrowserWindow created\n`);

    setupSystemTray();
    mainWindow.webContents.on('render-process-gone', (event, details) => {
        logDebug(`[RENDERER_GONE] reason: ${details.reason}, exitCode: ${details.exitCode}\n`);
    });
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        logDebug(`[LOAD_FAILED] code: ${errorCode}, desc: ${errorDescription}\n`);
    });
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        logDebug(`[CONSOLE] (${level}) ${message} [${sourceId}:${line}]\n`);
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadURL(`http://127.0.0.1:${port}`);
    logDebug(`[CREATE_WINDOW] loadURL called\n`);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    mainWindow.on('close', (e) => {
        logDebug(`[WINDOW_CLOSE] mainWindow close event\n`);
    });
    mainWindow.on('closed', () => {
        logDebug(`[WINDOW_CLOSED] mainWindow closed event\n`);
        mainWindow = null;
    });
}

app.whenReady().then(createWindow);

app.on('will-quit', (e) => {
    logDebug(`[APP] will-quit event\n`);
});

app.on('quit', (e, exitCode) => {
    logDebug(`[APP] quit event, exitCode: ${exitCode}\n`);
});

app.on('window-all-closed', () => {
    logDebug(`[APP] window-all-closed fired\n`);
    if (serverInstance) {
        try {
            serverInstance.close();
        } catch (_) {}
    }
    app.quit();
});
