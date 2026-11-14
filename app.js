import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getDatabase, ref, child, set as _fbSet, update as _fbUpdate, remove as _fbRemove, onValue as _fbOnValue, push as _fbPush, onDisconnect } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

import { menu } from "./menu.js";

const firebaseConfig = {
    apiKey: "AIzaSyDVgtCsFzrPOqRWBqoncZrsZsRdCn7wTWo",
    authDomain: "combetram.firebaseapp.com",
    databaseURL: "https://combetram-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "combetram",
    storageBucket: "combetram.firebasestorage.app",
    messagingSenderId: "727819537743",
    appId: "1:727819537743:web:36078910a5b351866f893a"
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const dbRef = ref(database, 'combetram_v6_data');

// ─── ĐỒNG BỘ GIỜ SERVER FIREBASE ──────────────────────────────────────
let serverTimeOffset = 0;
onValue(ref(database, '.info/serverTimeOffset'), (snap) => {
    const offset = Number(snap.val());
    if (Number.isFinite(offset)) serverTimeOffset = offset;
});
function getServerNow() {
    return Date.now() + serverTimeOffset;
}

// ─── HELPER FETCH CÓ TIMEOUT CHỐNG TREO PROXY/API ─────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 5500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ─── ƯỚC TÍNH PAYLOAD JSON ĐẨY LÊN/XUỐNG FIREBASE (không gồm overhead WebSocket) ───
let fbDownBytes = 0, fbUpBytes = 0;
const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function formatBytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(2)}MB`;
}
function byteSizeOf(data) {
    try {
        const json = JSON.stringify(data);
        if (json === undefined) return 0;
        if (textEncoder) return textEncoder.encode(json).length;
        return new Blob([json]).size;
    } catch (e) {
        return 0;
    }
}
const netFlashAnimations = new WeakMap();
function flashNetValue(el, direction) {
    if (!el?.animate) return;
    const prev = netFlashAnimations.get(el);
    if (prev) prev.cancel();
    const isDark = document.body.classList.contains('dark-mode');
    const isDown = direction === 'down';
    const color = isDown ? (isDark ? '#81c784' : '#2e7d32') : (isDark ? '#ef9a9a' : '#c62828');
    const glow = isDown ? (isDark ? 'rgba(129,199,132,0.8)' : 'rgba(76,175,80,0.7)') : (isDark ? 'rgba(239,154,154,0.8)' : 'rgba(244,67,54,0.7)');
    const anim = el.animate([
        { color, textShadow: `0 0 6px ${glow}`, transform: 'scale(1.12)' },
        { color: 'var(--text-muted)', textShadow: 'none', transform: 'scale(1)' }
    ], { duration: 700, easing: 'ease' });
    netFlashAnimations.set(el, anim);
    anim.onfinish = anim.oncancel = () => {
        if (netFlashAnimations.get(el) === anim) netFlashAnimations.delete(el);
    };
}
function updateNetWidget(direction) {
    const downEl = document.getElementById('net-down-val');
    const upEl = document.getElementById('net-up-val');
    if (downEl) downEl.textContent = `↓${formatBytes(fbDownBytes)}`;
    if (upEl) upEl.textContent = `↑${formatBytes(fbUpBytes)}`;
    if (direction === 'down' && downEl) flashNetValue(downEl, 'down');
    if (direction === 'up' && upEl) flashNetValue(upEl, 'up');
}
function set(refArg, value) { fbUpBytes += byteSizeOf(value); updateNetWidget('up'); return _fbSet(refArg, value); }
function update(refArg, value) { fbUpBytes += byteSizeOf(value); updateNetWidget('up'); return _fbUpdate(refArg, value); }
function remove(refArg) { fbUpBytes += byteSizeOf(null); updateNetWidget('up'); return _fbRemove(refArg); }
function push(refArg, value) { if (value !== undefined) { fbUpBytes += byteSizeOf(value); updateNetWidget('up'); } return _fbPush(refArg, value); }
function onValue(refArg, callback, ...rest) {
    return _fbOnValue(refArg, (snap) => {
        fbDownBytes += byteSizeOf(snap.val());
        updateNetWidget('down');
        callback(snap);
    }, ...rest);
}

let currentBillLang = 'vi';
let currentTab = null;
let data = { orders: {}, locked: {}, times: {} };
let billWasShown = false;

// Chặn double-click trong đúng khoảnh khắc xác nhận thanh toán.
let paymentInProgress = false;
const localPaymentEchoTables = new Set();

// ─── BILL ↔ QR: lật card + co/giãn chiều cao + cuộn đồng bộ ───
const BILL_FLIP_MS = 560;
let billViewMode = 'bill';
let billScrollAnimation = 0;

function getBillFlipDom() {
    return {
        shell: document.getElementById('bill-flip-shell'),
        front: document.getElementById('bill-face-front'),
        back: document.getElementById('bill-face-qr'),
        button: document.getElementById('btn-qr-toggle')
    };
}

function activeBillFaceHeight(mode = billViewMode) {
    const { front, back } = getBillFlipDom();
    const face = mode === 'qr' ? back : front;
    return face ? Math.ceil(face.offsetHeight) : 0;
}

function syncBillFlipHeight(animate = false) {
    const { shell } = getBillFlipDom();
    if (!shell) return;
    const targetHeight = activeBillFaceHeight();
    if (!targetHeight) return;

    if (!animate) {
        shell.style.height = `${targetHeight}px`;
        return;
    }

    const currentHeight = Math.ceil(shell.getBoundingClientRect().height) || targetHeight;
    shell.style.height = `${currentHeight}px`;
    requestAnimationFrame(() => { shell.style.height = `${targetHeight}px`; });
}

function stopBillScrollAnimation() {
    if (billScrollAnimation) {
        cancelAnimationFrame(billScrollAnimation);
        billScrollAnimation = 0;
    }
}

function animateScrollToQrCenter(targetHeight) {
    const { shell } = getBillFlipDom();
    if (!shell) return;
    stopBillScrollAnimation();

    const shellTop = shell.getBoundingClientRect().top + window.scrollY;
    const predictedDocumentHeight = document.documentElement.scrollHeight
        - shell.getBoundingClientRect().height + targetHeight;
    const maxScroll = Math.max(0, predictedDocumentHeight - window.innerHeight);
    const targetY = Math.max(0, Math.min(maxScroll, shellTop + targetHeight / 2 - window.innerHeight / 2));
    const startY = window.scrollY;
    const distance = targetY - startY;
    if (Math.abs(distance) < 1) return;

    const startedAt = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    const step = now => {
        const progress = Math.min(1, (now - startedAt) / BILL_FLIP_MS);
        window.scrollTo(0, startY + distance * ease(progress));
        if (progress < 1 && billViewMode === 'qr') billScrollAnimation = requestAnimationFrame(step);
        else billScrollAnimation = 0;
    };
    billScrollAnimation = requestAnimationFrame(step);
}

function resetBillQrView(instant = true) {
    stopBillScrollAnimation();
    billViewMode = 'bill';
    const { shell, back, button } = getBillFlipDom();
    if (!shell) return;

    if (instant) {
        shell.style.transition = 'none';
        const flipper = document.getElementById('bill-flipper');
        if (flipper) flipper.style.transition = 'none';
        shell.classList.remove('is-qr');
        if (back) back.setAttribute('aria-hidden', 'true');
        if (button) button.textContent = 'MÃ QR';
        shell.style.height = '';
        void shell.offsetHeight;
        shell.style.transition = '';
        if (flipper) flipper.style.transition = '';
        requestAnimationFrame(() => syncBillFlipHeight(false));
    } else {
        shell.classList.remove('is-qr');
        if (back) back.setAttribute('aria-hidden', 'true');
        if (button) button.textContent = 'MÃ QR';
        syncBillFlipHeight(true);
    }
}

function scrollBillIntoView() {
    if (billViewMode !== 'bill') return;
    document.querySelector('.bill-front .bill-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleBillQr() {
    if (paymentInProgress) return;
    triggerHaptic('nav');
    const { shell, back, button } = getBillFlipDom();
    if (!shell) return;

    const showQr = billViewMode !== 'qr';
    stopBillScrollAnimation();

    if (showQr) {
        const currentHeight = Math.ceil(shell.getBoundingClientRect().height) || activeBillFaceHeight('bill');
        const targetHeight = activeBillFaceHeight('qr');
        if (!targetHeight) return;

        shell.style.height = `${currentHeight}px`;
        billViewMode = 'qr';
        if (back) back.setAttribute('aria-hidden', 'false');
        if (button) button.textContent = 'XEM BILL';

        requestAnimationFrame(() => {
            shell.classList.add('is-qr');
            shell.style.height = `${targetHeight}px`;
            animateScrollToQrCenter(targetHeight);
        });
    } else {
        billViewMode = 'bill';
        shell.classList.remove('is-qr');
        if (back) back.setAttribute('aria-hidden', 'true');
        if (button) button.textContent = 'MÃ QR';
        syncBillFlipHeight(true);
    }
}

// ─── Menu lookup Map O(1) ──────────────────────────────────────────────
const ALL_ITEMS = menu.flatMap(g => g.items);
const ITEM_MAP = new Map(ALL_ITEMS.map(i => [i.id, i]));
const DRINK_ITEM_IDS = new Set(
    menu.filter(group => /NƯỚC|BEER/i.test(group.cat)).flatMap(group => group.items.map(item => item.id))
);

const ordersRef = child(dbRef, 'orders');
const lockedRef = child(dbRef, 'locked');
const timesRef = child(dbRef, 'times');

// Cache DOM cố định cho các đường render nóng.
const TABLE_DOM = Array.from({ length: 9 }, (_, idx) => {
    const table = idx + 1;
    return {
        card: document.getElementById(`tab-${table}`),
        sum: document.getElementById(`sum-${table}`),
        meta: document.getElementById(`meta-${table}`),
        time: document.getElementById(`time-${table}`)
    };
});
const ITEM_DOM = new Map();
const tableTotals = Array(10).fill(0);

function shallowRecordEqual(a, b) {
    if (a === b) return true;
    const aIsObject = a !== null && typeof a === 'object';
    const bIsObject = b !== null && typeof b === 'object';
    if (!aIsObject || !bIsObject) return false;
    const aKeys = Object.keys(a), bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) if (a[key] !== b[key]) return false;
    return true;
}

function changedTableIds(prev, next) {
    const changed = new Set();
    for (let i = 1; i <= 9; i++) {
        if (!shallowRecordEqual(prev?.[i], next?.[i])) changed.add(i);
    }
    return changed;
}

let scheduledRefresh = false;
let scheduledFullRefresh = false;
let scheduledCurrentOrderRefresh = false;
const dirtyTables = new Set();

function scheduleRefresh(tableIds = null, updateCurrentOrder = false) {
    if (tableIds === null) {
        scheduledFullRefresh = true;
        scheduledCurrentOrderRefresh = true;
    } else {
        for (const id of tableIds) dirtyTables.add(Number(id));
    }
    if (updateCurrentOrder) scheduledCurrentOrderRefresh = true;
    if (scheduledRefresh) return;
    scheduledRefresh = true;
    requestAnimationFrame(() => {
        scheduledRefresh = false;
        const ids = scheduledFullRefresh ? null : new Set(dirtyTables);
        const shouldUpdateOrder = scheduledCurrentOrderRefresh;
        scheduledFullRefresh = false;
        scheduledCurrentOrderRefresh = false;
        dirtyTables.clear();
        refresh(ids, shouldUpdateOrder);
    });
}

// ─── Lazy-load dict theo ngôn ngữ + Preload bill assets ─────────────────
let dictCache = { vi: { flag: "🇻🇳", total: "TỔNG", items: {} } };
let dictLoadPromise = null;
let billAssetsPreloaded = false;

async function getLangData(lang) {
    if (dictCache[lang]) return dictCache[lang];
    if (!dictLoadPromise) {
        dictLoadPromise = import('./dict.js').then(m => {
            dictCache = m.dict;
        }).catch((err) => {
            console.error('[dict] Lỗi tải từ điển đa ngôn ngữ:', err);
            dictLoadPromise = null;
        });
    }
    await dictLoadPromise;
    return dictCache[lang] || dictCache['vi'];
}

function preloadBillAssets() {
    if (billAssetsPreloaded) return;
    billAssetsPreloaded = true;
    getLangData('en').catch(() => {});
    const qrImg = document.getElementById('payment-qr');
    if (qrImg) {
        if (qrImg.complete) {
            qrImg.decode?.().catch(() => {});
        } else {
            const pre = new Image();
            pre.src = qrImg.currentSrc || qrImg.src;
            pre.decode?.().catch(() => {});
        }
    }
}

function syncActiveLangButton(lang) {
    document.querySelectorAll('#lang-grid .lang-btn').forEach(btn => {
        btn.classList.toggle('active-lang', btn.dataset.lang === lang);
    });
}

// CACHE THỜI TIẾT
let weatherCache = { status: 'cloudy', temp: 31, windSpeed: 14.0, windDir: 135 };
let lastWeatherIconStatus = null;
let lastWindIconHtml = null;

const SVG_ICONS = {
    sunny:              '<span class="w-icon"><span class="wi-spin">☀️</span></span>',
    partlyCloudy:       '<span class="w-icon"><span class="wi-sway">⛅</span></span>',
    cloudy:             '<span class="w-icon"><span class="wi-sway">☁️</span></span>',
    rainy:              '<span class="w-icon"><span class="wi-drop">🌧️</span></span>',
    storm:              '<span class="w-icon"><span class="wi-flash">⛈️</span></span>',
    night_fullmoon:     '<span class="w-icon"><span class="wi-pulse">🌕</span></span>',
    night_crescent:     '<span class="w-icon"><span class="wi-pulse">🌙</span></span>',
    night_nomoon:       '<span class="w-icon"><span class="wi-pulse">🌑</span></span>',
    night_partlyCloudy: '<span class="w-icon"><span class="wi-sway">🌤️</span></span>',
    windNone:           '<span class="w-icon">〰️</span>',
    windSlow:           '<span class="w-icon"><span class="wi-blow">💨</span></span>',
    windFast:           '<span class="w-icon"><span class="wi-blow2">💨</span></span>',
    windStorm:          '<span class="w-icon"><span class="wi-blow3">🌀</span></span>',
};

function renderWeather(status, temp, windSpeed, windDir) {
    let finalStatus = status;
    const hour = new Date().getHours();
    if (hour >= 18 || hour < 6) {
        const dayOfMonth = new Date().getDate();
        let moonType;
        if (dayOfMonth % 3 === 0) moonType = 'night_fullmoon';
        else if (dayOfMonth % 3 === 1) moonType = 'night_crescent';
        else moonType = 'night_nomoon';
        if (status === 'sunny') finalStatus = moonType;
        else if (status === 'partlyCloudy') finalStatus = 'night_partlyCloudy';
    }
    if (finalStatus !== lastWeatherIconStatus) {
        lastWeatherIconStatus = finalStatus;
        document.getElementById('w-icon-container').innerHTML = SVG_ICONS[finalStatus] || SVG_ICONS.sunny;
    }
    document.getElementById('w-temp').textContent = `${temp.toFixed(1)}°C`;
    const hub = document.getElementById('weather-hub');
    let windIcon = SVG_ICONS.windNone;
    hub.className = '';
    if (windSpeed > 5 && windSpeed <= 19) { windIcon = SVG_ICONS.windSlow; }
    else if (windSpeed >= 20 && windSpeed <= 39) { windIcon = SVG_ICONS.windFast; hub.classList.add('wind-warning'); }
    else if (windSpeed >= 40) { windIcon = SVG_ICONS.windStorm; hub.classList.add('wind-danger'); }
    if (windIcon !== lastWindIconHtml) {
        lastWindIconHtml = windIcon;
        document.getElementById('w-wind-icon-container').innerHTML = windIcon;
    }
    document.getElementById('w-wind-speed').textContent = `${windSpeed.toFixed(1)} km/h`;
    document.getElementById('w-arrow').style.transform = `rotate(${windDir}deg)`;
}

async function fetchRealtimeWeather() {
    try {
        const lat = 16.0544, lon = 108.2022;
        const response = await fetchWithTimeout(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m`,
            {},
            6000
        );
        if (!response.ok) return;
        const resData = await response.json();
        const current = resData.current;
        let status = 'sunny';
        const code = current.weather_code;
        if (code === 0) status = 'sunny';
        else if (code === 1 || code === 2) status = 'partlyCloudy';
        else if (code === 3 || code === 45 || code === 48) status = 'cloudy';
        else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) status = 'rainy';
        else if ((code >= 71 && code <= 77) || code === 85 || code === 86) status = 'cloudy';
        else if (code >= 95) status = 'storm';
        weatherCache = { status, temp: current.temperature_2m, windSpeed: current.wind_speed_10m, windDir: current.wind_direction_10m };
        renderWeather(weatherCache.status, weatherCache.temp, weatherCache.windSpeed, weatherCache.windDir);
    } catch (err) {
        console.error("Lỗi gọi API thời tiết:", err);
        renderWeather(weatherCache.status, weatherCache.temp, weatherCache.windSpeed, weatherCache.windDir);
    }
}

