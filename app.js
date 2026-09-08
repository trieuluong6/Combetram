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

// ─── ƯỚC TÍNH PAYLOAD JSON ĐẨY LÊN/XUỐNG FIREBASE (không gồm overhead WebSocket) ───
let fbDownBytes = 0, fbUpBytes = 0;
function formatBytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(2)}MB`;
}
function byteSizeOf(data) {
    try { return new Blob([JSON.stringify(data)]).size; } catch (e) { return 0; }
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
    if (downEl) downEl.innerText = `↓${formatBytes(fbDownBytes)}`;
    if (upEl) upEl.innerText = `↑${formatBytes(fbUpBytes)}`;
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
// localPaymentEchoTables giúp snapshot xóa bill của chính máy này không bị hiểu là thay đổi remote.
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
    // Khi mặt QR đang mở, không cho các auto-scroll cũ của bill giành quyền cuộn.
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

        // Cùng một frame: card bắt đầu lật, wrapper co về QR và trang kéo QR vào giữa.
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

// ─── FIX #2: Menu lookup Map O(1) thay vì find() O(n) trong mỗi vòng lặp ───
const ALL_ITEMS = menu.flatMap(g => g.items);
const ITEM_MAP = new Map(ALL_ITEMS.map(i => [i.id, i]));
// Nước uống + bia được gom thành một nhóm để hiển thị nhanh trên card bàn.
const DRINK_ITEM_IDS = new Set(
    menu.filter(group => /NƯỚC|BEER/i.test(group.cat)).flatMap(group => group.items.map(item => item.id))
);

// Listener dữ liệu chính được tách theo nhánh để tránh tải lại locked/times khi chỉ orders đổi.
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

// Tổng tiền cache theo bàn để chỉ tính lại bàn vừa thay đổi.
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
        const updateCurrentOrder = scheduledCurrentOrderRefresh;
        scheduledFullRefresh = false;
        scheduledCurrentOrderRefresh = false;
        dirtyTables.clear();
        refresh(ids, updateCurrentOrder);
    });
}

// ─── FIX #9: Lazy-load dict theo ngôn ngữ ───
let dictCache = { vi: { flag: "🇻🇳", total: "TỔNG", items: {} } };
let dictLoadPromise = null;

async function getLangData(lang) {
    if (dictCache[lang]) return dictCache[lang];
    if (!dictLoadPromise) {
        dictLoadPromise = import('./dict.js').then(m => {
            dictCache = m.dict;
        }).catch(() => {});
    }
    await dictLoadPromise;
    return dictCache[lang] || dictCache['vi'];
}

// CACHE THỜI TIẾT
let weatherCache = { status: 'cloudy', temp: 31, windSpeed: 14.0, windDir: 135 };

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
    document.getElementById('w-icon-container').innerHTML = SVG_ICONS[finalStatus] || SVG_ICONS.sunny;
    document.getElementById('w-temp').innerText = `${temp.toFixed(1)}°C`;
    const hub = document.getElementById('weather-hub');
    let windIcon = SVG_ICONS.windNone;
    hub.className = '';
    if (windSpeed > 5 && windSpeed <= 19) { windIcon = SVG_ICONS.windSlow; }
    else if (windSpeed >= 20 && windSpeed <= 39) { windIcon = SVG_ICONS.windFast; hub.classList.add('wind-warning'); }
    else if (windSpeed >= 40) { windIcon = SVG_ICONS.windStorm; hub.classList.add('wind-danger'); }
    document.getElementById('w-wind-icon-container').innerHTML = windIcon;
    document.getElementById('w-wind-speed').innerText = `${windSpeed.toFixed(1)} km/h`;
    document.getElementById('w-arrow').style.transform = `rotate(${windDir}deg)`;
}

async function fetchRealtimeWeather() {
    try {
        const lat = 16.0544, lon = 108.2022;
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m`);
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
    const tempOffset = (Math.random() - 0.5) * 0.4;
    const windSpeedOffset = (Math.random() - 0.5) * 0.6;
    const windDirOffset = Math.floor((Math.random() - 0.5) * 4);
    renderWeather(weatherCache.status, Math.max(10, Math.min(45, weatherCache.temp + tempOffset)), Math.max(0, Math.min(120, weatherCache.windSpeed + windSpeedOffset)), (weatherCache.windDir + windDirOffset + 360) % 360);
}

fetchRealtimeWeather();
setInterval(fetchRealtimeWeather, 600000);
setInterval(simulateWeatherFluctuation, 5000);

