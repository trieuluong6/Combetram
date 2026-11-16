import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
    getDatabase,
    ref,
    child,
    set as _fbSet,
    update as _fbUpdate,
    remove as _fbRemove,
    onValue as _fbOnValue,
    onChildAdded as _fbOnChildAdded,
    onChildChanged as _fbOnChildChanged,
    onChildRemoved as _fbOnChildRemoved,
    push as _fbPush,
    onDisconnect,
    runTransaction
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

import { menu } from "./menu.js?v=20261117";

const APP_BUILD_VERSION = '20261117';
const APP_VERSION_STORAGE_KEY = 'combetram_app_version';
const STATE_CACHE_KEY = 'combetram_state_cache_v1';

function reloadToBuildVersion(targetVer) {
    if (!targetVer) return;
    try {
        if (sessionStorage.getItem('combetram_reloaded_to_ver') === targetVer) return;
        sessionStorage.setItem('combetram_reloaded_to_ver', targetVer);
        localStorage.removeItem(STATE_CACHE_KEY);
        localStorage.setItem(APP_VERSION_STORAGE_KEY, targetVer);
        const url = new URL(window.location.href);
        url.searchParams.set('v', targetVer);
        window.location.replace(url.toString());
    } catch (e) {}
}

(function ensureBuildConsistency() {
    try {
        const storedVer = localStorage.getItem(APP_VERSION_STORAGE_KEY);
        if (storedVer !== APP_BUILD_VERSION) {
            localStorage.removeItem(STATE_CACHE_KEY);
            localStorage.setItem(APP_VERSION_STORAGE_KEY, APP_BUILD_VERSION);
        }
    } catch (e) {}

    const htmlVer = window.__APP_BUILD_VERSION;
    if (htmlVer && htmlVer !== APP_BUILD_VERSION) {
        const targetVer = htmlVer > APP_BUILD_VERSION ? htmlVer : APP_BUILD_VERSION;
        reloadToBuildVersion(targetVer);
    }
})();

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

// ─── CẤU HÌNH & TẠO MÃ VIETQR ĐỘNG THEO TỔNG BILL ────────────────────
const VIETQR_CONFIG = {
    bankId: 'TCB',                          // Techcombank (BIN: 970407)
    accountNo: 'MS00P00000000449397',        // Mã QR cửa hàng Quỳnh Trâm (trích xuất từ mã QR gốc)
    fallbackAccountNo: '1828591991',        // Số tài khoản Techcombank dự phòng
    accountName: 'LUONG THI QUYNH TRAM',    // Tên chủ tài khoản không dấu
    template: 'compact2'                    // 'compact2' | 'compact' | 'qr_only' | 'print'
};

let initialStaticQrSrc = '';
let parsedStaticVietQr = null;
let currentAppliedQrUrl = '';
let latestRequestedQrUrl = '';