function simulateWeatherFluctuation() {
    if (document.hidden) return;
    const tempOffset = (Math.random() - 0.5) * 0.4;
    const windSpeedOffset = (Math.random() - 0.5) * 0.6;
    const windDirOffset = Math.floor((Math.random() - 0.5) * 4);
    renderWeather(weatherCache.status, Math.max(10, Math.min(45, weatherCache.temp + tempOffset)), Math.max(0, Math.min(120, weatherCache.windSpeed + windSpeedOffset)), (weatherCache.windDir + windDirOffset + 360) % 360);
}

fetchRealtimeWeather();
setInterval(fetchRealtimeWeather, 600000);
setInterval(simulateWeatherFluctuation, 5000);

// TICKER BTC & DẦU
const BTC_TICKER_ID = 'btc-ticker';
const OIL_TICKER_ID = 'oil-ticker';
let realBitcoinPrice = null, realOilPrice = null;
let displayedBitcoinPrice = null, displayedOilPrice = null;
let realBitcoinChangePct = null, realOilChangePct = null;
const tickerHistory = { btc: [], oil: [] };
let lastSparkSampleAt = 0;

function formatTickerPrice(kind, value) {
    if (!Number.isFinite(value)) return '--';
    return kind === 'btc'
        ? `$${Math.round(value).toLocaleString('en-US')}`
        : `$${value.toFixed(2)}`;
}

function seedTickerHistory(kind, value, amplitude) {
    if (tickerHistory[kind].length || !Number.isFinite(value)) return;
    let cursor = value - amplitude * 0.3;
    for (let i = 0; i < 18; i++) {
        cursor += (Math.random() - 0.48) * amplitude;
        tickerHistory[kind].push(cursor);
    }
    tickerHistory[kind][tickerHistory[kind].length - 1] = value;
}

function pushTickerHistory(kind, value) {
    if (!Number.isFinite(value)) return;
    const arr = tickerHistory[kind];
    arr.push(value);
    if (arr.length > 22) arr.shift();
}