// TICKER BTC & DẦU — card tài chính mềm: giá + % thay đổi + sparkline session.
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
    // Coinbase stats cho cả giá cuối và open 24h; CoinGecko là fallback.
    const sources = [
        async () => {
            const res = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/stats', { cache: 'no-store' });
            if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
            const d = await res.json();
            const price = Number(d?.last), open = Number(d?.open);
            return { price, changePct: Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : null };
        },
        async () => {
            const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', { cache: 'no-store' });
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
            const res = await fetch('https://americasoilwatch.com/api/v1/wti', { cache: 'no-store' });
            if (!res.ok) throw new Error(`AmericasOilWatch HTTP ${res.status}`);
            const d = await res.json();
            return { price: Number(d?.priceUsd), changePct: Number(d?.changePct) };
        },
        ...['https://api.allorigins.win/raw?url=', 'https://corsproxy.io/?url='].map(proxy => async () => {
            const targetUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F';
            const res = await fetch(proxy + encodeURIComponent(targetUrl), { cache: 'no-store' });
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

// Ticker vẫn dao động local 800ms như bản cũ cho vui mắt; sparkline chỉ lấy mẫu ~3.2s/lần.
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
document.addEventListener('visibilitychange', () => {
    document.hidden ? stopTickerInterval() : startTickerInterval();
});
startTickerInterval();

// ĐỒNG HỒ LẬT
function updateCardValue(cardId, targetVal) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const topHalf = card.querySelector('.card-top');
    const bottomHalf = card.querySelector('.card-bottom');
    const wing = card.querySelector('.card-flip-wing');
    const wingBack = card.querySelector('.card-flip-wing-back');
    if (topHalf.innerText === targetVal) return;
    wing.innerText = topHalf.innerText;
    wingBack.innerText = targetVal;
    card.classList.add('animate');
    setTimeout(() => { topHalf.innerText = targetVal; }, 160);
    setTimeout(() => { bottomHalf.innerText = targetVal; wing.innerText = targetVal; card.classList.remove('animate'); }, 340);
}

function runClock() {
    const d = new Date();
    const hStr = String(d.getHours()).padStart(2, '0');
    const mStr = String(d.getMinutes()).padStart(2, '0');
    const sStr = String(d.getSeconds()).padStart(2, '0');
    updateCardValue('c-h1', hStr[0]); updateCardValue('c-h2', hStr[1]);
    updateCardValue('c-m1', mStr[0]); updateCardValue('c-m2', mStr[1]);
    updateCardValue('c-s1', sStr[0]); updateCardValue('c-s2', sStr[1]);
}

const currentInit = new Date();
const ih = String(currentInit.getHours()).padStart(2, '0'), im = String(currentInit.getMinutes()).padStart(2, '0'), is = String(currentInit.getSeconds()).padStart(2, '0');
['h1','h2','m1','m2','s1','s2'].forEach((k, idx) => {
    let v = (idx < 2) ? ih[idx] : (idx < 4 ? im[idx-2] : is[idx-4]);
    const c = document.getElementById('c-' + k);
    if(c) c.querySelectorAll('.card-half, .card-flip-wing, .card-flip-wing-back').forEach(el => el.innerText = v);
});
setInterval(runClock, 1000);

// HAPTIC
function triggerHaptic(type) {
    if (window.navigator && window.navigator.vibrate) window.navigator.vibrate([18, 25, 18]);
}

// ─── FIX #5: animateNumber với cancel flag để tránh race condition ───
const animatingFlags = {};
function animateNumber(elementId, newValue) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const startValue = parseInt(el.innerText.replace(/\D/g, '')) || 0;
    if (startValue === newValue) return;
    const diff = newValue - startValue;
    const duration = 750, startTime = performance.now();
    const token = Symbol();
    animatingFlags[elementId] = token;

    function easeCountMoney(t) {
        if (t < 0.7) { const p = t / 0.7; return (1 - Math.pow(1 - p, 3)) * 0.92; }
        const p = (t - 0.7) / 0.3;
        return 0.92 + (1 - Math.pow(1 - p, 2)) * 0.08;
    }
    function update(currentTime) {
        if (animatingFlags[elementId] !== token) return; // bị cancel
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = easeCountMoney(progress);
        let val = startValue + diff * eased;
        if (progress > 0.85) { const step = 1000; val = Math.round(val / step) * step; }
        val = Math.round(val);
        val = diff >= 0 ? Math.min(val, newValue) : Math.max(val, newValue);
        el.innerText = val.toLocaleString();
        if (progress < 1) requestAnimationFrame(update);
        else { el.innerText = newValue.toLocaleString(); delete animatingFlags[elementId]; }
    }
    requestAnimationFrame(update);
}

// PRESENCE
// ─── FIX #12: Tách presence/cursors/focus ra khỏi cây combetram_v6_data ───
// Trước đây 3 node này nằm chung cây với orders/locked/times, nên onValue(dbRef)
// (listener đơn hàng) bị refire MỖI LẦN có người di chuột (broadcast cursor 200ms/lần),
// kéo theo JSON.stringify(orders) deep-compare + refresh() toàn bộ dù đơn hàng không đổi.
// Giải pháp: đặt presence/cursors/focus ở path riêng (combetram_v6_rt), tách biệt hoàn toàn
// khỏi path dữ liệu đơn hàng (combetram_v6_data) — listener đơn hàng giờ chỉ fire khi
// orders/locked/times thật sự thay đổi.
const RT_ROOT = 'combetram_v6_rt';
const USER_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#d81b60', '#6d4c41', '#3949ab', '#c0ca33'];
const myColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
const onlineRef = ref(database, '.info/connected');
const presenceListRef = ref(database, `${RT_ROOT}/presence`);
const myPresenceRef = push(presenceListRef);
const myPresenceId = myPresenceRef.key;
const cursorsRef = ref(database, `${RT_ROOT}/cursors`);
const myCursorRef = child(cursorsRef, myPresenceId);
const focusRef = ref(database, `${RT_ROOT}/focus`);
const myFocusRef = child(focusRef, myPresenceId);

// ─── FIX #12: Listener riêng cho số người online, không còn ăn ké listener đơn hàng ───
onValue(presenceListRef, (snap) => {
    const presenceCount = Object.keys(snap.val() || {}).length;
    const el = document.getElementById('online-val');
    if (el) el.innerText = presenceCount || 1;
});

onValue(onlineRef, (snap) => {
    if (snap.val() === true) {
        onDisconnect(myPresenceRef).remove().catch(() => {});
        onDisconnect(myCursorRef).remove().catch(() => {});
        onDisconnect(myFocusRef).remove().catch(() => {});
        set(myPresenceRef, { color: myColor, ts: Date.now() })
            .then(() => console.log('[presence] ghi presence thành công'))
            .catch(e => console.error('[presence] LỖI GHI PRESENCE:', e.message));
        console.log('[presence] đã kết nối, id =', myPresenceId, 'color =', myColor);
    } else {
        console.log('[presence] mất kết nối tới Firebase');
    }
});

// ─── FIX #10: Object pool cho cursor trail ───
const TRAIL_POOL_SIZE = 20;
const trailPool = [];
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
    trail.style.left = x + 'px';
    trail.style.top = y + 'px';
    trail.style.background = color || '#999';
    trail.style.display = '';
    trail.style.animation = 'none';
    void trail.offsetWidth; // reflow để restart animation
    trail.style.animation = '';
    setTimeout(() => { trail.style.display = 'none'; }, 500);
}