(function captureInitialQrSource() {
    const qrImg = document.getElementById('payment-qr');
    if (!qrImg) return;
    initialStaticQrSrc = qrImg.getAttribute('src') || qrImg.src || '';
    const match = initialStaticQrSrc.match(/img\.vietqr\.io\/image\/([^-/?#]+)-([^-/?#]+)-([^.?#]+)\.(?:png|jpg|jpeg)/i);
    if (match) {
        let existingAccountName = '';
        try {
            const u = new URL(initialStaticQrSrc, window.location.href);
            existingAccountName = u.searchParams.get('accountName') || '';
        } catch (e) {}
        parsedStaticVietQr = {
            bankId: decodeURIComponent(match[1]),
            accountNo: decodeURIComponent(match[2]),
            template: decodeURIComponent(match[3]),
            accountName: existingAccountName
        };
    }
})();

function formatVietQrAddInfo(tab) {
    const raw = getTableDisplayName(tab)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .replace(/[^A-Za-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
    return (raw || `BAN ${tab}`).slice(0, 25);
}

function buildDynamicVietQrUrl(tab, amount, overrideAccountNo = '') {
    const cleanAmount = Math.max(0, Math.round(Number(amount) || 0));
    if (cleanAmount <= 0) return '';

    const bankId = (VIETQR_CONFIG.bankId || parsedStaticVietQr?.bankId || '').trim();
    const accountNo = (overrideAccountNo || VIETQR_CONFIG.accountNo || parsedStaticVietQr?.accountNo || '').trim();
    const template = (VIETQR_CONFIG.template || parsedStaticVietQr?.template || 'compact2').trim();
    const accountName = (VIETQR_CONFIG.accountName || parsedStaticVietQr?.accountName || '').trim();

    if (!bankId || !accountNo) return '';

    const params = new URLSearchParams();
    params.set('amount', String(cleanAmount));
    params.set('addInfo', formatVietQrAddInfo(tab));
    if (accountName) params.set('accountName', accountName);

    return `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-${encodeURIComponent(template)}.png?${params.toString()}`;
}

function loadDynamicQrCandidate(qrImg, candidates, idx = 0) {
    if (idx >= candidates.length) {
        latestRequestedQrUrl = '';
        if (initialStaticQrSrc && currentAppliedQrUrl !== initialStaticQrSrc) {
            currentAppliedQrUrl = initialStaticQrSrc;
            qrImg.src = initialStaticQrSrc;
        }
        return;
    }

    const url = candidates[idx];
    const loader = new Image();
    loader.onload = () => {
        if (latestRequestedQrUrl !== candidates[0]) return;
        currentAppliedQrUrl = url;
        qrImg.src = url;
        if (billViewMode === 'qr') {
            requestAnimationFrame(() => syncBillFlipHeight(true));
        }
    };
    loader.onerror = () => {
        if (latestRequestedQrUrl !== candidates[0]) return;
        loadDynamicQrCandidate(qrImg, candidates, idx + 1);
    };
    loader.src = url;
}

function updateDynamicVietQr(tab, totalAmount) {
    const qrImg = document.getElementById('payment-qr');
    if (!qrImg) return;

    const primaryUrl = buildDynamicVietQrUrl(tab, totalAmount);
    if (!primaryUrl) {
        latestRequestedQrUrl = '';
        if (initialStaticQrSrc && currentAppliedQrUrl !== initialStaticQrSrc) {
            currentAppliedQrUrl = initialStaticQrSrc;
            qrImg.src = initialStaticQrSrc;
        }
        return;
    }

    const candidates = [primaryUrl];
    const fallbackAcc = (VIETQR_CONFIG.fallbackAccountNo || '').trim();
    if (fallbackAcc && fallbackAcc !== (VIETQR_CONFIG.accountNo || '').trim()) {
        const fallbackUrl = buildDynamicVietQrUrl(tab, totalAmount, fallbackAcc);
        if (fallbackUrl && fallbackUrl !== primaryUrl) candidates.push(fallbackUrl);
    }

    if (candidates.includes(currentAppliedQrUrl) || primaryUrl === latestRequestedQrUrl) return;
    latestRequestedQrUrl = primaryUrl;
    loadDynamicQrCandidate(qrImg, candidates, 0);
}


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
function transaction(refArg, updateFn, options) {
    return runTransaction(refArg, updateFn, options).then((res) => {
        if (res?.committed) {
            fbUpBytes += byteSizeOf(res.snapshot?.val());
            updateNetWidget('up');
        }
        return res;
    });
}
function onValue(refArg, callback, ...rest) {
    return _fbOnValue(refArg, (snap) => {
        fbDownBytes += byteSizeOf(snap.val());
        updateNetWidget('down');
        callback(snap);
    }, ...rest);
}
function onChildAdded(refArg, callback, ...rest) {
    return _fbOnChildAdded(refArg, (snap, prevKey) => {
        fbDownBytes += byteSizeOf(snap.val());
        updateNetWidget('down');
        callback(snap, prevKey);
    }, ...rest);
}
function onChildChanged(refArg, callback, ...rest) {
    return _fbOnChildChanged(refArg, (snap, prevKey) => {
        fbDownBytes += byteSizeOf(snap.val());
        updateNetWidget('down');
        callback(snap, prevKey);
    }, ...rest);
}
function onChildRemoved(refArg, callback, ...rest) {
    return _fbOnChildRemoved(refArg, (snap) => {
        fbDownBytes += byteSizeOf(null);
        updateNetWidget('down');
        callback(snap);
    }, ...rest);
}

// ─── NON-BLOCKING MODAL & TOAST THAY THẾ ALERT/CONFIRM ─────────────────
let activeModalResolver = null;
let toastTimer = null;

function showToast(message, variant = 'info', durationMs = 3200) {
    const container = document.getElementById('app-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `app-toast app-toast-${variant}`;
    toast.textContent = message;
    container.replaceChildren(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.add('is-leaving');
        setTimeout(() => toast.remove(), 220);
    }, durationMs);
}

function closeAppModal(result) {
    const backdrop = document.getElementById('app-modal-backdrop');
    if (backdrop) backdrop.classList.add('hidden');
    const resolver = activeModalResolver;
    activeModalResolver = null;
    if (resolver) resolver(result);
}

function showAppModal({
    title = 'Thông báo',
    message = '',
    type = 'alert',
    confirmText = 'Xác nhận',
    cancelText = 'Hủy',
    danger = false
} = {}) {
    const backdrop = document.getElementById('app-modal-backdrop');
    const titleEl = document.getElementById('app-modal-title');
    const msgEl = document.getElementById('app-modal-message');
    const cancelBtn = document.getElementById('app-modal-cancel');
    const confirmBtn = document.getElementById('app-modal-confirm');

    if (!backdrop || !titleEl || !msgEl || !cancelBtn || !confirmBtn) {
        if (type === 'confirm') return Promise.resolve(window.confirm(message));
        window.alert(message);
        return Promise.resolve(true);
    }

    if (activeModalResolver) {
        closeAppModal(false);
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    confirmBtn.classList.toggle('is-danger', Boolean(danger));
    cancelBtn.classList.toggle('hidden', type === 'alert');
    backdrop.classList.remove('hidden');

    return new Promise((resolve) => {
        activeModalResolver = resolve;
        requestAnimationFrame(() => confirmBtn.focus());
    });
}

(function bindAppModalEvents() {
    const backdrop = document.getElementById('app-modal-backdrop');
    const cancelBtn = document.getElementById('app-modal-cancel');
    const confirmBtn = document.getElementById('app-modal-confirm');
    if (!backdrop || !cancelBtn || !confirmBtn) return;

    cancelBtn.addEventListener('click', () => closeAppModal(false));
    confirmBtn.addEventListener('click', () => closeAppModal(true));
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeAppModal(false);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && activeModalResolver) {
            e.preventDefault();
            closeAppModal(false);
        }
    });
})();

// ─── KHÓA CỨNG BILL & MÃ QR (CHẶN BÔI ĐEN, COPY, NHẤN GIỮ LƯU ẢNH) ────
(function initBillAndQrLock() {
    const shell = document.getElementById('bill-flip-shell');
    const qrImg = document.getElementById('payment-qr');
    if (qrImg) {
        qrImg.draggable = false;
        qrImg.setAttribute('draggable', 'false');
    }
    if (!shell) return;
    const blockEvent = (e) => {
        e.preventDefault();
        e.stopPropagation();
        return false;
    };
    ['contextmenu', 'selectstart', 'copy', 'cut', 'dragstart'].forEach((evt) => {
        shell.addEventListener(evt, blockEvent, { capture: true });
        if (qrImg) qrImg.addEventListener(evt, blockEvent, { capture: true });
    });
})();

let currentBillLang = 'vi';
let currentTab = null;
let data = { orders: {}, locked: {}, times: {} };
let billWasShown = false;

// Chặn double-click / thao tác chồng chéo khi đang gửi lệnh thanh toán lên Firebase.
let paymentInProgress = false;
let payingModalTable = null;
let payingHeartbeatTimer = null;
const payingTables = new Set();
const localPaymentEchoTables = new Set();

function clearTableLockAndTimeOnServer(tab) {
    const key = String(tab);
    return Promise.allSettled([
        remove(child(lockedRef, key)),
        remove(child(timesRef, key))
    ]);
}

function getTableDisplayName(n) {
    const num = Number(n);
    if (num === 7) return 'BÀN TRONG HIÊN';
    if (num === 8) return 'NGOÀI ĐƯỜNG (TRÁI)';
    if (num === 9) return 'NGOÀI ĐƯỜNG (PHẢI)';
    return `BÀN ${num}`;
}

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
        if (currentTab) {
            updateDynamicVietQr(currentTab, tableTotals[currentTab] || 0);
        }
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

// Cache DOM cố định cho các đường render nóng (tránh DOM churn khi đổi số lượng).
const TABLE_DOM = Array.from({ length: 9 }, (_, idx) => {
    const table = idx + 1;
    const meta = document.getElementById(`meta-${table}`);
    let foodSpan = null;
    let drinkSpan = null;
    if (meta) {
        meta.hidden = true;
        meta.style.display = 'none';
        foodSpan = document.createElement('span');
        foodSpan.className = 'table-meta-count';
        drinkSpan = document.createElement('span');
        drinkSpan.className = 'table-meta-count';
        meta.append('🍽 ', foodSpan, ' món · 🥤🍺 ', drinkSpan);
    }
    return {
        card: document.getElementById(`tab-${table}`),
        sum: document.getElementById(`sum-${table}`),
        meta,
        foodSpan,
        drinkSpan,
        time: document.getElementById(`time-${table}`),
        lastFoodQty: -1,
        lastDrinkQty: -1,
        lastMetaVisible: false,
        lastActive: false,
        lastLocked: false,
        lastHasGuest: false,
        flashTimer: 0
    };
});
const ITEM_DOM = new Map();
const tableTotals = Array(10).fill(0);

// ─── LOCALSTORAGE SNAPSHOT CACHE (HIỂN THỊ TỨC THÌ KHI MỞ APP) ──────────
const STATE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
let stateCacheSaveTimer = null;
let isShowingCachedSnapshot = false;

function scheduleSaveLocalStateCache() {
    clearTimeout(stateCacheSaveTimer);
    stateCacheSaveTimer = setTimeout(() => {
        try {
            const effectiveOrders = {};
            for (let t = 1; t <= 9; t++) {
                const merged = getMergedOrder(t);
                if (merged && Object.keys(merged).length > 0) {
                    effectiveOrders[t] = merged;
                }
            }
            localStorage.setItem(STATE_CACHE_KEY, JSON.stringify({
                orders: effectiveOrders,
                locked: data.locked || {},
                times: data.times || {},
                savedAt: Date.now()
            }));
        } catch (e) {}
    }, 350);
}

function isPlainObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function hydrateFromLocalStateCache() {
    try {
        const raw = localStorage.getItem(STATE_CACHE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) {
            localStorage.removeItem(STATE_CACHE_KEY);
            return false;
        }
        if (!Number.isFinite(parsed.savedAt) || (Date.now() - parsed.savedAt) > STATE_CACHE_MAX_AGE_MS) {
            localStorage.removeItem(STATE_CACHE_KEY);
            return false;
        }
        const safeOrders = {};
        if (isPlainObject(parsed.orders)) {
            for (let t = 1; t <= 9; t++) {
                const rawOrd = parsed.orders[t];
                if (!isPlainObject(rawOrd)) continue;
                const cleanOrd = {};
                for (const [itemId, rawQty] of Object.entries(rawOrd)) {
                    const qty = Math.max(0, Number(rawQty) || 0);
                    if (qty > 0) cleanOrd[itemId] = qty;
                }
                if (Object.keys(cleanOrd).length > 0) safeOrders[t] = cleanOrd;
            }
        }
        const safeLocked = {};
        if (isPlainObject(parsed.locked)) {
            for (let t = 1; t <= 9; t++) {
                if (parsed.locked[t] && safeOrders[t]) safeLocked[t] = true;
            }
        }
        const safeTimes = {};
        if (isPlainObject(parsed.times)) {
            for (let t = 1; t <= 9; t++) {
                const ts = Number(parsed.times[t]);
                if (Number.isFinite(ts) && ts > 0 && (safeOrders[t] || safeLocked[t])) safeTimes[t] = ts;
            }
        }
        data.orders = safeOrders;
        data.locked = safeLocked;
        data.times = safeTimes;
        isShowingCachedSnapshot = Object.keys(safeOrders).length > 0;
        return true;
    } catch (e) {
        try { localStorage.removeItem(STATE_CACHE_KEY); } catch (_) {}
        return false;
    }
}

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

function normalizeOrderMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
        const qty = Math.max(0, Number(v) || 0);
        if (qty > 0) out[String(k)] = qty;
    }
    return out;
}

function areOrdersEqual(a, b) {
    return shallowRecordEqual(normalizeOrderMap(a), normalizeOrderMap(b));
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
let dictRetryCount = 0;
let billAssetsPreloaded = false;

async function getLangData(lang) {
    if (dictCache[lang]) return dictCache[lang];
    if (!dictLoadPromise) {
        const retrySuffix = dictRetryCount > 0 ? `&retry=${dictRetryCount}` : '';
        dictLoadPromise = import(`./dict.js?v=${APP_BUILD_VERSION}${retrySuffix}`).then(m => {
            dictCache = m.dict;
        }).catch((err) => {
            console.error('[dict] Lỗi tải từ điển đa ngôn ngữ:', err);
            dictRetryCount++;
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

// ─── KIỂM TRA PHIÊN BẢN MỚI TRÊN GITHUB PAGES (BYPASS CDN/DISK CACHE) ───
let updateCheckInFlight = false;
let lastUpdateCheckAt = 0;

async function checkForRemoteAppUpdate(force = false) {
    if (updateCheckInFlight) return;
    if (paymentInProgress || payingModalTable !== null || payingTables.size > 0) return;
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;

    const now = Date.now();
    if (!force && (now - lastUpdateCheckAt) < 15000) return;
    lastUpdateCheckAt = now;
    updateCheckInFlight = true;

    try {
        const probeUrl = new URL('./index.html', window.location.href);
        probeUrl.searchParams.set('_cb', String(now));
        const res = await fetchWithTimeout(probeUrl.toString(), { cache: 'no-store' }, 4500);
        if (!res.ok) return;
        const html = await res.text();
        const match = html.match(/window\.__APP_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/);
        const remoteVer = match ? match[1].trim() : '';
        if (remoteVer && remoteVer !== APP_BUILD_VERSION) {
            flushAllPendingItems();
            reloadToBuildVersion(remoteVer);
        }
    } catch (e) {
        // Bỏ qua lặng lẽ nếu đang mất mạng hoặc offline
    } finally {
        updateCheckInFlight = false;
    }
}

setTimeout(() => checkForRemoteAppUpdate(true), 1200);
setInterval(() => {
    if (!document.hidden) checkForRemoteAppUpdate(false);
}, 180000);
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        checkForRemoteAppUpdate(true);
        refreshPresenceHeartbeat();
    }
});

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
        else if ((code >= 71 && code <= 77) || (code === 85 || code === 86)) status = 'cloudy';
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

function handleAppBackgrounded() {
    flushAllPendingItems();
    flushPendingActivity();
}

document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('tab-hidden', document.hidden);
    if (document.hidden) {
        handleAppBackgrounded();
        stopTickerInterval();
        stopClockInterval();
    } else {
        startTickerInterval();
        startClockInterval();
        refreshPresenceHeartbeat();
        runPeriodicMaintenance();
        checkForRemoteAppUpdate(false);
    }
});
window.addEventListener('pagehide', handleAppBackgrounded);
startClockInterval();

// ─── ÂM THANH THAO TÁC CÔNG SUẤT CAO + LAZY ON-DEMAND AUDIO CACHE ───────
if (typeof navigator !== 'undefined' && navigator.audioSession) {
    try { navigator.audioSession.type = 'playback'; } catch (e) {}
}

const IS_IOS_DEVICE = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

let isSoundMuted = false;
function applySoundMuteUi(muted) {
    isSoundMuted = muted;
    const btn = document.getElementById('sound-toggle');
    if (btn) {
        btn.textContent = muted ? '🔇' : '🔊';
        btn.classList.toggle('is-muted', muted);
    }
}
function initSoundMute() {
    try {
        applySoundMuteUi(localStorage.getItem('combetram_sound_muted') === '1');
    } catch (e) {
        applySoundMuteUi(false);
    }
}
initSoundMute();

// Tần số dải trung-cao tối ưu cho loa điện thoại + tiếng gõ nhạc cụ gỗ "leng keng" cho +- món
const SOUND_PATTERNS = {
    nav: [
        { freq: 932.33, dur: 0.155, delay: 0, instrument: 'glass', vol: 1.32 },
        { freq: 1244.51, dur: 0.22, delay: 0.066, instrument: 'glass', vol: 1.40 }
    ],
    add: [
        { freq: 1046.50, dur: 0.16, instrument: 'wood', vol: 1.0 },
        { freq: 1567.98, dur: 0.24, delay: 0.068, instrument: 'wood', vol: 1.0 }
    ],
    sub: [
        { freq: 1174.66, dur: 0.15, instrument: 'wood', vol: 0.96 },
        { freq: 880.00, dur: 0.23, delay: 0.068, instrument: 'wood', vol: 0.96 }
    ],
    lock: [
        { freq: 987.77, dur: 0.11, wave: 'sine', vol: 1.0 },
        { freq: 1318.51, dur: 0.19, delay: 0.095, wave: 'sine', vol: 1.0 }
    ],
    unlock: [
        { freq: 1174.66, dur: 0.10, wave: 'sine', vol: 0.95 },
        { freq: 880, dur: 0.15, delay: 0.09, wave: 'sine', vol: 0.95 }
    ],
    success: [
        { freq: 880, dur: 0.10, wave: 'triangle', vol: 1.0 },
        { freq: 1174.66, dur: 0.10, delay: 0.09, wave: 'triangle', vol: 1.0 },
        { freq: 1567.98, dur: 0.25, delay: 0.18, wave: 'sine', vol: 1.0 }
    ],
    ting: [
        { freq: 1318.51, dur: 0.16, wave: 'sine', vol: 1.0 },
        { freq: 1760, dur: 0.36, delay: 0.11, wave: 'sine', vol: 1.0 }
    ]
};

const SOUND_SAMPLE_RATE = 22050;
const MAX_POOL_PER_SOUND = 2;
const pcmSamplesCache = {};

function synthesizeSoundSamples(type, sampleRate = SOUND_SAMPLE_RATE) {
    if (pcmSamplesCache[type]) return pcmSamplesCache[type];
    const notes = SOUND_PATTERNS[type] || SOUND_PATTERNS.ting;
    const totalDur = Math.max(...notes.map(n => (n.delay || 0) + (n.dur || 0.12))) + 0.025;
    const numSamples = Math.max(1, Math.floor(sampleRate * totalDur));
    const mix = new Float32Array(numSamples);

    for (const n of notes) {
        const delay = n.delay || 0;
        const dur = n.dur || 0.12;
        const f0 = n.freq;
        const f1 = n.endFreq || f0;
        const vol = n.vol || 1.0;
        const wave = n.wave || 'sine';
        const isWood = n.instrument === 'wood';
        const isSolidKnock = n.instrument === 'solid_knock';
        const isGlass = n.instrument === 'glass';
        const startIdx = Math.floor(delay * sampleRate);
        const lenIdx = Math.max(1, Math.floor(dur * sampleRate));
        const attackSamples = Math.max(1, Math.floor((isWood ? 0.0015 : (isGlass ? 0.0018 : (isSolidKnock ? 0.0012 : 0.004))) * sampleRate));
        const releaseSamples = Math.max(1, Math.floor((isSolidKnock ? 0.012 : 0.015) * sampleRate));
        let phase = 0;
        let malletPhase = 0;

        for (let i = 0; i < lenIdx && (startIdx + i) < numSamples; i++) {
            const t = lenIdx > 1 ? i / (lenIdx - 1) : 0;
            const elapsedSec = i / sampleRate;
            const freq = isSolidKnock
                ? (f1 + (f0 - f1) * Math.exp(-elapsedSec * 65))
                : (f1 !== f0 ? f0 * Math.pow(f1 / f0, t) : f0);
            phase += (2 * Math.PI * freq) / sampleRate;

            const attack = Math.min(1, i / attackSamples);
            const release = Math.min(1, (lenIdx - 1 - i) / releaseSamples);

            if (isGlass) {
                const f0Env = Math.exp(-elapsedSec * 14.5);
                const f2Env = Math.exp(-elapsedSec * 34.0);
                const f3Env = Math.exp(-elapsedSec * 58.0);
                const f4Env = Math.exp(-elapsedSec * 95.0);

                let clink = 0;
                if (elapsedSec < 0.0032) {
                    const clinkFreq = 2650 - (elapsedSec / 0.0032) * 650;
                    malletPhase += (2 * Math.PI * clinkFreq) / sampleRate;
                    clink = 0.30 * Math.sin(malletPhase) * Math.exp(-elapsedSec * 720);
                }

                const glassSample =
                    1.35 * Math.sin(phase) * f0Env +
                    0.40 * Math.sin(2.0 * phase) * f2Env +
                    0.22 * Math.sin(2.756 * phase) * f3Env +
                    0.06 * Math.sin(4.15 * phase) * f4Env +
                    clink;

                mix[startIdx + i] += glassSample * vol * attack * release;
            } else if (isSolidKnock) {
                const bodyEnv = Math.exp(-elapsedSec * 26);
                const overtone1Env = Math.exp(-elapsedSec * 38);
                const overtone2Env = Math.exp(-elapsedSec * 58);
                const overtone3Env = Math.exp(-elapsedSec * 90);

                let knock = 0;
                if (elapsedSec < 0.009) {
                    const knockFreq = 1950 - (elapsedSec / 0.009) * 950;
                    malletPhase += (2 * Math.PI * knockFreq) / sampleRate;
                    knock = 1.15 * Math.sin(malletPhase) * Math.exp(-elapsedSec * 260);
                }

                const solidKnockSample =
                    1.25 * Math.sin(phase) * bodyEnv +
                    0.72 * Math.sin(1.48 * phase) * overtone1Env +
                    0.48 * Math.sin(2.15 * phase) * overtone2Env +
                    0.26 * Math.sin(2.85 * phase) * overtone3Env +
                    knock;

                mix[startIdx + i] += solidKnockSample * vol * attack * release;
            } else if (isWood) {
                const bodyEnv = Math.exp(-elapsedSec * 16.5);
                const overtone2Env = Math.exp(-elapsedSec * 34);
                const overtone3Env = Math.exp(-elapsedSec * 58);
                const overtone4Env = Math.exp(-elapsedSec * 85);

                let malletKnock = 0;
                if (elapsedSec < 0.012) {
                    const knockFreq = 2250 - (elapsedSec / 0.012) * 850;
                    malletPhase += (2 * Math.PI * knockFreq) / sampleRate;
                    malletKnock = 0.55 * Math.sin(malletPhase) * Math.exp(-elapsedSec * 340);
                }

                const woodSample =
                    Math.sin(phase) * bodyEnv +
                    0.38 * Math.sin(2 * phase) * overtone2Env +
                    0.34 * Math.sin(3 * phase) * overtone3Env +
                    0.22 * Math.sin(4 * phase) * overtone4Env +
                    malletKnock;

                mix[startIdx + i] += woodSample * vol * attack * release;
            } else {
                let sample;
                if (wave === 'triangle') {
                    const cyc = (phase / (2 * Math.PI)) % 1;
                    const tri = 2 * Math.abs(2 * cyc - 1) - 1;
                    sample = tri + 0.35 * Math.sin(2 * phase);
                } else {
                    sample = Math.sin(phase) + 0.45 * Math.sin(2 * phase) + 0.18 * Math.sin(3 * phase);
                }
                const sustainDecay = Math.pow(1 - t, 0.42);
                mix[startIdx + i] += sample * vol * attack * release * sustainDecay;
            }
        }
    }

    const drive = type === 'nav' ? 3.5 : 2.6;
    const norm = Math.tanh(drive);
    const out = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
        const boosted = Math.tanh(mix[i] * drive) / norm;
        out[i] = Math.max(-0.99, Math.min(0.99, boosted));
    }

    pcmSamplesCache[type] = out;
    return out;
}

