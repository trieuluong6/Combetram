import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, set, update, onValue, onChildAdded, onChildChanged, onChildRemoved, onDisconnect, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { MENU } from './menu.js?v=20260405_1';

const firebaseConfig = { databaseURL: "https://quan-bun-thit-nuong-default-rtdb.asia-southeast1.firebasedatabase.app/" };
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// ==========================================
// 1. CẤU HÌNH & BIẾN TOÀN CỤC
// ==========================================
const DEFAULT_BILL_LANG = 'vi';
const LANG_ORDER = ['vi', 'en', 'jp', 'cn', 'tw', 'kr', 'th', 'in'];
const LANG_FLAGS = {
    vi: '🇻🇳', en: '🇺🇸', jp: '🇯🇵', cn: '🇨🇳',
    tw: '🇹🇼', kr: '🇰🇷', th: '🇹🇭', in: '🇮🇳'
};
const DEFAULT_BILL_TEXT = {
    total: "TỔNG CỘNG:",
    empty: "Chưa chọn món nào...",
    thanks: "Xin cảm ơn quý khách!",
    unit: "món"
};
const TRANSLATION_CACHE = { vi: { ...DEFAULT_BILL_TEXT } };
let dictModulePromise = null;

function loadDictModule() {
    if (!dictModulePromise) {
        dictModulePromise = import('./dict.js?v=20260405_1');
    }
    return dictModulePromise;
}

async function getBillTexts(langCode) {
    const code = TRANSLATION_CACHE[langCode] ? langCode : (LANG_ORDER.includes(langCode) ? langCode : DEFAULT_BILL_LANG);
    if (TRANSLATION_CACHE[code]) return TRANSLATION_CACHE[code];
    try {
        const mod = await loadDictModule();
        const dict = mod.DICT || {};
        const texts = dict[code] || dict[DEFAULT_BILL_LANG] || DEFAULT_BILL_TEXT;
        TRANSLATION_CACHE[code] = texts;
        return texts;
    } catch (e) {
        console.error('Lỗi tải từ điển hóa đơn:', e);
        return DEFAULT_BILL_TEXT;
    }
}

const ITEM_MAP = new Map(MENU.map(item => [item.id, item]));
const DRINK_ITEM_IDS = new Set([35, 36, 37, 38, 39, 40, 41]);
const TABLE_NAMES = {
    1: 'BÀN 1', 2: 'BÀN 2', 3: 'BÀN 3',
    4: 'BÀN 4', 5: 'BÀN 5', 6: 'BÀN 6',
    7: 'BÀN TRONG HIÊN',
    8: 'NGOÀI ĐƯỜNG (TRÁI)',
    9: 'NGOÀI ĐƯỜNG (PHẢI)'
};
const TABLE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const TABLE_DOM = {};
const ITEM_DOM = {};
const CLOCK_CARD_DOM = {};
const CAT_PILL_ELS = Array.from(document.querySelectorAll('.cat-pill'));
const CAT_TARGETS = CAT_PILL_ELS
    .map(pill => {
        const targetId = pill.dataset.target;
        const el = targetId ? document.getElementById(targetId) : null;
        return el ? { pill, targetId, el } : null;
    })
    .filter(Boolean);

let currentTab = 1;
let billLang = DEFAULT_BILL_LANG;
let data = { orders: {}, locked: {}, times: {} };
let isInitialDataReady = false;
let isFirebaseConnected = false;
let hasReceivedServerOrders = false;
let hasReceivedServerLocked = false;
let hasReceivedServerTimes = false;
let billRenderToken = 0;

// Hàng đợi ghi Firebase chống mất dữ liệu khi mạng chập chờn / tắt tab
const pendingDeltas = {};
const pendingFlushTimers = {};
const inFlightTables = {};
const MAX_ITEM_QTY = 999;

// Cấu hình VietQR động (VCB - Nguyễn Phú Quí - 0041000285051)
const VIETQR_BANK_BIN = '970436';
const VIETQR_ACCOUNT_NO = '0041000285051';
const VIETQR_TEMPLATE = 'compact2';
const VIETQR_ACCOUNT_NAME = 'NGUYEN PHU QUI';
const STATIC_QR_FALLBACK = './qr-thanh-toan.png';
let currentQrMode = 'bill';
let lastLoadedDynamicQrUrl = '';
let qrLoadRequestToken = 0;

function formatCurrency(amount) {
    return `${Number(amount || 0).toLocaleString('vi-VN')}đ`;
}

function getEffectiveOrderQty(tab, itemId) {
    const serverQty = Number(data.orders?.[tab]?.[itemId]) || 0;
    const deltaQty = Number(pendingDeltas[tab]?.[itemId]) || 0;
    return Math.max(0, serverQty + deltaQty);
}

function getMergedOrder(tab) {
    const serverOrder = data.orders?.[tab] || {};
    const pendingOrder = pendingDeltas[tab];
    if (!pendingOrder) return serverOrder;
    const merged = { ...serverOrder };
    for (const [id, delta] of Object.entries(pendingOrder)) {
        const cleanQty = Math.max(0, (Number(merged[id]) || 0) + (Number(delta) || 0));
        if (cleanQty > 0) merged[id] = cleanQty;
        else delete merged[id];
    }
    return merged;
}

function hasPendingTableChanges(tab) {
    const pendingOrder = pendingDeltas[tab];
    return Boolean(pendingOrder && Object.keys(pendingOrder).length > 0) || Boolean(inFlightTables[tab]);
}

function effectiveTableHasItems(tab) {
    const { foodQty, drinkQty } = calculateTableStats(tab);
    return (foodQty + drinkQty) > 0;
}

// ==========================================
// 2. NON-BLOCKING MODAL & TOAST (THAY ALERT/CONFIRM)
// ==========================================
let toastTimer = null;
let toastClearTimer = null;
let currentToastKey = '';
let currentToastLoading = false;

function dismissToast() {
    const container = document.getElementById('app-toast-container');
    if (!container) return;
    clearTimeout(toastTimer);
    clearTimeout(toastClearTimer);
    const toast = container.querySelector('.app-toast');
    if (toast) {
        toast.classList.add('is-leaving');
        toastClearTimer = setTimeout(() => {
            container.innerHTML = '';
            currentToastKey = '';
            currentToastLoading = false;
        }, 210);
    } else {
        container.innerHTML = '';
        currentToastKey = '';
        currentToastLoading = false;
    }
}

function showToast(message, type = 'info', duration = 2600, options = {}) {
    const container = document.getElementById('app-toast-container');
    if (!container) return;
    const { loading = false, key = '' } = options;

    clearTimeout(toastTimer);
    clearTimeout(toastClearTimer);

    const existingToast = container.querySelector('.app-toast');
    if (existingToast && key && currentToastKey === key) {
        const msgEl = existingToast.querySelector('.app-toast-text');
        if (msgEl && msgEl.textContent !== message) msgEl.textContent = message;
        existingToast.classList.remove('is-pulse', 'is-leaving');
        void existingToast.offsetWidth;
        existingToast.classList.add('is-pulse');
        if (duration > 0) {
            toastTimer = setTimeout(() => dismissToast(), duration);
        }
        return;
    }

    container.innerHTML = '';
    const toast = document.createElement('div');
    toast.className = `app-toast app-toast-${type}${loading ? ' app-toast-loading' : ''}`;

    if (loading) {
        const spinner = document.createElement('span');
        spinner.className = 'app-toast-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        toast.appendChild(spinner);
    }

    const textSpan = document.createElement('span');
    textSpan.className = 'app-toast-text';
    textSpan.textContent = message;
    toast.appendChild(textSpan);

    container.appendChild(toast);
    currentToastKey = key;
    currentToastLoading = loading;

    if (duration > 0) {
        toastTimer = setTimeout(() => dismissToast(), duration);
    }
}

let activeModalResolver = null;
function showConfirmModal({ title, message, confirmText = 'Đồng ý', cancelText = 'Hủy', showCancel = true }) {
    const backdrop = document.getElementById('app-modal-backdrop');
    const titleEl = document.getElementById('app-modal-title');
    const msgEl = document.getElementById('app-modal-message');
    const btnConfirm = document.getElementById('app-modal-confirm');
    const btnCancel = document.getElementById('app-modal-cancel');

    if (!backdrop || !titleEl || !msgEl || !btnConfirm || !btnCancel) {
        return Promise.resolve(false);
    }

    if (activeModalResolver) {
        activeModalResolver(false);
        activeModalResolver = null;
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    btnConfirm.textContent = confirmText;
    btnCancel.textContent = cancelText;
    btnCancel.style.display = showCancel ? '' : 'none';
    backdrop.classList.remove('hidden');

    return new Promise((resolve) => {
        activeModalResolver = resolve;
        const cleanup = (result) => {
            backdrop.classList.add('hidden');
            btnConfirm.onclick = null;
            btnCancel.onclick = null;
            backdrop.onclick = null;
            activeModalResolver = null;
            resolve(result);
        };
        btnConfirm.onclick = () => cleanup(true);
        btnCancel.onclick = () => cleanup(false);
        backdrop.onclick = (e) => {
            if (e.target === backdrop) cleanup(false);
        };
    });
}

function showAlertModal(title, message) {
    return showConfirmModal({ title, message, confirmText: 'Đã hiểu', showCancel: false });
}

// ==========================================
// 3. KẾT NỐI FIREBASE & ĐỒNG BỘ THỜI GIAN SERVER
// ==========================================
let serverTimeOffsetMs = 0;
function getServerNow() {
    return Date.now() + serverTimeOffsetMs;
}

onValue(ref(database, '.info/serverTimeOffset'), (snap) => {
    const offset = Number(snap.val());
    serverTimeOffsetMs = Number.isFinite(offset) ? offset : 0;
    bindActiveSessionsListeners(true);
});

const connectedRef = ref(database, '.info/connected');
onValue(connectedRef, (snap) => {
    const connected = snap.val() === true;
    isFirebaseConnected = connected;
    const badge = document.getElementById('offline-badge');
    if (badge) badge.classList.toggle('hidden', connected);
    if (connected) {
        registerPresence();
        bindActiveSessionsListeners();
        TABLE_IDS.forEach(tab => {
            if (pendingDeltas[tab] && Object.keys(pendingDeltas[tab]).length > 0) {
                flushTableDeltas(tab);
            }
        });
    } else {
        resetRemoteCursors();
    }
});

// ==========================================
// 4. ĐỒNG HỒ LẬT & DARK MODE
// ==========================================
function setupClock() {
    ['h1', 'h2', 'm1', 'm2', 's1', 's2'].forEach(id => {
        const card = document.getElementById(id);
        if (!card) return;
        card.innerHTML = `<div class="card-half card-top">0</div><div class="card-half card-bottom">0</div><div class="card-flip-wing">0</div><div class="card-flip-wing-back">0</div>`;
        CLOCK_CARD_DOM[id] = {
            card,
            top: card.querySelector('.card-top'),
            bottom: card.querySelector('.card-bottom'),
            wingFront: card.querySelector('.card-flip-wing'),
            wingBack: card.querySelector('.card-flip-wing-back'),
            currentVal: '0',
            animTimer: null
        };
    });
}

function updateFlipCard(id, newVal) {
    const dom = CLOCK_CARD_DOM[id];
    if (!dom) return;
    if (dom.currentVal !== newVal) {
        const oldVal = dom.currentVal;
        dom.currentVal = newVal;
        dom.wingFront.innerText = oldVal;
        dom.wingBack.innerText = newVal;
        dom.top.innerText = newVal;
        dom.bottom.innerText = oldVal;
        dom.card.classList.remove('animate');
        void dom.card.offsetWidth;
        dom.card.classList.add('animate');
        clearTimeout(dom.animTimer);
        dom.animTimer = setTimeout(() => {
            dom.bottom.innerText = newVal;
            dom.wingFront.innerText = newVal;
            dom.card.classList.remove('animate');
        }, 350);
    }
}

let lastClockTickSec = -1;
function tickClock() {
    const now = new Date();
    const sec = now.getSeconds();
    if (sec === lastClockTickSec) return;
    lastClockTickSec = sec;
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(sec).padStart(2, '0');
    updateFlipCard('h1', h[0]);
    updateFlipCard('h2', h[1]);
    updateFlipCard('m1', m[0]);
    updateFlipCard('m2', m[1]);
    updateFlipCard('s1', s[0]);
    updateFlipCard('s2', s[1]);
}
setupClock();
tickClock();
setInterval(tickClock, 250);

const darkToggle = document.getElementById('dark-toggle');
function applyTheme(isDark) {
    document.body.classList.toggle('dark-mode', isDark);
    darkToggle.textContent = isDark ? '☀️' : '🌙';
}
const savedTheme = localStorage.getItem('darkMode');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
if (savedTheme !== null) applyTheme(savedTheme === 'true');
else applyTheme(prefersDark.matches);
darkToggle.onclick = () => {
    const isDark = !document.body.classList.contains('dark-mode');
    applyTheme(isDark);
    localStorage.setItem('darkMode', isDark);
};
prefersDark.addEventListener('change', e => {
    if (localStorage.getItem('darkMode') === null) applyTheme(e.matches);
});

// ==========================================
// 5. HIỆU ỨNG ÂM THANH KHI BẤM (+), (-), THANH TOÁN & CHỐT ĐƠN
// ==========================================
const soundToggle = document.getElementById('sound-toggle');
let isSoundEnabled = localStorage.getItem('soundEnabled') !== 'false';
let sharedAudioCtx = null;

function applySoundToggleUi() {
    if (!soundToggle) return;
    soundToggle.textContent = isSoundEnabled ? '🔊' : '🔇';
    soundToggle.classList.toggle('is-muted', !isSoundEnabled);
    soundToggle.title = isSoundEnabled ? 'Tắt âm thanh thao tác' : 'Bật âm thanh thao tác';
    soundToggle.setAttribute('aria-label', soundToggle.title);
}
applySoundToggleUi();

if (soundToggle) {
    soundToggle.onclick = () => {
        isSoundEnabled = !isSoundEnabled;
        localStorage.setItem('soundEnabled', String(isSoundEnabled));
        applySoundToggleUi();
        if (isSoundEnabled) {
            primeAudioEngine();
            playUiSound('add');
        }
    };
}

function getAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioCtx) {
        sharedAudioCtx = new AudioCtx();
    }
    return sharedAudioCtx;
}