// CURSOR ĐỒNG NGHIỆP
const remoteCursorEls = {};
const lastCursorPos = {};

function positionCursorOnTable(id, el, tableNum, offsetIndex, color) {
    const card = TABLE_DOM[Number(tableNum) - 1]?.card;
    if (!card) { el.classList.remove('visible'); return; }
    const rect = card.getBoundingClientRect();
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
    const entries = Object.entries(snapVal || {}).filter(([id, c]) => id !== myPresenceId && c && c.table);
    Object.keys(remoteCursorEls).forEach(id => {
        if (!entries.find(([eid]) => eid === id)) { remoteCursorEls[id].remove(); delete remoteCursorEls[id]; delete lastCursorPos[id]; }
    });
    const countPerTable = {}, tableViewerColor = {};
    entries.forEach(([id, c]) => {
        const idx = countPerTable[c.table] || 0;
        countPerTable[c.table] = idx + 1;
        if (!tableViewerColor[c.table]) tableViewerColor[c.table] = c.color || '#999';
        let el = remoteCursorEls[id];
        if (!el) { el = document.createElement('div'); el.className = 'remote-cursor'; document.body.appendChild(el); remoteCursorEls[id] = el; }
        el.style.background = c.color || '#999';
        positionCursorOnTable(id, el, c.table, idx, c.color);
    });
    for (let t = 1; t <= 9; t++) {
        const card = TABLE_DOM[t - 1]?.card;
        if (!card) continue;
        if (tableViewerColor[t]) { card.classList.add('has-viewer'); card.style.setProperty('--viewer-color', tableViewerColor[t]); }
        else { card.classList.remove('has-viewer'); card.style.removeProperty('--viewer-color'); }
    }
}

let lastCursorSnap = null;
onValue(cursorsRef, (snap) => { lastCursorSnap = snap.val(); renderRemoteCursors(lastCursorSnap); });

let cursorRenderTicking = false;
function scheduleRenderRemoteCursors() {
    if (cursorRenderTicking) return;
    cursorRenderTicking = true;
    requestAnimationFrame(() => { renderRemoteCursors(lastCursorSnap); cursorRenderTicking = false; });
}
window.addEventListener('resize', scheduleRenderRemoteCursors);
window.addEventListener('scroll', scheduleRenderRemoteCursors, { passive: true });

// ─── FIX #7: Throttle cursor broadcast 200ms ───
let lastCursorBroadcastTs = 0;
function broadcastCursor(tableNum) {
    const now = Date.now();
    if (tableNum && now - lastCursorBroadcastTs < 200) return;
    lastCursorBroadcastTs = now;
    if (tableNum) set(myCursorRef, { table: tableNum, color: myColor, ts: now }).catch(() => {});
    else remove(myCursorRef).catch(() => {});
    broadcastFocus(null);
}

// CLICK-TO-FOCUS
let lastFocusBroadcast = 0, focusClearTimer = null;
function broadcastFocus(itemId) {
    if (itemId === null) { clearTimeout(focusClearTimer); remove(myFocusRef).catch(() => {}); return; }
    const now = Date.now();
    if (now - lastFocusBroadcast > 120) {
        lastFocusBroadcast = now;
        set(myFocusRef, { table: currentTab, itemId, color: myColor, ts: now }).catch(() => {});
    }
    clearTimeout(focusClearTimer);
    focusClearTimer = setTimeout(() => remove(myFocusRef).catch(() => {}), 1500);
}

const remoteFocusRows = {};
function renderRemoteFocus(snapVal) {
    const entries = Object.entries(snapVal || {}).filter(([id, f]) => id !== myPresenceId && f);
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
        if (!tag) { tag = document.createElement('span'); tag.className = 'remote-focus-tag'; tag.innerText = '✏️'; row.appendChild(tag); requestAnimationFrame(() => tag.classList.add('visible')); }
        tag.style.background = f.color || '#999';
        remoteFocusRows[id] = { rowEl: row, tagEl: tag };
    });
}

let lastFocusSnap = null;
onValue(focusRef, (snap) => { lastFocusSnap = snap.val(); renderRemoteFocus(lastFocusSnap); });

// MENU — FIX #6: dùng array join thay concatenation
function renderMenu() {
    const parts = [];
    menu.forEach(g => {
        parts.push(`<div class="category-title">${g.cat}</div>`);
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
    document.getElementById('menu-list').innerHTML = parts.join('');
}
renderMenu();
ALL_ITEMS.forEach(item => {
    ITEM_DOM.set(item.id, {
        row: document.getElementById(`row-${item.id}`),
        qty: document.getElementById(`q-${item.id}`)
    });
});

// Không tải audio ở initial load; bắt đầu preload sau tương tác đầu tiên để tiếng báo vẫn phản hồi nhanh.
document.addEventListener('pointerdown', () => {
    const ting = document.getElementById('tingSound');
    if (ting) { ting.preload = 'auto'; ting.load(); }
}, { once: true, passive: true });

document.getElementById('menu-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-qty'); if (!btn) return;
    const itemId = parseInt(btn.dataset.itemId);
    change(itemId, btn.classList.contains('btn-add') ? 1 : -1);
});