function buildWavBlobUrl(type, sampleRate = SOUND_SAMPLE_RATE) {
    const samples = synthesizeSoundSamples(type, sampleRate);
    const numSamples = samples.length;
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (off, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < numSamples; i++) {
        view.setInt16(44 + i * 2, Math.round(samples[i] * 32767), true);
    }

    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

const wavUrlMap = {};
const htmlAudioPools = {};
const htmlAudioPoolIdx = {};
let audioUnlocked = false;

function getOrCreateHtmlAudioForType(type) {
    const key = SOUND_PATTERNS[type] ? type : 'ting';
    if (typeof URL === 'undefined' || typeof Blob === 'undefined') return null;

    if (!wavUrlMap[key]) {
        try {
            wavUrlMap[key] = buildWavBlobUrl(key);
        } catch (e) {
            return null;
        }
    }

    let pool = htmlAudioPools[key];
    if (!pool) {
        pool = [];
        htmlAudioPools[key] = pool;
        htmlAudioPoolIdx[key] = 0;
    }

    let idleAudio = pool.find(a => a.paused || a.ended);
    if (!idleAudio) {
        if (pool.length < MAX_POOL_PER_SOUND) {
            idleAudio = new Audio(wavUrlMap[key]);
            idleAudio.preload = 'none';
            idleAudio.setAttribute('playsinline', '');
            pool.push(idleAudio);
        } else {
            const idx = (htmlAudioPoolIdx[key] || 0) % pool.length;
            htmlAudioPoolIdx[key] = idx + 1;
            idleAudio = pool[idx];
        }
    }
    return idleAudio;
}

let sharedAudioCtx = null;
let sharedAudioMaster = null;
const webAudioBufferCache = {};

function getAudioContext() {
    if (!sharedAudioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
            try {
                sharedAudioCtx = new AudioCtx();
                const compressor = sharedAudioCtx.createDynamicsCompressor();
                compressor.threshold.setValueAtTime(-18, sharedAudioCtx.currentTime);
                compressor.knee.setValueAtTime(12, sharedAudioCtx.currentTime);
                compressor.ratio.setValueAtTime(8, sharedAudioCtx.currentTime);
                compressor.attack.setValueAtTime(0.002, sharedAudioCtx.currentTime);
                compressor.release.setValueAtTime(0.08, sharedAudioCtx.currentTime);

                const boostGain = sharedAudioCtx.createGain();
                boostGain.gain.setValueAtTime(1.45, sharedAudioCtx.currentTime);

                compressor.connect(boostGain);
                boostGain.connect(sharedAudioCtx.destination);
                sharedAudioMaster = compressor;
            } catch (e) {}
        }
    }
    if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
        sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
}

function getCachedWebAudioBuffer(ctx, type) {
    const key = SOUND_PATTERNS[type] ? type : 'ting';
    if (webAudioBufferCache[key]) return webAudioBufferCache[key];
    const samples = synthesizeSoundSamples(key, SOUND_SAMPLE_RATE);
    const audioBuf = ctx.createBuffer(1, samples.length, SOUND_SAMPLE_RATE);
    if (audioBuf.copyToChannel) {
        audioBuf.copyToChannel(samples, 0);
    } else {
        audioBuf.getChannelData(0).set(samples);
    }
    webAudioBufferCache[key] = audioBuf;
    return audioBuf;
}

function unlockAllAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;

    if (typeof navigator !== 'undefined' && navigator.audioSession) {
        try { navigator.audioSession.type = 'playback'; } catch (e) {}
    }
    const ctx = getAudioContext();
    if (ctx) {
        try {
            const silentBuf = ctx.createBuffer(1, 1, SOUND_SAMPLE_RATE);
            const src = ctx.createBufferSource();
            src.buffer = silentBuf;
            src.connect(ctx.destination);
            src.start(0);
        } catch (e) {}
    }
}

function playHtmlWav(type) {
    const audio = getOrCreateHtmlAudioForType(type);
    if (!audio) return false;
    try {
        audio.muted = false;
        audio.volume = 1.0;
        audio.currentTime = 0;
        const p = audio.play();
        if (p && p.catch) p.catch(() => {});
        return true;
    } catch (e) {
        return false;
    }
}

function playWebAudioCached(type) {
    const ctx = getAudioContext();
    if (!ctx || ctx.state !== 'running') return false;
    try {
        const audioBuf = getCachedWebAudioBuffer(ctx, type);
        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        if (type === 'nav') {
            const navGain = ctx.createGain();
            navGain.gain.setValueAtTime(1.25, ctx.currentTime);
            src.connect(navGain);
            navGain.connect(sharedAudioMaster || ctx.destination);
        } else {
            src.connect(sharedAudioMaster || ctx.destination);
        }
        src.start(0);
        return true;
    } catch (e) {
        return false;
    }
}

function playUiSound(type = 'nav') {
    if (isSoundMuted) return;
    try {
        if (IS_IOS_DEVICE) {
            if (playHtmlWav(type)) return;
        }
        if (!playWebAudioCached(type)) {
            playHtmlWav(type);
        }
    } catch (e) {}
}

function toggleSoundMute() {
    const wasUnlocked = audioUnlocked;
    unlockAllAudio();
    if (!isSoundMuted && !wasUnlocked) {
        playUiSound('ting');
        return;
    }
    const nextMuted = !isSoundMuted;
    applySoundMuteUi(nextMuted);
    try { localStorage.setItem('combetram_sound_muted', nextMuted ? '1' : '0'); } catch (e) {}
    if (!nextMuted) {
        playUiSound('ting');
    }
}

function triggerHaptic(type = 'nav') {
    playUiSound(type);
    if (window.navigator && window.navigator.vibrate) {
        try { window.navigator.vibrate([18, 25, 18]); } catch (e) {}
    }
}

// ─── animateNumber với cancel flag + cache giá trị số (tránh regex DOM) ──
const animatingFlags = {};
const animatedValues = {};

function setAnimatedDisplayValue(key, el, value, suffix = '') {
    animatedValues[key] = value;
    el.textContent = `${value.toLocaleString()}${suffix}`;
}

function animateNumber(target, newValue, suffix = '') {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    const key = el.id || String(target);
    const hasKnownStart = Object.prototype.hasOwnProperty.call(animatedValues, key);

    if (!hasKnownStart && newValue === 0) {
        setAnimatedDisplayValue(key, el, 0, suffix);
        return;
    }

    const startValue = hasKnownStart ? animatedValues[key] : 0;
    const expectedText = `${newValue.toLocaleString()}${suffix}`;
    if (startValue === newValue && el.textContent === expectedText) return;

    const diff = newValue - startValue;
    const duration = 750, startTime = performance.now();
    const token = Symbol();
    animatingFlags[key] = token;

    function easeCountMoney(t) {
        if (t < 0.7) { const p = t / 0.7; return (1 - Math.pow(1 - p, 3)) * 0.92; }
        const p = (t - 0.7) / 0.3;
        return 0.92 + (1 - Math.pow(1 - p, 2)) * 0.08;
    }
    function updateAnim(currentTime) {
        if (animatingFlags[key] !== token) return;
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = easeCountMoney(progress);
        let val = startValue + diff * eased;
        if (progress > 0.85) { const step = 1000; val = Math.round(val / step) * step; }
        val = Math.round(val);
        val = diff >= 0 ? Math.min(val, newValue) : Math.max(val, newValue);
        setAnimatedDisplayValue(key, el, val, suffix);
        if (progress < 1) requestAnimationFrame(updateAnim);
        else {
            setAnimatedDisplayValue(key, el, newValue, suffix);
            delete animatingFlags[key];
        }
    }
    requestAnimationFrame(updateAnim);
}