const SOUND_SAMPLE_RATE = 22050;
const webAudioBufferCache = {};

function renderToneSamples(type) {
    const durationSec = type === 'pay' ? 0.50 : (type === 'lock' ? 0.25 : 0.14);
    const totalSamples = Math.ceil(SOUND_SAMPLE_RATE * durationSec);
    const samples = new Float32Array(totalSamples);

    const addPartial = (freqStart, freqEnd, startSec, durSec, peakGain, wave = 'sine') => {
        const startIdx = Math.floor(startSec * SOUND_SAMPLE_RATE);
        const len = Math.floor(durSec * SOUND_SAMPLE_RATE);
        let phase = 0;
        for (let i = 0; i < len && (startIdx + i) < totalSamples; i++) {
            const p = i / len;
            const freq = freqStart + (freqEnd - freqStart) * p;
            phase += (2 * Math.PI * freq) / SOUND_SAMPLE_RATE;
            const attack = Math.min(1, i / (SOUND_SAMPLE_RATE * 0.005));
            const decay = Math.pow(1 - p, 2.2);
            const env = peakGain * attack * decay;
            let val = Math.sin(phase);
            if (wave === 'triangle') val = (2 / Math.PI) * Math.asin(val);
            samples[startIdx + i] += val * env;
        }
    };

    if (type === 'add') {
        addPartial(660, 740, 0, 0.055, 0.22, 'sine');
        addPartial(990, 1060, 0.032, 0.085, 0.25, 'sine');
    } else if (type === 'sub') {
        addPartial(540, 420, 0, 0.055, 0.20, 'triangle');
        addPartial(420, 320, 0.035, 0.085, 0.22, 'triangle');
    } else if (type === 'lock') {
        addPartial(587.33, 587.33, 0, 0.085, 0.22, 'sine');
        addPartial(880, 880, 0.065, 0.14, 0.25, 'sine');
    } else if (type === 'pay') {
        addPartial(1046.50, 1046.50, 0, 0.16, 0.24, 'sine');
        addPartial(2093.00, 2093.00, 0, 0.12, 0.09, 'sine');
        addPartial(1318.51, 1318.51, 0.075, 0.22, 0.26, 'sine');
        addPartial(2637.02, 2637.02, 0.075, 0.16, 0.10, 'sine');
        addPartial(1567.98, 1567.98, 0.155, 0.30, 0.28, 'sine');
        addPartial(3135.96, 3135.96, 0.155, 0.20, 0.10, 'sine');
    }
    return samples;
}

function getWebAudioBuffer(ctx, type) {
    if (webAudioBufferCache[type]) return webAudioBufferCache[type];
    const samples = renderToneSamples(type);
    const buffer = ctx.createBuffer(1, samples.length, SOUND_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    webAudioBufferCache[type] = buffer;
    return buffer;
}

function triggerWebAudioBuffer(ctx, type) {
    const buffer = getWebAudioBuffer(ctx, type);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
}

let audioPrimed = false;
function primeAudioEngine() {
    if (audioPrimed) return;
    audioPrimed = true;
    try {
        const ctx = getAudioContext();
        if (ctx) {
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            ['add', 'sub', 'lock', 'pay'].forEach(t => getWebAudioBuffer(ctx, t));
        }
    } catch (_) {}
}

['pointerdown', 'touchstart', 'keydown'].forEach(evtName => {
    window.addEventListener(evtName, primeAudioEngine, { once: true, passive: true });
});

function playUiSound(type) {
    if (!isSoundEnabled) return;
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        if (ctx.state === 'suspended') {
            ctx.resume().then(() => triggerWebAudioBuffer(ctx, type)).catch(() => {});
        } else {
            triggerWebAudioBuffer(ctx, type);
        }
    } catch (_) {}
}

// ==========================================
// 6. THỜI TIẾT ĐÀ NẴNG, THỊ TRƯỜNG BTC & DẦU THÔ
// ==========================================
const weatherIconRules = [
    { codes: [0],         html: '<span class="wi-spin">☀️</span>' },
    { codes: [1, 2],      html: '<span class="wi-pulse">🌤️</span>' },
    { codes: [3],         html: '<span class="wi-sway">☁️</span>' },
    { codes: [45, 48],    html: '<span class="wi-sway">🌫️</span>' },
    { codes: [51,53,55],  html: '<span class="wi-drop">🌦️</span>' },
    { codes: [61,63,65],  html: '<span class="wi-drop">🌧️</span>' },
    { codes: [80,81,82],  html: '<span class="wi-drop">🌧️</span>' },
    { codes: [95,96,99],  html: '<span class="wi-flash">⛈️</span>' },
];
function getWeatherIcon(code) {
    const r = weatherIconRules.find(x => x.codes.includes(code));
    return r ? r.html : '<span class="wi-pulse">🌤️</span>';
}

function setWeatherAnimationState(active) {
    const iconEl = document.getElementById('w-icon');
    if (iconEl) {
        iconEl.querySelectorAll('span').forEach(el => {
            el.style.animationPlayState = active ? 'running' : 'paused';
        });
    }
    const windContainer = document.getElementById('w-wind-icon');
    if (windContainer) {
        windContainer.querySelectorAll('.wi-blow, .wi-blow2, .wi-blow3').forEach(el => {
            el.style.animationPlayState = active ? 'running' : 'paused';
        });
    }
}

let isWeatherInViewport = true;
const weatherHubEl = document.getElementById('weather-hub');
if (weatherHubEl && 'IntersectionObserver' in window) {
    const weatherObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            isWeatherInViewport = entry.isIntersecting;
            setWeatherAnimationState(isWeatherInViewport && !document.hidden);
        });
    }, { threshold: 0.05 });
    weatherObserver.observe(weatherHubEl);
}

async function updateWeather() {
    try {
        const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=16.0678&longitude=108.2208&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m');
        if (!res.ok) return;
        const d = await res.json();
        const cur = d.current;
        const temp = Math.round(cur.temperature_2m);
        const speed = Math.round(cur.wind_speed_10m);
        const deg = cur.wind_direction_10m;
        const dirs = ['Bắc', 'Đ.Bắc', 'Đông', 'Đ.Nam', 'Nam', 'T.Nam', 'Tây', 'T.Bắc'];
        const dirText = dirs[Math.round(deg / 45) % 8];

        document.getElementById('w-icon').innerHTML = getWeatherIcon(cur.weather_code);
        document.getElementById('w-temp').innerText = `${temp}°C`;
        document.getElementById('w-wind-speed').innerText = `${speed} km/h`;
        document.getElementById('w-wind-dir').innerText = dirText;
        document.getElementById('w-arrow').style.transform = `rotate(${deg + 180}deg)`;

        const hub = document.getElementById('weather-hub');
        hub.classList.remove('wind-warning', 'wind-danger');
        const windContainer = document.getElementById('w-wind-icon');
        if (speed >= 30) {
            hub.classList.add('wind-danger');
            windContainer.innerHTML = `<span class="wi-blow">💨</span><span class="wi-blow2" style="margin-left:-4px">💨</span><span class="wi-blow3" style="margin-left:-4px">💨</span>`;
        } else if (speed >= 15) {
            hub.classList.add('wind-warning');
            windContainer.innerHTML = `<span class="wi-blow">💨</span><span class="wi-blow2" style="margin-left:-4px">💨</span>`;
        } else {
            windContainer.innerHTML = `<span class="wi-blow">💨</span>`;
        }
        setWeatherAnimationState(isWeatherInViewport && !document.hidden);
    } catch (e) {}
}
updateWeather();

const MARKET_CONFIG = {
    btc: {
        cardId: 'btc-ticker', valueId: 'btc-value', deltaId: 'btc-delta',
        decimals: 0, prefix: '$', suffix: '', baseline: null, lastPrice: null
    },
    oil: {
        cardId: 'oil-ticker', valueId: 'oil-value', deltaId: 'oil-delta',
        decimals: 2, prefix: '$', suffix: '', baseline: null, lastPrice: null
    }
};

function formatTickerPrice(price, decimals, prefix = '', suffix = '') {
    if (!Number.isFinite(price)) return '--';
    return prefix + price.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    }) + suffix;
}