// Dữ liệu chính: tách listener theo nhánh + chỉ đánh dấu các bàn thực sự thay đổi.
// pendingUpdates đặt trước listener để phân biệt echo local với thay đổi remote.
const pendingUpdates = {};
let firstOrdersLoad = true;
const initialBranchesLoaded = new Set();
let initialDataReady = false;

// Flash thay đổi từ thiết bị khác. Queue tới sau refresh để renderCurrentOrder/renderTable
// không ghi đè class flash vừa thêm. Echo của chính thiết bị này được bỏ qua nếu
// snapshot Firebase đúng bằng optimistic quantity đang chờ ghi.
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

            // update() của chính máy này cũng phát onValue local. Nếu snapshot đã đúng
            // với quantity optimistic đang pending thì local UI đã flash rồi, không flash lần 2.
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
        // Không coi snapshot xóa bill của chính lần thanh toán trên máy này là remote remove.
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
    if (initialDataReady && changed.size) cleanupStaleTimes(changed);
    if (changed.size) scheduleRefresh(changed, true);
    markInitialBranchLoaded('orders');
});

onValue(lockedRef, snap => {
    const nextLocked = snap.val() || {};
    const changed = changedTableIds(data.locked, nextLocked);
    data.locked = nextLocked;
    if (changed.size) scheduleRefresh(changed, true);
    markInitialBranchLoaded('locked');
});

onValue(timesRef, snap => {
    const nextTimes = snap.val() || {};
    const changed = changedTableIds(data.times, nextTimes);
    data.times = nextTimes;
    if (changed.size) scheduleRefresh(changed);
    markInitialBranchLoaded('times');
});

function selectTable(n, options = {}) {
    if (paymentInProgress && !options.allowDuringPayment) return;
    if (options.haptic !== false) triggerHaptic('nav');
    resetBillQrView(true);
    const previousTab = currentTab;
    const wasOpenForSameTable = (currentTab === n);
    currentTab = wasOpenForSameTable ? null : n; currentBillLang = 'vi';
    billWasShown = false;
    broadcastCursor(currentTab);
    renderRemoteFocus(lastFocusSnap);
    const section = document.getElementById('order-section');
    if (currentTab) {
        let title = "BÀN " + n;
        if (n === 7) title = "BÀN TRONG HIÊN"; if (n === 8) title = "NGOÀI ĐƯỜNG (TRÁI)"; if (n === 9) title = "NGOÀI ĐƯỜNG (PHẢI)";
        document.getElementById('table-title').innerText = title;
        section.style.display = 'block';
        requestAnimationFrame(() => requestAnimationFrame(() => section.classList.add('section-visible')));
        refresh(new Set([previousTab, currentTab].filter(Boolean)));
        const isLockedTable = (data.locked && data.locked[n]) || false;
        if (isLockedTable) setTimeout(scrollBillIntoView, 350);
    } else {
        section.classList.remove('section-visible');
        document.getElementById('scroll-to-checkout')?.classList.add('hidden');
        if (options.instantClose) {
            // Thanh toán cần phản hồi tức thì: bỏ riêng transition đóng 320ms.
            section.style.display = 'none';
        } else {
            setTimeout(() => { if (!currentTab) section.style.display = 'none'; }, 320);
        }
        refresh(new Set([previousTab].filter(Boolean)));
    }
}

// ─── FIX #1: Debounce Firebase write 250ms ───
const debounceTimers = {};
const debounceVersions = {};
const pendingStartTimes = new Set();

// Mỗi ô số chỉ có tối đa 1 animation đang chạy. Bấm mới sẽ hủy animation cũ,
// tránh nhiều requestAnimationFrame/class bump chồng lên nhau khi multi-touch.
const qtyBumpAnimations = new WeakMap();
function playQtyBump(el) {
    if (!el) return;
    const previous = qtyBumpAnimations.get(el);
    if (previous) previous.cancel();

    // Web Animations API tách animation của từng số và không cần ép reflow.
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

    const tab = currentTab; // capture bàn ngay lúc bấm, không đọc currentTab sau 250ms
    const order = data.orders[tab] || {};
    const currentQty = (pendingUpdates[tab]?.[id] ?? order[id]) || 0;
    if (delta < 0 && currentQty <= 0) return;

    // Cập nhật UI ngay lập tức (optimistic update)
    const newQty = Math.max(0, currentQty + delta);
    if (!pendingUpdates[tab]) pendingUpdates[tab] = {};
    pendingUpdates[tab][id] = newQty;

    const itemDom = ITEM_DOM.get(id);
    const qSpan = itemDom?.qty;
    const row = itemDom?.row;
    if (qSpan) {
        qSpan.innerText = newQty;
        applyMenuRowQtyClasses(row, newQty);
        playQtyBump(qSpan);
    }
    flashRow(id, delta);

    // Debounce ghi Firebase
    const key = `${tab}_${id}`;
    const version = (debounceVersions[key] || 0) + 1;
    debounceVersions[key] = version;
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(() => {
        // Nếu timer này đã bị một lần bấm mới hơn thay thế thì bỏ qua hoàn toàn.
        if (debounceVersions[key] !== version) return;
        const finalQty = pendingUpdates[tab]?.[id];
        if (finalQty === undefined) {
            if (debounceVersions[key] === version) {
                delete debounceTimers[key];
                delete debounceVersions[key];
            }
            return;
        }
        if (!data.times?.[tab] && !pendingStartTimes.has(tab) && finalQty > 0) {
            pendingStartTimes.add(tab);
            set(child(timesRef, String(tab)), Date.now())
                .catch(err => console.error('[times] Lỗi ghi mốc giờ Firebase:', err))
                .finally(() => pendingStartTimes.delete(tab));
        }
        const sentQty = finalQty;
        // Qty = 0 thì xóa key khỏi RTDB, tránh tích tụ các node 0 theo thời gian.
        update(child(ordersRef, String(tab)), { [id]: sentQty > 0 ? sentQty : null })
            .then(() => {
                // Chỉ xóa pending khi request này vẫn là lần bấm mới nhất của món/bàn đó.
                if (debounceVersions[key] === version && pendingUpdates[tab]?.[id] === sentQty) {
                    delete pendingUpdates[tab][id];
                    if (Object.keys(pendingUpdates[tab]).length === 0) delete pendingUpdates[tab];
                }
                // Nếu bàn đã thật sự không còn món, xóa mốc giờ. Nếu nhân viên vừa thêm
                // món khác trong lúc request đang chạy, effectiveTableHasItems() sẽ giữ lại giờ.
                queueMicrotask(() => {
                    if (!effectiveTableHasItems(tab)) remove(child(timesRef, String(tab))).catch(() => {});
                });
            })
            .catch(err => console.error('[orders] Lỗi ghi Firebase:', err))
            .finally(() => {
                // Request cũ không được xóa timer/version của lần bấm mới hơn.
                if (debounceVersions[key] === version) {
                    delete debounceTimers[key];
                    delete debounceVersions[key];
                }
            });
    }, 250);
}