// ─── PRESENCE & TRẠNG THÁI MẠNG (TỐI ƯU CHILD LISTENERS + GỘP ACTIVITY) ──
const RT_ROOT = 'combetram_v6_rt';
const PRESENCE_STORAGE_KEY = 'combetram_presence_id';
const STALE_PRESENCE_MS = 120000;
const STALE_CURSOR_MS = 45000;
const FOCUS_TTL_MS = 1500;
const PAYING_TTL_MS = 45000;
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
const activityRef = ref(database, `${RT_ROOT}/activity`);
const myActivityRef = child(activityRef, myPresenceId);

let isFirebaseConnected = false;
let hasEverConnected = false;
const presenceMap = {};
const cursorsMap = {};
const activityMap = {};
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
    if (isOffline) {
        badge.classList.remove('hidden', 'is-syncing');
        badge.textContent = '⚠️ Mất mạng';
        return;
    }
    if (!initialDataReady && isShowingCachedSnapshot) {
        badge.classList.remove('hidden');
        badge.classList.add('is-syncing');
        badge.textContent = '🔄 Đang đồng bộ...';
        return;
    }
    badge.classList.add('hidden');
    badge.classList.remove('is-syncing');
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

function bindChildMap(parentRef, targetMap, onChanged) {
    onChildAdded(parentRef, (snap) => {
        if (!snap.key) return;
        targetMap[snap.key] = snap.val();
        onChanged(snap.key, targetMap[snap.key], 'added');
    });
    onChildChanged(parentRef, (snap) => {
        if (!snap.key) return;
        targetMap[snap.key] = snap.val();
        onChanged(snap.key, targetMap[snap.key], 'changed');
    });
    onChildRemoved(parentRef, (snap) => {
        if (!snap.key) return;
        delete targetMap[snap.key];
        onChanged(snap.key, null, 'removed');
    });
}

bindChildMap(presenceListRef, presenceMap, () => {
    renderPresenceCount(presenceMap);
    cleanupStaleRealtimeNodes(presenceListRef, 'presence', presenceMap, STALE_PRESENCE_MS);
});

function refreshPresenceHeartbeat() {
    if (!isFirebaseConnected) return;
    update(myPresenceRef, { ts: getServerNow() }).catch(() => {});
    if (currentTab) {
        set(myCursorRef, { table: currentTab, color: myColor, ts: getServerNow() }).catch(() => {});
    }
}

function runPeriodicMaintenance() {
    if (document.hidden) return;
    const now = getServerNow();
    for (let i = 1; i <= 9; i++) renderTableTime(i, now);
    refreshPresenceHeartbeat();
    renderPresenceCount(presenceMap);
    cleanupStaleRealtimeNodes(presenceListRef, 'presence', presenceMap, STALE_PRESENCE_MS);
    renderRemoteCursors(cursorsMap);
    cleanupStaleRealtimeNodes(cursorsRef, 'cursors', cursorsMap, STALE_CURSOR_MS);
    renderRemoteFocus(activityMap);
    renderRemotePaying(activityMap);
    cleanupStaleRealtimeNodes(activityRef, 'activity', activityMap, STALE_CURSOR_MS);
}
setInterval(runPeriodicMaintenance, 30000);

onValue(onlineRef, (snap) => {
    isFirebaseConnected = snap.val() === true;
    if (isFirebaseConnected) {
        hasEverConnected = true;
        tryFinalizeInitialSync();
        updateNetworkStatusBadge();
        onDisconnect(myPresenceRef).remove().catch(() => {});
        onDisconnect(myCursorRef).remove().catch(() => {});
        onDisconnect(myActivityRef).remove().catch(() => {});
        set(myPresenceRef, { color: myColor, ts: getServerNow() })
            .catch(e => console.error('[presence] LỖI GHI PRESENCE:', e.message));
        if (currentTab) {
            set(myCursorRef, { table: currentTab, color: myColor, ts: getServerNow() }).catch(() => {});
        }
        cleanupStaleRealtimeNodes(presenceListRef, 'presence', presenceMap, STALE_PRESENCE_MS);
        cleanupStaleRealtimeNodes(cursorsRef, 'cursors', cursorsMap, STALE_CURSOR_MS);
        cleanupStaleRealtimeNodes(activityRef, 'activity', activityMap, STALE_CURSOR_MS);
        if (initialDataReady) {
            cleanupStaleTimes();
            scheduleOrphanedLockCheck();
        }
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

// ─── CURSOR ĐỒNG NGHIỆP (1 vòng rAF duy nhất cho trail, 0 setTimeout) ───
const remoteCursorEls = {};
const lastCursorPos = {};
const activeCursorTrails = {};
let cursorTrailRafId = 0;

function tickCursorTrails(now) {
    cursorTrailRafId = 0;
    let hasRemaining = false;

    for (const [id, flight] of Object.entries(activeCursorTrails)) {
        const elapsed = now - flight.startTime;
        const progress = Math.min(1, elapsed / flight.duration);
        const targetStep = Math.floor(progress * flight.steps);

        while (flight.emitted < targetStep && flight.emitted < flight.steps) {
            flight.emitted++;
            const t = flight.emitted / (flight.steps + 1);
            spawnTrail(
                flight.startX + (flight.endX - flight.startX) * t,
                flight.startY + (flight.endY - flight.startY) * t,
                flight.color
            );
        }

        if (progress >= 1) {
            delete activeCursorTrails[id];
        } else {
            hasRemaining = true;
        }
    }

    if (hasRemaining) {
        cursorTrailRafId = requestAnimationFrame(tickCursorTrails);
    }
}

function scheduleCursorTrail(id, startX, startY, endX, endY, color) {
    activeCursorTrails[id] = {
        startX,
        startY,
        endX,
        endY,
        color,
        startTime: performance.now(),
        duration: 140,
        steps: 4,
        emitted: 0
    };
    if (!cursorTrailRafId) {
        cursorTrailRafId = requestAnimationFrame(tickCursorTrails);
    }
}

function positionCursorOnTable(id, el, rect, offsetIndex, color) {
    if (!rect) { el.classList.remove('visible'); return; }
    const x = rect.left + 12 + (offsetIndex * 16);
    const y = rect.top + 12;
    const prev = lastCursorPos[id];
    if (prev && (Math.abs(prev.x - x) > 6 || Math.abs(prev.y - y) > 6)) {
        scheduleCursorTrail(id, prev.x, prev.y, x, y, color);
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
            delete activeCursorTrails[id];
        }
    });

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

bindChildMap(cursorsRef, cursorsMap, () => {
    renderRemoteCursors(cursorsMap);
    cleanupStaleRealtimeNodes(cursorsRef, 'cursors', cursorsMap, STALE_CURSOR_MS);
});

let cursorRenderTicking = false;
function scheduleRenderRemoteCursors() {
    if (cursorRenderTicking) return;
    cursorRenderTicking = true;
    requestAnimationFrame(() => { renderRemoteCursors(cursorsMap); cursorRenderTicking = false; });
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
}

// ─── GỘP FOCUS + SFX VÀO 1 GÓI TIN EPHEMERAL DUY NHẤT (TIẾT KIỆM WRITE) ─
let localActivitySeq = 0;
let lastRemoteSfxTs = 0;
let pendingActivityTimer = null;
let pendingActivityPayload = null;
const lastHandledActivitySeq = {};
const remoteFocusExpireTimers = {};
const remotePayingExpireTimers = {};

function flushPendingActivity() {
    clearTimeout(pendingActivityTimer);
    pendingActivityTimer = null;
    const toSend = pendingActivityPayload;
    pendingActivityPayload = null;
    if (toSend && isFirebaseConnected) {
        set(myActivityRef, toSend).catch(() => {});
    }
}

function broadcastActivity({ sfx = null, tableId = currentTab, itemId = null, paying = Boolean(payingModalTable), immediate = false } = {}) {
    if (!isFirebaseConnected) return;
    const payload = {
        table: Number(tableId) || 0,
        itemId: itemId !== null && itemId !== undefined ? Number(itemId) : null,
        color: myColor,
        sfx: sfx || null,
        paying: Boolean(paying),
        seq: ++localActivitySeq,
        ts: getServerNow()
    };
    if (immediate) {
        clearTimeout(pendingActivityTimer);
        pendingActivityTimer = null;
        pendingActivityPayload = null;
        set(myActivityRef, payload).catch(() => {});
        return;
    }
    pendingActivityPayload = payload;
    if (!pendingActivityTimer) {
        pendingActivityTimer = setTimeout(flushPendingActivity, 80);
    }
}

function startLocalPayingBroadcast(tab) {
    const tableNum = Number(tab);
    if (!tableNum) return;
    payingModalTable = tableNum;
    broadcastActivity({ tableId: tableNum, paying: true, immediate: true });
    clearInterval(payingHeartbeatTimer);
    payingHeartbeatTimer = setInterval(() => {
        if (!payingModalTable) {
            clearInterval(payingHeartbeatTimer);
            payingHeartbeatTimer = null;
            return;
        }
        broadcastActivity({ tableId: payingModalTable, paying: true, immediate: true });
    }, 15000);
}

function stopLocalPayingBroadcast(sfx = null, tableId = currentTab || 0) {
    const hadPaying = payingModalTable !== null;
    payingModalTable = null;
    clearInterval(payingHeartbeatTimer);
    payingHeartbeatTimer = null;
    if (hadPaying || sfx) {
        broadcastActivity({ sfx, tableId, itemId: null, paying: false, immediate: true });
    }
}

const remoteFocusRows = {};
function clearRemoteFocusEntry(id) {
    clearTimeout(remoteFocusExpireTimers[id]);
    delete remoteFocusExpireTimers[id];
    const prev = remoteFocusRows[id];
    if (!prev) return;
    if (prev.rowEl) {
        prev.rowEl.classList.remove('remote-focus');
        prev.rowEl.style.removeProperty('--focus-color');
    }
    if (prev.tagEl) prev.tagEl.remove();
    delete remoteFocusRows[id];
}

function renderRemoteFocus(snapVal) {
    const now = getServerNow();
    const entries = Object.entries(snapVal || {}).filter(([id, f]) => {
        if (id === myPresenceId || !f || !f.itemId) return false;
        const ts = Number(f.ts);
        return Number.isFinite(ts) && (now - ts) < FOCUS_TTL_MS;
    });

    const activeIds = new Set(entries.map(([id]) => id));
    Object.keys(remoteFocusRows).forEach(id => {
        const entry = entries.find(([eid]) => eid === id)?.[1];
        if (!activeIds.has(id) || !entry || entry.table !== currentTab) {
            clearRemoteFocusEntry(id);
        }
    });

    if (!currentTab) return;
    entries.forEach(([id, f]) => {
        if (f.table !== currentTab) return;
        const row = ITEM_DOM.get(Number(f.itemId))?.row;
        if (!row) return;
        const prev = remoteFocusRows[id];
        if (prev && prev.rowEl && prev.rowEl !== row) {
            prev.rowEl.classList.remove('remote-focus');
            prev.rowEl.style.removeProperty('--focus-color');
            if (prev.tagEl) prev.tagEl.remove();
        }
        row.classList.add('remote-focus');
        row.style.setProperty('--focus-color', f.color || '#999');
        let tag = (prev && prev.rowEl === row) ? prev.tagEl : null;
        if (!tag) {
            tag = document.createElement('span');
            tag.className = 'remote-focus-tag';
            tag.textContent = '✏️';
            row.appendChild(tag);
            requestAnimationFrame(() => tag.classList.add('visible'));
        }
        tag.style.background = f.color || '#999';
        remoteFocusRows[id] = { rowEl: row, tagEl: tag };

        const remainingMs = Math.max(80, FOCUS_TTL_MS - Math.max(0, now - Number(f.ts)));
        clearTimeout(remoteFocusExpireTimers[id]);
        remoteFocusExpireTimers[id] = setTimeout(() => {
            clearRemoteFocusEntry(id);
        }, remainingMs);
    });
}

function getActiveRemotePayingByTable(snapVal = activityMap) {
    const now = getServerNow();
    const byTable = new Map();
    for (const [id, f] of Object.entries(snapVal || {})) {
        if (id === myPresenceId || !f || f.paying !== true || !f.table) continue;
        const ts = Number(f.ts);
        if (!Number.isFinite(ts) || (now - ts) >= PAYING_TTL_MS || (ts - now) > PAYING_TTL_MS) continue;
        const tableNum = Number(f.table);
        if (!Number.isInteger(tableNum) || tableNum < 1 || tableNum > 9) continue;
        const prev = byTable.get(tableNum);
        if (!prev || ts > prev.ts) {
            byTable.set(tableNum, { id, table: tableNum, color: f.color || '#f59e0b', ts });
        }
    }
    return byTable;
}

function isTableRemotePaying(tableId) {
    const num = Number(tableId);
    if (!num) return null;
    return getActiveRemotePayingByTable(activityMap).get(num) || null;
}

function syncCurrentTableRemotePayingUi(info) {
    const billArea = document.getElementById('bill-area');
    if (!billArea) return;
    let banner = document.getElementById('remote-paying-banner');
    if (!banner && info) {
        banner = document.createElement('div');
        banner.id = 'remote-paying-banner';
        banner.className = 'remote-paying-banner';
        banner.textContent = '💰 Thiết bị khác đang thu tiền bàn này...';
        const flipShell = document.getElementById('bill-flip-shell');
        if (flipShell && flipShell.parentNode === billArea) {
            billArea.insertBefore(banner, flipShell);
        } else {
            billArea.prepend(banner);
        }
    }
    if (banner) {
        banner.classList.toggle('hidden', !info);
    }
    const unlockBtn = billArea.querySelector('[data-action="unlock-bill"]');
    const payBtn = billArea.querySelector('[data-action="pay-bill"]');
    if (unlockBtn) unlockBtn.classList.toggle('is-remote-paying-disabled', Boolean(info));
    if (payBtn) payBtn.classList.toggle('is-remote-paying-disabled', Boolean(info));
}

function renderRemotePaying(snapVal = activityMap) {
    const now = getServerNow();
    const byTable = getActiveRemotePayingByTable(snapVal);

    const activeIds = new Set();
    for (const [id, f] of Object.entries(snapVal || {})) {
        if (id === myPresenceId || !f || f.paying !== true || !f.table) continue;
        const ts = Number(f.ts);
        if (!Number.isFinite(ts) || (now - ts) >= PAYING_TTL_MS) continue;
        activeIds.add(id);
        const remainingMs = Math.max(120, PAYING_TTL_MS - Math.max(0, now - ts));
        clearTimeout(remotePayingExpireTimers[id]);
        remotePayingExpireTimers[id] = setTimeout(() => {
            delete remotePayingExpireTimers[id];
            renderRemotePaying(activityMap);
        }, remainingMs);
    }
    for (const id of Object.keys(remotePayingExpireTimers)) {
        if (!activeIds.has(id)) {
            clearTimeout(remotePayingExpireTimers[id]);
            delete remotePayingExpireTimers[id];
        }
    }

    for (let t = 1; t <= 9; t++) {
        const card = TABLE_DOM[t - 1]?.card;
        if (!card) continue;
        const info = byTable.get(t) || null;
        card.classList.toggle('is-remote-paying', Boolean(info));
        let badge = card.querySelector('.remote-paying-badge');
        if (info) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'remote-paying-badge';
                badge.textContent = '💰 Đang thu tiền...';
                card.appendChild(badge);
            }
        } else if (badge) {
            badge.remove();
        }
    }

    syncCurrentTableRemotePayingUi(currentTab ? (byTable.get(Number(currentTab)) || null) : null);
}