function updateTickerDisplay(key, price) {
    const cfg = MARKET_CONFIG[key];
    if (!cfg || !Number.isFinite(price) || price <= 0) return;

    const card = document.getElementById(cfg.cardId);
    const valEl = document.getElementById(cfg.valueId);
    const deltaEl = document.getElementById(cfg.deltaId);
    if (!card || !valEl || !deltaEl) return;

    valEl.textContent = formatTickerPrice(price, cfg.decimals, cfg.prefix, cfg.suffix);

    if (cfg.baseline === null) cfg.baseline = price;
    const refPrice = cfg.lastPrice !== null && cfg.lastPrice !== price ? cfg.lastPrice : cfg.baseline;
    const diff = price - refPrice;
    const pct = cfg.baseline ? ((price - cfg.baseline) / cfg.baseline) * 100 : 0;

    card.classList.remove('up', 'down', 'flat');
    if (diff > 0) {
        card.classList.add('up');
        deltaEl.textContent = `▲ ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    } else if (diff < 0) {
        card.classList.add('down');
        deltaEl.textContent = `▼ ${pct.toFixed(2)}%`;
    } else {
        card.classList.add('flat');
        deltaEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }

    cfg.lastPrice = price;
}

async function fetchBtcPrice() {
    try {
        const res = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', { cache: 'no-store' });
        if (!res.ok) throw new Error('Binance HTTP ' + res.status);
        const d = await res.json();
        const price = parseFloat(d.lastPrice);
        const openPrice = parseFloat(d.openPrice);
        if (Number.isFinite(openPrice) && openPrice > 0) MARKET_CONFIG.btc.baseline = openPrice;
        if (Number.isFinite(price) && price > 0) {
            updateTickerDisplay('btc', price);
            return;
        }
    } catch (_) {}

    try {
        const res2 = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { cache: 'no-store' });
        if (!res2.ok) return;
        const d2 = await res2.json();
        const price2 = parseFloat(d2?.data?.amount);
        if (Number.isFinite(price2) && price2 > 0) updateTickerDisplay('btc', price2);
    } catch (_) {}
}

async function fetchOilPrice() {
    try {
        const yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1m&range=1d';
        const res = await fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(yahooUrl), { cache: 'no-store' });
        if (!res.ok) return;
        const d = await res.json();
        const meta = d?.chart?.result?.[0]?.meta;
        const price = parseFloat(meta?.regularMarketPrice);
        const prevClose = parseFloat(meta?.previousClose || meta?.chartPreviousClose);
        if (Number.isFinite(prevClose) && prevClose > 0) MARKET_CONFIG.oil.baseline = prevClose;
        if (Number.isFinite(price) && price > 0) updateTickerDisplay('oil', price);
    } catch (_) {}
}

function updateMarketTickers() {
    fetchBtcPrice();
    fetchOilPrice();
}
updateMarketTickers();

// ==========================================
// 7. ĐO TỐC ĐỘ TẢI TRANG & MẠNG (PING + BĂNG THÔNG)
// ==========================================
function applySpeedColor(el, val, goodMax, warnMax) {
    if (!el) return;
    if (val <= goodMax) {
        el.style.color = '#2e7d32';
        el.style.textShadow = '0 0 6px rgba(46, 125, 50, 0.25)';
    } else if (val <= warnMax) {
        el.style.color = '#e65100';
        el.style.textShadow = '0 0 6px rgba(230, 81, 0, 0.25)';
    } else {
        el.style.color = '#c62828';
        el.style.textShadow = '0 0 6px rgba(198, 40, 40, 0.25)';
    }
}

function measurePageLoadSpeed() {
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    let loadMs = 0;
    if (nav && nav.domContentLoadedEventEnd > 0) {
        loadMs = Math.round(nav.domContentLoadedEventEnd - nav.startTime);
    } else if (performance.timing && performance.timing.domContentLoadedEventEnd > 0) {
        loadMs = performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart;
    } else {
        loadMs = Math.round(performance.now());
    }
    loadMs = Math.max(1, loadMs);
    const loadEl = document.getElementById('load-val');
    if (loadEl) {
        loadEl.textContent = loadMs >= 1000 ? `${(loadMs / 1000).toFixed(2)}s` : `${loadMs}ms`;
        applySpeedColor(loadEl, loadMs, 1000, 2500);
    }
}
if (document.readyState === 'complete') measurePageLoadSpeed();
else window.addEventListener('load', () => setTimeout(measurePageLoadSpeed, 50));

function updateBandwidthDisplay() {
    const bwEl = document.getElementById('bw-val');
    if (!bwEl) return;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && typeof conn.downlink === 'number' && conn.downlink > 0) {
        const mbps = conn.downlink;
        bwEl.textContent = mbps >= 10 ? `${Math.round(mbps)} Mbps` : `${mbps.toFixed(1)} Mbps`;
        if (mbps >= 5) {
            bwEl.style.color = '#2e7d32';
            bwEl.style.textShadow = '0 0 6px rgba(46, 125, 50, 0.25)';
        } else if (mbps >= 1.5) {
            bwEl.style.color = '#e65100';
            bwEl.style.textShadow = '0 0 6px rgba(230, 81, 0, 0.25)';
        } else {
            bwEl.style.color = '#c62828';
            bwEl.style.textShadow = '0 0 6px rgba(198, 40, 40, 0.25)';
        }
    } else {
        bwEl.textContent = 'WiFi/4G';
        bwEl.style.color = '#2e7d32';
    }
}
updateBandwidthDisplay();
if (navigator.connection && navigator.connection.addEventListener) {
    navigator.connection.addEventListener('change', updateBandwidthDisplay);
}

let isCheckingNetwork = false;
async function checkNetworkSpeed() {
    if (isCheckingNetwork) return;
    isCheckingNetwork = true;
    const pingEl = document.getElementById('ping-val');
    const bwEl = document.getElementById('bw-val');
    try {
        const t0 = performance.now();
        await fetch('https://www.gstatic.com/generate_204?t=' + Date.now(), { mode: 'no-cors', cache: 'no-store' });
        const pingMs = Math.max(1, Math.round(performance.now() - t0));
        if (pingEl) {
            pingEl.textContent = `${pingMs}ms`;
            applySpeedColor(pingEl, pingMs, 100, 250);
        }
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!conn || typeof conn.downlink !== 'number' || conn.downlink <= 0) {
            const t1 = performance.now();
            const probeRes = await fetch('https://www.google.com/images/phd/px.gif?t=' + Date.now(), { mode: 'no-cors', cache: 'no-store' });
            void probeRes;
            const dlMs = Math.max(1, performance.now() - t1);
            const estMbps = Math.min(100, Math.max(1, Math.round((800 / dlMs) * 10) / 10));
            if (bwEl) {
                bwEl.textContent = `${estMbps} Mbps`;
                if (estMbps >= 5) bwEl.style.color = '#2e7d32';
                else if (estMbps >= 1.5) bwEl.style.color = '#e65100';
                else bwEl.style.color = '#c62828';
            }
        } else {
            updateBandwidthDisplay();
        }
    } catch (_) {
        if (pingEl) {
            pingEl.textContent = 'Lỗi';
            pingEl.style.color = '#c62828';
        }
    } finally {
        isCheckingNetwork = false;
    }
}
checkNetworkSpeed();

let maintenanceTickCount = 0;
function runPeriodicMaintenance() {
    if (document.hidden) return;
    maintenanceTickCount++;

    const now = getServerNow();
    syncSessionViews(now);

    if (maintenanceTickCount % 15 === 0) {
        checkNetworkSpeed();
    }
    if (maintenanceTickCount % 30 === 0) {
        updateMarketTickers();
    }
    if (maintenanceTickCount % 900 === 0) {
        updateWeather();
    }
}
setInterval(runPeriodicMaintenance, 2000);

// ==========================================
// 8. HỆ THỐNG PRESENCE & CURSOR ĐỒNG NGHIỆP (TỰ DỌN RÁC + HEARTBEAT)
// ==========================================
let mySessionId = sessionStorage.getItem('mySessionId');
if (!mySessionId) {
    mySessionId = 'u_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
    sessionStorage.setItem('mySessionId', mySessionId);
}
const CURSOR_COLORS = ['#e91e63', '#00bcd4', '#8bc34a', '#ff5722', '#9c27b0', '#03a9f4', '#ff9800', '#009688'];
function hashColor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return CURSOR_COLORS[h % CURSOR_COLORS.length];
}
const myColor = hashColor(mySessionId);
const mySessionRef = ref(database, `active_sessions/${mySessionId}`);
const activeSessionsRef = ref(database, 'active_sessions');
const onlineRef = ref(database, 'online_users');

let sessionsMap = {};
let activeSessionsListenersBound = false;
let activeSessionsOffFns = [];
const remoteCursorEls = {};
const remoteFocusRows = {};
const remoteFocusExpireTimers = {};
const remotePayingExpireTimers = {};
let myFocusItemId = null;
let myFocusTimer = null;
let isSelfPaying = false;
let selfPayingHeartbeatTimer = null;

const HEARTBEAT_INTERVAL_MS = 20000;
const STALE_SESSION_MS = 45000;
const STALE_CURSOR_MS = 35000;
const FOCUS_TTL_MS = 1500;
const PAYING_TTL_MS = 45000;
const PAYING_HEARTBEAT_MS = 12000;
const SERVER_SWEEP_INTERVAL_MS = 60000;
const cleaningSessionIds = new Set();
let lastServerStaleSweepAt = 0;

function removeStaleSessionNode(id, expectedTs) {
    if (!id || id === mySessionId || cleaningSessionIds.has(id)) return;
    cleaningSessionIds.add(id);
    const targetRef = ref(database, `active_sessions/${id}`);
    runTransaction(targetRef, (cur) => {
        if (!cur) return cur;
        const curTs = Number(cur.ts);
        if (Number.isFinite(curTs) && Number.isFinite(expectedTs) && curTs > expectedTs) {
            return;
        }
        return null;
    }).catch(() => {}).finally(() => {
        cleaningSessionIds.delete(id);
    });
}

function unbindActiveSessionsListeners() {
    while (activeSessionsOffFns.length > 0) {
        const offFn = activeSessionsOffFns.pop();
        try { offFn(); } catch (_) {}
    }
    activeSessionsListenersBound = false;
}

function handleRemoteSessionChange(id, sessionData, eventType = 'change') {
    if (!id) return;
    const prevSession = sessionsMap[id];
    const prevTable = Number(prevSession?.table || 0);
    const nextTable = sessionData && typeof sessionData === 'object' ? Number(sessionData.table || 0) : 0;

    if (eventType === 'remove' || !sessionData || typeof sessionData !== 'object') {
        delete sessionsMap[id];
        if (id !== mySessionId) {
            clearRemoteFocusEntry(id);
            removeRemoteCursorEl(id);
        }
    } else {
        sessionsMap[id] = sessionData;
    }

    const now = getServerNow();
    const cursorChanged = eventType === 'remove' || prevTable !== nextTable;
    syncSessionViews(now, { cursors: cursorChanged });
}

function bindActiveSessionsListeners(forceRebind = false) {
    if (forceRebind) {
        unbindActiveSessionsListeners();
    }
    if (activeSessionsListenersBound) return;
    activeSessionsListenersBound = true;
    sessionsMap = {};

    const onAdd = onChildAdded(activeSessionsRef, (snap) => {
        handleRemoteSessionChange(snap.key, snap.val(), 'add');
    });
    const onChange = onChildChanged(activeSessionsRef, (snap) => {
        handleRemoteSessionChange(snap.key, snap.val(), 'change');
    });
    const onRemove = onChildRemoved(activeSessionsRef, (snap) => {
        handleRemoteSessionChange(snap.key, null, 'remove');
    });

    activeSessionsOffFns.push(onAdd, onChange, onRemove);
    const now = getServerNow();
    syncSessionViews(now);
}

function buildPresencePayload(overrides = {}) {
    const payload = {
        table: currentTab,
        color: myColor,
        ts: serverTimestamp(),
        ...overrides
    };
    if (myFocusItemId !== null && !Object.prototype.hasOwnProperty.call(overrides, 'itemId')) {
        payload.itemId = myFocusItemId;
    }
    if (isSelfPaying && !Object.prototype.hasOwnProperty.call(overrides, 'paying')) {
        payload.paying = true;
    }
    return payload;
}

function registerPresence() {
    onDisconnect(mySessionRef).remove();
    set(mySessionRef, buildPresencePayload()).catch(() => {});
}
registerPresence();

function setSelfPayingState(paying) {
    const next = Boolean(paying);
    isSelfPaying = next;
    clearInterval(selfPayingHeartbeatTimer);
    selfPayingHeartbeatTimer = null;

    if (next) {
        selfPayingHeartbeatTimer = setInterval(() => {
            if (!isSelfPaying || document.hidden || !isFirebaseConnected) return;
            update(mySessionRef, buildPresencePayload({ paying: true })).catch(() => {});
        }, PAYING_HEARTBEAT_MS);
    }

    if (!isFirebaseConnected) return;
    update(mySessionRef, buildPresencePayload({ paying: next ? true : null })).catch(() => {});
}

// Single-pass collector qua sessionsMap để gom toàn bộ dữ liệu hiển thị & leader trong 1 vòng lặp duy nhất
function collectSessionState(now = getServerNow()) {
    let activeCount = 0;
    let hasMySession = false;
    let leaderId = mySessionId || null;

    const cursors = [];
    const focuses = [];
    const payingByTable = new Map();
    const activePayingIds = [];
    const staleSessions = [];

    for (const id in sessionsMap) {
        const s = sessionsMap[id];
        if (id === mySessionId) {
            hasMySession = true;
            activeCount++;
            continue;
        }
        if (!s || typeof s !== 'object') {
            staleSessions.push([id, 0]);
            continue;
        }
        const ts = Number(s.ts);
        const hasValidTs = Number.isFinite(ts);
        const ageMs = hasValidTs ? (now - ts) : 0;

        if (hasValidTs && ageMs >= STALE_SESSION_MS) {
            staleSessions.push([id, ts]);
            continue;
        }

        activeCount++;
        if (leaderId === null || id < leaderId) {
            leaderId = id;
        }

        const tableNum = Number(s.table);
        const validTable = Number.isInteger(tableNum) && tableNum >= 1 && tableNum <= 9;
        if (!validTable) continue;

        if (!hasValidTs || ageMs < STALE_CURSOR_MS) {
            cursors.push([id, s]);
        }

        if (hasValidTs && ageMs < FOCUS_TTL_MS && s.itemId) {
            focuses.push([id, s]);
        }

        if (hasValidTs && ageMs < PAYING_TTL_MS && s.paying === true) {
            const remainingMs = Math.max(120, PAYING_TTL_MS - Math.max(0, ageMs));
            activePayingIds.push([id, remainingMs]);
            const prev = payingByTable.get(tableNum);
            if (!prev || ts > prev.ts) {
                payingByTable.set(tableNum, {
                    id,
                    table: tableNum,
                    color: s.color || '#f59e0b',
                    ts
                });
            }
        }
    }

    if (!hasMySession && mySessionId) {
        activeCount++;
    }

    const isLeader = Boolean(isFirebaseConnected && mySessionId && leaderId === mySessionId);

    return {
        now,
        activeCount,
        isLeader,
        cursors,
        focuses,
        payingByTable,
        activePayingIds,
        staleSessions
    };
}

function renderPresenceCount(now = getServerNow(), state = null) {
    const snap = state || collectSessionState(now);
    const total = Math.max(1, snap.activeCount);
    const el = document.getElementById('presence-count');
    if (el) el.innerHTML = `<span class="online-dot"></span> ${total} online`;
}

function cleanupStaleSessions(now = getServerNow(), state = null) {
    const snap = state || collectSessionState(now);
    if (!snap.isLeader) return;

    snap.staleSessions.forEach(([id, ts]) => {
        removeStaleSessionNode(id, ts);
    });

    if (now - lastServerStaleSweepAt >= SERVER_SWEEP_INTERVAL_MS) {
        lastServerStaleSweepAt = now;
        onValue(activeSessionsRef, (snapshot) => {
            const all = snapshot.val() || {};
            const sweepNow = getServerNow();
            Object.entries(all).forEach(([id, s]) => {
                if (id === mySessionId) return;
                if (!s || typeof s !== 'object') {
                    removeStaleSessionNode(id, 0);
                    return;
                }
                const ts = Number(s.ts);
                if (Number.isFinite(ts) && sweepNow - ts >= STALE_SESSION_MS) {
                    removeStaleSessionNode(id, ts);
                }
            });
        }, { onlyOnce: true });
    }
}

function syncSessionViews(now = getServerNow(), { cursors = true, focus = true, paying = true, presence = true, cleanup = true } = {}) {
    const state = collectSessionState(now);
    if (presence) renderPresenceCount(now, state);
    if (cursors) renderRemoteCursors(now, state);
    if (focus) renderRemoteFocus(now, state);
    if (paying) renderRemotePaying(now, state);
    if (cleanup) cleanupStaleSessions(now, state);
}

onValue(onlineRef, (snap) => {
    const v = snap.val();
    if (v && typeof v === 'object') {
        Object.keys(v).forEach(legacyId => {
            removeStaleSessionNode(legacyId, 0);
        });
    }
    syncSessionViews(getServerNow(), { cursors: false, focus: false, paying: false });
});

function broadcastMyFocus(itemId) {
    myFocusItemId = itemId;
    clearTimeout(myFocusTimer);
    myFocusTimer = setTimeout(() => {
        myFocusItemId = null;
        if (!isFirebaseConnected) return;
        update(mySessionRef, { itemId: null, ts: serverTimestamp() }).catch(() => {});
    }, FOCUS_TTL_MS);
    if (!isFirebaseConnected) return;
    update(mySessionRef, buildPresencePayload({ itemId })).catch(() => {});
}

// ==========================================
// 9. KHỞI TẠO & CẬP NHẬT UI BÀN & MENU
// ==========================================
function initTables() {
    const container = document.getElementById('tables-container');
    container.innerHTML = '';
    TABLE_IDS.forEach(i => {
        const div = document.createElement('div');
        div.id = `tab-${i}`;
        div.className = 'table-card' + (i === 1 ? ' active' : '') + (i === 7 ? ' full-width' : '') + (i >= 8 ? ' half-width' : '');
        div.onclick = () => selectTable(i);
        div.innerHTML = `
            <strong><span class="table-badge" aria-hidden="true"></span>${TABLE_NAMES[i]}</strong>
            <span id="sum-${i}" class="table-price skeleton">0đ</span>
            <span id="meta-${i}" class="table-meta"></span>
            <span id="time-${i}" class="table-time skeleton">00:00</span>
            <span id="paying-badge-${i}" class="remote-paying-badge" style="display:none"></span>
        `;
        container.appendChild(div);
        TABLE_DOM[i] = {
            card: div,
            sum: div.querySelector(`#sum-${i}`),
            meta: div.querySelector(`#meta-${i}`),
            time: div.querySelector(`#time-${i}`),
            payingBadge: div.querySelector(`#paying-badge-${i}`),
            flashTimer: null,
            loadingTapTimer: null
        };
    });
}
initTables();