function flashRow(id, delta) {
    const itemDom = ITEM_DOM.get(id), row = itemDom?.row, tabBtn = currentTab ? TABLE_DOM[currentTab - 1]?.card : null, qSpan = itemDom?.qty, cls = delta > 0 ? 'flash-add' : 'flash-sub';
    if (row) row.classList.add(cls); if (tabBtn) tabBtn.classList.add(cls);
    setTimeout(() => { if (row) row.classList.remove(cls); if (tabBtn) tabBtn.classList.remove(cls); }, 400);
}

function changeBillLang(l) { if (paymentInProgress) return; triggerHaptic('nav'); currentBillLang = l; renderCurrentOrder(); scrollBillIntoView(); }

// ─── FIX #3: Bỏ setInterval(refresh, 30000) — Firebase onValue() đã đủ ───
// ─── FIX #2: Dùng ITEM_MAP O(1) thay vì all.find() O(n) ───
function calculateTableStats(tableId) {
    let total = 0, foodQty = 0, drinkQty = 0;
    const order = data.orders[tableId] || {};
    for (const id in order) {
        const itemId = Number(id);
        const item = ITEM_MAP.get(itemId);
        const qty = Math.max(0, Number(order[id]) || 0);
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
        billArea.classList.remove('printing-out');
        requestAnimationFrame(() => requestAnimationFrame(() => billArea.classList.add('printing-out')));
        billWasShown = true;
    } else if (!isLock) {
        billWasShown = false;
        billArea.classList.remove('printing-out');
        if (billViewMode !== 'bill') resetBillQrView(true);
    }
    document.getElementById('scroll-to-checkout')?.classList.toggle('hidden', isLock);

    ALL_ITEMS.forEach(item => {
        // Nếu món đang chờ debounce của bàn hiện tại, giữ optimistic UI thay vì ghi đè bằng snapshot cũ.
        const q = Math.max(0, pendingUpdates[currentTab]?.[item.id] ?? data.orders[currentTab]?.[item.id] ?? 0);
        const itemDom = ITEM_DOM.get(item.id);
        const row = itemDom?.row, qSpan = itemDom?.qty;
        if (row && qSpan && qSpan.innerText !== String(q)) {
            qSpan.innerText = q;
            applyMenuRowQtyClasses(row, q);
        }
    });

    if (isLock) renderBillAsync(currentTab);
}

function renderTableTime(tableId, now = Date.now()) {
    const dom = TABLE_DOM[tableId - 1];
    if (!dom?.time) return;
    dom.time.classList.remove('skeleton');
    let txt = '';
    if (tableTotals[tableId] > 0 && data.times?.[tableId]) {
        const diff = Math.floor((now - data.times[tableId]) / 60000);
        txt = diff > 0 ? `⏱ ${diff} phút` : '⏱ Mới vào';
    }
    if (dom.time.innerText !== txt) dom.time.innerText = txt;
}

function renderTable(tableId, now = Date.now()) {
    const dom = TABLE_DOM[tableId - 1];
    if (!dom) return;
    const { total, foodQty, drinkQty } = calculateTableStats(tableId);
    tableTotals[tableId] = total;
    const locked = !!data.locked?.[tableId];

    if (dom.sum) {
        dom.sum.classList.remove('skeleton');
        if (parseInt(dom.sum.innerText.replace(/\D/g, '')) !== total) animateNumber(`sum-${tableId}`, total);
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
        if (locked) className += tableId >= 7 ? ' is-locked-special' : ' is-locked';
        else if (total > 0) className += ' has-guest';
        if (dom.card.className !== className) {
            dom.card.className = className;
            if (preserveViewer) dom.card.classList.add('has-viewer');
            if (preserveFlashAdd) dom.card.classList.add('flash-add');
            if (preserveFlashSub) dom.card.classList.add('flash-sub');
        }
    }
}

// Thời gian trôi qua không tạo Firebase event. Chỉ cập nhật 9 text thời gian,
// không render lại bill/menu/toàn app như timer refresh cũ.
setInterval(() => {
    const now = Date.now();
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
            crowdEl.className = 'status-badge status-empty'; crowdTxt.innerText = 'Vắng khách'; crowdIcon.innerText = '🟢';
        } else if (activeTablesCount <= 6) {
            crowdEl.className = 'status-badge status-normal'; crowdTxt.innerText = 'Bình thường'; crowdIcon.innerText = '🟡';
        } else {
            crowdEl.className = 'status-badge status-crowded'; crowdTxt.innerText = 'ĐÔNG KHÁCH'; crowdIcon.innerText = '🚨';
        }
    }
    document.getElementById('reset-area').style.display = anyGuest ? 'none' : 'block';
}