bindChildMap(activityRef, activityMap, (id, ev, eventType) => {
    if (eventType === 'removed') {
        delete lastHandledActivitySeq[id];
        clearRemoteFocusEntry(id);
        clearTimeout(remotePayingExpireTimers[id]);
        delete remotePayingExpireTimers[id];
        renderRemotePaying(activityMap);
        return;
    }
    if (!ev || id === myPresenceId) return;

    const seqKey = `${ev.seq || 0}_${ev.ts || 0}`;
    if (seqKey !== lastHandledActivitySeq[id]) {
        lastHandledActivitySeq[id] = seqKey;
        const ts = Number(ev.ts);
        if (ev.sfx && Number.isFinite(ts) && Math.abs(getServerNow() - ts) <= 10000) {
            lastRemoteSfxTs = Date.now();
            playUiSound(ev.sfx);
        }
    }

    renderRemoteFocus(activityMap);
    renderRemotePaying(activityMap);
    cleanupStaleRealtimeNodes(activityRef, 'activity', activityMap, STALE_CURSOR_MS);
});

// ─── MENU + THANH NHẢY NHANH THEO NHÓM MÓN ─────────────────────────────
const SHORT_CAT_LABELS = ['Cơm / Mỳ', 'Hấp / Cháo', 'Món thêm', 'Nước uống', 'Bia'];
let catPillEls = [];
let catSectionEls = [];
let activeCatIdx = 0;

function setActiveCatPill(idx) {
    if (!catPillEls.length) return;
    const nextIdx = Math.max(0, Math.min(catPillEls.length - 1, Number(idx) || 0));
    if (nextIdx === activeCatIdx) return;
    catPillEls[activeCatIdx]?.classList.remove('active');
    catPillEls[nextIdx]?.classList.add('active');
    activeCatIdx = nextIdx;
}

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
    if (catNav) {
        catNav.innerHTML = navParts.join('');
        catPillEls = Array.from(catNav.querySelectorAll('.cat-pill'));
    }
    const menuListEl = document.getElementById('menu-list');
    menuListEl.innerHTML = parts.join('');
    catSectionEls = Array.from(menuListEl.querySelectorAll('.category-title'));
    activeCatIdx = 0;
}
renderMenu();
ALL_ITEMS.forEach(item => {
    ITEM_DOM.set(item.id, {
        row: document.getElementById(`row-${item.id}`),
        qty: document.getElementById(`q-${item.id}`),
        qtyClass: '',
        lastQty: 0,
        flashTimer: 0
    });
});

document.getElementById('menu-cat-nav')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.cat-pill');
    if (!pill) return;
    triggerHaptic('nav');
    const idx = Number(pill.dataset.catIdx);
    setActiveCatPill(idx);
    catSectionEls[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Dùng IntersectionObserver thay vì scroll + getBoundingClientRect() để loại bỏ layout thrashing
if ('IntersectionObserver' in window && catSectionEls.length > 0) {
    const catObserver = new IntersectionObserver((entries) => {
        if (!currentTab || data.locked?.[currentTab]) return;
        for (const entry of entries) {
            const idx = Number(entry.target.dataset.catIdx);
            if (!Number.isInteger(idx)) continue;
            if (entry.isIntersecting) {
                setActiveCatPill(idx);
            } else if (entry.rootBounds && entry.boundingClientRect.top > entry.rootBounds.top) {
                setActiveCatPill(idx - 1);
            }
        }
    }, {
        rootMargin: '-56px 0px -72% 0px',
        threshold: 0
    });
    catSectionEls.forEach(sec => catObserver.observe(sec));
}

// Mở khóa nhẹ AudioContext ở chạm đầu tiên
['pointerdown', 'touchstart', 'keydown'].forEach(evt => {
    document.addEventListener(evt, unlockAllAudio, { once: true, passive: true, capture: true });
});

// ─── EVENT DELEGATION TẬP TRUNG (THAY THẾ TOÀN BỘ INLINE ONCLICK) ──────
document.addEventListener('click', (e) => {
    const targetEl = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!targetEl) return;

    const tableCard = targetEl.closest('.table-card[data-table]');
    if (tableCard) {
        selectTable(Number(tableCard.dataset.table));
        return;
    }

    const qtyBtn = targetEl.closest('#menu-list .btn-qty[data-item-id]');
    if (qtyBtn) {
        const itemId = Number(qtyBtn.dataset.itemId);
        change(itemId, qtyBtn.classList.contains('btn-add') ? 1 : -1);
        return;
    }

    const langBtn = targetEl.closest('#lang-grid .lang-btn[data-lang]');
    if (langBtn) {
        changeBillLang(langBtn.dataset.lang);
        return;
    }

    const actionEl = targetEl.closest('[data-action]');
    if (!actionEl) return;

    switch (actionEl.dataset.action) {
        case 'toggle-sound':
            toggleSoundMute();
            break;
        case 'toggle-dark':
            toggleDarkMode();
            break;
        case 'lock-bill':
            setLock(true);
            break;
        case 'unlock-bill':
            setLock(false);
            break;
        case 'toggle-qr':
            toggleBillQr();
            break;
        case 'pay-bill':
            doPay();
            break;
        case 'scroll-checkout':
            scrollToCheckout();
            break;
    }
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
    }, { threshold: 0.01 });
    checkoutObserver.observe(checkoutBtnEl);
}

// ─── DỮ LIỆU CHÍNH FIREBASE (SINGLE-SHOT INIT + GRANULAR CHILD LISTENERS) ──
const pendingDeltas = {};
const inFlightDeltas = {};
const localEchoDeltas = {};

function adjustDeltaMap(mapObj, tableId, itemId, delta) {
    if (!delta) return;
    if (!mapObj[tableId]) mapObj[tableId] = {};
    const next = (mapObj[tableId][itemId] || 0) + delta;
    if (next === 0) {
        delete mapObj[tableId][itemId];
        if (Object.keys(mapObj[tableId]).length === 0) delete mapObj[tableId];
    } else {
        mapObj[tableId][itemId] = next;
    }
}
const tableEpoch = Array(10).fill(0);
let firstOrdersLoad = true;
const initialBranchesLoaded = new Set();
let initialDataReady = false;
const pendingRemoteOrderFlashes = [];

function recordLocalEchoDelta(tableId, itemId, delta) {
    if (!delta) return;
    if (!localEchoDeltas[tableId]) localEchoDeltas[tableId] = {};
    localEchoDeltas[tableId][itemId] = (localEchoDeltas[tableId][itemId] || 0) + delta;
    if (localEchoDeltas[tableId][itemId] === 0) {
        delete localEchoDeltas[tableId][itemId];
        if (Object.keys(localEchoDeltas[tableId]).length === 0) delete localEchoDeltas[tableId];
    }
}

function consumeLocalEchoDelta(tableId, itemId, observedDelta) {
    const expected = localEchoDeltas[tableId]?.[itemId] || 0;
    if (!expected) return false;
    if (expected === observedDelta) {
        delete localEchoDeltas[tableId][itemId];
        if (Object.keys(localEchoDeltas[tableId]).length === 0) delete localEchoDeltas[tableId];
        return true;
    }
    if ((expected > 0 && observedDelta > 0) || (expected < 0 && observedDelta < 0)) {
        const remaining = expected - observedDelta;
        if (remaining === 0) {
            delete localEchoDeltas[tableId][itemId];
            if (Object.keys(localEchoDeltas[tableId]).length === 0) delete localEchoDeltas[tableId];
            return true;
        }
        localEchoDeltas[tableId][itemId] = remaining;
        return Math.abs(observedDelta) <= Math.abs(expected);
    }
    return false;
}

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

            const observedDelta = newQty - oldQty;
            if (consumeLocalEchoDelta(tableId, itemId, observedDelta)) continue;

            pendingRemoteOrderFlashes.push({
                tableId,
                itemId,
                delta: observedDelta
            });
            queued++;
        }
    }
    return queued;
}