function renderSparkline(elementId, history) {
    const widget = document.getElementById(elementId);
    const line = widget?.querySelector('.ticker-sparkline-line');
    if (!line || history.length < 2) return;
    const width = 64, height = 16, pad = 1.5;
    const min = Math.min(...history), max = Math.max(...history);
    const range = Math.max(max - min, Math.abs(max || 1) * 0.000001);
    const points = history.map((v, i) => {
        const x = pad + i * ((width - pad * 2) / (history.length - 1));
        const y = height - pad - ((v - min) / range) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    line.setAttribute('points', points);
}

function renderTicker(elementId, kind, value, prevValue, changePct) {
    const widget = document.getElementById(elementId);
    if (!widget || !Number.isFinite(value)) return;
    const valueSpan = widget.querySelector('.ticker-value');
    const deltaSpan = widget.querySelector('.ticker-delta');
    if (!valueSpan) return;

    valueSpan.textContent = formatTickerPrice(kind, value);
    const fallbackDelta = prevValue === null ? 0 : ((value - prevValue) / Math.max(Math.abs(prevValue), 1)) * 100;
    const delta = Number.isFinite(changePct) ? changePct : fallbackDelta;
    const isUp = delta > 0.0001;
    const isDown = delta < -0.0001;
    widget.classList.toggle('up', isUp);
    widget.classList.toggle('down', isDown);
    widget.classList.toggle('flat', !isUp && !isDown);
    if (deltaSpan) {
        const arrow = isUp ? '▲' : isDown ? '▼' : '•';
        deltaSpan.textContent = `${arrow} ${Math.abs(delta).toFixed(2)}%`;
    }
    renderSparkline(elementId, tickerHistory[kind]);
}

async function fetchBitcoinPrice() {
    const sources = [
        async () => {
            const res = await fetchWithTimeout('https://api.exchange.coinbase.com/products/BTC-USD/stats', { cache: 'no-store' }, 5000);
            if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
            const d = await res.json();
            const price = Number(d?.last), open = Number(d?.open);
            return { price, changePct: Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : null };
        },
        async () => {
            const res = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', { cache: 'no-store' }, 5000);
            if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
            const d = await res.json();
            return { price: Number(d?.bitcoin?.usd), changePct: Number(d?.bitcoin?.usd_24h_change) };
        }
    ];

    for (const getPrice of sources) {
        try {
            const { price, changePct } = await getPrice();
            if (!Number.isFinite(price) || price <= 0) continue;
            realBitcoinPrice = price;
            realBitcoinChangePct = Number.isFinite(changePct) ? changePct : realBitcoinChangePct;
            if (displayedBitcoinPrice === null) displayedBitcoinPrice = price;
            seedTickerHistory('btc', price, 70);
            renderTicker(BTC_TICKER_ID, 'btc', displayedBitcoinPrice, null, realBitcoinChangePct);
            return;
        } catch (err) { /* thử nguồn kế tiếp */ }
    }
    console.error('[ticker] Không lấy được giá BTC từ mọi nguồn dự phòng');
}

async function fetchOilPrice() {
    const sources = [
        async () => {
            const res = await fetchWithTimeout('https://americasoilwatch.com/api/v1/wti', { cache: 'no-store' }, 4500);
            if (!res.ok) throw new Error(`AmericasOilWatch HTTP ${res.status}`);
            const d = await res.json();
            return { price: Number(d?.priceUsd), changePct: Number(d?.changePct) };
        },
        ...['https://api.allorigins.win/raw?url=', 'https://corsproxy.io/?url='].map(proxy => async () => {
            const targetUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F';
            const res = await fetchWithTimeout(proxy + encodeURIComponent(targetUrl), { cache: 'no-store' }, 4500);
            if (!res.ok) throw new Error(`Oil fallback HTTP ${res.status}`);
            const d = await res.json();
            const meta = d?.chart?.result?.[0]?.meta || {};
            const price = Number(meta.regularMarketPrice);
            const prevClose = Number(meta.chartPreviousClose || meta.previousClose);
            return { price, changePct: Number.isFinite(prevClose) && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null };
        })
    ];

    for (const getPrice of sources) {
        try {
            const { price, changePct } = await getPrice();
            if (!Number.isFinite(price) || price <= 0) continue;
            realOilPrice = price;
            realOilChangePct = Number.isFinite(changePct) ? changePct : realOilChangePct;
            if (displayedOilPrice === null) displayedOilPrice = price;
            seedTickerHistory('oil', price, 0.18);
            renderTicker(OIL_TICKER_ID, 'oil', displayedOilPrice, null, realOilChangePct);
            return;
        } catch (err) { /* thử nguồn kế tiếp */ }
    }
    console.error('[ticker] Không lấy được giá dầu từ mọi nguồn dự phòng');
}

fetchBitcoinPrice(); fetchOilPrice();
setInterval(fetchBitcoinPrice, 180000);
setInterval(fetchOilPrice, 180000);

let tickerIntervalId = null;
function startTickerInterval() {
    if (tickerIntervalId) return;
    tickerIntervalId = setInterval(() => {
        const now = Date.now();
        const shouldSampleSpark = now - lastSparkSampleAt >= 3200;
        if (realBitcoinPrice !== null) {
            const newVal = realBitcoinPrice + (Math.random() - 0.5) * 100;
            if (shouldSampleSpark) pushTickerHistory('btc', newVal);
            renderTicker(BTC_TICKER_ID, 'btc', newVal, displayedBitcoinPrice, realBitcoinChangePct);
            displayedBitcoinPrice = newVal;
        }
        if (realOilPrice !== null) {
            const newVal = realOilPrice + (Math.random() - 0.5) * 0.3;
            if (shouldSampleSpark) pushTickerHistory('oil', newVal);
            renderTicker(OIL_TICKER_ID, 'oil', newVal, displayedOilPrice, realOilChangePct);
            displayedOilPrice = newVal;
        }
        if (shouldSampleSpark) lastSparkSampleAt = now;
    }, 800);
}
function stopTickerInterval() {
    clearInterval(tickerIntervalId);
    tickerIntervalId = null;
}
startTickerInterval();

// ─── ĐỒNG HỒ LẬT (tự dừng khi ẩn tab, dùng textContent tránh reflow) ─────
const CLOCK_CARD_DOM = ['h1', 'h2', 'm1', 'm2', 's1', 's2'].reduce((acc, k) => {
    const card = document.getElementById('c-' + k);
    if (card) {
        acc[k] = {
            card,
            topHalf: card.querySelector('.card-top'),
            bottomHalf: card.querySelector('.card-bottom'),
            wing: card.querySelector('.card-flip-wing'),
            wingBack: card.querySelector('.card-flip-wing-back'),
            timers: []
        };
    }
    return acc;
}, {});

function updateCardValue(cardKey, targetVal) {
    const entry = CLOCK_CARD_DOM[cardKey];
    if (!entry) return;
    const { card, topHalf, bottomHalf, wing, wingBack, timers } = entry;
    if (topHalf.textContent === targetVal) return;

    while (timers.length) clearTimeout(timers.pop());
    wing.textContent = topHalf.textContent;
    wingBack.textContent = targetVal;
    card.classList.add('animate');
    timers.push(setTimeout(() => { topHalf.textContent = targetVal; }, 160));
    timers.push(setTimeout(() => {
        bottomHalf.textContent = targetVal;
        wing.textContent = targetVal;
        card.classList.remove('animate');
    }, 340));
}

function syncClockInstant() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const digits = [h[0], h[1], m[0], m[1], s[0], s[1]];
    ['h1', 'h2', 'm1', 'm2', 's1', 's2'].forEach((k, idx) => {
        const entry = CLOCK_CARD_DOM[k];
        if (!entry) return;
        while (entry.timers.length) clearTimeout(entry.timers.pop());
        entry.card.classList.remove('animate');
        const v = digits[idx];
        entry.topHalf.textContent = v;
        entry.bottomHalf.textContent = v;
        entry.wing.textContent = v;
        entry.wingBack.textContent = v;
    });
}

function runClock() {
    const d = new Date();
    const hStr = String(d.getHours()).padStart(2, '0');
    const mStr = String(d.getMinutes()).padStart(2, '0');
    const sStr = String(d.getSeconds()).padStart(2, '0');
    updateCardValue('h1', hStr[0]); updateCardValue('h2', hStr[1]);
    updateCardValue('m1', mStr[0]); updateCardValue('m2', mStr[1]);
    updateCardValue('s1', sStr[0]); updateCardValue('s2', sStr[1]);
}

let clockIntervalId = null;
function startClockInterval() {
    if (clockIntervalId) return;
    syncClockInstant();
    clockIntervalId = setInterval(runClock, 1000);
}
function stopClockInterval() {
    clearInterval(clockIntervalId);
    clockIntervalId = null;
}

document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('tab-hidden', document.hidden);
    if (document.hidden) {
        stopTickerInterval();
        stopClockInterval();
    } else {
        startTickerInterval();
        startClockInterval();
        refreshPresenceHeartbeat();
    }
});
startClockInterval();

// HAPTIC
function triggerHaptic(type) {
    if (window.navigator && window.navigator.vibrate) window.navigator.vibrate([18, 25, 18]);
}

// ─── animateNumber với cancel flag ────────────────────────────────────
const animatingFlags = {};
function animateNumber(elementId, newValue, suffix = '') {
    const el = document.getElementById(elementId);
    if (!el) return;
    const startValue = parseInt(el.textContent.replace(/\D/g, '')) || 0;
    if (startValue === newValue && (!suffix || el.textContent.endsWith(suffix))) return;
    const diff = newValue - startValue;
    const duration = 750, startTime = performance.now();
    const token = Symbol();
    animatingFlags[elementId] = token;

    function easeCountMoney(t) {
        if (t < 0.7) { const p = t / 0.7; return (1 - Math.pow(1 - p, 3)) * 0.92; }
        const p = (t - 0.7) / 0.3;
        return 0.92 + (1 - Math.pow(1 - p, 2)) * 0.08;
    }
    function updateAnim(currentTime) {
        if (animatingFlags[elementId] !== token) return;
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = easeCountMoney(progress);
        let val = startValue + diff * eased;
        if (progress > 0.85) { const step = 1000; val = Math.round(val / step) * step; }
        val = Math.round(val);
        val = diff >= 0 ? Math.min(val, newValue) : Math.max(val, newValue);
        el.textContent = `${val.toLocaleString()}${suffix}`;
        if (progress < 1) requestAnimationFrame(updateAnim);
        else { el.textContent = `${newValue.toLocaleString()}${suffix}`; delete animatingFlags[elementId]; }
    }
    requestAnimationFrame(updateAnim);
}

// ─── PRESENCE & TRẠNG THÁI MẠNG ────────────────────────────────────────
const RT_ROOT = 'combetram_v6_rt';
const PRESENCE_STORAGE_KEY = 'combetram_presence_id';
const STALE_PRESENCE_MS = 120000;
const STALE_CURSOR_MS = 45000;
const USER_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#d81b60', '#6d4c41', '#3949ab', '#c0ca33'];
const myColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
const onlineRef = ref(database, '.info/connected');
const presenceListRef = ref(database, `${RT_ROOT}/presence`);