// tableIds = null => render đầy đủ; Set => chỉ render các bàn đã thay đổi.
function refresh(tableIds = null, updateCurrentOrder = true) {
    const ids = tableIds === null ? new Set(Array.from({ length: 9 }, (_, i) => i + 1)) : tableIds;
    const currentAffected = currentTab && (tableIds === null || ids.has(currentTab));
    if (updateCurrentOrder && currentAffected) renderCurrentOrder();
    const now = Date.now();
    for (const id of ids) renderTable(Number(id), now);
    renderCrowdAndReset();
    flushRemoteOrderFlashes();
}

// ─── FIX #9: Async bill render với lazy-load dict ───
async function renderBillAsync(tab) {
    const langData = await getLangData(currentBillLang);
    // Kiểm tra tab vẫn còn active sau khi await
    if (currentTab !== tab) return;

    let h = "", t = 0, my = data.orders[tab] || {};
    document.getElementById('txt-total-label').innerText = langData.total;
    document.getElementById('txt-lang-flag').innerText = langData.flag;
    let idx = 0;
    for (let id in my) {
        const itm = ITEM_MAP.get(Number(id)); // FIX #11
        if (itm && my[id] > 0) {
            let p = itm.price * my[id]; t += p;
            let nameShow = (currentBillLang !== 'vi' && langData.items && langData.items[itm.name]) ? langData.items[itm.name] : itm.name;
            h += `<div class="bill-row" style="animation-delay: ${idx * 0.08}s">
                    <span class="item-name">${nameShow}</span>
                    <span class="item-qty">x${my[id]}</span>
                    <div class="divider"></div>
                    <span class="item-price">${p.toLocaleString()}đ</span>
                  </div>`; idx++;
        }
    }
    document.getElementById('bill-list').innerHTML = h || "Trống";
    const bTotal = document.getElementById('bill-total'), tBox = document.getElementById('total-container');
    if (parseInt(bTotal.innerText.replace(/\D/g, '')) !== t) { animateNumber('bill-total', t); tBox.classList.add('total-pop'); setTimeout(() => tBox.classList.remove('total-pop'), 400); }
    requestAnimationFrame(() => syncBillFlipHeight(false));
}

function setLock(v) {
    if (!currentTab || paymentInProgress) return;
    triggerHaptic(v ? 'lock' : 'nav');
    if (v) resetBillQrView(true);
    set(child(lockedRef, String(currentTab)), v)
        .catch(err => console.error('[lock] Lỗi ghi trạng thái khóa Firebase:', err));
    if (!v) { currentBillLang = 'vi'; resetBillQrView(true); }
    if (v) setTimeout(scrollBillIntoView, 100);
}