function applyElementFlash(el, timerOwner, delta, durationMs) {
    if (!el || !timerOwner) return;
    if (timerOwner.flashTimer) clearTimeout(timerOwner.flashTimer);
    const addCls = delta > 0 ? 'flash-add' : 'flash-sub';
    const remCls = delta > 0 ? 'flash-sub' : 'flash-add';
    el.classList.remove(remCls);
    el.classList.add(addCls);
    timerOwner.flashTimer = setTimeout(() => {
        el.classList.remove(addCls);
        timerOwner.flashTimer = 0;
    }, durationMs);
}

function flushRemoteOrderFlashes() {
    if (!pendingRemoteOrderFlashes.length) return;
    const flashes = pendingRemoteOrderFlashes.splice(0);

    for (const { tableId, itemId, delta } of flashes) {
        const dom = TABLE_DOM[tableId - 1];
        const itemDom = currentTab === tableId ? ITEM_DOM.get(itemId) : null;
        if (dom?.card) applyElementFlash(dom.card, dom, delta, 400);
        if (itemDom?.row) applyElementFlash(itemDom.row, itemDom, delta, 400);
    }
}

function tryFinalizeInitialSync() {
    if (initialDataReady) return;
    if (initialBranchesLoaded.size < 3 || !isFirebaseConnected) return;
    initialDataReady = true;
    isShowingCachedSnapshot = false;
    updateNetworkStatusBadge();
    cleanupStaleTimes();
    scheduleOrphanedLockCheck();
    scheduleSaveLocalStateCache();
    scheduleRefresh(null);
}

function markInitialBranchLoaded(branch) {
    if (initialDataReady) return;
    initialBranchesLoaded.add(branch);
    tryFinalizeInitialSync();
    if (!initialDataReady) {
        scheduleRefresh(null);
    }
}

function handleSingleTableOrderSnapshot(rawKey, tableVal) {
    const tableId = Number(rawKey);
    if (!Number.isInteger(tableId) || tableId < 1 || tableId > 9) return;

    const nextTableOrder = tableVal && typeof tableVal === 'object' ? tableVal : {};
    const prevTableOrder = data.orders?.[tableId] || {};
    if (shallowRecordEqual(prevTableOrder, nextTableOrder)) return;

    fbDownBytes += byteSizeOf(tableVal);
    updateNetWidget('down');

    const wasLocalPay = localPaymentEchoTables.has(tableId);
    const prevHadItems = Object.values(prevTableOrder).some(q => Number(q) > 0);
    const nextHasItems = Object.values(nextTableOrder).some(q => Number(q) > 0);

    if (wasLocalPay && !nextHasItems) {
        localPaymentEchoTables.delete(tableId);
    }

    const changed = new Set([tableId]);
    if (!firstOrdersLoad) {
        const ignoredTables = wasLocalPay ? new Set([tableId]) : null;
        const remoteChanges = queueRemoteOrderFlashes(
            { [tableId]: prevTableOrder },
            { [tableId]: nextTableOrder },
            ignoredTables
        );
        if (remoteChanges > 0 && (Date.now() - lastRemoteSfxTs) > 1200) {
            playUiSound('ting');
        }
        if (!wasLocalPay && prevHadItems && !nextHasItems && currentTab === tableId) {
            currentBillLang = 'vi';
            syncActiveLangButton('vi');
            showToast(`${getTableDisplayName(tableId)} vừa được thanh toán ở thiết bị khác!`, 'info', 3500);
        }
    }

    if (nextHasItems) {
        if (!data.orders) data.orders = {};
        data.orders[tableId] = nextTableOrder;
    } else if (data.orders) {
        delete data.orders[tableId];
    }

    if (initialDataReady) {
        scheduleSaveLocalStateCache();
        cleanupStaleTimes(changed);
        scheduleOrphanedLockCheck(changed);
        scheduleRefresh(changed, true);
    }
}

function handleSingleTableLockSnapshot(rawKey, rawVal) {
    const tableId = Number(rawKey);
    if (!Number.isInteger(tableId) || tableId < 1 || tableId > 9) return;

    const nextLocked = Boolean(rawVal);
    const prevLocked = Boolean(data.locked?.[tableId]);
    if (prevLocked === nextLocked) return;

    fbDownBytes += byteSizeOf(rawVal);
    updateNetWidget('down');

    if (nextLocked) {
        if (!data.locked) data.locked = {};
        data.locked[tableId] = true;
    } else if (data.locked) {
        delete data.locked[tableId];
    }

    if (initialDataReady) {
        const changed = new Set([tableId]);
        scheduleSaveLocalStateCache();
        scheduleOrphanedLockCheck(changed);
        scheduleRefresh(changed, true);
    }
}

function handleSingleTableTimeSnapshot(rawKey, rawVal) {
    const tableId = Number(rawKey);
    if (!Number.isInteger(tableId) || tableId < 1 || tableId > 9) return;

    const parsedTs = Number(rawVal);
    const nextTime = (rawVal !== null && rawVal !== undefined && Number.isFinite(parsedTs) && parsedTs > 0) ? parsedTs : null;
    const prevTime = data.times?.[tableId] !== undefined ? Number(data.times[tableId]) : null;
    if (prevTime === nextTime) return;

    fbDownBytes += byteSizeOf(rawVal);
    updateNetWidget('down');

    if (nextTime !== null) {
        if (!data.times) data.times = {};
        data.times[tableId] = nextTime;
    } else if (data.times) {
        delete data.times[tableId];
    }

    if (initialDataReady) {
        scheduleSaveLocalStateCache();
        scheduleRefresh(new Set([tableId]));
    }
}

function bindBranchWithInitialSync(branchRef, branchName, applyInitialVal, handleChildVal) {
    let initialResolved = false;
    let listenersAttached = false;
    let skipInitialAddedKeys = null;
    let unsubInitial = null;

    const attachChildListeners = () => {
        if (listenersAttached) return;
        listenersAttached = true;

        _fbOnChildAdded(branchRef, (snap) => {
            const key = snap.key;
            if (!key) return;
            if (skipInitialAddedKeys && skipInitialAddedKeys.has(key)) {
                skipInitialAddedKeys.delete(key);
                if (skipInitialAddedKeys.size === 0) skipInitialAddedKeys = null;
                const val = snap.val();
                const tableId = Number(key);
                if (branchName === 'orders' && shallowRecordEqual(data.orders?.[tableId] || {}, val && typeof val === 'object' ? val : {})) return;
                if (branchName === 'locked' && Boolean(data.locked?.[tableId]) === Boolean(val)) return;
                if (branchName === 'times') {
                    const parsedTs = Number(val);
                    const nextTime = (val !== null && val !== undefined && Number.isFinite(parsedTs) && parsedTs > 0) ? parsedTs : null;
                    const prevTime = data.times?.[tableId] !== undefined ? Number(data.times[tableId]) : null;
                    if (prevTime === nextTime) return;
                }
            }
            handleChildVal(key, snap.val());
        });
        _fbOnChildChanged(branchRef, (snap) => handleChildVal(snap.key, snap.val()));
        _fbOnChildRemoved(branchRef, (snap) => handleChildVal(snap.key, null));
    };

    unsubInitial = onValue(branchRef, (initialSnap) => {
        if (initialResolved) return;
        initialResolved = true;
        queueMicrotask(() => {
            if (unsubInitial) {
                unsubInitial();
                unsubInitial = null;
            }
        });

        const initialVal = initialSnap.val() || {};
        skipInitialAddedKeys = new Set(Object.keys(initialVal));
        applyInitialVal(initialVal);
        markInitialBranchLoaded(branchName);
        attachChildListeners();
    });
}

// Vẽ ngay từ bản nháp localStorage (nếu có) trước khi Firebase đồng bộ xong
if (hydrateFromLocalStateCache()) {
    updateNetworkStatusBadge();
    refresh(null, false);
}

bindBranchWithInitialSync(
    ordersRef,
    'orders',
    (serverOrders) => {
        const reconciled = {};
        for (let t = 1; t <= 9; t++) {
            const rawOrder = serverOrders[t];
            if (rawOrder && typeof rawOrder === 'object' && Object.values(rawOrder).some(q => Number(q) > 0)) {
                reconciled[t] = rawOrder;
            }
        }
        data.orders = reconciled;
        firstOrdersLoad = false;
    },
    handleSingleTableOrderSnapshot
);

bindBranchWithInitialSync(
    lockedRef,
    'locked',
    (serverLocked) => {
        const reconciled = {};
        for (let t = 1; t <= 9; t++) {
            if (serverLocked[t]) reconciled[t] = true;
        }
        data.locked = reconciled;
    },
    handleSingleTableLockSnapshot
);

bindBranchWithInitialSync(
    timesRef,
    'times',
    (serverTimes) => {
        const reconciled = {};
        for (let t = 1; t <= 9; t++) {
            const ts = Number(serverTimes[t]);
            if (Number.isFinite(ts) && ts > 0) reconciled[t] = ts;
        }
        data.times = reconciled;
    },
    handleSingleTableTimeSnapshot
);

