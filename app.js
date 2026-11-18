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
    runTransaction,
    query,
    orderByChild,
    startAt,
    endAt,
    limitToFirst
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

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

// ─── CẤU HÌNH & TẠO MÃ VIETQR ĐỘNG THEO TỔNG BILL ────────────────────
const VIETQR_CONFIG = {
    bankId: 'TCB',                          // Techcombank (BIN: 970407)
    accountNo: 'MS00P00000000449397',        // Mã QR cửa hàng Quỳnh Trâm (trích xuất từ mã QR gốc)
    fallbackAccountNo: '1828591991',        // Số tài khoản Techcombank dự phòng
    accountName: 'LUONG THI QUYNH TRAM',    // Tên chủ tài khoản không dấu
    template: 'compact2'                    // 'compact2' | 'compact' | 'qr_only' | 'print'
};

let initialStaticQrSrc = '';
let currentAppliedQrUrl = '';
let latestRequestedQrUrl = '';

(function captureInitialQrSource() {
    const qrImg = document.getElementById('payment-qr');
    if (!qrImg) return;
    initialStaticQrSrc = qrImg.getAttribute('src') || qrImg.src || '';
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

    const bankId = (VIETQR_CONFIG.bankId || '').trim();
    const accountNo = (overrideAccountNo || VIETQR_CONFIG.accountNo || '').trim();
    const template = (VIETQR_CONFIG.template || 'compact2').trim();
    const accountName = (VIETQR_CONFIG.accountName || '').trim();

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
let hasServerTimeOffset = false;
onValue(ref(database, '.info/serverTimeOffset'), (snap) => {
    const offset = Number(snap.val());
    if (Number.isFinite(offset)) {
        const prevOffset = serverTimeOffset;
        serverTimeOffset = offset;
        const firstSync = !hasServerTimeOffset;
        hasServerTimeOffset = true;
        if (typeof bindActiveSessionsListeners === 'function') {
            if (firstSync || Math.abs(offset - prevOffset) >= 3000) {
                bindActiveSessionsListeners(true);
            }
        }
    }
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

function dismissToast() {
    const container = document.getElementById('app-toast-container');
    if (!container) return;
    clearTimeout(toastTimer);
    toastTimer = null;
    const current = container.firstElementChild;
    if (!current) return;
    current.classList.add('is-leaving');
    setTimeout(() => {
        if (current.parentNode === container) current.remove();
    }, 220);
}

function showToast(message, variant = 'info', durationMs = 3200) {
    const container = document.getElementById('app-toast-container');
    if (!container) return;

    const existing = container.firstElementChild;
    if (existing && !existing.classList.contains('is-leaving') && existing.dataset.variant === variant) {
        const textEl = existing.querySelector('.app-toast-text');
        if (textEl) textEl.textContent = message;
        existing.classList.remove('is-pulse');
        void existing.offsetWidth;
        existing.classList.add('is-pulse');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(dismissToast, durationMs);
        return;
    }

    const toast = document.createElement('div');
    toast.className = `app-toast app-toast-${variant}`;
    toast.dataset.variant = variant;

    if (variant === 'loading') {
        const spinner = document.createElement('span');
        spinner.className = 'app-toast-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        toast.appendChild(spinner);
    }

    const textSpan = document.createElement('span');
    textSpan.className = 'app-toast-text';
    textSpan.textContent = message;
    toast.appendChild(textSpan);

    container.replaceChildren(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(dismissToast, durationMs);
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
    confirmText = 'Xác nhận',
    cancelText = 'Hủy'
} = {}) {
    const backdrop = document.getElementById('app-modal-backdrop');
    const titleEl = document.getElementById('app-modal-title');
    const msgEl = document.getElementById('app-modal-message');
    const cancelBtn = document.getElementById('app-modal-cancel');
    const confirmBtn = document.getElementById('app-modal-confirm');

    if (activeModalResolver) {
        closeAppModal(false);
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
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

// Chặn double-click / thao tác chồng chéo theo từng bàn khi đang thanh toán hoặc chốt/mở đơn lên Firebase.
let payingModalTable = null;
let payingHeartbeatTimer = null;
const payingTables = new Set();
const localPaymentEchoTables = new Set();
const lockInProgressTables = new Set();

function syncLockButtonsState(tab = currentTab) {
    const tableNum = Number(tab);
    const isBusy = Boolean(tableNum && lockInProgressTables.has(tableNum));
    const hasItems = Boolean(tableNum && effectiveTableHasItems(tableNum));
    const checkoutBtn = document.getElementById('btn-checkout');
    const unlockBtn = document.querySelector('#bill-area [data-action="unlock-bill"]');
    if (checkoutBtn) {
        const disabled = isBusy || !hasItems;
        checkoutBtn.disabled = disabled;
        checkoutBtn.setAttribute('aria-disabled', String(disabled));
    }
    if (unlockBtn) {
        unlockBtn.disabled = isBusy;
        unlockBtn.setAttribute('aria-disabled', String(isBusy));
    }
}

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

const QR_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1"/></svg>';
const BILL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h14v18l-2.3-1.5L14.4 21 12 19.5 9.6 21l-2.3-1.5L5 21V3z"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4.5"/></svg>';

function syncQrToggleButtonUi(isQr) {
    const button = document.getElementById('btn-qr-toggle');
    if (!button) return;
    button.classList.toggle('is-qr-active', Boolean(isQr));
    const iconEl = document.getElementById('btn-qr-icon');
    const labelEl = document.getElementById('btn-qr-label');
    if (iconEl) iconEl.innerHTML = isQr ? BILL_ICON_SVG : QR_ICON_SVG;
    if (labelEl) labelEl.textContent = isQr ? 'XEM BILL' : 'MÃ QR';
}

function getBillFlipDom() {
    return {
        shell: document.getElementById('bill-flip-shell'),
        front: document.getElementById('bill-face-front'),
        back: document.getElementById('bill-face-qr')
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

function resetBillQrView() {
    stopBillScrollAnimation();
    billViewMode = 'bill';
    const { shell, back } = getBillFlipDom();
    if (!shell) return;

    shell.style.transition = 'none';
    const flipper = document.getElementById('bill-flipper');
    if (flipper) flipper.style.transition = 'none';
    shell.classList.remove('is-qr');
    if (back) back.setAttribute('aria-hidden', 'true');
    syncQrToggleButtonUi(false);
    shell.style.height = '';
    void shell.offsetHeight;
    shell.style.transition = '';
    if (flipper) flipper.style.transition = '';
    requestAnimationFrame(() => syncBillFlipHeight(false));
}

function scrollBillIntoView() {
    if (billViewMode !== 'bill') return;
    document.querySelector('.bill-front .bill-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleBillQr() {
    triggerHaptic('nav');
    const { shell, back } = getBillFlipDom();
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
        syncQrToggleButtonUi(true);

        requestAnimationFrame(() => {
            shell.classList.add('is-qr');
            shell.style.height = `${targetHeight}px`;
            animateScrollToQrCenter(targetHeight);
        });
    } else {
        billViewMode = 'bill';
        shell.classList.remove('is-qr');
        if (back) back.setAttribute('aria-hidden', 'true');
        syncQrToggleButtonUi(false);
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
const lastTableMetaKey = Array(10).fill(null);


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
let dictCache = { vi: { flag: "🇻🇳", total: "TỔNG", thanks: "Cảm ơn quý khách & hẹn gặp lại!", items: {} } };
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
}

function syncActiveLangButton(lang) {
    document.querySelectorAll('#lang-grid .lang-btn').forEach(btn => {
        btn.classList.toggle('active-lang', btn.dataset.lang === lang);
    });
    const billArea = document.getElementById('bill-area');
    if (billArea) {
        billArea.dataset.billLang = lang || 'vi';
    }
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
    clearTimeout(pendingSessionSyncTimer);
    pendingSessionSyncTimer = null;
    pendingSessionPatch = null;
    if (isFirebaseConnected) {
        update(mySessionRef, {
            table: 0,
            itemId: null,
            paying: false,
            sfx: null,
            ts: getServerNow()
        }).catch(() => {});
    }
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
        runPeriodicMaintenance();
    }
});
window.addEventListener('pagehide', handleAppBackgrounded);
startClockInterval();

// ─── ÂM THANH THAO TÁC CÔNG SUẤT CAO + PRE-RENDERED AUDIOBUFFER CACHE ───
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
        const vol = n.vol || 1.0;
        const wave = n.wave || 'sine';
        const isWood = n.instrument === 'wood';
        const isGlass = n.instrument === 'glass';
        const startIdx = Math.floor(delay * sampleRate);
        const lenIdx = Math.max(1, Math.floor(dur * sampleRate));
        const attackSamples = Math.max(1, Math.floor((isWood ? 0.0015 : (isGlass ? 0.0018 : 0.004)) * sampleRate));
        const releaseSamples = Math.max(1, Math.floor(0.015 * sampleRate));
        let phase = 0;
        let malletPhase = 0;

        for (let i = 0; i < lenIdx && (startIdx + i) < numSamples; i++) {
            const t = lenIdx > 1 ? i / (lenIdx - 1) : 0;
            const elapsedSec = i / sampleRate;
            phase += (2 * Math.PI * f0) / sampleRate;

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

const htmlAudioPools = {};
const htmlAudioPoolIdx = {};
let soundPoolsInitialized = false;
let audioUnlocked = false;

function ensureSoundPools() {
    if (soundPoolsInitialized) return;
    if (typeof URL === 'undefined' || typeof Blob === 'undefined') return;
    soundPoolsInitialized = true;
    for (const type of Object.keys(SOUND_PATTERNS)) {
        try {
            const url = buildWavBlobUrl(type);
            htmlAudioPoolIdx[type] = 0;
            htmlAudioPools[type] = Array.from({ length: 4 }, () => {
                const a = new Audio(url);
                a.preload = 'auto';
                a.setAttribute('playsinline', '');
                return a;
            });
        } catch (e) {}
    }
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
    if (typeof navigator !== 'undefined' && navigator.audioSession) {
        try { navigator.audioSession.type = 'playback'; } catch (e) {}
    }
    const ctx = getAudioContext();
    if (ctx && !audioUnlocked) {
        try {
            const silentBuf = ctx.createBuffer(1, 1, SOUND_SAMPLE_RATE);
            const src = ctx.createBufferSource();
            src.buffer = silentBuf;
            src.connect(ctx.destination);
            src.start(0);
            for (const type of Object.keys(SOUND_PATTERNS)) {
                getCachedWebAudioBuffer(ctx, type);
            }
        } catch (e) {}
    }
    if (!audioUnlocked) {
        audioUnlocked = true;
        if (IS_IOS_DEVICE) {
            ensureSoundPools();
        }
        if (soundPoolsInitialized) {
            for (const pool of Object.values(htmlAudioPools)) {
                for (const a of pool) {
                    try {
                        a.muted = true;
                        const p = a.play();
                        if (p && p.then) {
                            p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
                        } else {
                            a.pause(); a.currentTime = 0; a.muted = false;
                        }
                    } catch (e) { a.muted = false; }
                }
            }
        }
    }
}

function playHtmlWav(type) {
    ensureSoundPools();
    const pool = htmlAudioPools[type] || htmlAudioPools.ting || htmlAudioPools.nav;
    if (!pool || !pool.length) return false;
    const idx = (htmlAudioPoolIdx[type] || 0) % pool.length;
    htmlAudioPoolIdx[type] = idx + 1;
    const audio = pool[idx];
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
const NUMBER_FMT = new Intl.NumberFormat();
const animatingFlags = {};
const animatedValues = {};

function setAnimatedDisplayValue(key, el, value, suffix = '') {
    animatedValues[key] = value;
    el.textContent = `${NUMBER_FMT.format(value)}${suffix}`;
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
    const expectedText = `${NUMBER_FMT.format(newValue)}${suffix}`;
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

// ─── QUẢN LÝ PHIÊN REALTIME GỘP NHẤT (SESSIONS = PRESENCE + CURSORS + ACTIVITY) ──
const RT_ROOT = 'combetram_v6_rt';
const STALE_SESSION_MS = 120000; // 2 phút không heartbeat -> coi như phiên đã chết
const STALE_CURSOR_MS = 45000;   // 45 giây không tương tác -> tắt hiển thị con trỏ bàn
const FOCUS_TTL_MS = 1500;       // Hiệu ứng viền món ăn đang sửa tự tắt sau 1.5s
const PAYING_TTL_MS = 45000;     // Cảnh báo đang thu tiền tự hết hạn sau 45s nếu mất kết nối
const USER_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#d81b60', '#6d4c41', '#3949ab', '#c0ca33'];
const myColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];

const onlineRef = ref(database, '.info/connected');
const sessionsRef = ref(database, `${RT_ROOT}/sessions`);

// Tạo ID phiên duy nhất trong RAM cho mỗi tab trình duyệt (không dùng sessionStorage để tránh đè nhau khi nhân bản tab)
const mySessionRef = push(sessionsRef);
const mySessionId = mySessionRef.key;

let isFirebaseConnected = false;
let hasEverConnected = false;
const sessionsMap = {};
const cleanedStaleSessionKeys = new Set();
let lastServerStaleSweepAt = 0;

let localActivitySeq = 0;
let lastRemoteSfxTs = 0;
let pendingSessionSyncTimer = null;
let pendingSessionPatch = null;
let lastCursorSentAt = 0;
let lastCursorTableSent = 0;

const lastHandledActivitySeq = {};
const remoteFocusExpireTimers = {};
const remotePayingExpireTimers = {};

function getActiveSessionEntries(now = getServerNow()) {
    const active = [];
    for (const [id, s] of Object.entries(sessionsMap)) {
        if (id === mySessionId) {
            active.push([id, s]);
            continue;
        }
        if (!s || typeof s !== 'object') continue;
        const ts = Number(s.ts);
        if (!Number.isFinite(ts) || (now - ts) < STALE_SESSION_MS) {
            active.push([id, s]);
        }
    }
    return active;
}

// Leader Election: Chỉ máy có sessionId nhỏ nhất (theo thứ tự từ điển) trong các máy đang online mới đi dọn rác
function isSessionGarbageLeader(now = getServerNow()) {
    if (!isFirebaseConnected || !mySessionId) return false;
    const activeIds = getActiveSessionEntries(now).map(([id]) => id);
    if (!activeIds.includes(mySessionId)) activeIds.push(mySessionId);
    activeIds.sort();
    return activeIds[0] === mySessionId;
}

function removeStaleSessionNode(id, ts = 0) {
    if (!id || id === mySessionId) return;
    const cacheKey = `${id}:${ts || 0}`;
    if (cleanedStaleSessionKeys.has(cacheKey)) return;
    cleanedStaleSessionKeys.add(cacheKey);
    if (cleanedStaleSessionKeys.size > 200) {
        const oldest = cleanedStaleSessionKeys.values().next().value;
        cleanedStaleSessionKeys.delete(oldest);
    }
    remove(child(sessionsRef, id)).catch(() => {
        cleanedStaleSessionKeys.delete(cacheKey);
    });
}

function cleanupStaleSessions(now = getServerNow()) {
    if (!isSessionGarbageLeader(now)) return;
    for (const [id, s] of Object.entries(sessionsMap)) {
        if (id === mySessionId) continue;
        const ts = Number(s?.ts);
        if (!s || (Number.isFinite(ts) && (now - ts) >= STALE_SESSION_MS)) {
            removeStaleSessionNode(id, ts);
        }
    }

    // Quét tối đa 50 node session cũ hơn STALE_SESSION_MS còn sót trên server trước khi mở trang
    const localNow = Date.now();
    if ((localNow - lastServerStaleSweepAt) >= 60000) {
        lastServerStaleSweepAt = localNow;
        const staleQuery = query(
            sessionsRef,
            orderByChild('ts'),
            endAt(now - STALE_SESSION_MS),
            limitToFirst(50)
        );
        onValue(staleQuery, (snap) => {
            if (!snap || typeof snap.forEach !== 'function') return;
            snap.forEach((childSnap) => {
                const key = childSnap.key;
                if (key && key !== mySessionId) {
                    const val = childSnap.val();
                    removeStaleSessionNode(key, Number(val?.ts) || 0);
                }
            });
        }, { onlyOnce: true });
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

function renderPresenceCount(now = getServerNow()) {
    const activeCount = getActiveSessionEntries(now).length;
    const el = document.getElementById('online-val');
    if (el) el.textContent = Math.max(1, activeCount);
}

// Đồng bộ trạng thái của chính user hiện tại lên 1 node duy nhất: sessions/{mySessionId}
function syncMySession({
    table = undefined,
    itemId = undefined,
    sfx = undefined,
    paying = undefined,
    immediate = false,
    throttleCursor = false
} = {}) {
    if (!isFirebaseConnected) return;

    const nowMs = Date.now();
    if (throttleCursor && table !== undefined && table === lastCursorTableSent && (nowMs - lastCursorSentAt) < 200) {
        return;
    }

    const patch = { ...(pendingSessionPatch || {}) };
    patch.color = myColor;
    patch.ts = getServerNow();

    if (table !== undefined) {
        const cleanTable = Number(table) || 0;
        patch.table = cleanTable;
        lastCursorSentAt = nowMs;
        lastCursorTableSent = cleanTable;
        // Đóng bàn hoặc chuyển bàn thì xóa focus món cũ
        if (itemId === undefined) patch.itemId = null;
    }
    if (itemId !== undefined) {
        patch.itemId = itemId !== null ? Number(itemId) : null;
    }
    if (paying !== undefined) {
        patch.paying = Boolean(paying);
    }
    if (sfx !== undefined) {
        patch.sfx = sfx || null;
        if (sfx) patch.seq = ++localActivitySeq;
    }

    // Cập nhật ngay vào bản đồ cục bộ để Leader Election và bộ đếm luôn chính xác
    sessionsMap[mySessionId] = {
        ...(sessionsMap[mySessionId] || {}),
        ...patch
    };

    if (immediate) {
        clearTimeout(pendingSessionSyncTimer);
        pendingSessionSyncTimer = null;
        pendingSessionPatch = null;
        update(mySessionRef, patch).catch(() => {});
        return;
    }

    pendingSessionPatch = patch;
    if (!pendingSessionSyncTimer) {
        pendingSessionSyncTimer = setTimeout(() => {
            pendingSessionSyncTimer = null;
            const toSend = pendingSessionPatch;
            pendingSessionPatch = null;
            if (toSend && isFirebaseConnected) {
                update(mySessionRef, toSend).catch(() => {});
            }
        }, 80);
    }
}

function broadcastCursor(tableNum) {
    syncMySession({
        table: Number(tableNum) || 0,
        itemId: null,
        sfx: null,
        immediate: !tableNum,
        throttleCursor: Boolean(tableNum)
    });
}

function broadcastActivity({
    sfx = null,
    tableId = currentTab,
    itemId = null,
    paying = Boolean(payingModalTable),
    immediate = false
} = {}) {
    syncMySession({
        table: Number(tableId) || 0,
        itemId,
        sfx,
        paying,
        immediate
    });
}

function startLocalPayingBroadcast(tab) {
    const tableNum = Number(tab);
    if (!tableNum) return;
    payingModalTable = tableNum;
    syncMySession({ table: tableNum, itemId: null, paying: true, immediate: true });
    clearInterval(payingHeartbeatTimer);
    payingHeartbeatTimer = setInterval(() => {
        if (!payingModalTable) {
            clearInterval(payingHeartbeatTimer);
            payingHeartbeatTimer = null;
            return;
        }
        syncMySession({ table: payingModalTable, paying: true, immediate: true });
    }, 15000);
}

function stopLocalPayingBroadcast(sfx = null, tableId = currentTab || 0) {
    const hadPaying = payingModalTable !== null;
    payingModalTable = null;
    clearInterval(payingHeartbeatTimer);
    payingHeartbeatTimer = null;
    if (hadPaying || sfx) {
        syncMySession({
            table: Number(tableId) || 0,
            itemId: null,
            sfx,
            paying: false,
            immediate: true
        });
    }
}

function refreshPresenceHeartbeat() {
    if (!isFirebaseConnected || document.hidden) return;
    syncMySession({
        table: currentTab || 0,
        paying: Boolean(payingModalTable),
        immediate: true
    });
}

function runPeriodicMaintenance() {
    if (document.hidden) return;
    const now = getServerNow();
    for (let i = 1; i <= 9; i++) renderTableTime(i, now);
    refreshPresenceHeartbeat();
    renderPresenceCount(now);
    renderRemoteCursors(now);
    renderRemoteFocus(now);
    renderRemotePaying(now);
    cleanupStaleSessions(now);
}
setInterval(runPeriodicMaintenance, 30000);

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

const cachedTableRects = new Map();
let tableRectsDirty = true;

function measureAllTableRects() {
    cachedTableRects.clear();
    for (let t = 1; t <= 9; t++) {
        const card = TABLE_DOM[t - 1]?.card;
        cachedTableRects.set(t, card ? card.getBoundingClientRect() : null);
    }
    tableRectsDirty = false;
}

function getCachedTableRect(tableNum) {
    if (tableRectsDirty || !cachedTableRects.has(tableNum)) {
        measureAllTableRects();
    }
    return cachedTableRects.get(tableNum) || null;
}

function renderRemoteCursors(now = getServerNow()) {
    const entries = Object.entries(sessionsMap).filter(([id, s]) => {
        if (id === mySessionId || !s || !Number(s.table)) return false;
        const ts = Number(s.ts);
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

    const countPerTable = {}, tableViewerColor = {};
    entries.forEach(([id, s]) => {
        const tableNum = Number(s.table);
        const idx = countPerTable[tableNum] || 0;
        countPerTable[tableNum] = idx + 1;
        if (!tableViewerColor[tableNum]) tableViewerColor[tableNum] = s.color || '#999';
        let el = remoteCursorEls[id];
        if (!el) {
            el = document.createElement('div');
            el.className = 'remote-cursor';
            document.body.appendChild(el);
            remoteCursorEls[id] = el;
        }
        el.style.background = s.color || '#999';
        positionCursorOnTable(id, el, getCachedTableRect(tableNum), idx, s.color);
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

let cursorRenderTicking = false;
function scheduleRenderRemoteCursors(remeasure = false) {
    if (remeasure) tableRectsDirty = true;
    if (cursorRenderTicking) return;
    cursorRenderTicking = true;
    requestAnimationFrame(() => {
        if (tableRectsDirty) measureAllTableRects();
        renderRemoteCursors();
        cursorRenderTicking = false;
    });
}
let scrollTicking = false;
window.addEventListener('resize', () => {
    scheduleRenderRemoteCursors(true);
    if (currentTab && data.locked?.[currentTab] && billViewMode === 'bill') {
        fitBillThanksText();
        syncBillFlipHeight(false);
    }
});
window.addEventListener('scroll', () => {
    tableRectsDirty = true;
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
        scrollTicking = false;
        if (tableRectsDirty) measureAllTableRects();
        renderRemoteCursors();
        updateActiveMenuCatPill();
    });
}, { passive: true });

// ─── FOCUS MÓN ĂN & TRẠNG THÁI ĐANG THU TIỀN TỪ SESSIONS ───────────────
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

function renderRemoteFocus(now = getServerNow()) {
    const entries = Object.entries(sessionsMap).filter(([id, s]) => {
        if (id === mySessionId || !s || !s.itemId || !Number(s.table)) return false;
        const ts = Number(s.ts);
        return Number.isFinite(ts) && (now - ts) < FOCUS_TTL_MS;
    });

    const activeIds = new Set(entries.map(([id]) => id));
    Object.keys(remoteFocusRows).forEach(id => {
        const entry = entries.find(([eid]) => eid === id)?.[1];
        if (!activeIds.has(id) || !entry || Number(entry.table) !== currentTab) {
            clearRemoteFocusEntry(id);
        }
    });

    if (!currentTab) return;
    entries.forEach(([id, s]) => {
        if (Number(s.table) !== currentTab) return;
        const row = ITEM_DOM.get(Number(s.itemId))?.row;
        if (!row) return;
        const prev = remoteFocusRows[id];
        if (prev && prev.rowEl && prev.rowEl !== row) {
            prev.rowEl.classList.remove('remote-focus');
            prev.rowEl.style.removeProperty('--focus-color');
            if (prev.tagEl) prev.tagEl.remove();
        }
        row.classList.add('remote-focus');
        row.style.setProperty('--focus-color', s.color || '#999');
        let tag = (prev && prev.rowEl === row) ? prev.tagEl : null;
        if (!tag) {
            tag = document.createElement('span');
            tag.className = 'remote-focus-tag';
            tag.textContent = '✏️';
            row.appendChild(tag);
            requestAnimationFrame(() => tag.classList.add('visible'));
        }
        tag.style.background = s.color || '#999';
        remoteFocusRows[id] = { rowEl: row, tagEl: tag };

        const remainingMs = Math.max(80, FOCUS_TTL_MS - Math.max(0, now - Number(s.ts)));
        clearTimeout(remoteFocusExpireTimers[id]);
        remoteFocusExpireTimers[id] = setTimeout(() => {
            clearRemoteFocusEntry(id);
        }, remainingMs);
    });
}

function getActiveRemotePayingByTable(now = getServerNow()) {
    const byTable = new Map();
    for (const [id, s] of Object.entries(sessionsMap)) {
        if (id === mySessionId || !s || s.paying !== true || !s.table) continue;
        const ts = Number(s.ts);
        if (!Number.isFinite(ts) || (now - ts) >= PAYING_TTL_MS) continue;
        const tableNum = Number(s.table);
        if (!Number.isInteger(tableNum) || tableNum < 1 || tableNum > 9) continue;
        const prev = byTable.get(tableNum);
        if (!prev || ts > prev.ts) {
            byTable.set(tableNum, { id, table: tableNum, color: s.color || '#f59e0b', ts });
        }
    }
    return byTable;
}

function isTableRemotePaying(tableId) {
    const num = Number(tableId);
    if (!num) return null;
    return getActiveRemotePayingByTable().get(num) || null;
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

function renderRemotePaying(now = getServerNow()) {
    const byTable = getActiveRemotePayingByTable(now);

    const activeIds = new Set();
    for (const [id, s] of Object.entries(sessionsMap)) {
        if (id === mySessionId || !s || s.paying !== true || !s.table) continue;
        const ts = Number(s.ts);
        if (!Number.isFinite(ts) || (now - ts) >= PAYING_TTL_MS) continue;
        activeIds.add(id);
        const remainingMs = Math.max(120, PAYING_TTL_MS - Math.max(0, now - ts));
        clearTimeout(remotePayingExpireTimers[id]);
        remotePayingExpireTimers[id] = setTimeout(() => {
            delete remotePayingExpireTimers[id];
            renderRemotePaying();
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

const REMOTE_SFX_THROTTLE_MS = 280;

function handleRemoteSessionChange(id, sessionData, eventType) {
    const now = getServerNow();
    const prevSession = sessionsMap[id];

    if (eventType === 'removed' || !sessionData || typeof sessionData !== 'object') {
        const hadCursorTable = Boolean(prevSession && Number(prevSession.table));
        delete sessionsMap[id];
        delete lastHandledActivitySeq[id];
        clearRemoteFocusEntry(id);
        clearTimeout(remotePayingExpireTimers[id]);
        delete remotePayingExpireTimers[id];
        renderPresenceCount(now);
        if (hadCursorTable || remoteCursorEls[id]) {
            renderRemoteCursors(now);
        }
        renderRemotePaying(now);
        return;
    }

    sessionsMap[id] = sessionData;

    if (id !== mySessionId && sessionData.sfx) {
        const seqKey = `${sessionData.seq || 0}_${sessionData.ts || 0}`;
        if (seqKey !== lastHandledActivitySeq[id]) {
            lastHandledActivitySeq[id] = seqKey;
            const ts = Number(sessionData.ts);
            if (Number.isFinite(ts) && Math.abs(now - ts) <= 10000) {
                const nowLocal = Date.now();
                if ((nowLocal - lastRemoteSfxTs) >= REMOTE_SFX_THROTTLE_MS) {
                    lastRemoteSfxTs = nowLocal;
                    playUiSound(sessionData.sfx);
                }
            }
        }
    }

    const prevTable = Number(prevSession?.table) || 0;
    const nextTable = Number(sessionData.table) || 0;
    const prevColor = prevSession?.color || '';
    const nextColor = sessionData.color || '';
    const prevTs = Number(prevSession?.ts);
    const wasCursorStale = !prevSession || !Number.isFinite(prevTs) || (now - prevTs) >= STALE_CURSOR_MS;
    const isCursorActive = nextTable > 0;
    const cursorChanged = (prevTable !== nextTable)
        || (isCursorActive && prevColor !== nextColor)
        || (isCursorActive && wasCursorStale && !remoteCursorEls[id]);

    renderPresenceCount(now);
    if (cursorChanged) {
        renderRemoteCursors(now);
    }
    renderRemoteFocus(now);
    renderRemotePaying(now);
    cleanupStaleSessions(now);
}

// Lọc phía server theo giờ đã đồng bộ với Firebase (.info/serverTimeOffset) tránh lệch đồng hồ thiết bị
let activeSessionUnsubs = [];
let sessionBindFallbackTimer = null;

function bindActiveSessionsListeners(forceRebind = false) {
    clearTimeout(sessionBindFallbackTimer);
    sessionBindFallbackTimer = null;

    if (!forceRebind && activeSessionUnsubs.length > 0) return;
    while (activeSessionUnsubs.length) {
        const unsub = activeSessionUnsubs.pop();
        try { unsub(); } catch (e) {}
    }

    const now = getServerNow();
    const cutoffTs = now - STALE_SESSION_MS - 15000;
    const activeSessionsQuery = query(
        sessionsRef,
        orderByChild('ts'),
        startAt(cutoffTs)
    );

    activeSessionUnsubs.push(
        onChildAdded(activeSessionsQuery, (snap) => {
            if (snap.key) handleRemoteSessionChange(snap.key, snap.val(), 'added');
        }),
        onChildChanged(activeSessionsQuery, (snap) => {
            if (snap.key) handleRemoteSessionChange(snap.key, snap.val(), 'changed');
        }),
        onChildRemoved(activeSessionsQuery, (snap) => {
            if (snap.key) handleRemoteSessionChange(snap.key, null, 'removed');
        })
    );

    renderPresenceCount(now);
    renderRemoteCursors(now);
    renderRemoteFocus(now);
    renderRemotePaying(now);
    cleanupStaleSessions(now);
}

sessionBindFallbackTimer = setTimeout(() => {
    bindActiveSessionsListeners(false);
}, 900);

onValue(onlineRef, (snap) => {
    isFirebaseConnected = snap.val() === true;
    if (isFirebaseConnected) {
        hasEverConnected = true;
        updateNetworkStatusBadge();
        if (activeSessionUnsubs.length === 0) {
            bindActiveSessionsListeners(false);
        }
        // Chỉ cần 1 onDisconnect duy nhất cho toàn bộ phiên làm việc
        onDisconnect(mySessionRef).remove().catch(() => {});

        const initialSessionPayload = {
            color: myColor,
            table: document.hidden ? 0 : (Number(currentTab) || 0),
            itemId: null,
            sfx: null,
            paying: Boolean(payingModalTable),
            seq: localActivitySeq,
            ts: getServerNow()
        };
        sessionsMap[mySessionId] = initialSessionPayload;
        set(mySessionRef, initialSessionPayload)
            .catch(e => console.error('[sessions] LỖI GHI SESSION:', e.message));

        renderPresenceCount();
        cleanupStaleSessions();
    } else {
        updateNetworkStatusBadge();
    }
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

function updateActiveMenuCatPill() {
    if (!currentTab || data.locked?.[currentTab]) return;
    const nav = document.getElementById('menu-cat-nav');
    if (!nav) return;
    const threshold = nav.getBoundingClientRect().bottom + 14;
    let activeIdx = 0;
    for (let i = 0; i < menu.length; i++) {
        const sec = document.getElementById(`cat-sec-${i}`);
        if (sec && sec.getBoundingClientRect().top <= threshold) activeIdx = i;
    }
    nav.querySelectorAll('.cat-pill').forEach((p, idx) => p.classList.toggle('active', idx === activeIdx));
}

// Mở khóa toàn bộ kênh âm thanh ngay từ chạm đầu tiên
['pointerdown', 'touchstart', 'keydown'].forEach(evt => {
    document.addEventListener(evt, unlockAllAudio, { once: true, passive: true, capture: true });
});

// ─── EVENT DELEGATION TẬP TRUNG (THAY THẾ TOÀN BỘ INLINE ONCLICK) ──────
document.addEventListener('click', (e) => {
    const tableCard = e.target.closest('.table-card[data-table]');
    if (tableCard) {
        selectTable(Number(tableCard.dataset.table));
        return;
    }

    const qtyBtn = e.target.closest('#menu-list .btn-qty[data-item-id]');
    if (qtyBtn) {
        const itemId = Number(qtyBtn.dataset.itemId);
        change(itemId, qtyBtn.classList.contains('btn-add') ? 1 : -1);
        return;
    }

    const langBtn = e.target.closest('#lang-grid .lang-btn[data-lang]');
    if (langBtn) {
        changeBillLang(langBtn.dataset.lang);
        return;
    }

    const actionEl = e.target.closest('[data-action]');
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

// ─── TỰ ẨN NÚT CUỘN XUỐNG KHI NÚT CHỐT ĐƠN ĐÃ HIỆN RA HOẶC BÀN 0Đ ─────
let checkoutBtnVisible = false;
function updateScrollCheckoutButton() {
    const scrollBtn = document.getElementById('scroll-to-checkout');
    if (!scrollBtn) return;
    const hasItems = Boolean(currentTab && effectiveTableHasItems(currentTab));
    const shouldShow = Boolean(currentTab && !data.locked?.[currentTab] && hasItems && !checkoutBtnVisible);
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

// ─── DỮ LIỆU CHÍNH FIREBASE (SINGLE-SHOT INIT + GRANULAR CHILD LISTENERS) ──
const pendingDeltas = {};
const localEchoDeltas = {};
const tableEpoch = Array(10).fill(0);
const initialBranchesLoaded = new Set();
let initialDataReady = false;
const pendingRemoteOrderFlashes = [];
const loadingTapTimers = {};

function isTableSkeletonLoading(tableId = null) {
    if (!initialDataReady) return true;
    if (tableId !== null && tableId !== undefined) {
        const card = TABLE_DOM[Number(tableId) - 1]?.card;
        if (card && card.querySelector('.skeleton')) return true;
    }
    return false;
}

function notifyTableLoading(tableId) {
    const tableNum = Number(tableId);
    const card = TABLE_DOM[tableNum - 1]?.card;
    if (card) {
        card.classList.remove('is-loading-tap');
        void card.offsetWidth;
        card.classList.add('is-loading-tap');
        clearTimeout(loadingTapTimers[tableNum]);
        loadingTapTimers[tableNum] = setTimeout(() => {
            card.classList.remove('is-loading-tap');
            delete loadingTapTimers[tableNum];
        }, 360);
    }
    if (window.navigator && window.navigator.vibrate) {
        try { window.navigator.vibrate(15); } catch (e) {}
    }
    showToast('Đang tải, vui lòng chờ...', 'loading', 2200);
}

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

function flushRemoteOrderFlashes() {
    if (!pendingRemoteOrderFlashes.length) return;
    const flashes = pendingRemoteOrderFlashes.splice(0);

    for (const { tableId, delta } of flashes) {
        const cls = delta > 0 ? 'flash-add' : 'flash-sub';
        const tableBtn = TABLE_DOM[tableId - 1]?.card;
        if (!tableBtn) continue;

        tableBtn.classList.add(cls);
        setTimeout(() => {
            tableBtn.classList.remove(cls);
        }, 400);
    }
}

function markInitialBranchLoaded(branch) {
    if (initialDataReady) return;
    initialBranchesLoaded.add(branch);
    if (initialBranchesLoaded.size === 3) {
        initialDataReady = true;
        const tablesContainer = document.getElementById('tables-container');
        if (tablesContainer) {
            tablesContainer.classList.remove('is-loading');
            tablesContainer.removeAttribute('aria-busy');
        }
        const activeToast = document.getElementById('app-toast-container')?.firstElementChild;
        if (activeToast?.dataset.variant === 'loading') {
            dismissToast();
        }
        cleanupStaleTimes();
        scheduleOrphanedLockCheck();
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

    if (nextHasItems) {
        data.orders[tableId] = nextTableOrder;
    } else {
        delete data.orders[tableId];
    }

    if (initialDataReady) {
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
        data.locked[tableId] = true;
    } else {
        delete data.locked[tableId];
    }

    if (initialDataReady) {
        const changed = new Set([tableId]);
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
        data.times[tableId] = nextTime;
    } else {
        delete data.times[tableId];
    }

    if (initialDataReady) {
        scheduleRefresh(new Set([tableId]));
    }
}

function bindBranchWithInitialSync(branchRef, branchName, applyInitialVal, handleChildVal) {
    let unsubInitial = null;
    unsubInitial = onValue(branchRef, (initialSnap) => {
        if (unsubInitial) {
            unsubInitial();
            unsubInitial = null;
        }
        applyInitialVal(initialSnap.val() || {});
        markInitialBranchLoaded(branchName);

        _fbOnChildAdded(branchRef, (snap) => handleChildVal(snap.key, snap.val()));
        _fbOnChildChanged(branchRef, (snap) => handleChildVal(snap.key, snap.val()));
        _fbOnChildRemoved(branchRef, (snap) => handleChildVal(snap.key, null));
    });
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
    if (n !== null && n !== undefined && isTableSkeletonLoading(n)) {
        notifyTableLoading(n);
        return;
    }
    if (payingTables.has(Number(n))) return;
    if (options.haptic !== false) triggerHaptic('nav');
    resetBillQrView();
    const previousTab = currentTab;
    const wasOpenForSameTable = (currentTab === n);
    currentTab = wasOpenForSameTable ? null : n;
    currentBillLang = 'vi';
    syncActiveLangButton('vi');
    billWasShown = false;
    broadcastCursor(currentTab);
    renderRemoteFocus();
    renderRemotePaying();
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
        } else {
            setTimeout(() => {
                if (currentTab === n && !(data.locked && data.locked[n])) {
                    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 120);
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
const inFlightItemCommits = new Map(); // tableId -> Set<Promise>

function trackTableCommit(tab, promise) {
    const tableNum = Number(tab);
    let setForTable = inFlightItemCommits.get(tableNum);
    if (!setForTable) {
        setForTable = new Set();
        inFlightItemCommits.set(tableNum, setForTable);
    }
    setForTable.add(promise);
    promise.finally(() => {
        setForTable.delete(promise);
        if (setForTable.size === 0) {
            inFlightItemCommits.delete(tableNum);
        }
    });
}

function getEffectiveItemQty(tab, itemId) {
    const serverQty = Number(data.orders?.[tab]?.[itemId] || 0);
    const delta = Number(pendingDeltas[tab]?.[itemId] || 0);
    return Math.max(0, serverQty + delta);
}

function clearPendingForTable(tab) {
    tableEpoch[tab] = (tableEpoch[tab] || 0) + 1;
    delete pendingDeltas[tab];
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
    if (expectedVersion !== null && debounceVersions[key] !== expectedVersion) {
        return Promise.resolve();
    }

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
        return Promise.resolve();
    }

    const startEpoch = tableEpoch[tab] || 0;

    delete pendingDeltas[tab][id];
    if (Object.keys(pendingDeltas[tab]).length === 0) delete pendingDeltas[tab];

    if (deltaToSend > 0 && !data.times?.[tab] && !pendingStartTimes.has(tab)) {
        pendingStartTimes.add(tab);
        const startTs = getServerNow();
        const timePromise = set(child(timesRef, String(tab)), startTs)
            .catch(err => console.error('[times] Lỗi ghi mốc giờ Firebase:', err))
            .finally(() => pendingStartTimes.delete(tab));
        trackTableCommit(tab, timePromise);
    }

    const itemRef = child(ordersRef, `${tab}/${id}`);
    let passCount = 0;
    let initialLocalCur = 0;
    let prevOptimisticTarget = null;

    const txPromise = transaction(itemRef, (cur) => {
        passCount++;
        const current = Math.max(0, Number(cur) || 0);
        if (passCount === 1) initialLocalCur = current;

        if ((tableEpoch[tab] || 0) !== startEpoch || (current === 0 && deltaToSend < 0)) {
            if (prevOptimisticTarget !== null && prevOptimisticTarget !== current) {
                recordLocalEchoDelta(tab, id, initialLocalCur - prevOptimisticTarget);
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
        return finalVal;
    })
        .then(({ committed }) => {
            if (!committed) {
                scheduleRefresh(new Set([tab]), currentTab === tab);
            }
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
                if (!pendingDeltas[tab]) pendingDeltas[tab] = {};
                pendingDeltas[tab][id] = (pendingDeltas[tab][id] || 0) + deltaToSend;
            }
            scheduleRefresh(new Set([tab]), currentTab === tab);
        })
        .finally(() => {
            if (debounceVersions[key] === version) {
                delete debounceTimers[key];
                delete debounceVersions[key];
            }
        });

    return trackTableCommit(tab, txPromise);
}

async function flushPendingForTable(tab) {
    const tableNum = Number(tab);
    const pending = pendingDeltas[tableNum];
    if (pending) {
        for (const rawId of Object.keys(pending)) {
            commitPendingItem(tableNum, Number(rawId));
        }
    }
    const activeCommits = inFlightItemCommits.get(tableNum);
    if (activeCommits && activeCommits.size > 0) {
        await Promise.allSettled(Array.from(activeCommits));
    }
}

function flushAllPendingItems() {
    const tabs = new Set([
        ...Object.keys(pendingDeltas).map(Number),
        ...inFlightItemCommits.keys()
    ]);
    for (const tableNum of tabs) {
        flushPendingForTable(tableNum);
    }
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
    const serverOrder = data.orders?.[tab];
    const pendingOrder = pendingDeltas[tab];
    if (serverOrder && typeof serverOrder === 'object') {
        for (const id of Object.keys(serverOrder)) {
            if (!ITEM_MAP.has(Number(id))) continue;
            const qty = (Number(serverOrder[id]) || 0) + (Number(pendingOrder?.[id]) || 0);
            if (qty > 0) return true;
        }
    }
    if (pendingOrder && typeof pendingOrder === 'object') {
        for (const id of Object.keys(pendingOrder)) {
            if (serverOrder && Object.prototype.hasOwnProperty.call(serverOrder, id)) continue;
            if (!ITEM_MAP.has(Number(id))) continue;
            if ((Number(pendingOrder[id]) || 0) > 0) return true;
        }
    }
    return false;
}

const STALE_TIME_GRACE_MS = 15000;
function cleanupStaleTimes(tableIds = null) {
    if (!initialDataReady) return;
    const now = getServerNow();
    const ids = tableIds ? Array.from(tableIds) : Array.from({ length: 9 }, (_, i) => i + 1);
    for (const tab of ids) {
        const startTs = Number(data.times?.[tab]);
        if (!startTs || data.locked?.[tab] || effectiveTableHasItems(tab)) continue;
        if ((now - startTs) < STALE_TIME_GRACE_MS) continue;
        remove(child(timesRef, String(tab))).catch(() => {});
    }
}

const orphanedLockTimers = {};
function scheduleOrphanedLockCheck(tableIds = null) {
    if (!initialDataReady) return;
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
            if (!initialDataReady || payingTables.has(tab) || localPaymentEchoTables.has(tab)) return;
            if (!data.locked?.[tab] || effectiveTableHasItems(tab)) return;

            delete data.locked[tab];
            if (data.times?.[tab]) delete data.times[tab];
            scheduleRefresh(new Set([tab]), currentTab === tab);
            clearTableLockAndTimeOnServer(tab);
        }, 1200);
    }
}

function applyMenuRowQtyClasses(row, qty) {
    if (!row) return;
    const preserveRemoteFocus = row.classList.contains('remote-focus');
    row.className = 'menu-item';
    if (qty >= 5) row.classList.add('qty-5');
    else if (qty > 0) row.classList.add('qty-' + qty);
    if (preserveRemoteFocus) row.classList.add('remote-focus');
}

function change(id, delta) {
    if (!currentTab || (data.locked && data.locked[currentTab]) || lockInProgressTables.has(Number(currentTab))) return;
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
    const itemDom = ITEM_DOM.get(id);
    const qSpan = itemDom?.qty;
    const row = itemDom?.row;
    if (qSpan) {
        qSpan.textContent = newQty;
        applyMenuRowQtyClasses(row, newQty);
        playQtyBump(qSpan);
    }
    syncLockButtonsState(tab);
    updateScrollCheckoutButton();
    renderTable(tab, getServerNow());
    renderCrowdStatus();
    flashTableCard(delta);

    const key = `${tab}_${id}`;
    const version = (debounceVersions[key] || 0) + 1;
    debounceVersions[key] = version;
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(() => commitPendingItem(tab, id, version), 250);
}

function flashTableCard(delta) {
    const tabBtn = currentTab ? TABLE_DOM[currentTab - 1]?.card : null;
    if (!tabBtn) return;
    const cls = delta > 0 ? 'flash-add' : 'flash-sub';
    tabBtn.classList.add(cls);
    setTimeout(() => tabBtn.classList.remove(cls), 320);
}

function changeBillLang(l) {
    triggerHaptic('nav');
    currentBillLang = l;
    syncActiveLangButton(l);
    renderCurrentOrder();
    scrollBillIntoView();
}

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
        if (billViewMode !== 'bill') resetBillQrView();
    }
    updateScrollCheckoutButton();
    syncCurrentTableRemotePayingUi(isTableRemotePaying(currentTab));
    syncLockButtonsState(currentTab);

    ALL_ITEMS.forEach(item => {
        const q = getEffectiveItemQty(currentTab, item.id);
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
    if (!initialDataReady) return;
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
        const metaKey = total > 0 ? `1:${foodQty}:${drinkQty}` : '0';
        if (lastTableMetaKey[tableId] !== metaKey) {
            lastTableMetaKey[tableId] = metaKey;
            dom.meta.innerHTML = total > 0 ? `🍽 <span class="table-meta-count">${foodQty}</span> món · 🥤🍺 <span class="table-meta-count">${drinkQty}</span>` : '';
            dom.meta.title = total > 0 ? `${foodQty} phần món ăn · ${drinkQty} nước/bia` : '';
        }
    }
    renderTableTime(tableId, now);

    if (dom.card) {
        const preserveViewer = dom.card.classList.contains('has-viewer');
        const preserveRemotePaying = dom.card.classList.contains('is-remote-paying');
        const preserveFlashAdd = dom.card.classList.contains('flash-add');
        const preserveFlashSub = dom.card.classList.contains('flash-sub');
        let className = tableId === 7 ? 'table-card full-width' : (tableId >= 8 ? 'table-card half-width' : 'table-card');
        if (tableId === currentTab) className += ' active';
        if (locked) className += ' is-locked';
        else if (total > 0) className += ' has-guest';
        if (dom.card.className !== className) {
            dom.card.className = className;
            if (preserveViewer) dom.card.classList.add('has-viewer');
            if (preserveRemotePaying) dom.card.classList.add('is-remote-paying');
            if (preserveFlashAdd) dom.card.classList.add('flash-add');
            if (preserveFlashSub) dom.card.classList.add('flash-sub');
        }
    }
}

function renderCrowdStatus() {
    let activeTablesCount = 0;
    for (let i = 1; i <= 9; i++) {
        if (tableTotals[i] > 0 || data.locked?.[i]) activeTablesCount++;
    }
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

function fitBillThanksText() {
    const el = document.getElementById('bill-thanks');
    if (!el) return;
    const availableWidth = el.clientWidth;
    if (!availableWidth) return;

    const maxFontPx = 17.5;
    const minFontPx = 12;
    el.style.whiteSpace = 'nowrap';
    el.style.fontSize = `${maxFontPx}px`;

    const textWidth = el.scrollWidth;
    if (textWidth > availableWidth) {
        const fittedSize = Math.floor((availableWidth / textWidth) * maxFontPx * 10) / 10;
        if (fittedSize >= minFontPx) {
            el.style.fontSize = `${fittedSize}px`;
        } else {
            el.style.fontSize = '12.5px';
            el.style.whiteSpace = 'normal';
        }
    }
}

async function renderBillAsync(tab) {
    const targetLang = currentBillLang;
    const langData = await getLangData(targetLang);
    if (currentTab !== tab || currentBillLang !== targetLang || !data.locked?.[tab]) return;

    const billArea = document.getElementById('bill-area');
    if (billArea) billArea.dataset.billLang = targetLang;

    let h = "", t = 0, my = getMergedOrder(tab);
    document.getElementById('txt-total-label').textContent = langData.total;
    document.getElementById('txt-lang-flag').textContent = langData.flag;
    const thanksEl = document.getElementById('bill-thanks');
    if (thanksEl) {
        thanksEl.textContent = langData.thanks || dictCache.vi.thanks;
    }
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
    fitBillThanksText();
    requestAnimationFrame(() => {
        fitBillThanksText();
        syncBillFlipHeight(false);
    });
}

async function setLock(v) {
    if (!currentTab) return;
    const tab = Number(currentTab);
    if (payingTables.has(tab) || lockInProgressTables.has(tab)) return;
    if (Boolean(data.locked?.[tab]) === Boolean(v)) return;

    if (isTableRemotePaying(tab)) {
        showToast('Thiết bị khác đang thu tiền bàn này, vui lòng chờ!', 'warning', 2800);
        return;
    }
    if (v && !effectiveTableHasItems(tab)) {
        showToast('Bàn chưa có món nào để chốt đơn!', 'warning', 2600);
        return;
    }

    lockInProgressTables.add(tab);
    syncLockButtonsState(tab);

    try {
        triggerHaptic(v ? 'lock' : 'unlock');
        broadcastActivity({ sfx: v ? 'lock' : 'unlock', tableId: tab, itemId: null, immediate: true });
        if (v) {
            // Chờ toàn bộ món debounced & in-flight transaction hoàn tất trên Firebase trước khi khóa bàn
            await flushPendingForTable(tab);
            if (pendingDeltas[tab] && Object.keys(pendingDeltas[tab]).length > 0) {
                showToast('Chưa đồng bộ được món lên máy chủ, vui lòng kiểm tra mạng và thử lại!', 'error', 3200);
                return;
            }
            if (!effectiveTableHasItems(tab)) {
                showToast('Bàn chưa có món nào để chốt đơn!', 'warning', 2600);
                return;
            }
            preloadBillAssets();
            resetBillQrView();
        }
        await set(child(lockedRef, String(tab)), v ? true : null);
        if (!v) {
            currentBillLang = 'vi';
            syncActiveLangButton('vi');
            resetBillQrView();
        }
        if (v && currentTab === tab) {
            setTimeout(scrollBillIntoView, 100);
        }
    } catch (err) {
        console.error('[lock] Lỗi ghi trạng thái khóa Firebase:', err);
        showToast('Không thể cập nhật trạng thái bàn, vui lòng thử lại!', 'error', 2800);
    } finally {
        lockInProgressTables.delete(tab);
        syncLockButtonsState(currentTab);
    }
}

async function doPay() {
    if (!currentTab || payingTables.has(currentTab)) return;

    const tab = currentTab;
    if (isTableRemotePaying(tab)) {
        showToast('Thiết bị khác đang thu tiền bàn này, vui lòng chờ!', 'warning', 2800);
        return;
    }

    await flushPendingForTable(tab);

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
        confirmText: 'Thanh toán',
        cancelText: 'Quay lại'
    });
    if (!confirmed || currentTab !== tab || payingTables.has(tab)) {
        stopLocalPayingBroadcast(null, currentTab || 0);
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
            data.orders[tab] = backupOrder;
        }
        if (backupLocked !== null && data.locked?.[tab] === undefined) {
            data.locked[tab] = backupLocked;
        }
        if (backupTime !== null && data.times?.[tab] === undefined) {
            data.times[tab] = backupTime;
        }
        if (backupTotal) tableTotals[tab] = backupTotal;
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

    payingTables.add(tab);
    localPaymentEchoTables.add(tab);
    clearPendingForTable(tab);
    stopBillScrollAnimation();
    triggerHaptic('success');
    broadcastActivity({ sfx: 'success', tableId: tab, itemId: null, paying: true, immediate: true });

    delete data.orders[tab];
    delete data.locked[tab];
    delete data.times[tab];
    tableTotals[tab] = 0;
    scheduleRefresh(new Set([tab]), true);

    selectTable(null, { haptic: false, instantClose: true });

    const tableOrderRef = child(ordersRef, String(tab));
    let orderDeletedOnServer = false;
    const finalizeSuccessfulPayment = async (awaitCleanup = true) => {
        const cleanupPromise = clearTableLockAndTimeOnServer(tab);
        if (awaitCleanup) await cleanupPromise;
        localPaymentEchoTables.delete(tab);
        if (hasItems) {
            showToast(`Đã thanh toán ${getTableDisplayName(tab)} • ${totalAmount.toLocaleString()}đ`, 'info', 2800);
        }
    };

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
                data.orders[tab] = serverOrderVal;
                if (backupLocked !== null) {
                    data.locked[tab] = backupLocked;
                }
                if (backupTime !== null) {
                    data.times[tab] = backupTime;
                }
            } else {
                delete data.orders[tab];
                delete data.locked[tab];
                delete data.times[tab];
            }
            scheduleRefresh(new Set([tab]), true);
            showToast('Đơn bàn này vừa có thay đổi hoặc đã được thanh toán ở máy khác!', 'warning', 4500);
            return;
        }

        orderDeletedOnServer = true;
        await finalizeSuccessfulPayment(true);
    } catch (err) {
        localPaymentEchoTables.delete(tab);
        console.error('[payment] Lỗi thanh toán Firebase:', err);
        if (orderDeletedOnServer) {
            finalizeSuccessfulPayment(false);
        } else {
            restoreTableState();
            showToast('Mất kết nối! Thanh toán chưa lưu được, dữ liệu bàn đã được khôi phục.', 'error', 4500);
        }
    } finally {
        payingTables.delete(tab);
        stopLocalPayingBroadcast(null, currentTab || 0);
    }
}

// RIPPLE (tái sử dụng 1 node/nút + Web Animations API, không tạo/xóa DOM hay setTimeout)
const buttonRipples = new WeakMap();
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-action');
    if (!btn || btn.disabled) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let state = buttonRipples.get(btn);
    if (!state) {
        const el = document.createElement('span');
        el.className = 'ripple';
        btn.appendChild(el);
        state = { el, anim: null };
        buttonRipples.set(btn, state);
    }
    if (state.anim) state.anim.cancel();

    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.2;
    const { el } = state;
    el.style.width = el.style.height = size + 'px';
    el.style.left = (e.clientX - rect.left - size / 2) + 'px';
    el.style.top = (e.clientY - rect.top - size / 2) + 'px';

    if (el.animate) {
        const anim = el.animate([
            { transform: 'scale(0)', opacity: 1 },
            { transform: 'scale(2.8)', opacity: 0 }
        ], { duration: 550, easing: 'ease-out', fill: 'forwards' });
        state.anim = anim;
        anim.onfinish = () => {
            if (state.anim === anim) {
                state.anim = null;
                try { anim.cancel(); } catch (err) {}
            }
        };
    }
});

// ─── SINGLE-SHEET ORIGAMI INTRO V7 ────────────────────────────────────
const SINGLE_FOLD_DURATION = 420;
const singleFoldAnimations = [];
const singleFoldTimers = [];
const singleFoldTargets = new Set();

function paperFlipLater(fn, delay) {
    const id = setTimeout(fn, delay);
    singleFoldTimers.push(id);
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
    tableRectsDirty = true;
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
    applyDarkMode(saved === 'on');
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

// ─── SERVICE WORKER: TỰ ĐỘNG LẤY BẢN MỚI KHI PUSH GITHUB ───────────────
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
            .then((reg) => {
                document.addEventListener('visibilitychange', () => {
                    if (!document.hidden) {
                        reg.update().catch(() => {});
                    }
                });
            })
            .catch((err) => console.warn('[sw] Không thể đăng ký Service Worker:', err));
    });
}