function getOrCreatePresenceRef() {
    let storedId = null;
    try {
        storedId = sessionStorage.getItem(PRESENCE_STORAGE_KEY);
    } catch (e) {}
    if (storedId && /^[A-Za-z0-9_-]{6,64}$/.test(storedId)) {
        return child(presenceListRef, storedId);
    }
    const createdRef = push(presenceListRef);
    try {
        if (createdRef.key) sessionStorage.setItem(PRESENCE_STORAGE_KEY, createdRef.key);
    } catch (e) {}
    return createdRef;
}

const myPresenceRef = getOrCreatePresenceRef();
const myPresenceId = myPresenceRef.key;
const cursorsRef = ref(database, `${RT_ROOT}/cursors`);
const myCursorRef = child(cursorsRef, myPresenceId);
const focusRef = ref(database, `${RT_ROOT}/focus`);
const myFocusRef = child(focusRef, myPresenceId);

let isFirebaseConnected = false;
let hasEverConnected = false;
let lastPresenceSnap = null;
const cleanedStaleKeys = new Set();

function cleanupStaleRealtimeNodes(parentRef, prefix, snapVal, maxAgeMs) {
    if (!isFirebaseConnected || !snapVal || typeof snapVal !== 'object') return;
    const now = getServerNow();
    for (const [id, entry] of Object.entries(snapVal)) {
        if (id === myPresenceId) continue;
        const ts = Number(entry?.ts);
        if (Number.isFinite(ts) && (now - ts) >= maxAgeMs) {
            const cacheKey = `${prefix}:${id}:${ts}`;
            if (cleanedStaleKeys.has(cacheKey)) continue;
            cleanedStaleKeys.add(cacheKey);
            if (cleanedStaleKeys.size > 200) {
                const oldest = cleanedStaleKeys.values().next().value;
                cleanedStaleKeys.delete(oldest);
            }
            remove(child(parentRef, id)).catch(() => {
                cleanedStaleKeys.delete(cacheKey);
            });
        }
    }
}

function updateNetworkStatusBadge() {
    const badge = document.getElementById('offline-badge');
    if (!badge) return;
    const isOffline = navigator.onLine === false || (hasEverConnected && !isFirebaseConnected);
    badge.classList.toggle('hidden', !isOffline);
}
window.addEventListener('online', updateNetworkStatusBadge);
window.addEventListener('offline', updateNetworkStatusBadge);

function renderPresenceCount(snapVal) {
    const now = getServerNow();
    const entries = Object.entries(snapVal || {}).filter(([id, info]) => {
        if (id === myPresenceId) return true;
        const ts = Number(info?.ts);
        return !Number.isFinite(ts) || (now - ts) < STALE_PRESENCE_MS;
    });
    const el = document.getElementById('online-val');
    if (el) el.textContent = Math.max(1, entries.length);
}

onValue(presenceListRef, (snap) => {
    lastPresenceSnap = snap.val();
    renderPresenceCount(lastPresenceSnap);
    cleanupStaleRealtimeNodes(presenceListRef, 'presence', lastPresenceSnap, STALE_PRESENCE_MS);
});

function refreshPresenceHeartbeat() {
    if (!isFirebaseConnected) return;
    update(myPresenceRef, { ts: getServerNow() }).catch(() => {});
    if (currentTab) {
        set(myCursorRef, { table: currentTab, color: myColor, ts: getServerNow() }).catch(() => {});
    }
}
setInterval(() => {
    if (!document.hidden) refreshPresenceHeartbeat();
    renderPresenceCount(lastPresenceSnap);
    cleanupStaleRealtimeNodes(presenceListRef, 'presence', lastPresenceSnap, STALE_PRESENCE_MS);
    if (lastCursorSnap) {
        renderRemoteCursors(lastCursorSnap);
        cleanupStaleRealtimeNodes(cursorsRef, 'cursors', lastCursorSnap, STALE_CURSOR_MS);
    }
    if (lastFocusSnap) {
        renderRemoteFocus(lastFocusSnap);
        cleanupStaleRealtimeNodes(focusRef, 'focus', lastFocusSnap, STALE_CURSOR_MS);
    }
}, 30000);

onValue(onlineRef, (snap) => {
    isFirebaseConnected = snap.val() === true;
    if (isFirebaseConnected) {
        hasEverConnected = true;
        updateNetworkStatusBadge();
        onDisconnect(myPresenceRef).remove().catch(() => {});
        onDisconnect(myCursorRef).remove().catch(() => {});
        onDisconnect(myFocusRef).remove().catch(() => {});
        set(myPresenceRef, { color: myColor, ts: getServerNow() })
            .catch(e => console.error('[presence] LỖI GHI PRESENCE:', e.message));
        if (currentTab) {
            set(myCursorRef, { table: currentTab, color: myColor, ts: getServerNow() }).catch(() => {});
        }
        cleanupStaleRealtimeNodes(presenceListRef, 'presence', lastPresenceSnap, STALE_PRESENCE_MS);
        cleanupStaleRealtimeNodes(cursorsRef, 'cursors', lastCursorSnap, STALE_CURSOR_MS);
        cleanupStaleRealtimeNodes(focusRef, 'focus', lastFocusSnap, STALE_CURSOR_MS);
    } else {
        updateNetworkStatusBadge();
    }
});

// ─── Object pool cho cursor trail dùng Web Animations API (0 reflow) ───
const TRAIL_POOL_SIZE = 20;
const trailPool = [];
const trailAnimations = new WeakMap();
for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'cursor-trail';
    el.style.display = 'none';
    document.body.appendChild(el);
    trailPool.push(el);
}
let trailPoolIdx = 0;

function spawnTrail(x, y, color) {
    const trail = trailPool[trailPoolIdx % TRAIL_POOL_SIZE];
    trailPoolIdx++;
    const prevAnim = trailAnimations.get(trail);
    if (prevAnim) prevAnim.cancel();

    trail.style.left = x + 'px';
    trail.style.top = y + 'px';
    trail.style.background = color || '#999';
    trail.style.display = 'block';

    if (trail.animate) {
        const anim = trail.animate([
            { opacity: 0.55, transform: 'translate(-50%, -50%) scale(1)' },
            { opacity: 0, transform: 'translate(-50%, -50%) scale(0.3)' }
        ], { duration: 500, easing: 'ease-out' });
        trailAnimations.set(trail, anim);
        anim.onfinish = anim.oncancel = () => {
            if (trailAnimations.get(trail) === anim) {
                trailAnimations.delete(trail);
                trail.style.display = 'none';
            }
        };
    } else {
        setTimeout(() => { trail.style.display = 'none'; }, 500);
    }
}

// ─── CURSOR ĐỒNG NGHIỆP (gom nhóm getBoundingClientRect theo bàn) ───────
const remoteCursorEls = {};
const lastCursorPos = {};

function positionCursorOnTable(id, el, rect, offsetIndex, color) {
    if (!rect) { el.classList.remove('visible'); return; }
    const x = rect.left + 12 + (offsetIndex * 16);
    const y = rect.top + 12;
    const prev = lastCursorPos[id];
    if (prev && (Math.abs(prev.x - x) > 6 || Math.abs(prev.y - y) > 6)) {
        const steps = 4;
        for (let s = 1; s <= steps; s++) {
            const t = s / (steps + 1);
            setTimeout(() => spawnTrail(prev.x + (x - prev.x) * t, prev.y + (y - prev.y) * t, color), s * 28);
        }
    }
    lastCursorPos[id] = { x, y };
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.classList.add('visible');
}

function renderRemoteCursors(snapVal) {
    const now = getServerNow();
    const entries = Object.entries(snapVal || {}).filter(([id, c]) => {
        if (id === myPresenceId || !c || !c.table) return false;
        const ts = Number(c.ts);
        return !Number.isFinite(ts) || (now - ts) < STALE_CURSOR_MS;
    });

    const activeIds = new Set(entries.map(([id]) => id));
    Object.keys(remoteCursorEls).forEach(id => {
        if (!activeIds.has(id)) {
            remoteCursorEls[id].remove();
            delete remoteCursorEls[id];
            delete lastCursorPos[id];
        }
    });

    // Đo tọa độ mỗi thẻ bàn tối đa 1 lần cho toàn bộ khung hình
    const tableRects = new Map();
    const countPerTable = {}, tableViewerColor = {};
    entries.forEach(([id, c]) => {
        const tableNum = Number(c.table);
        if (!tableRects.has(tableNum)) {
            const card = TABLE_DOM[tableNum - 1]?.card;
            tableRects.set(tableNum, card ? card.getBoundingClientRect() : null);
        }
        const idx = countPerTable[tableNum] || 0;
        countPerTable[tableNum] = idx + 1;
        if (!tableViewerColor[tableNum]) tableViewerColor[tableNum] = c.color || '#999';
        let el = remoteCursorEls[id];
        if (!el) {
            el = document.createElement('div');
            el.className = 'remote-cursor';
            document.body.appendChild(el);
            remoteCursorEls[id] = el;
        }
        el.style.background = c.color || '#999';
        positionCursorOnTable(id, el, tableRects.get(tableNum), idx, c.color);
    });

    for (let t = 1; t <= 9; t++) {
        const card = TABLE_DOM[t - 1]?.card;
        if (!card) continue;
        if (tableViewerColor[t]) {
            card.classList.add('has-viewer');
            card.style.setProperty('--viewer-color', tableViewerColor[t]);
        } else {
            card.classList.remove('has-viewer');
            card.style.removeProperty('--viewer-color');
        }
    }
}

let lastCursorSnap = null;
onValue(cursorsRef, (snap) => {
    lastCursorSnap = snap.val();
    renderRemoteCursors(lastCursorSnap);
    cleanupStaleRealtimeNodes(cursorsRef, 'cursors', lastCursorSnap, STALE_CURSOR_MS);
});

let cursorRenderTicking = false;
function scheduleRenderRemoteCursors() {
    if (cursorRenderTicking) return;
    cursorRenderTicking = true;
    requestAnimationFrame(() => { renderRemoteCursors(lastCursorSnap); cursorRenderTicking = false; });
}
window.addEventListener('resize', scheduleRenderRemoteCursors);
window.addEventListener('scroll', scheduleRenderRemoteCursors, { passive: true });