function selectTable(n, options = {}) {
    if ((paymentInProgress || payingTables.has(Number(n))) && !options.allowDuringPayment) return;
    if (options.haptic !== false) triggerHaptic('nav');
    resetBillQrView(true);
    const previousTab = currentTab;
    const wasOpenForSameTable = (currentTab === n);
    currentTab = wasOpenForSameTable ? null : n;
    currentBillLang = 'vi';
    syncActiveLangButton('vi');
    billWasShown = false;
    broadcastCursor(currentTab);
    renderRemoteFocus(activityMap);
    renderRemotePaying(activityMap);
    const section = document.getElementById('order-section');
    if (currentTab) {
        document.getElementById('table-title').textContent = getTableDisplayName(n);
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

// ─── Debounce Firebase write 250ms với Atomic Transaction chặn cận dưới 0 ───
const debounceTimers = {};
const debounceVersions = {};
const pendingStartTimes = new Set();

function getEffectiveItemQty(tab, itemId) {
    const serverQty = Number(data.orders?.[tab]?.[itemId] || 0);
    const pending = Number(pendingDeltas[tab]?.[itemId] || 0);
    const inFlight = Number(inFlightDeltas[tab]?.[itemId] || 0);
    return Math.max(0, serverQty + pending + inFlight);
}

function clearPendingForTable(tab) {
    tableEpoch[tab] = (tableEpoch[tab] || 0) + 1;
    delete pendingDeltas[tab];
    delete inFlightDeltas[tab];
    delete localEchoDeltas[tab];
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

    const deltaToSend = Number(pendingDeltas[tab]?.[id] || 0);
    if (deltaToSend === 0) {
        if (pendingDeltas[tab]) {
            delete pendingDeltas[tab][id];
            if (Object.keys(pendingDeltas[tab]).length === 0) delete pendingDeltas[tab];
        }
        if (debounceVersions[key] === version) delete debounceVersions[key];
        return;
    }

    const startEpoch = tableEpoch[tab] || 0;

    delete pendingDeltas[tab][id];
    if (Object.keys(pendingDeltas[tab]).length === 0) delete pendingDeltas[tab];
    adjustDeltaMap(inFlightDeltas, tab, id, deltaToSend);

    if (deltaToSend > 0 && !data.times?.[tab] && !pendingStartTimes.has(tab)) {
        pendingStartTimes.add(tab);
        const startTs = getServerNow();
        set(child(timesRef, String(tab)), startTs)
            .catch(err => console.error('[times] Lỗi ghi mốc giờ Firebase:', err))
            .finally(() => pendingStartTimes.delete(tab));
    }

    const itemRef = child(ordersRef, `${tab}/${id}`);
    let passCount = 0;
    let initialLocalCur = 0;
    let prevOptimisticTarget = null;
    let inFlightReleased = false;
    let appliedLocally = false;
    const releaseInFlight = () => {
        if (inFlightReleased) return;
        inFlightReleased = true;
        if ((tableEpoch[tab] || 0) === startEpoch) {
            adjustDeltaMap(inFlightDeltas, tab, id, -deltaToSend);
        }
    };

    transaction(itemRef, (cur) => {
        passCount++;
        const current = Math.max(0, Number(cur) || 0);
        if (passCount === 1) initialLocalCur = current;

        if ((tableEpoch[tab] || 0) !== startEpoch || (current === 0 && deltaToSend < 0)) {
            if (prevOptimisticTarget !== null && prevOptimisticTarget !== current) {
                recordLocalEchoDelta(tab, id, current - prevOptimisticTarget);
                prevOptimisticTarget = current;
            }
            return undefined;
        }

        const next = current + deltaToSend;
        const finalVal = next > 0 ? next : null;
        const target = finalVal || 0;

        if (passCount === 1) {
            recordLocalEchoDelta(tab, id, target - current);
        } else if (prevOptimisticTarget !== null) {
            const remoteShift = current - initialLocalCur;
            recordLocalEchoDelta(tab, id, (target - prevOptimisticTarget) - remoteShift);
        }
        prevOptimisticTarget = target;
        if (passCount === 1) appliedLocally = true;
        return finalVal;
    })
        .then(() => {
            releaseInFlight();
            scheduleSaveLocalStateCache();
            scheduleRefresh(new Set([tab]), currentTab === tab);
            queueMicrotask(() => {
                if (!effectiveTableHasItems(tab) && (data.times?.[tab] || pendingStartTimes.has(tab))) {
                    remove(child(timesRef, String(tab))).catch(() => {});
                }
            });
        })
        .catch(err => {
            console.error('[orders] Lỗi transaction Firebase:', err);
            if (prevOptimisticTarget !== null && prevOptimisticTarget !== initialLocalCur) {
                recordLocalEchoDelta(tab, id, initialLocalCur - prevOptimisticTarget);
            }
            if ((tableEpoch[tab] || 0) === startEpoch) {
                releaseInFlight();
                adjustDeltaMap(pendingDeltas, tab, id, deltaToSend);
            }
            scheduleSaveLocalStateCache();
            scheduleRefresh(new Set([tab]), currentTab === tab);
        })
        .finally(() => {
            if (debounceVersions[key] === version) {
                delete debounceTimers[key];
                delete debounceVersions[key];
            }
        });

    if (appliedLocally) releaseInFlight();
}


function flushPendingForTable(tab) {
    const pending = pendingDeltas[tab];
    if (!pending) return;
    for (const rawId of Object.keys(pending)) {
        commitPendingItem(tab, Number(rawId));
    }
}

function flushAllPendingItems() {
    for (const rawTab of Object.keys(pendingDeltas)) {
        flushPendingForTable(Number(rawTab));
    }
}

function getMergedOrder(tab) {
    const serverOrder = data.orders?.[tab] || {};
    const pendingOrder = pendingDeltas[tab];
    const inFlightOrder = inFlightDeltas[tab];
    if (!pendingOrder && !inFlightOrder) return serverOrder;
    const merged = { ...serverOrder };
    const allDeltaIds = new Set([
        ...Object.keys(pendingOrder || {}),
        ...Object.keys(inFlightOrder || {})
    ]);
    for (const id of allDeltaIds) {
        const delta = (Number(pendingOrder?.[id]) || 0) + (Number(inFlightOrder?.[id]) || 0);
        const cleanQty = Math.max(0, (Number(merged[id]) || 0) + delta);
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
    const merged = getMergedOrder(tab);
    if (!merged || typeof merged !== 'object') return false;
    for (const [id, rawQty] of Object.entries(merged)) {
        if (!ITEM_MAP.has(Number(id))) continue;
        if ((Number(rawQty) || 0) > 0) return true;
    }
    return false;
}

const STALE_TIME_GRACE_MS = 15000;
function cleanupStaleTimes(tableIds = null) {
    if (!initialDataReady || !isFirebaseConnected) return;
    const now = getServerNow();
    const ids = tableIds ? Array.from(tableIds) : Array.from({ length: 9 }, (_, i) => i + 1);
    for (const tab of ids) {
        const startTs = Number(data.times?.[tab]);
        if (!startTs || data.locked?.[tab] || effectiveTableHasItems(tab)) continue;
        if ((now - startTs) < STALE_TIME_GRACE_MS) continue;
        remove(child(timesRef, String(tab))).catch(() => {});
    }
}

// Tự động giải phóng trạng thái khóa mồ côi (sau 8s để không đè lệnh chốt đơn từ máy khác đang đồng bộ)
const ORPHAN_LOCK_GRACE_MS = 8000;
const orphanedLockTimers = {};
function scheduleOrphanedLockCheck(tableIds = null) {
    if (!initialDataReady || !isFirebaseConnected) return;
    const ids = tableIds ? Array.from(tableIds) : Array.from({ length: 9 }, (_, i) => i + 1);
    for (const rawTab of ids) {
        const tab = Number(rawTab);
        if (!Number.isInteger(tab) || tab < 1 || tab > 9) continue;
        if (!data.locked?.[tab] || effectiveTableHasItems(tab)) {
            clearTimeout(orphanedLockTimers[tab]);
            delete orphanedLockTimers[tab];
            continue;
        }
        if (orphanedLockTimers[tab]) continue;
        orphanedLockTimers[tab] = setTimeout(() => {
            delete orphanedLockTimers[tab];
            if (!initialDataReady || !isFirebaseConnected || paymentInProgress || payingTables.has(tab) || localPaymentEchoTables.has(tab)) return;
            if (!data.locked?.[tab] || effectiveTableHasItems(tab)) return;

            const tableStartTs = Number(data.times?.[tab]);
            if (Number.isFinite(tableStartTs) && tableStartTs > 0 && (getServerNow() - tableStartTs) < ORPHAN_LOCK_GRACE_MS) {
                scheduleOrphanedLockCheck([tab]);
                return;
            }

            delete data.locked[tab];
            if (data.times?.[tab]) delete data.times[tab];
            scheduleSaveLocalStateCache();
            scheduleRefresh(new Set([tab]), currentTab === tab);
            clearTableLockAndTimeOnServer(tab);
        }, ORPHAN_LOCK_GRACE_MS);
    }
}

function applyMenuRowQtyClasses(itemDom, qty) {
    const row = itemDom?.row;
    if (!row) return;
    const nextClass = qty >= 5 ? 'qty-5' : (qty > 0 ? `qty-${qty}` : '');
    if (itemDom.qtyClass === nextClass) return;
    if (itemDom.qtyClass) row.classList.remove(itemDom.qtyClass);
    if (nextClass) row.classList.add(nextClass);
    itemDom.qtyClass = nextClass;
}

function updateItemRowQty(itemId, qty, bump = false) {
    const itemDom = ITEM_DOM.get(itemId);
    if (!itemDom) return;
    if (itemDom.lastQty !== qty) {
        itemDom.lastQty = qty;
        if (itemDom.qty) itemDom.qty.textContent = String(qty);
        applyMenuRowQtyClasses(itemDom, qty);
    }
    if (bump && itemDom.qty) playQtyBump(itemDom.qty);
}

function change(id, delta) {
    if (!currentTab || (data.locked && data.locked[currentTab])) return;
    const sfxType = delta > 0 ? 'add' : 'sub';
    triggerHaptic(sfxType);
    broadcastActivity({ sfx: sfxType, tableId: currentTab, itemId: id, immediate: false });

    const tab = currentTab;
    const currentQty = getEffectiveItemQty(tab, id);
    if (delta < 0 && currentQty <= 0) return;

    if (!pendingDeltas[tab]) pendingDeltas[tab] = {};
    const nextDelta = (pendingDeltas[tab][id] || 0) + delta;
    if (nextDelta === 0) {
        delete pendingDeltas[tab][id];
        if (Object.keys(pendingDeltas[tab]).length === 0) delete pendingDeltas[tab];
    } else {
        pendingDeltas[tab][id] = nextDelta;
    }

    const newQty = getEffectiveItemQty(tab, id);
    updateItemRowQty(id, newQty, true);
    renderTable(tab, getServerNow());
    renderCrowdStatus();
    flashRow(id, delta);
    scheduleSaveLocalStateCache();

    const key = `${tab}_${id}`;
    const version = (debounceVersions[key] || 0) + 1;
    debounceVersions[key] = version;
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(() => commitPendingItem(tab, id, version), 250);
}

function flashRow(id, delta) {
    const itemDom = ITEM_DOM.get(id);
    const dom = currentTab ? TABLE_DOM[currentTab - 1] : null;
    if (itemDom?.row) applyElementFlash(itemDom.row, itemDom, delta, 320);
    if (dom?.card) applyElementFlash(dom.card, dom, delta, 320);
}

function changeBillLang(l) {
    if (paymentInProgress) return;
    triggerHaptic('nav');
    currentBillLang = l;
    syncActiveLangButton(l);
    renderCurrentOrder();
    scrollBillIntoView();
}

// ─── Tính tổng tiền + số món ăn / nước uống (gộp cả pendingDeltas) ───────
function calculateTableStats(tableId) {
    let total = 0, foodQty = 0, drinkQty = 0;
    const mergedOrder = getMergedOrder(tableId);
    for (const id in mergedOrder) {
        const itemId = Number(id);
        const item = ITEM_MAP.get(itemId);
        const qty = Math.max(0, Number(mergedOrder[id]) || 0);
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
    syncCurrentTableRemotePayingUi(isTableRemotePaying(currentTab));

    ALL_ITEMS.forEach(item => {
        const q = getEffectiveItemQty(currentTab, item.id);
        updateItemRowQty(item.id, q, false);
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
        const sumKey = `sum-${tableId}`;
        if (animatedValues[sumKey] !== total || !dom.sum.textContent.endsWith('đ')) {
            animateNumber(dom.sum, total, 'đ');
        }
    }
    if (dom.meta) {
        dom.meta.classList.remove('skeleton');
        const shouldShowMeta = total > 0;
        if (shouldShowMeta) {
            if (!dom.lastMetaVisible) {
                dom.meta.hidden = false;
                dom.meta.style.display = '';
                dom.lastMetaVisible = true;
            }
            if (dom.lastFoodQty !== foodQty || dom.lastDrinkQty !== drinkQty) {
                if (dom.foodSpan && dom.lastFoodQty !== foodQty) dom.foodSpan.textContent = String(foodQty);
                if (dom.drinkSpan && dom.lastDrinkQty !== drinkQty) dom.drinkSpan.textContent = String(drinkQty);
                dom.meta.title = `${foodQty} phần món ăn · ${drinkQty} nước/bia`;
                dom.lastFoodQty = foodQty;
                dom.lastDrinkQty = drinkQty;
            }
        } else if (dom.lastMetaVisible) {
            dom.meta.hidden = true;
            dom.meta.style.display = 'none';
            dom.meta.title = '';
            dom.lastMetaVisible = false;
        }
    }
    renderTableTime(tableId, now);

    if (dom.card) {
        const isActive = tableId === currentTab;
        const hasGuest = !locked && total > 0;
        if (dom.lastActive !== isActive) {
            dom.card.classList.toggle('active', isActive);
            dom.lastActive = isActive;
        }
        if (dom.lastLocked !== locked) {
            dom.card.classList.toggle('is-locked', locked);
            dom.lastLocked = locked;
        }
        if (dom.lastHasGuest !== hasGuest) {
            dom.card.classList.toggle('has-guest', hasGuest);
            dom.lastHasGuest = hasGuest;
        }
    }
}

let lastCrowdTier = null;
function renderCrowdStatus() {
    let activeTablesCount = 0;
    for (let i = 1; i <= 9; i++) {
        if (tableTotals[i] > 0 || data.locked?.[i]) activeTablesCount++;
    }
    const nextTier = activeTablesCount <= 3 ? 'empty' : (activeTablesCount <= 6 ? 'normal' : 'crowded');
    if (nextTier === lastCrowdTier) return;
    lastCrowdTier = nextTier;

    const crowdEl = document.getElementById('crowd-status');
    const crowdTxt = document.getElementById('crowd-text');
    const crowdIcon = document.getElementById('crowd-icon');
    if (crowdEl && crowdTxt && crowdIcon) {
        if (nextTier === 'empty') {
            crowdEl.className = 'status-badge status-empty'; crowdTxt.textContent = 'Vắng khách'; crowdIcon.textContent = '🟢';
        } else if (nextTier === 'normal') {
            crowdEl.className = 'status-badge status-normal'; crowdTxt.textContent = 'Bình thường'; crowdIcon.textContent = '🟡';
        } else {
            crowdEl.className = 'status-badge status-crowded'; crowdTxt.textContent = 'ĐÔNG KHÁCH'; crowdIcon.textContent = '🚨';
        }
    }
}

function refresh(tableIds = null, updateCurrentOrder = true) {
    const ids = tableIds === null ? new Set(Array.from({ length: 9 }, (_, i) => i + 1)) : tableIds;
    const currentAffected = currentTab && (tableIds === null || ids.has(currentTab));
    if (updateCurrentOrder && currentAffected) renderCurrentOrder();
    const now = getServerNow();
    for (const id of ids) renderTable(Number(id), now);
    renderCrowdStatus();
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
    if (animatedValues['bill-total'] !== t) {
        animateNumber(bTotal, t);
        tBox.classList.add('total-pop');
        setTimeout(() => tBox.classList.remove('total-pop'), 400);
    }
    updateDynamicVietQr(tab, t);
    requestAnimationFrame(() => syncBillFlipHeight(false));
}

function setLock(v) {
    if (!currentTab) return;
    if (paymentInProgress) {
        showToast('Đang xử lý thanh toán, vui lòng chờ giây lát!', 'warning', 2000);
        return;
    }
    const tab = currentTab;
    if (isTableRemotePaying(tab)) {
        showToast('Thiết bị khác đang thu tiền bàn này, vui lòng chờ!', 'warning', 2800);
        return;
    }
    if (v && !effectiveTableHasItems(tab)) {
        showToast('Bàn chưa có món nào để chốt đơn!', 'warning', 2600);
        return;
    }

    const prevLocked = Boolean(data.locked?.[tab]);
    triggerHaptic(v ? 'lock' : 'unlock');
    broadcastActivity({ sfx: v ? 'lock' : 'unlock', tableId: tab, itemId: null, immediate: true });

    if (v) {
        flushPendingForTable(tab);
        preloadBillAssets();
        resetBillQrView(true);
        if (!data.locked) data.locked = {};
        data.locked[tab] = true;
    } else {
        if (data.locked) delete data.locked[tab];
        currentBillLang = 'vi';
        syncActiveLangButton('vi');
        resetBillQrView(true);
    }

    scheduleSaveLocalStateCache();
    refresh(new Set([tab]), true);

    if (v) {
        requestAnimationFrame(() => {
            document.getElementById('bill-area')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    set(child(lockedRef, String(tab)), v ? true : null)
        .catch(err => {
            console.error('[lock] Lỗi ghi trạng thái khóa Firebase:', err);
            if (prevLocked) {
                if (!data.locked) data.locked = {};
                data.locked[tab] = true;
            } else if (data.locked) {
                delete data.locked[tab];
            }
            scheduleSaveLocalStateCache();
            refresh(new Set([tab]), true);
            showToast('Không thể kết nối máy chủ để chốt đơn. Vui lòng thử lại!', 'error', 3500);
        });
}

async function doPay() {
    if (!currentTab || paymentInProgress || payingTables.has(currentTab)) return;

    if (!isFirebaseConnected || navigator.onLine === false) {
        showToast('Đang mất mạng, không thể xác nhận thanh toán!', 'error', 3500);
        return;
    }

    const tab = currentTab;
    if (isTableRemotePaying(tab)) {
        showToast('Thiết bị khác đang thu tiền bàn này, vui lòng chờ!', 'warning', 2800);
        return;
    }

    const lockedBeforeConfirm = !!data.locked?.[tab];
    const orderBeforeConfirm = normalizeOrderMap(getMergedOrder(tab));

    if (Object.keys(orderBeforeConfirm).length === 0) {
        if (data.locked?.[tab]) {
            delete data.locked[tab];
            clearTableLockAndTimeOnServer(tab);
            scheduleRefresh(new Set([tab]), true);
        }
        showToast('Bàn này đã trống (0đ)!', 'warning', 2600);
        return;
    }

    startLocalPayingBroadcast(tab);
    const confirmed = await showAppModal({
        title: 'Xác nhận thanh toán',
        message: `Xác nhận thanh toán và đóng bill cho ${getTableDisplayName(tab)}?`,
        type: 'confirm',
        confirmText: 'Thanh toán',
        cancelText: 'Quay lại'
    });
    if (!confirmed || currentTab !== tab || paymentInProgress || payingTables.has(tab)) {
        stopLocalPayingBroadcast(null, currentTab || 0);
        return;
    }

    if (!isFirebaseConnected || navigator.onLine === false) {
        stopLocalPayingBroadcast(null, tab);
        showToast('Mất kết nối mạng, giao dịch thanh toán đã được hủy!', 'error', 3500);
        return;
    }

    const lockedAfterConfirm = !!data.locked?.[tab];
    const expectedOrder = normalizeOrderMap(getMergedOrder(tab));
    if ((lockedBeforeConfirm && !lockedAfterConfirm) || !areOrdersEqual(orderBeforeConfirm, expectedOrder)) {
        stopLocalPayingBroadcast(null, tab);
        showToast('Đơn bàn này vừa được cập nhật từ thiết bị khác. Vui lòng kiểm tra lại bill!', 'warning', 4000);
        scheduleRefresh(new Set([tab]), true);
        return;
    }

    const backupOrder = data.orders?.[tab] ? { ...data.orders[tab] } : { ...expectedOrder };
    const backupLocked = data.locked?.[tab] !== undefined ? data.locked[tab] : null;
    const backupTime = data.times?.[tab] !== undefined ? data.times[tab] : null;
    const backupTotal = tableTotals[tab];

    const restoreTableState = () => {
        const hasCurrentOrder = data.orders?.[tab] && Object.keys(data.orders[tab]).length > 0;
        if (backupOrder && Object.keys(backupOrder).length > 0 && !hasCurrentOrder) {
            if (!data.orders) data.orders = {};
            data.orders[tab] = backupOrder;
        }
        if (backupLocked !== null && data.locked?.[tab] === undefined) {
            if (!data.locked) data.locked = {};
            data.locked[tab] = backupLocked;
        }
        if (backupTime !== null && data.times?.[tab] === undefined) {
            if (!data.times) data.times = {};
            data.times[tab] = backupTime;
        }
        if (backupTotal) tableTotals[tab] = backupTotal;
        scheduleSaveLocalStateCache();
        scheduleRefresh(new Set([tab]), true);
    };

    let totalAmount = 0;
    let hasItems = false;

    for (const [rawId, rawQty] of Object.entries(expectedOrder)) {
        const itemId = Number(rawId);
        const qty = Number(rawQty) || 0;
        const item = ITEM_MAP.get(itemId);
        if (!item || qty <= 0) continue;
        totalAmount += item.price * qty;
        hasItems = true;
    }

    paymentInProgress = true;
    payingTables.add(tab);
    localPaymentEchoTables.add(tab);
    try {
        clearPendingForTable(tab);
        stopBillScrollAnimation();
        triggerHaptic('success');
        broadcastActivity({ sfx: 'success', tableId: tab, itemId: null, paying: true, immediate: true });

        if (data.orders) delete data.orders[tab];
        if (data.locked) delete data.locked[tab];
        if (data.times) delete data.times[tab];
        tableTotals[tab] = 0;
        scheduleRefresh(new Set([tab]), true);

        selectTable(null, { haptic: false, allowDuringPayment: true, instantClose: true });
    } catch (prepErr) {
        console.error('[payment] Lỗi chuẩn bị thanh toán:', prepErr);
    } finally {
        paymentInProgress = false;
    }

    const tableOrderRef = child(ordersRef, String(tab));
    let orderDeletedOnServer = false;

    try {
        const txResult = await transaction(tableOrderRef, (serverOrder) => {
            if (!areOrdersEqual(serverOrder, expectedOrder)) {
                return undefined;
            }
            return null;
        });

        if (!txResult.committed) {
            localPaymentEchoTables.delete(tab);
            const serverOrderVal = normalizeOrderMap(txResult.snapshot?.val());
            if (Object.keys(serverOrderVal).length > 0) {
                if (!data.orders) data.orders = {};
                data.orders[tab] = serverOrderVal;
                if (backupLocked !== null) {
                    if (!data.locked) data.locked = {};
                    data.locked[tab] = backupLocked;
                }
                if (backupTime !== null) {
                    if (!data.times) data.times = {};
                    data.times[tab] = backupTime;
                }
            } else {
                if (data.orders) delete data.orders[tab];
                if (data.locked) delete data.locked[tab];
                if (data.times) delete data.times[tab];
            }
            scheduleSaveLocalStateCache();
            scheduleRefresh(new Set([tab]), true);
            showToast('Đơn bàn này vừa có thay đổi hoặc đã được thanh toán ở máy khác!', 'warning', 4500);
            return;
        }

        orderDeletedOnServer = true;

        await clearTableLockAndTimeOnServer(tab);
        localPaymentEchoTables.delete(tab);
        scheduleSaveLocalStateCache();

        if (hasItems) {
            showToast(`Đã thanh toán ${getTableDisplayName(tab)} • ${totalAmount.toLocaleString()}đ`, 'info', 2800);
        }
    } catch (err) {
        localPaymentEchoTables.delete(tab);
        console.error('[payment] Lỗi thanh toán Firebase:', err);
        if (orderDeletedOnServer) {
            clearTableLockAndTimeOnServer(tab);
            scheduleSaveLocalStateCache();
            if (hasItems) {
                showToast(`Đã thanh toán ${getTableDisplayName(tab)} • ${totalAmount.toLocaleString()}đ`, 'info', 2800);
            }
        } else {
            restoreTableState();
            showToast('Mất kết nối! Thanh toán chưa lưu được, dữ liệu bàn đã được khôi phục.', 'error', 4500);
        }
    } finally {
        payingTables.delete(tab);
        stopLocalPayingBroadcast(null, currentTab || 0);
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

        try {
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
        } catch (err) {
            finishPaperFlipIntro();
        }
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

window.__finishPaperFlipIntro = finishPaperFlipIntro;

function runPaperFlipIntro() {
    if (!document.documentElement.classList.contains('paper-flip-pending')) return;
    if (document.hidden || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        finishPaperFlipIntro();
        return;
    }

    clearTimeout(window.__paperFlipFailsafe);
    window.__paperFlipFailsafe = setTimeout(finishPaperFlipIntro, 2600);

    const $ = sel => document.querySelector(sel);

    animateSingleSheet($('.header-title'),       0,    2, true);
    animateSingleSheet($('#weather-hub'),        110,  0, true);
    animateSingleSheet($('#presence-count'),     215,  1, false);
    animateSingleSheet($('#sound-toggle'),       260,  0, false);
    animateSingleSheet($('#dark-toggle'),        310,  2, false);
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

// Tương thích ngược nếu trình duyệt từng lưu cache HTML cũ dùng inline onclick
Object.assign(window, {
    selectTable,
    change,
    setLock,
    doPay,
    toggleBillQr,
    changeBillLang,
    toggleDarkMode,
    toggleSoundMute,
    scrollToCheckout
});