function setTablesLoadingState(isLoading) {
    const container = document.getElementById('tables-container');
    if (container) container.classList.toggle('is-loading', isLoading);
}

function initMenu() {
    const container = document.getElementById('menu-container');
    container.innerHTML = '';
    const categories = {
        "bún": { label: "🍜 BÚN & PHỞ", anchorId: "cat-bun" },
        "nước uống": { label: "🥤 NƯỚC UỐNG", anchorId: "cat-nuoc" },
        "nem": { label: "🍢 NEM CHẢ THÊM", anchorId: "cat-nem" },
        "mì": { label: "🍝 MÌ XÀO & MÌ TRỘN", anchorId: "cat-mi" }
    };

    Object.entries(categories).forEach(([catKey, catInfo]) => {
        const title = document.createElement('div');
        title.id = catInfo.anchorId;
        title.className = 'category-title';
        title.textContent = catInfo.label;
        container.appendChild(title);

        MENU.filter(m => m.cat === catKey).forEach(item => {
            const row = document.createElement('div');
            row.className = 'menu-item';
            row.id = `row-${item.id}`;
            row.dataset.itemId = String(item.id);
            row.innerHTML = `
                <div class="item-info">
                    <b>${item.name}</b>
                    <small>${formatCurrency(item.price)}</small>
                </div>
                <div class="controls">
                    <button type="button" class="btn-qty btn-sub" data-action="sub" aria-label="Giảm ${item.name}">−</button>
                    <span class="qty-num" id="qty-${item.id}">0</span>
                    <button type="button" class="btn-qty btn-add" data-action="add" aria-label="Tăng ${item.name}">+</button>
                </div>
            `;
            container.appendChild(row);
            ITEM_DOM[item.id] = {
                row,
                qty: row.querySelector(`#qty-${item.id}`),
                lastQty: 0,
                lastLevel: 0
            };
        });
    });
}
initMenu();

function initMenuCategoryNav() {
    const nav = document.getElementById('menu-cat-nav');
    if (!nav || CAT_TARGETS.length === 0) return;

    const setActivePill = (targetId) => {
        CAT_TARGETS.forEach(({ pill, targetId: id }) => {
            pill.classList.toggle('active', id === targetId);
        });
    };

    nav.addEventListener('click', (e) => {
        const pill = e.target.closest('.cat-pill');
        if (!pill) return;
        const targetId = pill.dataset.target;
        const targetEl = document.getElementById(targetId);
        if (!targetEl) return;
        setActivePill(targetId);
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    setActivePill(entry.target.id);
                }
            });
        }, { rootMargin: '-70px 0px -65% 0px', threshold: 0 });
        CAT_TARGETS.forEach(({ el }) => observer.observe(el));
    }
}
initMenuCategoryNav();

const menuContainerEl = document.getElementById('menu-container');
if (menuContainerEl) {
    menuContainerEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-qty');
        if (!btn) return;
        const row = btn.closest('.menu-item');
        const itemId = Number(row?.dataset.itemId);
        if (!itemId) return;
        const delta = btn.dataset.action === 'add' ? 1 : -1;
        change(itemId, delta);
    });
}

function triggerTableFlash(tableId, type) {
    const dom = TABLE_DOM[tableId];
    if (!dom) return;
    const card = dom.card;
    const cls = type === 'add' ? 'flash-add' : 'flash-sub';
    card.classList.remove('flash-add', 'flash-sub');
    void card.offsetWidth;
    card.classList.add(cls);
    clearTimeout(dom.flashTimer);
    dom.flashTimer = setTimeout(() => {
        card.classList.remove('flash-add', 'flash-sub');
    }, 400);
}

let prevRemoteSnapshot = null;
let hasInitializedRemoteSnapshot = false;
function queueRemoteOrderFlashes(nextOrders) {
    const safeNext = nextOrders || {};
    if (!hasInitializedRemoteSnapshot) {
        prevRemoteSnapshot = JSON.parse(JSON.stringify(safeNext));
        hasInitializedRemoteSnapshot = true;
        return;
    }
    const prevOrders = prevRemoteSnapshot || {};
    TABLE_IDS.forEach(tab => {
        if (hasPendingTableChanges(tab)) return;
        const oldTab = prevOrders[tab] || {};
        const newTab = safeNext[tab] || {};
        const allIds = new Set([...Object.keys(oldTab), ...Object.keys(newTab)]);
        let flashType = null;
        for (const id of allIds) {
            const oldQty = Number(oldTab[id] || 0);
            const newQty = Number(newTab[id] || 0);
            if (newQty > oldQty) {
                flashType = 'add';
                break;
            } else if (newQty < oldQty) {
                flashType = 'sub';
            }
        }
        if (flashType) triggerTableFlash(tab, flashType);
    });
    prevRemoteSnapshot = JSON.parse(JSON.stringify(safeNext));
}

function markInitialDataReadyIfComplete() {
    if (isInitialDataReady) return;
    if (hasReceivedServerOrders && hasReceivedServerLocked && hasReceivedServerTimes) {
        isInitialDataReady = true;
        setTablesLoadingState(false);
        renderAllTables();
        renderCurrentOrder();
        const checkoutBtn = document.getElementById('btn-checkout');
        if (checkoutBtn) setupCheckoutObserver(checkoutBtn);
        dismissToast();
        updateGuestStatus();
    }
}

const rootDbRef = ref(database);
onValue(rootDbRef, (snapshot) => {
    const rootVal = snapshot.val() || {};
    const nextOrders = rootVal.orders && typeof rootVal.orders === 'object' ? rootVal.orders : {};
    const nextLocked = rootVal.locked && typeof rootVal.locked === 'object' ? rootVal.locked : {};
    const nextTimes = rootVal.times && typeof rootVal.times === 'object' ? rootVal.times : {};

    data.orders = nextOrders;
    data.locked = nextLocked;
    data.times = nextTimes;

    hasReceivedServerOrders = true;
    hasReceivedServerLocked = true;
    hasReceivedServerTimes = true;

    if (!isInitialDataReady) {
        markInitialDataReadyIfComplete();
        return;
    }

    queueRemoteOrderFlashes(nextOrders);
    renderAllTables();
    renderCurrentOrder();
    updateGuestStatus();
});