// ─── Throttle cursor broadcast 200ms ───────────────────────────────────
let lastCursorBroadcastTs = 0;
function broadcastCursor(tableNum) {
    const now = Date.now();
    if (tableNum && now - lastCursorBroadcastTs < 200) return;
    lastCursorBroadcastTs = now;
    if (tableNum) set(myCursorRef, { table: tableNum, color: myColor, ts: getServerNow() }).catch(() => {});
    else remove(myCursorRef).catch(() => {});
    broadcastFocus(null);
}

// ─── CLICK-TO-FOCUS (chỉ gửi remove khi thật sự có focus đang bật) ────
let lastFocusBroadcast = 0, focusClearTimer = null, hasActiveFocus = false;
function broadcastFocus(itemId) {
    if (itemId === null) {
        clearTimeout(focusClearTimer);
        focusClearTimer = null;
        if (hasActiveFocus) {
            hasActiveFocus = false;
            remove(myFocusRef).catch(() => {});
        }
        return;
    }
    const now = Date.now();
    if (now - lastFocusBroadcast > 120) {
        lastFocusBroadcast = now;
        hasActiveFocus = true;
        set(myFocusRef, { table: currentTab, itemId, color: myColor, ts: getServerNow() }).catch(() => {});
    }
    clearTimeout(focusClearTimer);
    focusClearTimer = setTimeout(() => {
        focusClearTimer = null;
        if (hasActiveFocus) {
            hasActiveFocus = false;
            remove(myFocusRef).catch(() => {});
        }
    }, 1500);
}

const remoteFocusRows = {};
function renderRemoteFocus(snapVal) {
    const now = getServerNow();
    const entries = Object.entries(snapVal || {}).filter(([id, f]) => {
        if (id === myPresenceId || !f) return false;
        const ts = Number(f.ts);
        return !Number.isFinite(ts) || (now - ts) < STALE_CURSOR_MS;
    });
    Object.keys(remoteFocusRows).forEach(id => {
        const stillActive = entries.find(([eid, f]) => eid === id && f.table === currentTab);
        if (!stillActive) {
            const prev = remoteFocusRows[id];
            if (prev.rowEl) { prev.rowEl.classList.remove('remote-focus'); prev.rowEl.style.removeProperty('--focus-color'); }
            if (prev.tagEl) prev.tagEl.remove();
            delete remoteFocusRows[id];
        }
    });
    if (!currentTab) return;
    entries.forEach(([id, f]) => {
        if (f.table !== currentTab) return;
        const row = ITEM_DOM.get(Number(f.itemId))?.row;
        if (!row) return;
        const prev = remoteFocusRows[id];
        if (prev && prev.rowEl && prev.rowEl !== row) { prev.rowEl.classList.remove('remote-focus'); prev.rowEl.style.removeProperty('--focus-color'); if (prev.tagEl) prev.tagEl.remove(); }
        row.classList.add('remote-focus');
        row.style.setProperty('--focus-color', f.color || '#999');
        let tag = (prev && prev.rowEl === row) ? prev.tagEl : null;
        if (!tag) { tag = document.createElement('span'); tag.className = 'remote-focus-tag'; tag.textContent = '✏️'; row.appendChild(tag); requestAnimationFrame(() => tag.classList.add('visible')); }
        tag.style.background = f.color || '#999';
        remoteFocusRows[id] = { rowEl: row, tagEl: tag };
    });
}

let lastFocusSnap = null;
onValue(focusRef, (snap) => {
    lastFocusSnap = snap.val();
    renderRemoteFocus(lastFocusSnap);
    cleanupStaleRealtimeNodes(focusRef, 'focus', lastFocusSnap, STALE_CURSOR_MS);
});

// ─── MENU + THANH NHẢY NHANH THEO NHÓM MÓN ─────────────────────────────
const SHORT_CAT_LABELS = ['Cơm / Mỳ', 'Hấp / Cháo', 'Món thêm', 'Nước uống', 'Bia'];

function renderMenu() {
    const navParts = [];
    const parts = [];
    menu.forEach((g, idx) => {
        const shortLabel = SHORT_CAT_LABELS[idx] || g.cat.split('/')[0].trim();
        navParts.push(`<button type="button" class="cat-pill${idx === 0 ? ' active' : ''}" data-cat-idx="${idx}">${shortLabel}</button>`);
        parts.push(`<div class="category-title" id="cat-sec-${idx}" data-cat-idx="${idx}">${g.cat}</div>`);
        g.items.forEach(i => {
            parts.push(`<div class="menu-item" id="row-${i.id}">
                <div class="item-info"><b>${i.name}</b><small>${i.price.toLocaleString()}đ</small></div>
                <div class="controls">
                    <button class="btn-qty btn-sub" data-item-id="${i.id}">-</button>
                    <span class="qty-num" id="q-${i.id}">0</span>
                    <button class="btn-qty btn-add" data-item-id="${i.id}">+</button>
                </div>
            </div>`);
        });
    });
    const catNav = document.getElementById('menu-cat-nav');
    if (catNav) catNav.innerHTML = navParts.join('');
    document.getElementById('menu-list').innerHTML = parts.join('');
}
renderMenu();
ALL_ITEMS.forEach(item => {
    ITEM_DOM.set(item.id, {
        row: document.getElementById(`row-${item.id}`),
        qty: document.getElementById(`q-${item.id}`)
    });
});