function doPay() {
    if (!currentTab || paymentInProgress) return;
    if (!confirm("Xác nhận thanh toán?")) return;

    const tab = currentTab;
    paymentInProgress = true;
    localPaymentEchoTables.add(tab);
    stopBillScrollAnimation();
    triggerHaptic('success');

    // Atomic multi-path update: xóa cả order/lock/time trong một commit.
    // Không chờ animation hay network trước khi đóng UI, nên cảm giác thanh toán là tức thì.
    const paymentWrite = update(dbRef, {
        [`orders/${tab}`]: null,
        [`locked/${tab}`]: null,
        [`times/${tab}`]: null
    });

    // Optimistic clear để card bàn phản hồi ngay cả trước callback Firebase local.
    if (data.orders) delete data.orders[tab];
    if (data.locked) delete data.locked[tab];
    if (data.times) delete data.times[tab];
    tableTotals[tab] = 0;
    scheduleRefresh(new Set([tab]), true);

    // Đóng khu order ngay; không còn 650ms payment-success delay.
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

// ─── PAPER-SWARM STARTUP INTRO V4 ─────────────────────────────────────
// Progressive reveal: the live module is visible under a body-coloured tiled veil.
// Each incoming paper sheet lands on one veil tile, then folds away from that edge;
// the matching content region is revealed immediately underneath. No whole-card pop.
const PAPER_SWARM_DURATION = 760;
const PAPER_FOLD_DURATION = 185;
const paperFlipAnimations = [];
const paperFlipTimers = [];
const paperRevealTargets = new Set();

function paperFlipLater(fn, delay) {
    const id = setTimeout(fn, delay);
    paperFlipTimers.push(id);
    return id;
}

function getPaperGrid(rect) {
    const cols = Math.max(2, Math.min(6, Math.round(rect.width / 22)));
    const rows = Math.max(2, Math.min(3, Math.round(rect.height / 14)));
    return { cols, rows };
}

function getFoldWave(col, row, cols, rows, variant) {
    // Diagonal / centre-out waves make the reveal visibly follow fold lines.
    switch (variant % 4) {
        case 0: return col + row; // top-left -> bottom-right
        case 1: return (cols - 1 - col) + row; // top-right -> bottom-left
        case 2: return Math.abs(col - (cols - 1) / 2) + Math.abs(row - (rows - 1) / 2); // centre-out
        default: return col + (rows - 1 - row); // bottom-left -> top-right
    }
}

function getFoldAxis(col, row, cols, rows, variant) {
    const mode = (col + row + variant) % 4;
    if (mode === 0) return { origin: 'left center',  transform: 'translate3d(0,0,11px) rotateY(104deg) scale(.985)' };
    if (mode === 1) return { origin: 'right center', transform: 'translate3d(0,0,11px) rotateY(-104deg) scale(.985)' };
    if (mode === 2) return { origin: 'center top',   transform: 'translate3d(0,0,11px) rotateX(-104deg) scale(.985)' };
    return { origin: 'center bottom', transform: 'translate3d(0,0,11px) rotateX(104deg) scale(.985)' };
}

function createPaperSwarm(target, delay = 0, variant = 0, intensity = 1) {
    const overlay = document.getElementById('paper-flip-overlay');
    if (!overlay || !target) return;

    paperFlipLater(() => {
        if (!target.isConnected || !overlay.isConnected) return;
        const rect = target.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        const { cols, rows } = getPaperGrid(rect);
        const tileW = rect.width / cols;
        const tileH = rect.height / rows;
        const total = cols * rows;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const radiusBase = Math.min(138, Math.max(58, 48 + Math.max(rect.width, rect.height) * .38)) * intensity;

        // Build an invisible-looking veil first, then expose the live module underneath.
        // The veil uses body background so there is no blank-card flash before folding starts.
        const veils = [];
        for (let i = 0; i < total; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const veil = document.createElement('span');
            veil.className = 'paper-veil';
            veil.style.left = `${rect.left + col * tileW - .6}px`;
            veil.style.top = `${rect.top + row * tileH - .6}px`;
            veil.style.width = `${tileW + 1.2}px`;
            veil.style.height = `${tileH + 1.2}px`;
            overlay.appendChild(veil);
            veils.push(veil);
        }

        if (target.id === 'crowd-status') target.style.animation = 'none';
        target.classList.add('paper-reveal-live');

        for (let i = 0; i < total; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const tile = document.createElement('span');
            const cool = (i + variant * 2) % 5 === 0 ? ' paper-tile-cool' : '';
            tile.className = `paper-tile${(i + variant) % 2 ? ' paper-tile-alt' : ''}${cool}`;
            tile.style.setProperty('--tile-w', `${Math.max(7, tileW + .8)}px`);
            tile.style.setProperty('--tile-h', `${Math.max(6, tileH + .8)}px`);
            tile.style.left = `${rect.left + col * tileW - .2}px`;
            tile.style.top = `${rect.top + row * tileH - .2}px`;

            const fold = getFoldAxis(col, row, cols, rows, variant);
            tile.style.transformOrigin = fold.origin;
            overlay.appendChild(tile);

            const angle = ((i / total) * Math.PI * 2) + variant * .63 + row * .22;
            const radius = radiusBase * (.78 + ((i * 29 + variant * 17) % 29) / 100);
            const sx = Math.cos(angle) * radius;
            const sy = Math.sin(angle) * radius * .62;
            const z = 28 + ((i * 31 + variant * 13) % 70);
            const rz = ((i * 71 + variant * 27) % 260) - 130;
            const rx = 65 + ((i * 41 + variant * 19) % 95);
            const ry = ((i * 59 + variant * 23) % 180) - 90;

            // The reveal follows a visible diagonal/centre wave instead of all pieces landing together.
            const wave = getFoldWave(col, row, cols, rows, variant);
            const stagger = Math.round(wave * 38 + ((i + variant) % 2) * 7);

            const anim = tile.animate([
                {
                    opacity: 0,
                    transform: `translate3d(${sx}px,${sy}px,${z}px) rotateZ(${rz}deg) rotateX(${rx}deg) rotateY(${ry}deg) scale(.58)`
                },
                {
                    opacity: 1,
                    transform: `translate3d(${sx * .72}px,${sy * .72}px,${z * .72}px) rotateZ(${rz * .78}deg) rotateX(${rx * .75}deg) rotateY(${ry * .75}deg) scale(.72)`,
                    offset: .16
                },
                {
                    opacity: 1,
                    transform: `translate3d(${sx * .30}px,${sy * .30}px,16px) rotateZ(${rz * .33}deg) rotateX(${rx * .38}deg) rotateY(${ry * .38}deg) scale(.90)`,
                    offset: .48
                },
                {
                    opacity: 1,
                    transform: 'translate3d(0,0,1px) rotateZ(0deg) rotateX(0deg) rotateY(0deg) scale(1)',
                    offset: .68
                },
                {
                    opacity: .98,
                    transform: 'translate3d(0,0,3px) rotateZ(0deg) rotateX(0deg) rotateY(0deg) scale(1)',
                    offset: .76
                },
                {
                    opacity: 0,
                    transform: fold.transform,
                    offset: 1
                }
            ], {
                duration: PAPER_SWARM_DURATION,
                delay: stagger,
                easing: 'cubic-bezier(.16,.76,.16,1)',
                fill: 'forwards'
            });
            paperFlipAnimations.push(anim);
            anim.finished.catch(() => {}).finally(() => tile.remove());

            // The body-coloured veil disappears exactly as this paper sheet becomes flat.
            // From that moment onward, the folding sheet itself is the only cover, so the
            // underlying live UI is revealed progressively along the physical fold edge.
            const unveilAt = Math.round(PAPER_SWARM_DURATION * .675) + stagger;
            paperFlipLater(() => {
                const veil = veils[i];
                if (!veil?.isConnected) return;
                const veilAnim = veil.animate([
                    { opacity: 1 },
                    { opacity: 0 }
                ], {
                    duration: 36,
                    easing: 'linear',
                    fill: 'forwards'
                });
                paperFlipAnimations.push(veilAnim);
                veilAnim.finished.catch(() => {}).finally(() => veil.remove());
            }, unveilAt);
        }

        // A couple of loose sheets trail off after the last folds. Decorative only.
        const trailCount = rect.width > 100 ? 2 : 1;
        for (let i = 0; i < trailCount; i++) {
            const trail = document.createElement('span');
            trail.className = 'paper-trail';
            trail.style.setProperty('--trail-w', `${10 + (i % 2) * 3}px`);
            trail.style.setProperty('--trail-h', `${6 + (i % 3)}px`);
            trail.style.left = `${cx - 5}px`;
            trail.style.top = `${cy - 3}px`;
            overlay.appendChild(trail);
            const a = variant * .83 + i * 2.1;
            const ex = Math.cos(a) * (28 + i * 10);
            const ey = Math.sin(a) * (18 + i * 7);
            const trailAnim = trail.animate([
                { opacity: 0, transform: 'translate3d(0,0,12px) rotateX(75deg) rotateZ(0deg) scale(.6)' },
                { opacity: .78, offset: .18 },
                { opacity: .58, transform: `translate3d(${ex}px,${ey}px,2px) rotateX(12deg) rotateZ(${100 + i * 70}deg) scale(.9)`, offset: .62 },
                { opacity: 0, transform: `translate3d(${ex * 1.55}px,${ey * 1.55}px,-9px) rotateX(-40deg) rotateZ(${220 + i * 90}deg) scale(.50)` }
            ], {
                duration: 390,
                delay: 560 + i * 34,
                easing: 'ease-out',
                fill: 'forwards'
            });
            paperFlipAnimations.push(trailAnim);
            trailAnim.finished.catch(() => {}).finally(() => trail.remove());
        }
    }, delay);
}

function animatePaperReveal(target, delay, variant = 0, intensity = 1) {
    if (!target) return;
    paperRevealTargets.add(target);
    createPaperSwarm(target, delay, variant, intensity);
}

function finishPaperFlipIntro() {
    document.documentElement.classList.remove('paper-flip-pending');
    clearTimeout(window.__paperFlipFailsafe);
    for (const timer of paperFlipTimers) clearTimeout(timer);
    paperFlipTimers.length = 0;
    for (const anim of paperFlipAnimations) {
        try { anim.cancel(); } catch (e) {}
    }
    paperFlipAnimations.length = 0;
    for (const target of paperRevealTargets) {
        target.classList.remove('paper-reveal-live');
        if (target.id === 'crowd-status') target.style.removeProperty('animation');
    }
    paperRevealTargets.clear();
    document.getElementById('paper-flip-overlay')?.replaceChildren();
}

function runPaperFlipIntro() {
    if (!document.documentElement.classList.contains('paper-flip-pending')) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        finishPaperFlipIntro();
        return;
    }

    clearTimeout(window.__paperFlipFailsafe);
    window.__paperFlipFailsafe = setTimeout(finishPaperFlipIntro, 3000);
    const $ = sel => document.querySelector(sel);

    // V5: widget-level sequencing.  The old V4 gaps were only 20–40 ms, so on a
    // 30/60 fps phone several modules visually committed in the same frame.
    // Keep the fold animation overlapping, but space the *first unveil* of each
    // module far enough apart that the dashboard is visibly built one piece at a time.
    animatePaperReveal($('.header-title'),       0,    2, 1.08);
    animatePaperReveal($('#weather-hub'),        160,  0, .92);
    animatePaperReveal($('#presence-count'),     285,  1, .86);
    animatePaperReveal($('#dark-toggle'),        400,  2, .76);
    animatePaperReveal($('#crowd-status'),       520,  1, .92);
    animatePaperReveal($('#load-speed-widget'),  645,  3, .82);
    animatePaperReveal($('#net-speed-widget'),   770,  0, .82);
    animatePaperReveal($('#btc-ticker'),         920,  1, .94);

    // Build the clock left-to-right instead of revealing all five clock chunks together.
    document.querySelectorAll('.flip-clock-container > .flip-unit, .flip-clock-container > .flip-colon')
        .forEach((el, i) => animatePaperReveal(el, 1040 + i * 65, 2 + i, .82));

    animatePaperReveal($('#oil-ticker'),         1390, 3, .94);

    // Do not clear the veil globally until the last widget has had time to finish
    // its own fold.  This prevents the old "everything appears at once" fallback.
    paperFlipLater(finishPaperFlipIntro, 2550);
}