function updateGuestStatus() {
    const badge = document.getElementById('crowd-status');
    const text = document.getElementById('crowd-text');
    if (!isInitialDataReady) {
        badge.className = 'status-badge status-empty';
        text.innerText = 'ĐANG TẢI...';
        return;
    }
    const active = TABLE_IDS.filter(i => effectiveTableHasItems(i)).length;
    badge.className = 'status-badge ' + (active === 0 ? 'status-empty' : (active <= 4 ? 'status-normal' : 'status-crowded'));
    text.innerText = active === 0 ? "QUÁN VẮNG" : (active <= 4 ? "KHÁCH BÌNH THƯỜNG" : "QUÁN ĐÔNG KHÁCH");
}

function calculateTableStats(tableId) {
    let total = 0, foodQty = 0, drinkQty = 0;
    const serverOrder = data.orders?.[tableId];
    const pendingOrder = pendingDeltas[tableId];

    if (serverOrder && typeof serverOrder === 'object') {
        for (const id in serverOrder) {
            const itemId = Number(id);
            const item = ITEM_MAP.get(itemId);
            if (!item) continue;
            const qty = Math.max(0, (Number(serverOrder[id]) || 0) + (Number(pendingOrder?.[id]) || 0));
            if (qty <= 0) continue;
            total += item.price * qty;
            if (DRINK_ITEM_IDS.has(itemId)) drinkQty += qty;
            else foodQty += qty;
        }
    }

    if (pendingOrder && typeof pendingOrder === 'object') {
        for (const id in pendingOrder) {
            if (serverOrder && Object.prototype.hasOwnProperty.call(serverOrder, id)) continue;
            const itemId = Number(id);
            const item = ITEM_MAP.get(itemId);
            if (!item) continue;
            const qty = Math.max(0, Number(pendingOrder[id]) || 0);
            if (qty <= 0) continue;
            total += item.price * qty;
            if (DRINK_ITEM_IDS.has(itemId)) drinkQty += qty;
            else foodQty += qty;
        }
    }

    return { total, foodQty, drinkQty };
}

function renderAllTables() {
    if (!isInitialDataReady) return;
    TABLE_IDS.forEach(i => {
        const dom = TABLE_DOM[i];
        if (!dom) return;
        const { total, foodQty, drinkQty } = calculateTableStats(i);

        dom.sum.classList.remove('skeleton');
        dom.time.classList.remove('skeleton');
        animateNumber(`sum-${i}`, total);

        let metaText = '';
        if (foodQty > 0 && drinkQty > 0) metaText = `${foodQty} món · ${drinkQty} nước`;
        else if (foodQty > 0) metaText = `${foodQty} món`;
        else if (drinkQty > 0) metaText = `${drinkQty} nước`;
        dom.meta.textContent = metaText;

        const locked = Boolean(data.locked?.[i]);
        let className = 'table-card';
        if (i === currentTab) className += ' active';
        if (i === 7) className += ' full-width';
        if (i >= 8) className += ' half-width';
        if (locked) className += ' is-locked';
        else if (total > 0) className += ' has-guest';
        if (dom.card.classList.contains('flash-add')) className += ' flash-add';
        if (dom.card.classList.contains('flash-sub')) className += ' flash-sub';
        if (dom.card.classList.contains('has-viewer')) className += ' has-viewer';
        if (dom.card.classList.contains('is-remote-paying')) className += ' is-remote-paying';
        dom.card.className = className;

        const timeVal = data.times?.[i];
        if (total > 0 && timeVal) {
            dom.time.innerText = timeVal;
            dom.time.style.visibility = 'visible';
        } else {
            dom.time.innerText = '00:00';
            dom.time.style.visibility = 'hidden';
        }
    });
}

// ==========================================
// 10. ANIMATION & HIỆU ỨNG TRỰC QUAN
// ==========================================
function runPaperFlipIntro() {
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
        document.documentElement.classList.remove('paper-flip-pending');
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'paper-flip-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(overlay);

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isSmall = vw <= 380;

    const topIds = ['weather-hub', 'presence-count', 'sound-toggle', 'dark-toggle'];
    const headerIds = ['load-speed-widget', 'crowd-status', 'net-speed-widget'];
    const titleEl = document.querySelector('.header-title');
    const clockEls = Array.from(document.querySelectorAll('.flip-clock-container > .flip-unit, .flip-clock-container > .flip-colon'));
    const marketIds = ['btc-ticker', 'oil-ticker'];

    const topEls = topIds.map(id => document.getElementById(id)).filter(Boolean);
    const headerEls = headerIds.map(id => document.getElementById(id)).filter(Boolean);
    const marketEls = marketIds.map(id => document.getElementById(id)).filter(Boolean);

    const allIntroEls = [
        ...topEls,
        ...headerEls,
        ...(titleEl ? [titleEl] : []),
        ...clockEls,
        ...marketEls
    ];

    allIntroEls.forEach(el => {
        el.style.visibility = 'hidden';
    });
    document.documentElement.classList.remove('paper-flip-pending');

    function spawnPaperWisps(rect, count) {
        const cx = rect.left + rect.width * 0.5;
        const cy = rect.top + rect.height * 0.5;
        for (let i = 0; i < count; i++) {
            const wisp = document.createElement('div');
            wisp.className = 'single-paper-wisp';
            const sx = cx + (Math.random() - 0.5) * Math.min(rect.width * 0.65, 54);
            const sy = cy + (Math.random() - 0.5) * Math.min(rect.height * 0.45, 24);
            const driftX = (Math.random() - 0.5) * 44;
            const driftY = -12 - Math.random() * 24;
            const rotStart = (Math.random() - 0.5) * 40;
            const rotEnd = rotStart + (Math.random() > 0.5 ? 130 : -130);

            wisp.style.left = sx + 'px';
            wisp.style.top = sy + 'px';
            overlay.appendChild(wisp);

            wisp.animate([
                { opacity: 0, transform: `translate3d(0, 0, 0) rotate(${rotStart}deg) scale(0.45)` },
                { opacity: 0.72, transform: `translate3d(${driftX * 0.35}px, ${driftY * 0.35}px, 0) rotate(${rotStart + 35}deg) scale(1)`, offset: 0.25 },
                { opacity: 0.36, transform: `translate3d(${driftX * 0.75}px, ${driftY * 0.75}px, 0) rotate(${rotStart + 85}deg) scale(0.82)`, offset: 0.68 },
                { opacity: 0, transform: `translate3d(${driftX}px, ${driftY}px, 0) rotate(${rotEnd}deg) scale(0.45)` }
            ], {
                duration: 460 + Math.random() * 140,
                easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
                fill: 'forwards'
            });
        }
    }

    function animateSingleSheet(el, {
        delay = 0,
        duration = 560,
        foldAxis = 'X',
        startAngle = 82,
        origin = 'center top',
        slideX = 0,
        slideY = -12,
        wispCount = 0
    } = {}) {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            el.style.visibility = '';
            return;
        }

        el.style.visibility = 'visible';
        el.classList.add('single-fold-active');
        el.style.transformOrigin = origin;

        const rotMid = foldAxis === 'Y'
            ? `rotateY(${-startAngle * 0.14}deg)`
            : `rotateX(${-startAngle * 0.14}deg)`;
        const rotStart = foldAxis === 'Y'
            ? `rotateY(${startAngle}deg)`
            : `rotateX(${startAngle}deg)`;
        const rotEnd = foldAxis === 'Y' ? 'rotateY(0deg)' : 'rotateX(0deg)';

        const anim = el.animate([
            {
                opacity: 0,
                transform: `perspective(920px) translate3d(${slideX}px, ${slideY}px, -18px) ${rotStart} scale(0.92)`
            },
            {
                opacity: 1,
                transform: `perspective(920px) translate3d(${-slideX * 0.08}px, ${-slideY * 0.10}px, 4px) ${rotMid} scale(1.012)`,
                offset: 0.72
            },
            {
                opacity: 1,
                transform: `perspective(920px) translate3d(0px, 0px, 0px) ${rotEnd} scale(1)`
            }
        ], {
            duration,
            delay,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            fill: 'both'
        });

        if (wispCount > 0) {
            setTimeout(() => spawnPaperWisps(rect, wispCount), delay + 45);
        }

        anim.onfinish = () => {
            el.classList.remove('single-fold-active');
            el.style.transformOrigin = '';
            el.style.visibility = '';
            anim.cancel();
        };
    }

    topEls.forEach((el, idx) => {
        const fromLeft = idx === 0;
        animateSingleSheet(el, {
            delay: idx * 45,
            duration: 500,
            foldAxis: 'X',
            startAngle: 76,
            origin: 'center top',
            slideX: fromLeft ? -14 : 14,
            slideY: -10,
            wispCount: idx === 0 ? 1 : 0
        });
    });

    headerEls.forEach((el, idx) => {
        const isLeft = el.id === 'load-speed-widget';
        const isRight = el.id === 'net-speed-widget';
        animateSingleSheet(el, {
            delay: 110 + idx * 55,
            duration: 540,
            foldAxis: isLeft || isRight ? 'Y' : 'X',
            startAngle: isLeft ? -74 : (isRight ? 74 : 78),
            origin: isLeft ? 'left center' : (isRight ? 'right center' : 'center top'),
            slideX: isLeft ? -14 : (isRight ? 14 : 0),
            slideY: -10,
            wispCount: !isLeft && !isRight ? 1 : 0
        });
    });

    if (titleEl) {
        animateSingleSheet(titleEl, {
            delay: 240,
            duration: 640,
            foldAxis: 'X',
            startAngle: 86,
            origin: 'center top',
            slideX: 0,
            slideY: -14,
            wispCount: isSmall ? 2 : 3
        });
    }

    const midIdx = (clockEls.length - 1) / 2;
    clockEls.forEach((el, idx) => {
        const distFromCenter = Math.abs(idx - midIdx);
        const isUnit = el.classList.contains('flip-unit');
        animateSingleSheet(el, {
            delay: 360 + distFromCenter * 48,
            duration: 580,
            foldAxis: 'X',
            startAngle: 88,
            origin: 'center top',
            slideX: (idx - midIdx) * 4,
            slideY: -12,
            wispCount: isUnit && (idx === 0 || idx === clockEls.length - 1) ? 1 : 0
        });
    });

    marketEls.forEach((el, idx) => {
        const isLeft = idx === 0;
        animateSingleSheet(el, {
            delay: 520 + idx * 65,
            duration: 560,
            foldAxis: 'Y',
            startAngle: isLeft ? -76 : 76,
            origin: isLeft ? 'left center' : 'right center',
            slideX: isLeft ? -16 : 16,
            slideY: 8,
            wispCount: 1
        });
    });

    setTimeout(() => {
        allIntroEls.forEach(el => {
            el.classList.remove('single-fold-active');
            el.style.transformOrigin = '';
            el.style.visibility = '';
        });
        overlay.remove();
    }, 1720);
}

runPaperFlipIntro();