document.getElementById('menu-cat-nav')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.cat-pill');
    if (!pill) return;
    triggerHaptic('nav');
    const idx = pill.dataset.catIdx;
    document.querySelectorAll('#menu-cat-nav .cat-pill').forEach(p => p.classList.toggle('active', p === pill));
    document.getElementById(`cat-sec-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Highlight active category pill khi cuộn thực đơn
let catScrollTicking = false;
window.addEventListener('scroll', () => {
    if (!currentTab || data.locked?.[currentTab] || catScrollTicking) return;
    catScrollTicking = true;
    requestAnimationFrame(() => {
        catScrollTicking = false;
        const nav = document.getElementById('menu-cat-nav');
        if (!nav) return;
        const threshold = nav.getBoundingClientRect().bottom + 14;
        let activeIdx = 0;
        for (let i = 0; i < menu.length; i++) {
            const sec = document.getElementById(`cat-sec-${i}`);
            if (sec && sec.getBoundingClientRect().top <= threshold) activeIdx = i;
        }
        nav.querySelectorAll('.cat-pill').forEach((p, idx) => p.classList.toggle('active', idx === activeIdx));
    });
}, { passive: true });

// Preload audio sau tương tác đầu tiên
document.addEventListener('pointerdown', () => {
    const ting = document.getElementById('tingSound');
    if (ting) { ting.preload = 'auto'; ting.load(); }
}, { once: true, passive: true });

document.getElementById('menu-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-qty'); if (!btn) return;
    const itemId = parseInt(btn.dataset.itemId);
    change(itemId, btn.classList.contains('btn-add') ? 1 : -1);
});

// ─── TỰ ẨN NÚT CUỘN XUỐNG KHI NÚT CHỐT ĐƠN ĐÃ HIỆN RA ─────────────────
let checkoutBtnVisible = false;
function updateScrollCheckoutButton() {
    const scrollBtn = document.getElementById('scroll-to-checkout');
    if (!scrollBtn) return;
    const shouldShow = Boolean(currentTab && !data.locked?.[currentTab] && !checkoutBtnVisible);
    scrollBtn.classList.toggle('hidden', !shouldShow);
}

const checkoutBtnEl = document.getElementById('btn-checkout');
if (checkoutBtnEl && 'IntersectionObserver' in window) {
    const checkoutObserver = new IntersectionObserver((entries) => {
        checkoutBtnVisible = entries.some(entry => entry.isIntersecting);
        updateScrollCheckoutButton();
    }, { threshold: 0.15 });
    checkoutObserver.observe(checkoutBtnEl);
}

// ─── DỮ LIỆU CHÍNH FIREBASE ────────────────────────────────────────────
const pendingUpdates = {};
let firstOrdersLoad = true;
const initialBranchesLoaded = new Set();
let initialDataReady = false;
const pendingRemoteOrderFlashes = [];

function queueRemoteOrderFlashes(prevOrders, nextOrders, ignoredTables = null) {
    let queued = 0;
    for (let tableId = 1; tableId <= 9; tableId++) {
        if (ignoredTables?.has(tableId)) continue;
        const prevTable = prevOrders?.[tableId] || {};
        const nextTable = nextOrders?.[tableId] || {};
        const itemIds = new Set([...Object.keys(prevTable), ...Object.keys(nextTable)]);

        for (const rawId of itemIds) {
            const itemId = Number(rawId);
            const oldQty = Number(prevTable?.[rawId] || 0);
            const newQty = Number(nextTable?.[rawId] || 0);
            if (oldQty === newQty) continue;

            const localPendingQty = pendingUpdates[tableId]?.[itemId];
            if (localPendingQty !== undefined && Number(localPendingQty) === newQty) continue;

            pendingRemoteOrderFlashes.push({
                tableId,
                itemId,
                delta: newQty - oldQty
            });
            queued++;
        }
    }
    return queued;
}

function flushRemoteOrderFlashes() {
    if (!pendingRemoteOrderFlashes.length) return;
    const flashes = pendingRemoteOrderFlashes.splice(0);

    for (const { tableId, itemId, delta } of flashes) {
        const cls = delta > 0 ? 'flash-add' : 'flash-sub';
        const tableBtn = TABLE_DOM[tableId - 1]?.card;
        const row = currentTab === tableId ? ITEM_DOM.get(itemId)?.row : null;

        if (tableBtn) tableBtn.classList.add(cls);
        if (row) row.classList.add(cls);

        setTimeout(() => {
            if (tableBtn) tableBtn.classList.remove(cls);
            if (row) row.classList.remove(cls);
        }, 400);
    }
}

function markInitialBranchLoaded(branch) {
    if (initialDataReady) return;
    initialBranchesLoaded.add(branch);
    if (initialBranchesLoaded.size === 3) {
        initialDataReady = true;
        cleanupStaleTimes();
        scheduleRefresh(null);
    }
}

onValue(ordersRef, snap => {
    const nextOrders = snap.val() || {};
    const changed = changedTableIds(data.orders, nextOrders);
    if (!firstOrdersLoad && changed.size) {
        const ignoredTables = localPaymentEchoTables.size ? new Set(localPaymentEchoTables) : null;
        const remoteChanges = queueRemoteOrderFlashes(data.orders, nextOrders, ignoredTables);
        if (remoteChanges > 0) document.getElementById('tingSound').play().catch(() => {});
        if (ignoredTables) {
            for (const tableId of ignoredTables) {
                if (!nextOrders?.[tableId] || Object.keys(nextOrders[tableId]).length === 0) {
                    localPaymentEchoTables.delete(tableId);
                }
            }
        }
    }
    data.orders = nextOrders;
    firstOrdersLoad = false;
    if (initialDataReady && changed.size) {
        cleanupStaleTimes(changed);
        scheduleRefresh(changed, true);
    }
    markInitialBranchLoaded('orders');
});

onValue(lockedRef, snap => {
    const nextLocked = snap.val() || {};
    const changed = changedTableIds(data.locked, nextLocked);
    data.locked = nextLocked;
    if (initialDataReady && changed.size) scheduleRefresh(changed, true);
    markInitialBranchLoaded('locked');
});

onValue(timesRef, snap => {
    const nextTimes = snap.val() || {};
    const changed = changedTableIds(data.times, nextTimes);
    data.times = nextTimes;
    if (initialDataReady && changed.size) scheduleRefresh(changed);
    markInitialBranchLoaded('times');
});

function selectTable(n, options = {}) {
    if (paymentInProgress && !options.allowDuringPayment) return;
    if (options.haptic !== false) triggerHaptic('nav');
    resetBillQrView(true);
    const previousTab = currentTab;
    const wasOpenForSameTable = (currentTab === n);
    currentTab = wasOpenForSameTable ? null : n;
    currentBillLang = 'vi';
    syncActiveLangButton('vi');
    billWasShown = false;
    broadcastCursor(currentTab);
    renderRemoteFocus(lastFocusSnap);
    const section = document.getElementById('order-section');
    if (currentTab) {
        let title = "BÀN " + n;
        if (n === 7) title = "BÀN TRONG HIÊN"; if (n === 8) title = "NGOÀI ĐƯỜNG (TRÁI)"; if (n === 9) title = "NGOÀI ĐƯỜNG (PHẢI)";
        document.getElementById('table-title').textContent = title;
        section.style.display = 'block';
        requestAnimationFrame(() => requestAnimationFrame(() => section.classList.add('section-visible')));
        refresh(new Set([previousTab, currentTab].filter(Boolean)));
        const isLockedTable = (data.locked && data.locked[n]) || false;
        if (isLockedTable) {
            preloadBillAssets();
            setTimeout(scrollBillIntoView, 350);
        }
    } else {
        section.classList.remove('section-visible');
        checkoutBtnVisible = false;
        updateScrollCheckoutButton();
        if (options.instantClose) {
            section.style.display = 'none';
        } else {
            setTimeout(() => { if (!currentTab) section.style.display = 'none'; }, 320);
        }
        refresh(new Set([previousTab].filter(Boolean)));
    }
}

// ─── Debounce Firebase write 250ms & Flush tức thì khi chốt đơn ─────────
const debounceTimers = {};
const debounceVersions = {};
const pendingStartTimes = new Set();

function clearPendingForTable(tab) {
    delete pendingUpdates[tab];
    pendingStartTimes.delete(tab);
    const prefix = `${tab}_`;
    for (const key of Object.keys(debounceTimers)) {
        if (key.startsWith(prefix)) {
            clearTimeout(debounceTimers[key]);
            delete debounceTimers[key];
            delete debounceVersions[key];
        }
    }
}

function commitPendingItem(tab, id, expectedVersion = null) {
    const key = `${tab}_${id}`;
    if (expectedVersion !== null && debounceVersions[key] !== expectedVersion) return;

    const version = expectedVersion !== null ? expectedVersion : ((debounceVersions[key] || 0) + 1);
    debounceVersions[key] = version;
    clearTimeout(debounceTimers[key]);
    delete debounceTimers[key];

    const finalQty = pendingUpdates[tab]?.[id];
    if (finalQty === undefined) {
        if (debounceVersions[key] === version) delete debounceVersions[key];
        return;
    }

    if (!data.times?.[tab] && !pendingStartTimes.has(tab) && finalQty > 0) {
        pendingStartTimes.add(tab);
        const startTs = getServerNow();
        set(child(timesRef, String(tab)), startTs)
            .catch(err => console.error('[times] Lỗi ghi mốc giờ Firebase:', err))
            .finally(() => pendingStartTimes.delete(tab));
    }

    const sentQty = finalQty;
    update(child(ordersRef, String(tab)), { [id]: sentQty > 0 ? sentQty : null })
        .then(() => {
            if (debounceVersions[key] === version && pendingUpdates[tab]?.[id] === sentQty) {
                delete pendingUpdates[tab][id];
                if (Object.keys(pendingUpdates[tab]).length === 0) delete pendingUpdates[tab];
            }
            queueMicrotask(() => {
                if (!effectiveTableHasItems(tab)) remove(child(timesRef, String(tab))).catch(() => {});
            });
        })
        .catch(err => {
            console.error('[orders] Lỗi ghi Firebase:', err);
            if (debounceVersions[key] === version && pendingUpdates[tab]?.[id] === sentQty) {
                delete pendingUpdates[tab][id];
                if (Object.keys(pendingUpdates[tab]).length === 0) delete pendingUpdates[tab];
                scheduleRefresh(new Set([tab]), currentTab === tab);
            }
        })
        .finally(() => {
            if (debounceVersions[key] === version) {
                delete debounceTimers[key];
                delete debounceVersions[key];
            }
        });
}

function flushPendingForTable(tab) {
    const pending = pendingUpdates[tab];
    if (!pending) return;
    for (const rawId of Object.keys(pending)) {
        commitPendingItem(tab, Number(rawId));
    }
}

function getMergedOrder(tab) {
    const serverOrder = data.orders?.[tab] || {};
    const pendingOrder = pendingUpdates[tab];
    if (!pendingOrder) return serverOrder;
    const merged = { ...serverOrder };
    for (const [id, qty] of Object.entries(pendingOrder)) {
        const cleanQty = Math.max(0, Number(qty) || 0);
        if (cleanQty > 0) merged[id] = cleanQty;
        else delete merged[id];
    }
    return merged;
}

const qtyBumpAnimations = new WeakMap();
function playQtyBump(el) {
    if (!el) return;
    const previous = qtyBumpAnimations.get(el);
    if (previous) previous.cancel();

    const animation = el.animate(
        [
            { transform: 'scale(1)' },
            { transform: 'scale(1.45)', offset: 0.45 },
            { transform: 'scale(1)' }
        ],
        {
            duration: 280,
            easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
        }
    );
    qtyBumpAnimations.set(el, animation);
    animation.onfinish = animation.oncancel = () => {
        if (qtyBumpAnimations.get(el) === animation) qtyBumpAnimations.delete(el);
    };
}

function effectiveTableHasItems(tab) {
    for (const item of ALL_ITEMS) {
        const qty = pendingUpdates[tab]?.[item.id] ?? data.orders?.[tab]?.[item.id] ?? 0;
        if (Number(qty) > 0) return true;
    }
    return false;
}

function cleanupStaleTimes(tableIds = null) {
    if (!initialDataReady) return;
    const ids = tableIds ? Array.from(tableIds) : Array.from({ length: 9 }, (_, i) => i + 1);
    for (const tab of ids) {
        if (!data.times?.[tab] || data.locked?.[tab] || effectiveTableHasItems(tab)) continue;
        remove(child(timesRef, String(tab))).catch(() => {});
    }
}

function applyMenuRowQtyClasses(row, qty) {
    if (!row) return;
    const preserveRemoteFocus = row.classList.contains('remote-focus');
    const preserveFlashAdd = row.classList.contains('flash-add');
    const preserveFlashSub = row.classList.contains('flash-sub');
    row.className = 'menu-item';
    if (qty >= 5) row.classList.add('qty-5');
    else if (qty > 0) row.classList.add('qty-' + qty);
    if (preserveRemoteFocus) row.classList.add('remote-focus');
    if (preserveFlashAdd) row.classList.add('flash-add');
    if (preserveFlashSub) row.classList.add('flash-sub');
}

function change(id, delta) {
    if (!currentTab || (data.locked && data.locked[currentTab])) return;
    triggerHaptic(delta > 0 ? 'add' : 'sub');
    broadcastFocus(id);

    const tab = currentTab;
    const order = data.orders[tab] || {};
    const currentQty = (pendingUpdates[tab]?.[id] ?? order[id]) || 0;
    if (delta < 0 && currentQty <= 0) return;

    // Optimistic update ngay lập tức cho cả dòng món lẫn thẻ bàn phía trên
    const newQty = Math.max(0, currentQty + delta);
    if (!pendingUpdates[tab]) pendingUpdates[tab] = {};
    pendingUpdates[tab][id] = newQty;

    const itemDom = ITEM_DOM.get(id);
    const qSpan = itemDom?.qty;
    const row = itemDom?.row;
    if (qSpan) {
        qSpan.textContent = newQty;
        applyMenuRowQtyClasses(row, newQty);
        playQtyBump(qSpan);
    }
    renderTable(tab, getServerNow());
    renderCrowdAndReset();
    flashRow(id, delta);

    // Debounce ghi Firebase
    const key = `${tab}_${id}`;
    const version = (debounceVersions[key] || 0) + 1;
    debounceVersions[key] = version;
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(() => commitPendingItem(tab, id, version), 250);
}

function flashRow(id, delta) {
    const itemDom = ITEM_DOM.get(id), row = itemDom?.row, tabBtn = currentTab ? TABLE_DOM[currentTab - 1]?.card : null, cls = delta > 0 ? 'flash-add' : 'flash-sub';
    if (row) row.classList.add(cls); if (tabBtn) tabBtn.classList.add(cls);
    setTimeout(() => { if (row) row.classList.remove(cls); if (tabBtn) tabBtn.classList.remove(cls); }, 400);
}

function changeBillLang(l) {
    if (paymentInProgress) return;
    triggerHaptic('nav');
    currentBillLang = l;
    syncActiveLangButton(l);
    renderCurrentOrder();
    scrollBillIntoView();
}

// ─── Tính tổng tiền + số món ăn / nước uống (gộp cả pendingUpdates) ─────
function calculateTableStats(tableId) {
    let total = 0, foodQty = 0, drinkQty = 0;
    const serverOrder = data.orders?.[tableId] || {};
    const pendingOrder = pendingUpdates[tableId];
    if (!pendingOrder) {
        for (const id in serverOrder) {
            const itemId = Number(id);
            const item = ITEM_MAP.get(itemId);
            const qty = Math.max(0, Number(serverOrder[id]) || 0);
            if (!item || qty <= 0) continue;
            total += item.price * qty;
            if (DRINK_ITEM_IDS.has(itemId)) drinkQty += qty;
            else foodQty += qty;
        }
        return { total, foodQty, drinkQty };
    }

    const seen = new Set();
    for (const id in pendingOrder) {
        seen.add(id);
        const itemId = Number(id);
        const item = ITEM_MAP.get(itemId);
        const qty = Math.max(0, Number(pendingOrder[id]) || 0);
        if (!item || qty <= 0) continue;
        total += item.price * qty;
        if (DRINK_ITEM_IDS.has(itemId)) drinkQty += qty;
        else foodQty += qty;
    }
    for (const id in serverOrder) {
        if (seen.has(id)) continue;
        const itemId = Number(id);
        const item = ITEM_MAP.get(itemId);
        const qty = Math.max(0, Number(serverOrder[id]) || 0);
        if (!item || qty <= 0) continue;
        total += item.price * qty;
        if (DRINK_ITEM_IDS.has(itemId)) drinkQty += qty;
        else foodQty += qty;
    }
    return { total, foodQty, drinkQty };
}

function renderCurrentOrder() {
    if (!currentTab) return;
    const billArea = document.getElementById('bill-area');

    const isLock = !!data.locked?.[currentTab];
    document.getElementById('menu-area').style.display = isLock ? 'none' : 'block';
    billArea.style.display = isLock ? 'block' : 'none';
    if (isLock && !billWasShown) {
        preloadBillAssets();
        billArea.classList.remove('printing-out');
        requestAnimationFrame(() => requestAnimationFrame(() => billArea.classList.add('printing-out')));
        billWasShown = true;
    } else if (!isLock) {
        billWasShown = false;
        billArea.classList.remove('printing-out');
        if (billViewMode !== 'bill') resetBillQrView(true);
    }
    updateScrollCheckoutButton();

    ALL_ITEMS.forEach(item => {
        const q = Math.max(0, pendingUpdates[currentTab]?.[item.id] ?? data.orders[currentTab]?.[item.id] ?? 0);
        const itemDom = ITEM_DOM.get(item.id);
        const row = itemDom?.row, qSpan = itemDom?.qty;
        if (row && qSpan && qSpan.textContent !== String(q)) {
            qSpan.textContent = q;
            applyMenuRowQtyClasses(row, q);
        }
    });

    if (isLock) renderBillAsync(currentTab);
}

function renderTableTime(tableId, now = getServerNow()) {
    const dom = TABLE_DOM[tableId - 1];
    if (!dom?.time) return;
    dom.time.classList.remove('skeleton');
    let txt = '';
    if (tableTotals[tableId] > 0 && data.times?.[tableId]) {
        const diff = Math.max(0, Math.floor((now - data.times[tableId]) / 60000));
        txt = diff > 0 ? `⏱ ${diff} phút` : '⏱ Mới vào';
    }
    if (dom.time.textContent !== txt) dom.time.textContent = txt;
}

function renderTable(tableId, now = getServerNow()) {
    const dom = TABLE_DOM[tableId - 1];
    if (!dom) return;
    const { total, foodQty, drinkQty } = calculateTableStats(tableId);
    tableTotals[tableId] = total;
    const locked = !!data.locked?.[tableId];

    if (dom.sum) {
        dom.sum.classList.remove('skeleton');
        if (parseInt(dom.sum.textContent.replace(/\D/g, '')) !== total || !dom.sum.textContent.endsWith('đ')) animateNumber(`sum-${tableId}`, total, 'đ');
    }
    if (dom.meta) {
        dom.meta.classList.remove('skeleton');
        dom.meta.innerHTML = total > 0 ? `🍽 <span class="table-meta-count">${foodQty}</span> món · 🥤🍺 <span class="table-meta-count">${drinkQty}</span>` : '';
        dom.meta.title = total > 0 ? `${foodQty} phần món ăn · ${drinkQty} nước/bia` : '';
    }
    renderTableTime(tableId, now);

    if (dom.card) {
        const preserveViewer = dom.card.classList.contains('has-viewer');
        const preserveFlashAdd = dom.card.classList.contains('flash-add');
        const preserveFlashSub = dom.card.classList.contains('flash-sub');
        let className = tableId === 7 ? 'table-card full-width' : (tableId >= 8 ? 'table-card half-width' : 'table-card');
        if (tableId === currentTab) className += ' active';
        if (locked) className += ' is-locked';
        else if (total > 0) className += ' has-guest';
        if (dom.card.className !== className) {
            dom.card.className = className;
            if (preserveViewer) dom.card.classList.add('has-viewer');
            if (preserveFlashAdd) dom.card.classList.add('flash-add');
            if (preserveFlashSub) dom.card.classList.add('flash-sub');
        }
    }
}

setInterval(() => {
    const now = getServerNow();
    for (let i = 1; i <= 9; i++) renderTableTime(i, now);
}, 30000);

function renderCrowdAndReset() {
    let activeTablesCount = 0;
    for (let i = 1; i <= 9; i++) {
        if (tableTotals[i] > 0 || data.locked?.[i]) activeTablesCount++;
    }
    const anyGuest = activeTablesCount > 0;
    const crowdEl = document.getElementById('crowd-status');
    const crowdTxt = document.getElementById('crowd-text');
    const crowdIcon = document.getElementById('crowd-icon');
    if (crowdEl && crowdTxt && crowdIcon) {
        if (activeTablesCount <= 3) {
            crowdEl.className = 'status-badge status-empty'; crowdTxt.textContent = 'Vắng khách'; crowdIcon.textContent = '🟢';
        } else if (activeTablesCount <= 6) {
            crowdEl.className = 'status-badge status-normal'; crowdTxt.textContent = 'Bình thường'; crowdIcon.textContent = '🟡';
        } else {
            crowdEl.className = 'status-badge status-crowded'; crowdTxt.textContent = 'ĐÔNG KHÁCH'; crowdIcon.textContent = '🚨';
        }
    }
    document.getElementById('reset-area').style.display = anyGuest ? 'none' : 'block';
}

function refresh(tableIds = null, updateCurrentOrder = true) {
    const ids = tableIds === null ? new Set(Array.from({ length: 9 }, (_, i) => i + 1)) : tableIds;
    const currentAffected = currentTab && (tableIds === null || ids.has(currentTab));
    if (updateCurrentOrder && currentAffected) renderCurrentOrder();
    const now = getServerNow();
    for (const id of ids) renderTable(Number(id), now);
    renderCrowdAndReset();
    flushRemoteOrderFlashes();
}

// ─── Async bill render với kiểm tra trạng thái khóa sau await ──────────
async function renderBillAsync(tab) {
    const targetLang = currentBillLang;
    const langData = await getLangData(targetLang);
    if (currentTab !== tab || currentBillLang !== targetLang || !data.locked?.[tab]) return;

    let h = "", t = 0, my = getMergedOrder(tab);
    document.getElementById('txt-total-label').textContent = langData.total;
    document.getElementById('txt-lang-flag').textContent = langData.flag;
    let idx = 0;
    for (let id in my) {
        const itm = ITEM_MAP.get(Number(id));
        if (itm && my[id] > 0) {
            let p = itm.price * my[id]; t += p;
            let nameShow = (targetLang !== 'vi' && langData.items?.[itm.id]) ? langData.items[itm.id] : itm.name;
            const delaySec = Math.min(idx * 0.05, 0.35).toFixed(2);
            h += `<div class="bill-row" style="animation-delay: ${delaySec}s">
                    <span class="item-name">${nameShow}</span>
                    <span class="item-qty">x${my[id]}</span>
                    <div class="divider"></div>
                    <span class="item-price">${p.toLocaleString()}đ</span>
                  </div>`; idx++;
        }
    }
    document.getElementById('bill-list').innerHTML = h || "Trống";
    const bTotal = document.getElementById('bill-total'), tBox = document.getElementById('total-container');
    if (parseInt(bTotal.textContent.replace(/\D/g, '')) !== t) { animateNumber('bill-total', t); tBox.classList.add('total-pop'); setTimeout(() => tBox.classList.remove('total-pop'), 400); }
    requestAnimationFrame(() => syncBillFlipHeight(false));
}

function setLock(v) {
    if (!currentTab || paymentInProgress) return;
    triggerHaptic(v ? 'lock' : 'nav');
    if (v) {
        flushPendingForTable(currentTab);
        preloadBillAssets();
        resetBillQrView(true);
    }
    set(child(lockedRef, String(currentTab)), v)
        .catch(err => console.error('[lock] Lỗi ghi trạng thái khóa Firebase:', err));
    if (!v) {
        currentBillLang = 'vi';
        syncActiveLangButton('vi');
        resetBillQrView(true);
    }
    if (v) setTimeout(scrollBillIntoView, 100);
}

function doPay() {
    if (!currentTab || paymentInProgress) return;

    const tab = currentTab;
    const lockedBeforeConfirm = !!data.locked?.[tab];
    const orderSnapshotBeforeConfirm = JSON.stringify(getMergedOrder(tab));

    if (!confirm("Xác nhận thanh toán?")) return;

    // Kiểm tra xem máy khác có vừa mở khóa hoặc sửa đơn trong lúc hộp thoại xác nhận đang mở không
    const lockedAfterConfirm = !!data.locked?.[tab];
    const orderSnapshotAfterConfirm = JSON.stringify(getMergedOrder(tab));
    if ((lockedBeforeConfirm && !lockedAfterConfirm) || orderSnapshotBeforeConfirm !== orderSnapshotAfterConfirm) {
        alert("Đơn bàn này vừa được cập nhật hoặc mở khóa từ thiết bị khác. Vui lòng kiểm tra lại bill trước khi thanh toán!");
        scheduleRefresh(new Set([tab]), true);
        return;
    }

    paymentInProgress = true;
    localPaymentEchoTables.add(tab);
    clearPendingForTable(tab);
    stopBillScrollAnimation();
    triggerHaptic('success');

    const paymentWrite = update(dbRef, {
        [`orders/${tab}`]: null,
        [`locked/${tab}`]: null,
        [`times/${tab}`]: null
    });

    if (data.orders) delete data.orders[tab];
    if (data.locked) delete data.locked[tab];
    if (data.times) delete data.times[tab];
    tableTotals[tab] = 0;
    scheduleRefresh(new Set([tab]), true);

    selectTable(null, { haptic: false, allowDuringPayment: true, instantClose: true });
    paymentInProgress = false;

    paymentWrite.catch(err => {
        localPaymentEchoTables.delete(tab);
        console.error('[payment] Lỗi ghi Firebase:', err);
        alert('Thanh toán chưa đồng bộ được lên hệ thống. Dữ liệu bàn sẽ được Firebase khôi phục nếu ghi thất bại.');
    });
}

async function doReset() {
    if (prompt("Mật khẩu xóa dữ liệu:") === "123") {
        try {
            await update(dbRef, { orders: null, locked: null, times: null });
            location.reload();
        } catch (err) {
            console.error('[reset] Lỗi xóa dữ liệu:', err);
            alert('Không thể xóa dữ liệu. Vui lòng thử lại.');
        }
    }
}

// RIPPLE
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-action'); if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    const size = Math.max(rect.width, rect.height) * 1.2;
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
});

// ─── SINGLE-SHEET ORIGAMI INTRO V7 ────────────────────────────────────
const SINGLE_FOLD_DURATION = 420;
const singleFoldAnimations = [];
const singleFoldTimers = [];
const singleFoldTargets = new Set();

function paperFlipLater(fn, delay) {
    const id = setTimeout(fn, delay);
    singleFoldTimers.push(id);
    return id;
}

function getSingleFoldSpec(variant = 0) {
    switch (variant % 4) {
        case 0:
            return {
                origin: 'left center',
                start: 'perspective(850px) translate3d(-16px,0,0) rotateY(84deg) scale(.96)',
                mid:   'perspective(850px) translate3d(0,0,0) rotateY(-5deg) scale(1.01)'
            };
        case 1:
            return {
                origin: 'right center',
                start: 'perspective(850px) translate3d(16px,0,0) rotateY(-84deg) scale(.96)',
                mid:   'perspective(850px) translate3d(0,0,0) rotateY(5deg) scale(1.01)'
            };
        case 2:
            return {
                origin: 'center top',
                start: 'perspective(850px) translate3d(0,-13px,0) rotateX(-80deg) scale(.97)',
                mid:   'perspective(850px) translate3d(0,0,0) rotateX(4deg) scale(1.01)'
            };
        default:
            return {
                origin: 'center bottom',
                start: 'perspective(850px) translate3d(0,13px,0) rotateX(80deg) scale(.97)',
                mid:   'perspective(850px) translate3d(0,0,0) rotateX(-4deg) scale(1.01)'
            };
    }
}

function spawnPaperWisp(target, variant = 0) {
    const overlay = document.getElementById('paper-flip-overlay');
    if (!overlay || !target?.isConnected) return;

    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const wisp = document.createElement('span');
    wisp.className = 'single-paper-wisp';
    const side = variant % 4;
    const x = side === 0 ? rect.left - 7 : side === 1 ? rect.right - 5 : rect.left + rect.width * .72;
    const y = side === 2 ? rect.top - 7 : side === 3 ? rect.bottom - 6 : rect.top + rect.height * .22;
    wisp.style.left = `${x}px`;
    wisp.style.top = `${y}px`;
    overlay.appendChild(wisp);

    const dx = side === 0 ? -22 : side === 1 ? 22 : (variant % 2 ? 14 : -14);
    const dy = side === 2 ? -18 : side === 3 ? 18 : -10;
    const rz = side % 2 ? 38 : -42;

    const anim = wisp.animate([
        { opacity: 0, transform: `translate3d(${-dx * .6}px,${-dy * .6}px,0) rotate(${rz * -.5}deg) scale(.65)` },
        { opacity: .9, transform: 'translate3d(0,0,0) rotate(0deg) scale(1)', offset: .45 },
        { opacity: 0, transform: `translate3d(${dx}px,${dy}px,0) rotate(${rz}deg) scale(.82)` }
    ], {
        duration: 390,
        easing: 'cubic-bezier(.2,.72,.22,1)',
        fill: 'forwards'
    });
    singleFoldAnimations.push(anim);
    anim.onfinish = () => wisp.remove();
}

function animateSingleSheet(target, delay = 0, variant = 0, withWisp = false) {
    if (!target) return;
    singleFoldTargets.add(target);

    paperFlipLater(() => {
        if (!target.isConnected) return;
        const spec = getSingleFoldSpec(variant);

        target.style.setProperty('visibility', 'visible', 'important');
        target.style.transformOrigin = spec.origin;
        target.classList.add('single-fold-active');

        if (withWisp) spawnPaperWisp(target, variant);

        const anim = target.animate([
            { opacity: 0, transform: spec.start },
            { opacity: .42, transform: spec.start, offset: .10 },
            { opacity: 1, transform: spec.mid, offset: .78 },
            { opacity: 1, transform: 'perspective(850px) translate3d(0,0,0) rotateX(0deg) rotateY(0deg) scale(1)' }
        ], {
            duration: SINGLE_FOLD_DURATION,
            easing: 'cubic-bezier(.18,.78,.18,1)',
            fill: 'forwards'
        });
        singleFoldAnimations.push(anim);

        anim.onfinish = () => {
            if (!target.isConnected) return;
            target.style.setProperty('opacity', '1', 'important');
            target.style.setProperty('visibility', 'visible', 'important');
            target.classList.remove('single-fold-active');
            target.style.removeProperty('transform-origin');
            try { anim.cancel(); } catch (e) {}
        };
    }, delay);
}

function finishPaperFlipIntro() {
    document.documentElement.classList.remove('paper-flip-pending');
    clearTimeout(window.__paperFlipFailsafe);

    for (const timer of singleFoldTimers) clearTimeout(timer);
    singleFoldTimers.length = 0;

    for (const anim of singleFoldAnimations) {
        try { anim.cancel(); } catch (e) {}
    }
    singleFoldAnimations.length = 0;

    for (const target of singleFoldTargets) {
        target.classList.remove('single-fold-active');
        target.style.removeProperty('visibility');
        target.style.removeProperty('opacity');
        target.style.removeProperty('transform-origin');
    }
    singleFoldTargets.clear();
    document.getElementById('paper-flip-overlay')?.replaceChildren();
}

function runPaperFlipIntro() {
    if (!document.documentElement.classList.contains('paper-flip-pending')) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        finishPaperFlipIntro();
        return;
    }

    clearTimeout(window.__paperFlipFailsafe);
    window.__paperFlipFailsafe = setTimeout(finishPaperFlipIntro, 2600);

    const $ = sel => document.querySelector(sel);

    animateSingleSheet($('.header-title'),       0,    2, true);
    animateSingleSheet($('#weather-hub'),        110,  0, true);
    animateSingleSheet($('#presence-count'),     215,  1, false);
    animateSingleSheet($('#dark-toggle'),        305,  2, false);
    animateSingleSheet($('#crowd-status'),       400,  1, true);
    animateSingleSheet($('#load-speed-widget'),  505,  3, false);
    animateSingleSheet($('#net-speed-widget'),   605,  0, false);
    animateSingleSheet($('#btc-ticker'),         710,  1, true);

    document.querySelectorAll('.flip-clock-container > .flip-unit, .flip-clock-container > .flip-colon')
        .forEach((el, i) => animateSingleSheet(el, 820 + i * 58, 2 + i, false));

    animateSingleSheet($('#oil-ticker'),         1180, 3, true);

    paperFlipLater(finishPaperFlipIntro, 1720);
}

requestAnimationFrame(runPaperFlipIntro);

// DARK MODE
function applyDarkMode(isDark) {
    document.body.classList.toggle('dark-mode', isDark);
    const btn = document.getElementById('dark-toggle');
    if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}
function toggleDarkMode() {
    triggerHaptic('nav');
    const isDark = !document.body.classList.contains('dark-mode');
    applyDarkMode(isDark);
    try { localStorage.setItem('combetram_dark_mode', isDark ? 'on' : 'off'); } catch (e) {}
}
function initDarkMode() {
    let saved = null;
    try { saved = localStorage.getItem('combetram_dark_mode'); } catch (e) {}
    if (saved === 'on') { applyDarkMode(true); return; }
    if (saved === 'off') { applyDarkMode(false); return; }
    applyDarkMode(false);
}
initDarkMode();

function scrollToCheckout() {
    triggerHaptic('nav');
    document.getElementById('btn-checkout')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// THỜI GIAN MỞ TRANG
function reportLoadSpeed() {
    const el = document.getElementById('load-speed-val');
    if (!el) return;
    try {
        const nav = performance.getEntriesByType('navigation')[0];
        const ms = nav ? Math.round(nav.duration) : Math.round(performance.now());
        el.textContent = `${ms} ms`;
    } catch (e) {
        el.textContent = `${Math.round(performance.now())} ms`;
    }
}
if (document.readyState === 'complete') {
    reportLoadSpeed();
} else {
    window.addEventListener('load', () => setTimeout(reportLoadSpeed, 0));
}

updateNetWidget();

window.selectTable = selectTable; window.setLock = setLock; window.doPay = doPay; window.doReset = doReset; window.changeBillLang = changeBillLang; window.toggleDarkMode = toggleDarkMode; window.scrollToCheckout = scrollToCheckout; window.toggleBillQr = toggleBillQr;