// APIs/Firebase/tickers initialize in parallel; the intro is purely visual.
requestAnimationFrame(runPaperFlipIntro);

// DARK MODE
function applyDarkMode(isDark) {
    document.body.classList.toggle('dark-mode', isDark);
    const btn = document.getElementById('dark-toggle');
    if (btn) btn.innerText = isDark ? '☀️' : '🌙';
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

// THỜI GIAN MỞ TRANG (bên trái)
function reportLoadSpeed() {
    const el = document.getElementById('load-speed-val');
    if (!el) return;
    try {
        const nav = performance.getEntriesByType('navigation')[0];
        const ms = nav ? Math.round(nav.duration) : Math.round(performance.now());
        el.innerText = `${ms} ms`;
    } catch (e) {
        el.innerText = `${Math.round(performance.now())} ms`;
    }
}
if (document.readyState === 'complete') {
    reportLoadSpeed();
} else {
    window.addEventListener('load', () => setTimeout(reportLoadSpeed, 0));
}

// PAYLOAD FIREBASE (bên phải) — ước tính JSON nhận/gửi, không phải số byte vật lý trên dây
updateNetWidget();

window.selectTable = selectTable; window.setLock = setLock; window.doPay = doPay; window.doReset = doReset; window.changeBillLang = changeBillLang; window.toggleDarkMode = toggleDarkMode; window.scrollToCheckout = scrollToCheckout; window.toggleBillQr = toggleBillQr;
// ─── FIX #3: setInterval(refresh, 30000) đã bị xóa — Firebase onValue() lo ───