const numAnimTokens = {};
const numCurrentValues = {};
function animateNumber(elId, newValue) {
    const el = document.getElementById(elId);
    if (!el) return;
    const hasKnownStart = Object.prototype.hasOwnProperty.call(numCurrentValues, elId);
    const start = hasKnownStart
        ? numCurrentValues[elId]
        : (parseInt(el.textContent.replace(/[^\d]/g, ''), 10) || 0);
    if (start === newValue) {
        numCurrentValues[elId] = newValue;
        el.textContent = formatCurrency(newValue);
        return;
    }
    if (!hasKnownStart && newValue === 0) {
        numCurrentValues[elId] = 0;
        el.textContent = '0đ';
        return;
    }
    const token = Symbol();
    numAnimTokens[elId] = token;
    const duration = 750;
    const startTime = performance.now();
    const formatter = new Intl.NumberFormat('vi-VN');
    function update(now) {
        if (numAnimTokens[elId] !== token) return;
        const progress = Math.min((now - startTime) / duration, 1);
        const ease = 1 - Math.pow(1 - progress, 4);
        let current = Math.round(start + (newValue - start) * ease);
        if (progress < 1 && progress > 0.85) {
            current = Math.round(current / 1000) * 1000;
        }
        numCurrentValues[elId] = current;
        el.textContent = formatter.format(current) + 'đ';
        if (progress < 1) requestAnimationFrame(update);
        else {
            numCurrentValues[elId] = newValue;
            el.textContent = formatter.format(newValue) + 'đ';
        }
    }
    requestAnimationFrame(update);
}

document.addEventListener('click', e => {
    const btn = e.target.closest('.btn-qty, .btn-action, .lang-btn');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX ? (e.clientX - rect.left - size / 2) : (rect.width / 2 - size / 2);
    const y = e.clientY ? (e.clientY - rect.top - size / 2) : (rect.height / 2 - size / 2);
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px;`;
    btn.style.position = 'relative';
    btn.style.overflow = 'hidden';
    btn.appendChild(ripple);
    ripple.animate(
        [{ transform: 'scale(0)', opacity: 0.75 }, { transform: 'scale(2.5)', opacity: 0 }],
        { duration: 500, easing: 'ease-out', fill: 'forwards' }
    ).onfinish = () => ripple.remove();
});

// ==========================================
// 11. CHỌN BÀN, GỌI MÓN, CHỐT BILL & THANH TOÁN
// ==========================================
function selectTable(n, options = {}) {
    const { skipBroadcast = false } = options;
    if (!isInitialDataReady) {
        const dom = TABLE_DOM[n];
        if (dom) {
            dom.card.classList.remove('is-loading-tap');
            void dom.card.offsetWidth;
            dom.card.classList.add('is-loading-tap');
            clearTimeout(dom.loadingTapTimer);
            dom.loadingTapTimer = setTimeout(() => dom.card.classList.remove('is-loading-tap'), 360);
        }
        showToast('Đang tải dữ liệu bàn từ máy chủ, vui lòng đợi...', 'warning', 1800, {
            loading: true,
            key: 'loading-tables'
        });
        return;
    }

    currentTab = n;
    if (Boolean(data.locked?.[n])) {
        loadDictModule();
    }
    document.getElementById('current-table-title').innerText = "BẠN ĐANG CHỌN: " + TABLE_NAMES[n];
    renderAllTables();
    const orderSec = document.getElementById('order-section');
    orderSec.classList.remove('section-visible');
    void orderSec.offsetWidth;
    renderCurrentOrder();
    orderSec.classList.add('section-visible');
    syncSessionViews(getServerNow(), { cursors: false, presence: false, cleanup: false });
    if (!skipBroadcast && isFirebaseConnected) {
        update(mySessionRef, buildPresencePayload({ table: n, itemId: null })).catch(() => {});
    }
}

function renderCurrentOrder() {
    const isLocked = Boolean(data.locked?.[currentTab]);
    const remotePaying = isTableRemotePaying(currentTab);
    const mergedOrder = getMergedOrder(currentTab);

    MENU.forEach(item => {
        const dom = ITEM_DOM[item.id];
        if (!dom) return;
        const q = Math.max(0, Number(mergedOrder[item.id]) || 0);
        if (dom.lastQty !== q) {
            dom.qty.innerText = q;
            dom.lastQty = q;
        }
        const level = q > 0 ? Math.min(q, 5) : 0;
        if (dom.lastLevel !== level) {
            dom.row.className = level > 0 ? `menu-item qty-${level}` : 'menu-item';
            dom.lastLevel = level;
        }
    });

    const menuBox = document.getElementById('menu-box');
    const billArea = document.getElementById('bill-area');
    const prevVisible = billArea.style.display === 'block';
    menuBox.style.display = isLocked ? 'none' : 'block';
    billArea.style.display = isLocked ? 'block' : 'none';

    const checkoutBtn = document.getElementById('btn-checkout');
    if (checkoutBtn) {
        checkoutBtn.disabled = remotePaying || !effectiveTableHasItems(currentTab);
    }

    syncCurrentTableRemotePayingUi(remotePaying);

    if (isLocked) {
        if (!prevVisible) {
            resetBillQrView();
            billArea.classList.remove('printing-out');
            void billArea.offsetWidth;
            billArea.classList.add('printing-out');
        }
        renderBillAsync(currentTab);
        hideScrollBtn();
    } else {
        resetBillQrView();
        if (checkoutBtn) setupCheckoutObserver(checkoutBtn);
    }
}

function getFormattedNowTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function flushTableDeltas(tab) {
    const queued = pendingDeltas[tab];
    if (!queued || Object.keys(queued).length === 0) return;
    if (inFlightTables[tab]) return;

    const batchToSend = { ...queued };
    delete pendingDeltas[tab];
    inFlightTables[tab] = true;

    const orderRef = ref(database, `orders/${tab}`);
    runTransaction(orderRef, (currentOrder) => {
        const nextOrder = currentOrder && typeof currentOrder === 'object' ? { ...currentOrder } : {};
        for (const [id, delta] of Object.entries(batchToSend)) {
            const currentQty = Number(nextOrder[id]) || 0;
            const updatedQty = Math.min(MAX_ITEM_QTY, Math.max(0, currentQty + Number(delta)));
            if (updatedQty > 0) nextOrder[id] = updatedQty;
            else delete nextOrder[id];
        }
        return Object.keys(nextOrder).length > 0 ? nextOrder : null;
    }).then((result) => {
        inFlightTables[tab] = false;
        const committedOrder = result.snapshot.val();
        if (committedOrder && typeof committedOrder === 'object') {
            data.orders[tab] = committedOrder;
        } else {
            delete data.orders[tab];
        }
        const hasAnyItem = Boolean(committedOrder && Object.keys(committedOrder).length > 0);
        if (hasAnyItem && !data.times?.[tab]) {
            const timeStr = getFormattedNowTime();
            data.times[tab] = timeStr;
            set(ref(database, `times/${tab}`), timeStr).catch(() => {});
        } else if (!hasAnyItem && data.times?.[tab]) {
            delete data.times[tab];
            set(ref(database, `times/${tab}`), null).catch(() => {});
        }
        renderAllTables();
        if (tab === currentTab) renderCurrentOrder();
        updateGuestStatus();

        if (pendingDeltas[tab] && Object.keys(pendingDeltas[tab]).length > 0) {
            flushTableDeltas(tab);
        }
    }).catch(() => {
        inFlightTables[tab] = false;
        if (!pendingDeltas[tab]) pendingDeltas[tab] = {};
        for (const [id, delta] of Object.entries(batchToSend)) {
            pendingDeltas[tab][id] = (pendingDeltas[tab][id] || 0) + Number(delta);
            if (pendingDeltas[tab][id] === 0) delete pendingDeltas[tab][id];
        }
        if (Object.keys(pendingDeltas[tab]).length === 0) delete pendingDeltas[tab];
        showToast('Mạng chập chờn — món vừa bấm sẽ tự động đồng bộ lại!', 'warning', 2500);
        clearTimeout(pendingFlushTimers[tab]);
        pendingFlushTimers[tab] = setTimeout(() => flushTableDeltas(tab), 1200);
    });
}

function change(id, delta) {
    if (!isInitialDataReady) {
        showToast('Đang tải dữ liệu bàn từ máy chủ, vui lòng đợi...', 'warning', 1800, {
            loading: true,
            key: 'loading-tables'
        });
        return;
    }
    const tab = currentTab;
    if (data.locked?.[tab]) return;
    if (isTableRemotePaying(tab)) {
        showToast('Thiết bị khác đang mở bill thu tiền bàn này!', 'warning', 2400);
        return;
    }

    const currentEffectiveQty = getEffectiveOrderQty(tab, id);
    if (delta < 0 && currentEffectiveQty <= 0) return;
    if (delta > 0 && currentEffectiveQty >= MAX_ITEM_QTY) return;

    playUiSound(delta > 0 ? 'add' : 'sub');
    broadcastMyFocus(id);

    const hadAnyItemBefore = effectiveTableHasItems(tab);
    if (!pendingDeltas[tab]) pendingDeltas[tab] = {};
    pendingDeltas[tab][id] = (pendingDeltas[tab][id] || 0) + delta;
    if (pendingDeltas[tab][id] === 0) delete pendingDeltas[tab][id];
    if (Object.keys(pendingDeltas[tab]).length === 0) delete pendingDeltas[tab];

    const hasAnyItemAfter = effectiveTableHasItems(tab);
    if (!hadAnyItemBefore && hasAnyItemAfter && !data.times?.[tab]) {
        const timeStr = getFormattedNowTime();
        data.times[tab] = timeStr;
        set(ref(database, `times/${tab}`), timeStr).catch(() => {});
    } else if (hadAnyItemBefore && !hasAnyItemAfter && data.times?.[tab]) {
        delete data.times[tab];
        set(ref(database, `times/${tab}`), null).catch(() => {});
    }

    triggerTableFlash(tab, delta > 0 ? 'add' : 'sub');
    renderAllTables();
    renderCurrentOrder();
    updateGuestStatus();

    clearTimeout(pendingFlushTimers[tab]);
    pendingFlushTimers[tab] = setTimeout(() => flushTableDeltas(tab), 90);
}

window.addEventListener('beforeunload', () => {
    TABLE_IDS.forEach(tab => {
        if (pendingDeltas[tab] && Object.keys(pendingDeltas[tab]).length > 0) {
            flushTableDeltas(tab);
        }
    });
});

function setLock(v) {
    if (!isInitialDataReady) return;
    const tab = currentTab;
    if (isTableRemotePaying(tab)) {
        showToast('Thiết bị khác đang thu tiền bàn này, không thể thao tác!', 'warning', 2600);
        return;
    }
    if (v) {
        if (!effectiveTableHasItems(tab)) {
            showToast('Bàn chưa có món nào để chốt đơn!', 'warning');
            return;
        }
        playUiSound('lock');
        loadDictModule();
    }
    flushTableDeltas(tab);
    data.locked[tab] = v;
    renderAllTables();
    renderCurrentOrder();
    set(ref(database, `locked/${tab}`), v).catch(() => {
        showToast('Không thể lưu trạng thái chốt đơn, kiểm tra mạng!', 'error');
    });
}

function getBillShellElements() {
    return {
        shell: document.getElementById('bill-flip-shell'),
        front: document.getElementById('bill-front-face'),
        back: document.getElementById('bill-back-face'),
        qrBtn: document.getElementById('btn-toggle-qr'),
        qrLabel: document.getElementById('btn-toggle-qr-label')
    };
}

function buildDynamicVietQrUrl(amount, tableId) {
    const cleanAmount = Math.max(0, Math.round(Number(amount) || 0));
    const tableLabel = (TABLE_NAMES[tableId] || `BAN ${tableId}`)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .replace(/[^a-zA-Z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
    const addInfo = `${tableLabel} THANH TOAN`.slice(0, 50);
    const params = new URLSearchParams({
        amount: String(cleanAmount),
        addInfo,
        accountName: VIETQR_ACCOUNT_NAME
    });
    return `https://img.vietqr.io/image/${VIETQR_BANK_BIN}-${VIETQR_ACCOUNT_NO}-${VIETQR_TEMPLATE}.png?${params.toString()}`;
}

function loadDynamicQrCandidate(qrImg, url, token, onReady) {
    if (!url) {
        onReady(false);
        return;
    }
    const probe = new Image();
    let settled = false;
    const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (token !== qrLoadRequestToken) return;
        if (ok) {
            lastLoadedDynamicQrUrl = url;
            qrImg.src = url;
        }
        onReady(ok);
    };
    const timeoutId = setTimeout(() => finish(false), 3800);
    probe.onload = () => finish(probe.naturalWidth > 0);
    probe.onerror = () => finish(false);
    probe.src = url;
}

function updateDynamicPaymentQr(totalAmount, tableId) {
    const qrImg = document.getElementById('payment-qr');
    if (!qrImg) return;

    const cleanAmount = Math.max(0, Math.round(Number(totalAmount) || 0));
    const currentAmount = Number(qrImg.dataset.qrAmount || -1);
    const currentTable = Number(qrImg.dataset.qrTable || -1);
    if (currentAmount === cleanAmount && currentTable === tableId && qrImg.getAttribute('src')) {
        return;
    }

    qrImg.dataset.qrAmount = String(cleanAmount);
    qrImg.dataset.qrTable = String(tableId);

    if (cleanAmount <= 0) {
        qrImg.src = STATIC_QR_FALLBACK;
        return;
    }

    const dynamicUrl = buildDynamicVietQrUrl(cleanAmount, tableId);
    if (lastLoadedDynamicQrUrl === dynamicUrl) {
        qrImg.src = dynamicUrl;
        return;
    }

    const token = ++qrLoadRequestToken;
    qrImg.src = STATIC_QR_FALLBACK;

    loadDynamicQrCandidate(qrImg, dynamicUrl, token, (ok) => {
        if (ok && currentQrMode === 'qr') {
            syncBillFlipHeight(true);
        }
    });
}

function activeBillFaceHeight(mode = currentQrMode) {
    const { front, back } = getBillShellElements();
    const face = mode === 'qr' ? back : front;
    if (!face) return 0;
    const h = Math.ceil(face.offsetHeight || face.getBoundingClientRect().height);
    if (h > 0) return h;
    const content = face.querySelector('.bill-box');
    return content ? Math.ceil(content.offsetHeight + 16) : 0;
}

function syncBillFlipHeight(immediate = false) {
    const { shell } = getBillShellElements();
    if (!shell) return;
    const targetHeight = activeBillFaceHeight(currentQrMode);
    if (!targetHeight) return;
    if (immediate) {
        const prevTransition = shell.style.transition;
        shell.style.transition = 'none';
        shell.style.height = `${targetHeight}px`;
        void shell.offsetHeight;
        shell.style.transition = prevTransition;
    } else {
        shell.style.height = `${targetHeight}px`;
    }
}

function resetBillQrView() {
    const { shell, back, qrBtn, qrLabel } = getBillShellElements();
    currentQrMode = 'bill';
    if (shell) {
        shell.classList.remove('is-qr');
        shell.style.height = '';
    }
    if (back) back.setAttribute('aria-hidden', 'true');
    if (qrBtn) qrBtn.classList.remove('is-qr-active');
    if (qrLabel) qrLabel.textContent = 'MÃ QR';
    if (isSelfPaying) setSelfPayingState(false);
}

let qrScrollAnimId = null;
function animateScrollToQrCenter(targetEl, duration = 640) {
    if (!targetEl) return;
    if (qrScrollAnimId) {
        cancelAnimationFrame(qrScrollAnimId);
        qrScrollAnimId = null;
    }
    const startY = window.scrollY || window.pageYOffset;
    const rect = targetEl.getBoundingClientRect();
    const elCenterY = startY + rect.top + rect.height / 2;
    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const targetY = Math.min(maxScrollY, Math.max(0, elCenterY - window.innerHeight / 2));
    const distance = targetY - startY;
    if (Math.abs(distance) < 4) return;

    const startTime = performance.now();
    const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        window.scrollTo(0, startY + distance * easeInOutCubic(progress));
        if (progress < 1) {
            qrScrollAnimId = requestAnimationFrame(step);
        } else {
            qrScrollAnimId = null;
        }
    }
    qrScrollAnimId = requestAnimationFrame(step);
}

function toggleBillQr() {
    const { shell, back, qrBtn, qrLabel } = getBillShellElements();
    if (!shell || !back || !qrBtn) return;
    const nextIsQr = currentQrMode !== 'qr';
    if (nextIsQr && isTableRemotePaying(currentTab)) {
        showToast('Thiết bị khác đang mở bill thu tiền bàn này!', 'warning', 2500);
        return;
    }
    const currentHeight = Math.ceil(shell.getBoundingClientRect().height) || activeBillFaceHeight(currentQrMode);
    if (currentHeight > 0) shell.style.height = `${currentHeight}px`;
    void shell.offsetHeight;

    currentQrMode = nextIsQr ? 'qr' : 'bill';
    setSelfPayingState(nextIsQr);
    back.setAttribute('aria-hidden', nextIsQr ? 'false' : 'true');
    const targetHeight = activeBillFaceHeight(currentQrMode);
    if (targetHeight > 0) shell.style.height = `${targetHeight}px`;
    shell.classList.toggle('is-qr', nextIsQr);
    qrBtn.classList.toggle('is-qr-active', nextIsQr);
    if (qrLabel) qrLabel.textContent = nextIsQr ? 'XEM BILL' : 'MÃ QR';
    if (nextIsQr) {
        setTimeout(() => animateScrollToQrCenter(shell, 640), 140);
    }
}

const paymentQrImg = document.getElementById('payment-qr');
if (paymentQrImg) {
    paymentQrImg.addEventListener('load', () => {
        if (currentQrMode === 'qr') syncBillFlipHeight(true);
    });
    paymentQrImg.addEventListener('error', () => {
        if (!paymentQrImg.src.endsWith('qr-thanh-toan.png')) {
            paymentQrImg.src = STATIC_QR_FALLBACK;
        }
    });
}
window.addEventListener('resize', () => {
    const billArea = document.getElementById('bill-area');
    if (billArea && billArea.style.display === 'block') syncBillFlipHeight(true);
});

async function renderBillAsync(tab = currentTab) {
    const token = ++billRenderToken;
    const t = await getBillTexts(billLang);
    if (token !== billRenderToken || tab !== currentTab) return;

    const billAreaEl = document.getElementById('bill-area');
    if (billAreaEl) billAreaEl.dataset.billLang = billLang;

    document.getElementById('txt-lang-flag').innerText = LANG_FLAGS[billLang] || LANG_FLAGS[DEFAULT_BILL_LANG];
    document.getElementById('txt-total-label').innerText = t.total;

    const list = document.getElementById('bill-items');
    list.innerHTML = '';
    let total = 0, count = 0;

    const mergedOrder = getMergedOrder(tab);
    for (const id in mergedOrder) {
        const item = ITEM_MAP.get(Number(id));
        const q = Math.max(0, Number(mergedOrder[id]) || 0);
        if (!item || q <= 0) continue;
        const sub = item.price * q;
        total += sub;
        const row = document.createElement('div');
        row.className = 'bill-row';
        row.style.animationDelay = `${count * 0.05}s`;
        const itemName = billLang === 'vi' ? item.name : (t[item.id] || item.name);
        row.innerHTML = `<span class="item-name">${itemName}</span><span class="item-qty">x${q}</span><span class="divider"></span><span class="item-price">${formatCurrency(sub)}</span>`;
        list.appendChild(row);
        count++;
    }

    if (count === 0) {
        list.innerHTML = `<p style="text-align:center;color:var(--text-muted)">${t.empty}</p>`;
    }

    const totalEl = document.getElementById('bill-total');
    totalEl.classList.remove('total-pop');
    void totalEl.offsetWidth;
    totalEl.classList.add('total-pop');
    animateNumber('bill-total', total);
    updateDynamicPaymentQr(total, tab);
    document.getElementById('txt-thanks').innerText = t.thanks;
    syncBillFlipHeight(true);
}

function setLang(l) {
    billLang = l;
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active-lang', btn.dataset.lang === l);
    });
    renderBillAsync(currentTab);
}

async function doPay() {
    if (!isInitialDataReady) return;
    const tab = currentTab;
    if (isTableRemotePaying(tab)) {
        showToast('Thiết bị khác đang thu tiền bàn này, vui lòng chờ!', 'warning', 2600);
        return;
    }
    const { total, foodQty, drinkQty } = calculateTableStats(tab);
    if (total <= 0) {
        showToast('Bàn đang trống, không có món để thanh toán!', 'warning');
        return;
    }

    const wasSelfPaying = isSelfPaying;
    if (!wasSelfPaying) setSelfPayingState(true);

    const confirmed = await showConfirmModal({
        title: `Xác nhận thanh toán ${TABLE_NAMES[tab]}`,
        message: `Tổng cộng ${foodQty + drinkQty} phần — Thành tiền: ${formatCurrency(total)}. Xóa đơn bàn này sau khi thu tiền?`,
        confirmText: 'Đã thu tiền',
        cancelText: 'Quay lại'
    });
    if (!confirmed) {
        if (!wasSelfPaying && currentQrMode !== 'qr') {
            setSelfPayingState(false);
        }
        return;
    }

    playUiSound('pay');

    const expectedOrder = JSON.parse(JSON.stringify(getMergedOrder(tab)));
    delete pendingDeltas[tab];
    clearTimeout(pendingFlushTimers[tab]);
    delete data.orders[tab];
    data.locked[tab] = false;
    delete data.times[tab];

    if (prevRemoteSnapshot && prevRemoteSnapshot[tab]) {
        delete prevRemoteSnapshot[tab];
    }

    setSelfPayingState(false);

    renderAllTables();
    renderCurrentOrder();
    updateGuestStatus();

    const orderRef = ref(database, `orders/${tab}`);
    runTransaction(orderRef, (remoteOrder) => {
        const currentRemote = remoteOrder && typeof remoteOrder === 'object' ? remoteOrder : {};
        const remaining = {};
        let hasExtraItems = false;

        for (const [id, remoteQtyRaw] of Object.entries(currentRemote)) {
            const remoteQty = Number(remoteQtyRaw) || 0;
            const paidQty = Number(expectedOrder[id]) || 0;
            const diff = remoteQty - paidQty;
            if (diff > 0) {
                remaining[id] = diff;
                hasExtraItems = true;
            }
        }
        return hasExtraItems ? remaining : null;
    }).then((result) => {
        const remainingOrder = result.snapshot.val();
        if (remainingOrder && typeof remainingOrder === 'object' && Object.keys(remainingOrder).length > 0) {
            data.orders[tab] = remainingOrder;
            showToast('Phát hiện có món mới gọi thêm trong lúc thanh toán — đã giữ lại món mới!', 'warning', 3200);
        } else {
            delete data.orders[tab];
            set(ref(database, `times/${tab}`), null).catch(() => {});
            showToast(`Đã thanh toán xong ${TABLE_NAMES[tab]}!`, 'info', 2000);
        }
        set(ref(database, `locked/${tab}`), false).catch(() => {});
        renderAllTables();
        if (tab === currentTab) renderCurrentOrder();
        updateGuestStatus();
    }).catch(() => {
        showToast('Lỗi kết nối khi thanh toán — vui lòng kiểm tra lại mạng!', 'error', 3500);
    });
}

// ==========================================
// 12. CURSOR ĐỒNG NGHIỆP & HAO QUANG BÀN (ĐỒNG BỘ SERVER TIME)
// ==========================================
function removeRemoteCursorEl(id) {
    if (remoteCursorEls[id]) {
        remoteCursorEls[id].remove();
        delete remoteCursorEls[id];
    }
}

function resetRemoteCursors() {
    Object.keys(remoteCursorEls).forEach(removeRemoteCursorEl);
    TABLE_IDS.forEach(i => {
        const dom = TABLE_DOM[i];
        if (!dom) return;
        dom.card.classList.remove('has-viewer', 'is-remote-paying');
        dom.card.style.removeProperty('--viewer-color');
        if (dom.payingBadge) dom.payingBadge.style.display = 'none';
    });
    Object.keys(remoteFocusRows).forEach(clearRemoteFocusEntry);
    Object.keys(remotePayingExpireTimers).forEach(id => {
        clearTimeout(remotePayingExpireTimers[id]);
        delete remotePayingExpireTimers[id];
    });
    syncCurrentTableRemotePayingUi(false);
}

const cursorPosCache = {};
const tableRectCache = {};
let tableRectCacheDirty = true;
let cursorRafPending = false;

function invalidateTableRectCache() {
    tableRectCacheDirty = true;
}

function getCachedTableCenter(tableId) {
    if (tableRectCacheDirty || !tableRectCache[tableId]) {
        TABLE_IDS.forEach(id => {
            const dom = TABLE_DOM[id];
            if (!dom) return;
            const rect = dom.card.getBoundingClientRect();
            tableRectCache[id] = {
                x: rect.left + rect.width * 0.5,
                y: rect.top + rect.height * 0.5,
                valid: rect.width > 0 && rect.height > 0
            };
        });
        tableRectCacheDirty = false;
    }
    return tableRectCache[tableId];
}

function scheduleRenderRemoteCursors(remeasure = false) {
    if (remeasure) invalidateTableRectCache();
    if (cursorRafPending) return;
    cursorRafPending = true;
    requestAnimationFrame(() => {
        cursorRafPending = false;
        renderRemoteCursors();
    });
}

function spawnCursorTrail(x, y, color) {
    if (document.hidden) return;
    const trail = document.createElement('div');
    trail.className = 'cursor-trail';
    trail.style.left = x + 'px';
    trail.style.top = y + 'px';
    trail.style.background = color;
    document.body.appendChild(trail);
    trail.animate(
        [{ transform: 'translate(-50%,-50%) scale(1)', opacity: 0.55 },
         { transform: 'translate(-50%,-50%) scale(0.1)', opacity: 0 }],
        { duration: 480, easing: 'ease-out', fill: 'forwards' }
    ).onfinish = () => trail.remove();
}

function renderRemoteCursors(now = getServerNow(), state = null) {
    const snap = state || collectSessionState(now);
    const activeIds = new Set();
    const tableViewers = {};

    snap.cursors.forEach(([id, s]) => {
        const tableNum = Number(s.table);
        activeIds.add(id);
        const color = s.color || '#e91e63';
        tableViewers[tableNum] = color;

        const center = getCachedTableCenter(tableNum);
        if (!center || !center.valid) return;

        let el = remoteCursorEls[id];
        const isNew = !el;
        if (isNew) {
            el = document.createElement('div');
            el.className = 'remote-cursor';
            document.body.appendChild(el);
            remoteCursorEls[id] = el;
        }
        el.style.background = color;
        const x = center.x;
        const y = center.y;

        const prev = cursorPosCache[id];
        const moved = prev && (Math.abs(prev.x - x) > 1 || Math.abs(prev.y - y) > 1);
        cursorPosCache[id] = { x, y };

        if (isNew) {
            el.style.left = x + 'px';
            el.style.top = y + 'px';
            requestAnimationFrame(() => el.classList.add('visible'));
        } else {
            if (moved && prev) spawnCursorTrail(prev.x, prev.y, color);
            el.style.left = x + 'px';
            el.style.top = y + 'px';
        }
    });

    Object.keys(remoteCursorEls).forEach(id => {
        if (!activeIds.has(id)) {
            removeRemoteCursorEl(id);
            delete cursorPosCache[id];
        }
    });

    TABLE_IDS.forEach(i => {
        const dom = TABLE_DOM[i];
        if (!dom) return;
        if (tableViewers[i]) {
            dom.card.classList.add('has-viewer');
            dom.card.style.setProperty('--viewer-color', tableViewers[i]);
        } else {
            dom.card.classList.remove('has-viewer');
            dom.card.style.removeProperty('--viewer-color');
        }
    });
}

function clearRemoteFocusEntry(id) {
    clearTimeout(remoteFocusExpireTimers[id]);
    delete remoteFocusExpireTimers[id];
    const row = remoteFocusRows[id];
    if (row) {
        row.classList.remove('remote-focus');
        row.style.removeProperty('--focus-color');
        const tag = row.querySelector('.remote-focus-tag');
        if (tag) tag.remove();
        delete remoteFocusRows[id];
    }
}

function renderRemoteFocus(now = getServerNow(), state = null) {
    const snap = state || collectSessionState(now);
    const focusById = new Map(snap.focuses);

    Object.keys(remoteFocusRows).forEach(id => {
        const entry = focusById.get(id);
        if (!entry || Number(entry.table) !== currentTab) {
            clearRemoteFocusEntry(id);
        }
    });

    snap.focuses.forEach(([id, s]) => {
        const remainingMs = Math.max(80, FOCUS_TTL_MS - Math.max(0, now - Number(s.ts)));
        clearTimeout(remoteFocusExpireTimers[id]);
        remoteFocusExpireTimers[id] = setTimeout(() => {
            clearRemoteFocusEntry(id);
        }, remainingMs);

        if (Number(s.table) !== currentTab) return;
        const dom = ITEM_DOM[Number(s.itemId)];
        if (!dom) return;
        const row = dom.row;
        const prev = remoteFocusRows[id];
        if (prev && prev !== row) clearRemoteFocusEntry(id);
        remoteFocusRows[id] = row;
        const color = s.color || '#e91e63';
        row.classList.add('remote-focus');
        row.style.setProperty('--focus-color', color);
        let tag = row.querySelector('.remote-focus-tag');
        if (!tag) {
            tag = document.createElement('span');
            tag.className = 'remote-focus-tag';
            tag.innerText = 'Đang chọn';
            row.appendChild(tag);
            requestAnimationFrame(() => tag.classList.add('visible'));
        }
        tag.style.background = color;
    });
}

function isTableRemotePaying(tableId, now = getServerNow()) {
    const targetTable = Number(tableId);
    let latestPaying = null;
    for (const id in sessionsMap) {
        if (id === mySessionId) continue;
        const s = sessionsMap[id];
        if (!s || typeof s !== 'object' || s.paying !== true) continue;
        if (Number(s.table) !== targetTable) continue;
        const ts = Number(s.ts);
        if (!Number.isFinite(ts) || (now - ts) >= PAYING_TTL_MS) continue;
        if (!latestPaying || ts > latestPaying.ts) {
            latestPaying = { id, table: targetTable, color: s.color || '#f59e0b', ts };
        }
    }
    return latestPaying;
}

function syncCurrentTableRemotePayingUi(isRemotePaying) {
    const banner = document.getElementById('remote-paying-banner');
    if (banner) {
        banner.classList.toggle('hidden', !isRemotePaying);
    }

    const checkoutBtn = document.getElementById('btn-checkout');
    if (checkoutBtn) {
        checkoutBtn.disabled = isRemotePaying || !effectiveTableHasItems(currentTab);
        checkoutBtn.classList.toggle('is-remote-paying-disabled', isRemotePaying);
    }

    const qrBtn = document.getElementById('btn-toggle-qr');
    const addMoreBtn = document.getElementById('btn-add-more');
    const payConfirmBtn = document.getElementById('btn-pay-confirm');
    [qrBtn, addMoreBtn, payConfirmBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = isRemotePaying;
        btn.classList.toggle('is-remote-paying-disabled', isRemotePaying);
    });
}

function renderRemotePaying(now = getServerNow(), state = null) {
    const snap = state || collectSessionState(now);
    const activePayingIds = new Set();

    snap.activePayingIds.forEach(([id, remainingMs]) => {
        activePayingIds.add(id);
        clearTimeout(remotePayingExpireTimers[id]);
        remotePayingExpireTimers[id] = setTimeout(() => {
            delete remotePayingExpireTimers[id];
            renderRemotePaying(getServerNow());
        }, remainingMs);
    });

    Object.keys(remotePayingExpireTimers).forEach(id => {
        if (!activePayingIds.has(id)) {
            clearTimeout(remotePayingExpireTimers[id]);
            delete remotePayingExpireTimers[id];
        }
    });

    TABLE_IDS.forEach(i => {
        const dom = TABLE_DOM[i];
        if (!dom) return;
        const payingInfo = snap.payingByTable.get(i);
        if (payingInfo) {
            dom.card.classList.add('is-remote-paying');
            if (dom.payingBadge) {
                dom.payingBadge.textContent = '💳 Đang thu tiền';
                dom.payingBadge.style.display = 'inline-flex';
            }
        } else {
            dom.card.classList.remove('is-remote-paying');
            if (dom.payingBadge) {
                dom.payingBadge.style.display = 'none';
            }
        }
    });

    syncCurrentTableRemotePayingUi(snap.payingByTable.has(currentTab));
}

function hasActiveRemoteCursors(now = getServerNow()) {
    for (const id in sessionsMap) {
        if (id === mySessionId) continue;
        const s = sessionsMap[id];
        if (!s || typeof s !== 'object') continue;
        const tableNum = Number(s.table);
        if (!Number.isInteger(tableNum) || tableNum < 1 || tableNum > 9) continue;
        const ts = Number(s.ts);
        if (!Number.isFinite(ts) || (now - ts) < STALE_CURSOR_MS) {
            return true;
        }
    }
    return false;
}

window.addEventListener('resize', () => {
    if (hasActiveRemoteCursors()) scheduleRenderRemoteCursors(true);
});

let scrollCursorTicking = false;
window.addEventListener('scroll', () => {
    if (!hasActiveRemoteCursors()) return;
    invalidateTableRectCache();
    if (!scrollCursorTicking) {
        scrollCursorTicking = true;
        requestAnimationFrame(() => {
            scrollCursorTicking = false;
            renderRemoteCursors();
        });
    }
}, { passive: true });

// ==========================================
// 13. NÚT CUỘN XUỐNG CHỐT BILL & HEARTBEAT
// ==========================================
const scrollBtn = document.getElementById('scroll-to-checkout');
scrollBtn.onclick = () => {
    const checkoutBtn = document.getElementById('btn-checkout');
    if (checkoutBtn) checkoutBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    hideScrollBtn();
};
function showScrollBtn() { scrollBtn.classList.remove('hidden'); }
function hideScrollBtn() { scrollBtn.classList.add('hidden'); }

let checkoutObserver = null;
function setupCheckoutObserver(targetEl) {
    if (checkoutObserver) checkoutObserver.disconnect();
    const rect = targetEl.getBoundingClientRect();
    if (rect.top >= window.innerHeight) showScrollBtn();
    else hideScrollBtn();
    checkoutObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting || entry.boundingClientRect.top < 0) hideScrollBtn();
            else showScrollBtn();
        });
    }, { threshold: 0.1 });
    checkoutObserver.observe(targetEl);
}

let heartbeatTimer = null;
function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
        if (!document.hidden && isFirebaseConnected) {
            update(mySessionRef, buildPresencePayload()).catch(() => {});
        }
    }, HEARTBEAT_INTERVAL_MS);
}
startHeartbeat();

document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('tab-hidden', document.hidden);
    setWeatherAnimationState(isWeatherInViewport && !document.hidden);
    if (!document.hidden) {
        lastClockTickSec = -1;
        tickClock();
        if (isFirebaseConnected) {
            registerPresence();
            bindActiveSessionsListeners();
        }
        startHeartbeat();
    } else {
        clearInterval(heartbeatTimer);
    }
});

// ==========================================
// 14. GẮN SỰ KIỆN CHO CÁC NÚT ĐIỀU KHIỂN
// ==========================================
document.getElementById('btn-checkout')?.addEventListener('click', () => setLock(true));
document.getElementById('btn-toggle-qr')?.addEventListener('click', () => toggleBillQr());
document.getElementById('btn-add-more')?.addEventListener('click', () => setLock(false));
document.getElementById('btn-pay-confirm')?.addEventListener('click', () => doPay());

document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        if (lang) setLang(lang);
    });
});

setTablesLoadingState(true);
showToast('Đang tải dữ liệu bàn từ máy chủ...', 'info', 0, {
    loading: true,
    key: 'loading-tables'
});
