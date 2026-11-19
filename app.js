// app.js — Đồng bộ phiên bản cache tự động, từ điển 3 tầng + self-audit, và transaction chốt đơn an toàn

const APP_VERSION = (() => {
  try {
    return new URL(import.meta.url).searchParams.get("v") || "";
  } catch (_) {
    return "";
  }
})();

function withAppVersion(path) {
  if (!APP_VERSION) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}v=${encodeURIComponent(APP_VERSION)}`;
}

// Nạp thực đơn động theo đúng version của app.js để tránh lệch cache giữa các thiết bị
const { menu } = await import(withAppVersion("./menu.js"));

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  update,
  onValue as _fbOnValue,
  onChildAdded as _fbOnChildAdded,
  onChildChanged as _fbOnChildChanged,
  onChildRemoved as _fbOnChildRemoved,
  remove,
  child,
  get,
  runTransaction,
  onDisconnect,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-database.js";

// ─── TỰ ĐỘNG ĐO DỮ LIỆU TẢI XUỐNG TỪ FIREBASE ─────────────────────────────────
const _te = new TextEncoder();
function byteSizeOf(val) {
  if (val === undefined) return 0;
  try {
    return _te.encode(JSON.stringify(val)).length;
  } catch (_) {
    return 0;
  }
}

function recordDownload(snap) {
  try {
    fbDownBytes += byteSizeOf(snap.val());
    scheduleBandwidthUiUpdate();
  } catch (_) {}
}

const onValue = (q, cb, errCb) =>
  _fbOnValue(q, (snap) => { recordDownload(snap); cb(snap); }, errCb);
const onChildAdded = (q, cb, errCb) =>
  _fbOnChildAdded(q, (snap) => { recordDownload(snap); cb(snap); }, errCb);
const onChildChanged = (q, cb, errCb) =>
  _fbOnChildChanged(q, (snap) => { recordDownload(snap); cb(snap); }, errCb);
const onChildRemoved = (q, cb, errCb) =>
  _fbOnChildRemoved(q, (snap) => { recordDownload(snap); cb(snap); }, errCb);

// ─── CACHE TỪ ĐIỂN & SELF-AUDIT ĐA NGÔN NGỮ ──────────────────────────────────
let dictCache = null;
let dictMetaCache = null;
let dictAuditDone = false;

function runDictionaryAudit(mod) {
  if (dictAuditDone || !mod) return;
  dictAuditDone = true;
  try {
    const issues = [];
    const canonicalLangs = Array.isArray(mod.CANONICAL_LANGS) ? mod.CANONICAL_LANGS : [];
    const langMeta = mod.LANG_META || {};
    const translations = mod.ITEM_TRANSLATIONS || {};
    const dictObj = mod.dict || {};

    // 1. Đối chiếu các nút cờ trên HTML với LANG_META
    document.querySelectorAll("#lang-grid [data-lang]").forEach((btn) => {
      const code = btn.getAttribute("data-lang");
      if (!code || !dictObj[code]) {
        issues.push(`Thiếu cấu hình cờ '${code}' trong dict.js`);
      } else if (!dictObj[code].flag || !dictObj[code].total || !dictObj[code].thanks) {
        issues.push(`Thiếu flag/total/thanks cho cờ '${code}'`);
      }
    });

    // 2. Đối chiếu toàn bộ món trong menu.js với ITEM_TRANSLATIONS
    const menuIds = new Set();
    for (const itm of menu) {
      menuIds.add(String(itm.id));
      const row = translations[itm.id];
      if (!row) {
        issues.push(`Món #${itm.id} (${itm.name}) chưa có bản dịch trong ITEM_TRANSLATIONS`);
        continue;
      }
      const missingLangs = canonicalLangs.filter((l) => !row[l] || !String(row[l]).trim());
      if (missingLangs.length > 0) {
        issues.push(`Món #${itm.id} (${itm.name}) thiếu bản dịch: ${missingLangs.join(", ")}`);
      }
    }

    // 3. Kiểm tra ID dư thừa trong ITEM_TRANSLATIONS không còn trong menu.js
    for (const idKey of Object.keys(translations)) {
      if (!menuIds.has(String(idKey))) {
        issues.push(`ID #${idKey} có trong dict.js nhưng không tồn tại trong menu.js`);
      }
    }

    if (issues.length > 0) {
      console.warn(`[DICT AUDIT] Phát hiện ${issues.length} vấn đề bản dịch:\n- ` + issues.join("\n- "));
    } else {
      console.info(
        `[DICT AUDIT] OK: ${menu.length} món × ${canonicalLangs.length} ngôn ngữ chuẩn (${Object.keys(langMeta).length} lá cờ) đầy đủ.`
      );
    }
  } catch (e) {
    console.warn("[DICT AUDIT] Lỗi kiểm tra từ điển:", e);
  }
}

async function getLangData(lang) {
  if (!dictCache) {
    const mod = await import(withAppVersion("./dict.js"));
    dictCache = mod.dict;
    dictMetaCache = mod.LANG_META || null;
    runDictionaryAudit(mod);
  }
  return dictCache[lang] || dictCache["vi"];
}

// ─── TỰ ĐỘNG TÍNH TOÁN & CẬP NHẬT SĨ SỐ KHÁCH TẠI QUÁN ───────────────────────
function updateCrowdStatus(totalGuests) {
  const el = document.getElementById("crowd-status");
  if (!el) return;

  let text = "";
  let levelClass = "";

  if (totalGuests === 0) {
    text = "Quán đang trống (0 khách)";
    levelClass = "crowd-empty";
  } else if (totalGuests <= 5) {
    text = `Vắng khách (~${totalGuests} khách)`;
    levelClass = "crowd-low";
  } else if (totalGuests <= 12) {
    text = `Khách vừa (~${totalGuests} khách)`;
    levelClass = "crowd-medium";
  } else if (totalGuests <= 20) {
    text = `Đang đông (~${totalGuests} khách)`;
    levelClass = "crowd-high";
  } else {
    text = `Quá tải / Rất đông (~${totalGuests} khách)`;
    levelClass = "crowd-full";
  }

  const icon =
    totalGuests === 0
      ? "🍃"
      : totalGuests <= 5
        ? "🌱"
        : totalGuests <= 12
          ? "🍜"
          : totalGuests <= 20
            ? "🔥"
            : "🚨";
  el.textContent = `${icon} ${text}`;
  el.className = `crowd-badge ${levelClass}`;
}

function getGuestCountForTable(tab) {
  const order = serverOrders[tab];
  if (!order) return 0;

  let mainDishes = 0;
  for (const [idStr, qty] of Object.entries(order)) {
    const q = Number(qty) || 0;
    if (q <= 0) continue;
    const itm = ITEM_MAP.get(Number(idStr));
    if (itm && itm.cat === "main") {
      mainDishes += q;
    }
  }
  return mainDishes;
}

function recalculateTotalCrowd() {
  let total = 0;
  for (let t = 1; t <= TABLE_COUNT; t++) {
    total += getGuestCountForTable(t);
  }
  updateCrowdStatus(total);
}

// ─── HỆ THỐNG THỜI TIẾT & CHẤT LƯỢNG KHÔNG KHÍ ĐÀ NẴNG ─────────────────────────
function wmoWeatherInfo(code, isDay = 1) {
  const day = isDay === 1;
  if (code === 0) return { icon: day ? "☀️" : "🌙", desc: day ? "Trời quang" : "Đêm quang" };
  if (code === 1) return { icon: day ? "🌤️" : "🌙", desc: "Ít mây" };
  if (code === 2) return { icon: "⛅", desc: "Có mây" };
  if (code === 3) return { icon: "☁️", desc: "Nhiều mây" };
  if (code === 45 || code === 48) return { icon: "🌫️", desc: "Sương mù" };
  if ([51, 53, 55, 56, 57].includes(code)) return { icon: "🌦️", desc: "Mưa phùn" };
  if ([61, 63, 65, 66, 67].includes(code)) return { icon: "🌧️", desc: "Có mưa" };
  if ([71, 73, 75, 77].includes(code)) return { icon: "❄️", desc: "Tuyết rơi" };
  if ([80, 81, 82].includes(code)) return { icon: "🌦️", desc: "Mưa rào" };
  if ([95, 96, 99].includes(code)) return { icon: "⛈️", desc: "Dông bão" };
  return { icon: "🌡️", desc: "Ổn định" };
}

function getAqiStyle(aqi) {
  if (aqi == null || Number.isNaN(Number(aqi))) {
    return { label: "--", cls: "aqi-good" };
  }
  const v = Number(aqi);
  if (v <= 50) return { label: `${v} Tốt`, cls: "aqi-good" };
  if (v <= 100) return { label: `${v} TB`, cls: "aqi-fair" };
  if (v <= 150) return { label: `${v} Kém`, cls: "aqi-mod" };
  return { label: `${v} Xấu`, cls: "aqi-poor" };
}

async function fetchDanangWeatherAndAqi() {
  const iconEl = document.getElementById("wx-icon");
  const tempEl = document.getElementById("wx-temp");
  const descEl = document.getElementById("wx-desc");
  const humEl = document.getElementById("wx-hum");
  const rainEl = document.getElementById("wx-rain");
  const aqiEl = document.getElementById("wx-aqi");
  const hubEl = document.getElementById("weather-hub");

  if (!iconEl || !tempEl) return;

  const LAT = 16.0544;
  const LON = 108.2022;

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,is_day,weather_code&hourly=precipitation_probability&timezone=Asia%2FHo_Chi_Minh&forecast_days=1`;
  const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}&current=us_aqi&timezone=Asia%2FHo_Chi_Minh`;

  try {
    const [wxRes, aqiRes] = await Promise.allSettled([
      fetch(weatherUrl, { cache: "no-store" }),
      fetch(aqiUrl, { cache: "no-store" })
    ]);

    if (wxRes.status === "fulfilled" && wxRes.value.ok) {
      const wxData = await wxRes.value.json();
      const cur = wxData.current;
      if (cur) {
        const temp = Math.round(cur.temperature_2m);
        const hum = Math.round(cur.relative_humidity_2m);
        const info = wmoWeatherInfo(cur.weather_code, cur.is_day);

        iconEl.textContent = info.icon;
        tempEl.textContent = `${temp}°C`;
        if (descEl) descEl.textContent = info.desc;
        if (humEl) humEl.textContent = `${hum}%`;

        let rainProb = 0;
        if (wxData.hourly && Array.isArray(wxData.hourly.time) && Array.isArray(wxData.hourly.precipitation_probability)) {
          const curHourPrefix = cur.time ? cur.time.slice(0, 13) : "";
          const idx = wxData.hourly.time.findIndex((t) => t.startsWith(curHourPrefix));
          if (idx !== -1 && wxData.hourly.precipitation_probability[idx] != null) {
            rainProb = wxData.hourly.precipitation_probability[idx];
          }
        }
        if (rainEl) rainEl.textContent = `${rainProb}%`;
      }
    }

    if (aqiRes.status === "fulfilled" && aqiRes.value.ok) {
      const aqiData = await aqiRes.value.json();
      const usAqi = aqiData?.current?.us_aqi;
      const st = getAqiStyle(usAqi);
      if (aqiEl) {
        aqiEl.textContent = st.label;
        aqiEl.className = `wx-aqi-pill ${st.cls}`;
      }
    }

    if (hubEl) {
      const nowStr = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      hubEl.title = `Đà Nẵng • Cập nhật lúc ${nowStr} (Bấm để làm mới)`;
    }
  } catch (err) {
    console.warn("Lỗi tải dữ liệu thời tiết Đà Nẵng:", err);
    if (descEl) descEl.textContent = "Tạm mất kết nối";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const hubEl = document.getElementById("weather-hub");
  if (hubEl) {
    hubEl.addEventListener("click", () => {
      playSound("nav");
      const descEl = document.getElementById("wx-desc");
      if (descEl) descEl.textContent = "Đang cập nhật...";
      fetchDanangWeatherAndAqi();
    });
  }
});

// ─── HỆ THỐNG BÁO GIÁ BITCOIN REALTIME & ĐỒ THỊ SPARKLINE ──────────────────────
const BTC_MAX_POINTS = 28;
let btcPriceHistory = [];
let btcLastPrice = null;
let btcWs = null;
let btcReconnectTimer = null;

function formatUsdCompact(price) {
  if (!Number.isFinite(price)) return "$--";
  return (
    "$" +
    price.toLocaleString("en-US", {
      minimumFractionDigits: price >= 1000 ? 0 : 2,
      maximumFractionDigits: price >= 1000 ? 0 : 2
    })
  );
}

function drawBtcSparkline(isUp) {
  const canvas = document.getElementById("btc-spark");
  if (!canvas || btcPriceHistory.length < 2) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 72;
  const h = canvas.clientHeight || 22;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const min = Math.min(...btcPriceHistory);
  const max = Math.max(...btcPriceHistory);
  const span = max - min || 1;
  const padY = 2.5;
  const usableH = h - padY * 2;
  const stepX = w / (btcPriceHistory.length - 1);

  const strokeColor = isUp ? "#10b981" : "#f43f5e";
  const fillTop = isUp ? "rgba(16, 185, 129, 0.28)" : "rgba(244, 63, 94, 0.28)";
  const fillBottom = isUp ? "rgba(16, 185, 129, 0.0)" : "rgba(244, 63, 94, 0.0)";

  ctx.beginPath();
  btcPriceHistory.forEach((val, idx) => {
    const x = idx * stepX;
    const y = padY + usableH - ((val - min) / span) * usableH;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, fillTop);
  grad.addColorStop(1, fillBottom);
  ctx.fillStyle = grad;
  ctx.fill();

  const lastX = (btcPriceHistory.length - 1) * stepX;
  const lastVal = btcPriceHistory[btcPriceHistory.length - 1];
  const lastY = padY + usableH - ((lastVal - min) / span) * usableH;
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.1, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor;
  ctx.fill();
}

function updateBtcTickerUi(price, open24h) {
  const tickerEl = document.getElementById("btc-ticker");
  const priceEl = document.getElementById("btc-price");
  const changeEl = document.getElementById("btc-change");
  if (!tickerEl || !priceEl || !changeEl || !Number.isFinite(price)) return;

  priceEl.textContent = formatUsdCompact(price);

  let pct = 0;
  if (Number.isFinite(open24h) && open24h > 0) {
    pct = ((price - open24h) / open24h) * 100;
  }
  const isUp = pct >= 0;
  changeEl.textContent = `${isUp ? "▲" : "▼"}${Math.abs(pct).toFixed(2)}%`;
  changeEl.className = `btc-change ${isUp ? "is-up" : "is-down"}`;

  if (btcLastPrice !== null && price !== btcLastPrice) {
    tickerEl.classList.remove("flash-up", "flash-down");
    void tickerEl.offsetWidth;
    tickerEl.classList.add(price > btcLastPrice ? "flash-up" : "flash-down");
  }
  btcLastPrice = price;

  btcPriceHistory.push(price);
  if (btcPriceHistory.length > BTC_MAX_POINTS) {
    btcPriceHistory.shift();
  }
  drawBtcSparkline(isUp);
}

async function seedBtcInitialHistory() {
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=24",
      { cache: "no-store" }
    );
    if (!res.ok) return;
    const klines = await res.json();
    if (Array.isArray(klines) && klines.length > 0) {
      btcPriceHistory = klines.map((k) => parseFloat(k[4])).filter(Number.isFinite);
      const lastClose = btcPriceHistory[btcPriceHistory.length - 1];
      const firstOpen = parseFloat(klines[0][1]);
      if (Number.isFinite(lastClose)) {
        updateBtcTickerUi(lastClose, firstOpen);
      }
    }
  } catch (_) {}
}

function connectBtcWebSocket() {
  if (btcWs) {
    try {
      btcWs.close();
    } catch (_) {}
    btcWs = null;
  }
  if (btcReconnectTimer) {
    clearTimeout(btcReconnectTimer);
    btcReconnectTimer = null;
  }

  try {
    btcWs = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@miniTicker");
    btcWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const closePrice = parseFloat(data.c);
        const openPrice = parseFloat(data.o);
        if (Number.isFinite(closePrice)) {
          updateBtcTickerUi(closePrice, openPrice);
        }
      } catch (_) {}
    };
    btcWs.onerror = () => {
      try {
        btcWs.close();
      } catch (_) {}
    };
    btcWs.onclose = () => {
      btcReconnectTimer = setTimeout(connectBtcWebSocket, 4000);
    };
  } catch (_) {
    btcReconnectTimer = setTimeout(connectBtcWebSocket, 5000);
  }
}

function initBtcTicker() {
  const tickerEl = document.getElementById("btc-ticker");
  if (!tickerEl) return;
  tickerEl.addEventListener("click", () => {
    playSound("nav");
    seedBtcInitialHistory();
    connectBtcWebSocket();
  });
  seedBtcInitialHistory().then(() => {
    connectBtcWebSocket();
  });
}

// ─── FIREBASE CONFIG ──────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAh6y9iJ6O34P-sV1Y0qP5pS6sU7vW8xY9z",
  authDomain: "order-quan-com.firebaseapp.com",
  databaseURL: "https://order-quan-com-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "order-quan-com",
  storageBucket: "order-quan-com.firebasestorage.app",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef1234567890abcdef"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ─── VIETQR CONFIG ────────────────────────────────────────────────────────────
const VIETQR_CONFIG = {
  bankId: "MB",
  accountNo: "MS00T07197498621487",
  fallbackAccountNo: "1828591991",
  accountName: "TRAN THANH HUNG",
  template: "qr_only"
};

// ─── CẤU HÌNH BÀN & DANH MỤC ──────────────────────────────────────────────────
const TABLE_COUNT = 9;

const CAT_ICONS = {
  main: "🍚",
  side: "🍲",
  drink: "🥤",
  beer: "🍺"
};

const CAT_LABELS = {
  main: "Món chính",
  side: "Món thêm",
  drink: "Nước giải khát",
  beer: "Bia"
};

const ITEM_MAP = new Map(menu.map((item) => [item.id, item]));
const MENU_BY_CAT = {
  main: menu.filter((i) => i.cat === "main"),
  side: menu.filter((i) => i.cat === "side"),
  drink: menu.filter((i) => i.cat === "drink"),
  beer: menu.filter((i) => i.cat === "beer")
};

// ─── CLIENT SESSION ID (ĐỊNH DANH THIẾT BỊ HIỆN TẠI) ──────────────────────────
const CLIENT_ID = (() => {
  try {
    let cid = sessionStorage.getItem("pos_client_id");
    if (!cid) {
      cid = "dev_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now().toString(36);
      sessionStorage.setItem("pos_client_id", cid);
    }
    return cid;
  } catch (_) {
    return "dev_" + Math.random().toString(36).slice(2, 10);
  }
})();

// ─── STATE ĐỒNG BỘ ────────────────────────────────────────────────────────────
let currentTable = null;
let currentCat = "main";
let currentLang = "vi";

const serverOrders = {};
const serverLocked = {};
const tableStartTimes = {};
const activeViewers = {};
let myViewingRef = null;
let myViewingDisconnect = null;

for (let t = 1; t <= TABLE_COUNT; t++) {
  serverOrders[t] = {};
  serverLocked[t] = false;
  tableStartTimes[t] = null;
  activeViewers[t] = 0;
}

const pendingDeltas = {};
const localEchoDeltas = {};
const pendingTimers = {};
const commitInFlight = {};
let isPaying = false;
const warnedUnknownItemIds = new Set();

const lastRenderedTableState = {};
const tableBtnRefs = {};
const tablePriceRefs = {};
const tableTimeRefs = {};
const tableViewerRefs = {};
const tableBadgeRefs = {};

const ordersRef = ref(db, "orders");
const lockedRef = ref(db, "locked");
const timesRef = ref(db, "times");
const viewersRef = ref(db, "viewers");

// ─── BỘ ĐO DỮ LIỆU TẢI XUỐNG TỪ FIREBASE ─────────────────────────────────────
let fbDownBytes = 0;
let bwUiTimer = null;

function formatBytesVN(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function scheduleBandwidthUiUpdate() {
  if (bwUiTimer) return;
  bwUiTimer = setTimeout(() => {
    bwUiTimer = null;
    const downEl = document.getElementById("bw-down");
    if (downEl) downEl.textContent = formatBytesVN(fbDownBytes);
  }, 150);
}

// ─── HỆ THỐNG ĐỒNG HỒ ĐẾM THỜI GIAN KHÁCH NGỒI ─────────────────────────────────
function formatElapsedTime(startTimeMs) {
  if (!startTimeMs || typeof startTimeMs !== "number") return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000));
  const hrs = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  if (hrs > 0) {
    return `⏱ ${hrs}h${String(mins).padStart(2, "0")}p`;
  }
  return `⏱ ${mins}:${String(secs).padStart(2, "0")}`;
}

function updateAllTableTimers() {
  for (let t = 1; t <= TABLE_COUNT; t++) {
    const timeEl = tableTimeRefs[t];
    if (!timeEl) continue;

    const effective = getEffectiveOrder(t);
    const hasItems = Object.keys(effective).length > 0;
    const startMs = tableStartTimes[t];

    if (hasItems && startMs) {
      const txt = formatElapsedTime(startMs);
      if (timeEl.textContent !== txt) {
        timeEl.textContent = txt;
      }
      timeEl.style.display = "inline-block";

      const diffMins = (Date.now() - startMs) / 60000;
      timeEl.classList.toggle("is-long", diffMins >= 45);
    } else {
      if (timeEl.textContent !== "") timeEl.textContent = "";
      timeEl.style.display = "none";
      timeEl.classList.remove("is-long");
    }
  }
}

setInterval(updateAllTableTimers, 1000);

// ─── HỆ THỐNG DARK MODE ───────────────────────────────────────────────────────
const THEME_STORAGE_KEY = "pos_dark_mode";

function applyTheme(isDark, animate = false) {
  const body = document.body;
  const btn = document.getElementById("btn-theme-toggle");

  if (animate) {
    body.classList.add("theme-transitioning");
    setTimeout(() => {
      body.classList.remove("theme-transitioning");
    }, 400);
  }

  if (isDark) {
    body.classList.add("dark-mode");
    if (btn) {
      btn.textContent = "☀️";
      btn.setAttribute("aria-label", "Chuyển sang giao diện sáng");
    }
  } else {
    body.classList.remove("dark-mode");
    if (btn) {
      btn.textContent = "🌙";
      btn.setAttribute("aria-label", "Chuyển sang giao diện tối");
    }
  }
}

function initTheme() {
  let isDark = false;
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "true") {
      isDark = true;
    } else if (saved === null && window.matchMedia) {
      isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
  } catch (_) {}

  applyTheme(isDark, false);

  const btn = document.getElementById("btn-theme-toggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const nextDark = !document.body.classList.contains("dark-mode");
      applyTheme(nextDark, true);
      playSound("nav");
      try {
        localStorage.setItem(THEME_STORAGE_KEY, String(nextDark));
      } catch (_) {}
    });
  }
}

// ─── HIỆU ỨNG LẬT GIẤY MỞ MÀN (PAPER FLIP INTRO) ───────────────────────────────
function runPaperFlipIntro() {
  const TARGET_SELECTORS = [
    "#weather-hub",
    "#crowd-status",
    ".header-title",
    ".bw-badge",
    "#btc-ticker",
    "#btn-theme-toggle",
    ".table-btn",
    "#hint",
    ".cat-btn",
    ".menu-item",
    ".bill-box",
    "#pay-btn"
  ];

  const allTargets = [];
  TARGET_SELECTORS.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      if (el && !allTargets.includes(el)) {
        allTargets.push(el);
      }
    });
  });

  if (allTargets.length === 0) {
    document.documentElement.classList.remove("paper-flip-pending");
    return;
  }

  allTargets.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const isVisibleInViewport =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight);

    if (isVisibleInViewport) {
      el.classList.add("paper-flip-item");
      el.dataset.flipY = String(Math.round(rect.top));
      el.dataset.flipX = String(Math.round(rect.left));
    }
  });

  const visibleItems = allTargets.filter((el) => el.classList.contains("paper-flip-item"));
  visibleItems.sort((a, b) => {
    const dy = Number(a.dataset.flipY) - Number(b.dataset.flipY);
    if (Math.abs(dy) > 18) return dy;
    return Number(a.dataset.flipX) - Number(b.dataset.flipX);
  });

  const STEP_DELAY = 38;
  const MAX_TOTAL_DELAY = 680;
  const ANIM_DURATION = 520;

  visibleItems.forEach((el, idx) => {
    const delay = Math.min(idx * STEP_DELAY, MAX_TOTAL_DELAY);
    el.style.animationDelay = `${delay}ms`;
  });

  requestAnimationFrame(() => {
    document.documentElement.classList.remove("paper-flip-pending");
    visibleItems.forEach((el) => {
      el.classList.add("is-flipping");
    });

    const totalCleanupMs = MAX_TOTAL_DELAY + ANIM_DURATION + 120;
    setTimeout(() => {
      visibleItems.forEach((el) => {
        el.classList.remove("paper-flip-item", "is-flipping");
        el.style.animationDelay = "";
        delete el.dataset.flipY;
        delete el.dataset.flipX;
      });
    }, totalCleanupMs);
  });
}

// ─── HỆ THỐNG ÂM THANH KÉP TỐI ƯU IPHONE ──────────────────────────────────────
let audioCtx = null;
let audioUnlocked = false;
let silentKeepAliveSource = null;
const decodedAudioBuffers = {};
const htmlAudioPools = {};
const htmlPoolIndex = {};
const HTML_POOL_SIZE = 4;

const IS_IOS_DEVICE = (() => {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
})();

const IOS_MAJOR_VERSION = (() => {
  if (!IS_IOS_DEVICE) return 0;
  const m = (navigator.userAgent || "").match(/OS (\d+)_/i);
  return m ? parseInt(m[1], 10) : 17;
})();

const USE_LEGACY_IOS_HTML_AUDIO = IS_IOS_DEVICE && IOS_MAJOR_VERSION > 0 && IOS_MAJOR_VERSION < 17;

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  return audioCtx;
}

function getSoundDuration(type) {
  switch (type) {
    case "plus": return 0.14;
    case "minus": return 0.14;
    case "nav": return 0.08;
    case "error": return 0.25;
    case "pay": return 0.72;
    default: return 0.15;
  }
}

const SOUND_PATTERNS = {
  plus: [
    { f1: 784, f2: 1175, t0: 0.0, dur: 0.095, wave: "triangle", vol: 0.95 },
    { f1: 1175, f2: 1568, t0: 0.04, dur: 0.095, wave: "sine", vol: 0.65 }
  ],
  minus: [
    { f1: 587, f2: 330, t0: 0.0, dur: 0.115, wave: "triangle", vol: 0.90 }
  ],
  nav: [
    { f1: 1320, f2: 920, t0: 0.0, dur: 0.055, wave: "triangle", vol: 1.32 },
    { f1: 2100, f2: 1500, t0: 0.0, dur: 0.04, wave: "sine", vol: 1.40 }
  ],
  error: [
    { f1: 220, f2: 196, t0: 0.0, dur: 0.12, wave: "sawtooth", vol: 0.60 },
    { f1: 196, f2: 165, t0: 0.11, dur: 0.13, wave: "sawtooth", vol: 0.60 }
  ],
  pay: [
    { f1: 1046.5, f2: 1046.5, t0: 0.0, dur: 0.12, wave: "triangle", vol: 0.85 },
    { f1: 1318.5, f2: 1318.5, t0: 0.08, dur: 0.13, wave: "triangle", vol: 0.88 },
    { f1: 1568.0, f2: 1568.0, t0: 0.16, dur: 0.14, wave: "triangle", vol: 0.92 },
    { f1: 2093.0, f2: 2093.0, t0: 0.24, dur: 0.44, wave: "sine", vol: 1.0 }
  ]
};

function renderSoundSamples(type, sampleRate) {
  const dur = getSoundDuration(type);
  const numSamples = Math.ceil(sampleRate * dur);
  const samples = new Float32Array(numSamples);
  const notes = SOUND_PATTERNS[type] || [];

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sum = 0;

    for (let n = 0; n < notes.length; n++) {
      const note = notes[n];
      if (t >= note.t0 && t <= note.t0 + note.dur) {
        const localT = t - note.t0;
        const progress = localT / note.dur;

        const attack = Math.min(1, localT / 0.005);
        const decay = Math.pow(1 - progress, 1.5);
        const env = attack * decay * note.vol;

        let phase;
        if (note.f1 === note.f2) {
          phase = 2 * Math.PI * note.f1 * localT;
        } else {
          const ratio = note.f2 / note.f1;
          phase = (2 * Math.PI * note.f1 * note.dur * (Math.pow(ratio, progress) - 1)) / Math.log(ratio);
        }

        let osc = 0;
        if (note.wave === "sine") {
          osc = Math.sin(phase);
        } else if (note.wave === "triangle") {
          osc = (2 / Math.PI) * Math.asin(Math.sin(phase));
        } else if (note.wave === "sawtooth") {
          const norm = (phase / (2 * Math.PI)) % 1;
          osc = 2 * (norm < 0 ? norm + 1 : norm) - 1;
        }

        sum += osc * env;
      }
    }

    const drive = type === "nav" ? 3.5 : 2.6;
    samples[i] = Math.tanh(sum * drive);
  }

  return samples;
}

function buildAudioBuffer(ctx, type) {
  const sr = ctx.sampleRate || 44100;
  const samples = renderSoundSamples(type, sr);
  const buf = ctx.createBuffer(1, samples.length, sr);
  buf.getChannelData(0).set(samples);
  return buf;
}

function createWavBlobUrl(type) {
  const sampleRate = 44100;
  const samples = renderSoundSamples(type, sampleRate);
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  const blob = new Blob([buffer], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

function initHtmlAudioPools() {
  if (!USE_LEGACY_IOS_HTML_AUDIO) return;
  const types = ["plus", "minus", "nav", "error", "pay"];
  for (const t of types) {
    if (htmlAudioPools[t]) continue;
    const url = createWavBlobUrl(t);
    htmlAudioPools[t] = [];
    htmlPoolIndex[t] = 0;
    for (let i = 0; i < HTML_POOL_SIZE; i++) {
      const a = new Audio(url);
      a.preload = "auto";
      a.volume = 1.0;
      htmlAudioPools[t].push(a);
    }
  }
}

function startSilentWebAudioKeepAlive(ctx) {
  if (silentKeepAliveSource) return;
  try {
    const sr = ctx.sampleRate || 44100;
    const silentBuf = ctx.createBuffer(1, sr * 2, sr);
    const src = ctx.createBufferSource();
    src.buffer = silentBuf;
    src.loop = true;

    const zeroGain = ctx.createGain();
    zeroGain.gain.value = 0.00001;

    src.connect(zeroGain);
    zeroGain.connect(ctx.destination);
    src.start(0);
    silentKeepAliveSource = src;
  } catch (_) {}
}

function playHtmlPoolSound(type) {
  if (!USE_LEGACY_IOS_HTML_AUDIO) return false;
  initHtmlAudioPools();
  const pool = htmlAudioPools[type];
  if (!pool || pool.length === 0) return false;

  const idx = htmlPoolIndex[type] % pool.length;
  htmlPoolIndex[type] = idx + 1;
  const audio = pool[idx];

  try {
    audio.pause();
    audio.currentTime = 0;
    const p = audio.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

function playWebAudioCached(type) {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  if (!decodedAudioBuffers[type]) {
    decodedAudioBuffers[type] = buildAudioBuffer(ctx, type);
  }

  const src = ctx.createBufferSource();
  src.buffer = decodedAudioBuffers[type];

  const boostGain = ctx.createGain();
  boostGain.gain.value = 1.45;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.002;
  comp.release.value = 0.08;

  src.connect(boostGain);
  boostGain.connect(comp);
  comp.connect(ctx.destination);
  src.start(0);
}

function playSound(type) {
  try {
    if (USE_LEGACY_IOS_HTML_AUDIO) {
      playHtmlPoolSound(type);
      return;
    }
    playWebAudioCached(type);
  } catch (e) {
    console.warn("Audio fallback:", e);
  }
}

function unlockHtmlAudioPoolsAsync() {
  if (!USE_LEGACY_IOS_HTML_AUDIO) return;
  initHtmlAudioPools();
  for (const type of Object.keys(htmlAudioPools)) {
    const a = htmlAudioPools[type][0];
    if (!a) continue;
    try {
      a.muted = true;
      const p = a.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          a.pause();
          a.currentTime = 0;
          a.muted = false;
        }).catch(() => {
          a.muted = false;
        });
      } else {
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      }
    } catch (_) {
      a.muted = false;
    }
  }
}

function unlockAllAudio() {
  const ctx = ensureAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  if (!audioUnlocked) {
    audioUnlocked = true;

    if (ctx) {
      const types = ["plus", "minus", "nav", "error", "pay"];
      for (const t of types) {
        if (!decodedAudioBuffers[t]) {
          decodedAudioBuffers[t] = buildAudioBuffer(ctx, t);
        }
      }
      startSilentWebAudioKeepAlive(ctx);
    }

    if (USE_LEGACY_IOS_HTML_AUDIO) {
      unlockHtmlAudioPoolsAsync();
    }
  }
}

["touchstart", "touchend", "pointerdown", "mousedown", "click", "keydown"].forEach((evt) => {
  document.addEventListener(evt, unlockAllAudio, { passive: true });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    fetchDanangWeatherAndAqi();
    if (!btcWs || btcWs.readyState !== WebSocket.OPEN) {
      connectBtcWebSocket();
    }
  }
});

// ─── TÍNH TOÁN DỮ LIỆU ĐƠN HÀNG HIỆU LỰC ─────────────────────────────────────
function getEffectiveOrder(tab) {
  const result = {};
  const srv = serverOrders[tab] || {};
  const pnd = pendingDeltas[tab] || {};
  const echo = localEchoDeltas[tab] || {};
  const allIds = new Set([...Object.keys(srv), ...Object.keys(pnd), ...Object.keys(echo)]);
  for (const idStr of allIds) {
    const qty = (srv[idStr] || 0) + (pnd[idStr] || 0) + (echo[idStr] || 0);
    if (qty > 0) result[idStr] = qty;
  }
  return result;
}

function calculateTotalFromMap(orderMap) {
  let total = 0;
  for (const [idStr, qty] of Object.entries(orderMap)) {
    const item = ITEM_MAP.get(Number(idStr));
    if (item) total += item.price * qty;
  }
  return total;
}

function formatMoney(amount) {
  return amount.toLocaleString("vi-VN") + "đ";
}

function showToast(msg, duration = 2200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), duration);
}

// ─── QUẢN LÝ TRẠNG THÁI "ĐANG XEM BÀN" (PRESENCE) ────────────────────────────
async function leaveCurrentViewingTable() {
  if (myViewingDisconnect) {
    try {
      await myViewingDisconnect.cancel();
    } catch (_) {}
    myViewingDisconnect = null;
  }
  if (myViewingRef) {
    try {
      await remove(myViewingRef);
    } catch (_) {}
    myViewingRef = null;
  }
}

async function enterViewingTable(tab) {
  await leaveCurrentViewingTable();
  if (!tab) return;
  const r = ref(db, `viewers/table_${tab}/${CLIENT_ID}`);
  myViewingRef = r;
  try {
    myViewingDisconnect = onDisconnect(r);
    await myViewingDisconnect.remove();
    await set(r, true);
  } catch (_) {}
}

window.addEventListener("beforeunload", () => {
  if (myViewingRef) {
    try {
      remove(myViewingRef);
    } catch (_) {}
  }
});

// ─── GỬI DELTA CỘNG/TRỪ MÓN LÊN SERVER ───────────────────────────────────────
function queueItemDelta(tab, itemId, delta) {
  if (!tab) {
    playSound("error");
    showToast("Vui lòng chọn bàn trước!");
    return;
  }
  if (serverLocked[tab]) {
    playSound("error");
    showToast(`Bàn ${tab} đang được thu tiền, vui lòng đợi!`);
    return;
  }

  const effective = getEffectiveOrder(tab);
  const currentQty = effective[itemId] || 0;
  const nextQty = currentQty + delta;

  if (nextQty < 0) return;

  if (delta > 0) {
    playSound("plus");
  } else {
    playSound("minus");
  }

  const isTableCurrentlyEmpty = Object.keys(effective).length === 0;
  if (isTableCurrentlyEmpty && delta > 0 && !tableStartTimes[tab]) {
    const nowMs = Date.now();
    tableStartTimes[tab] = nowMs;
    updateAllTableTimers();
    const timeKey = `table_${tab}`;
    runTransaction(child(timesRef, timeKey), (curTime) => {
      if (curTime === null) return nowMs;
      return curTime;
    }).catch((err) => console.warn("Lỗi ghi giờ bắt đầu bàn:", err));
  }

  if (!pendingDeltas[tab]) pendingDeltas[tab] = {};
  pendingDeltas[tab][itemId] = (pendingDeltas[tab][itemId] || 0) + delta;
  if (pendingDeltas[tab][itemId] === 0) delete pendingDeltas[tab][itemId];

  renderTableButton(tab);
  recalculateTotalCrowd();
  if (currentTable === tab) {
    renderMenuItemsOnly();
    renderBillAsync(tab);
  }

  const timerKey = `${tab}_${itemId}`;
  clearTimeout(pendingTimers[timerKey]);
  pendingTimers[timerKey] = setTimeout(() => {
    commitPendingItem(tab, itemId);
  }, 250);
}

async function commitPendingItem(tab, itemId) {
  const timerKey = `${tab}_${itemId}`;
  if (commitInFlight[timerKey]) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => commitPendingItem(tab, itemId), 120);
    return;
  }

  const delta = pendingDeltas[tab]?.[itemId] || 0;
  if (delta === 0) return;

  delete pendingDeltas[tab][itemId];
  if (!localEchoDeltas[tab]) localEchoDeltas[tab] = {};
  localEchoDeltas[tab][itemId] = (localEchoDeltas[tab][itemId] || 0) + delta;
  if (localEchoDeltas[tab][itemId] === 0) delete localEchoDeltas[tab][itemId];

  commitInFlight[timerKey] = true;

  const itemRef = ref(db, `orders/table_${tab}/${itemId}`);
  try {
    const txRes = await runTransaction(itemRef, (currentVal) => {
      const base = typeof currentVal === "number" ? currentVal : 0;
      const updated = base + delta;
      return updated > 0 ? updated : null;
    });

    if (localEchoDeltas[tab] && localEchoDeltas[tab][itemId] !== undefined) {
      localEchoDeltas[tab][itemId] -= delta;
      if (localEchoDeltas[tab][itemId] === 0) delete localEchoDeltas[tab][itemId];
    }

    if (txRes && txRes.committed) {
      if (!serverOrders[tab]) serverOrders[tab] = {};
      const finalServerVal = txRes.snapshot ? txRes.snapshot.val() : null;
      if (typeof finalServerVal === "number" && finalServerVal > 0) {
        serverOrders[tab][String(itemId)] = finalServerVal;
      } else {
        delete serverOrders[tab][String(itemId)];
      }
    }
  } catch (err) {
    console.warn("Lỗi đồng bộ món, tự khôi phục hàng đợi:", err);
    if (localEchoDeltas[tab] && localEchoDeltas[tab][itemId] !== undefined) {
      localEchoDeltas[tab][itemId] -= delta;
      if (localEchoDeltas[tab][itemId] === 0) delete localEchoDeltas[tab][itemId];
    }
    if (!pendingDeltas[tab]) pendingDeltas[tab] = {};
    pendingDeltas[tab][itemId] = (pendingDeltas[tab][itemId] || 0) + delta;
    if (pendingDeltas[tab][itemId] === 0) delete pendingDeltas[tab][itemId];
  } finally {
    commitInFlight[timerKey] = false;
    renderTableButton(tab);
    recalculateTotalCrowd();
    if (currentTable === tab) {
      renderMenuItemsOnly();
      renderBillAsync(tab);
    }
    checkAndClearEmptyTableTime(tab);
  }
}

function checkAndClearEmptyTableTime(tab) {
  const hasPending = pendingDeltas[tab] && Object.keys(pendingDeltas[tab]).length > 0;
  const hasEcho = localEchoDeltas[tab] && Object.keys(localEchoDeltas[tab]).length > 0;
  if (hasPending || hasEcho) return;

  const srv = serverOrders[tab] || {};
  if (Object.keys(srv).length === 0 && tableStartTimes[tab]) {
    tableStartTimes[tab] = null;
    updateAllTableTimers();
    remove(child(timesRef, `table_${tab}`)).catch(() => {});
  }
}

async function flushPendingForTable(tab) {
  const promises = [];
  for (let i = 1; i <= menu.length + 20; i++) {
    const key = `${tab}_${i}`;
    if (pendingTimers[key]) {
      clearTimeout(pendingTimers[key]);
      delete pendingTimers[key];
    }
  }
  if (pendingDeltas[tab]) {
    for (const itemIdStr of Object.keys(pendingDeltas[tab])) {
      promises.push(commitPendingItem(tab, Number(itemIdStr)));
    }
  }
  await Promise.all(promises);

  let guard = 0;
  while (guard < 25) {
    const stillBusy = Object.keys(commitInFlight).some((k) => k.startsWith(`${tab}_`) && commitInFlight[k]);
    if (!stillBusy) break;
    await new Promise((r) => setTimeout(r, 40));
    guard++;
  }
}

function clearPendingForTable(tab) {
  for (const key of Object.keys(pendingTimers)) {
    if (key.startsWith(`${tab}_`)) {
      clearTimeout(pendingTimers[key]);
      delete pendingTimers[key];
    }
  }
  delete pendingDeltas[tab];
  delete localEchoDeltas[tab];
}

// ─── KHỞI TẠO & RENDER BẢNG CHỌN BÀN ──────────────────────────────────────────
function initTables() {
  const tablesDiv = document.getElementById("tables");
  if (!tablesDiv) return;
  tablesDiv.innerHTML = "";

  for (let i = 1; i <= TABLE_COUNT; i++) {
    const btn = document.createElement("button");
    btn.className = "table-btn table-card";
    btn.type = "button";
    btn.onclick = () => selectTable(i);

    const nameEl = document.createElement("strong");
    nameEl.className = "table-name";
    nameEl.textContent = `Bàn ${i}`;

    const priceEl = document.createElement("span");
    priceEl.className = "table-price";
    priceEl.textContent = "0đ";

    const timeEl = document.createElement("span");
    timeEl.className = "table-time";
    timeEl.style.display = "none";

    const viewerEl = document.createElement("span");
    viewerEl.className = "table-viewer-badge";
    viewerEl.style.display = "none";

    const badgeEl = document.createElement("span");
    badgeEl.className = "remote-paying-badge";
    badgeEl.textContent = "💰 Đang thu tiền...";
    badgeEl.style.display = "none";

    btn.append(nameEl, priceEl, timeEl, viewerEl, badgeEl);
    tablesDiv.appendChild(btn);

    tableBtnRefs[i] = btn;
    tablePriceRefs[i] = priceEl;
    tableTimeRefs[i] = timeEl;
    tableViewerRefs[i] = viewerEl;
    tableBadgeRefs[i] = badgeEl;
    renderTableButton(i);
  }
}

function renderTableButton(tab) {
  const btn = tableBtnRefs[tab];
  const priceEl = tablePriceRefs[tab];
  const viewerEl = tableViewerRefs[tab];
  const badgeEl = tableBadgeRefs[tab];
  if (!btn || !priceEl) return;

  const effective = getEffectiveOrder(tab);
  const total = calculateTotalFromMap(effective);
  const isSelected = currentTable === tab;
  const isLocked = Boolean(serverLocked[tab]);
  const hasGuest = total > 0;
  const viewersCount = activeViewers[tab] || 0;
  const hasViewer = viewersCount > 0;

  const stateKey = `${total}|${isSelected}|${isLocked}|${hasGuest}|${viewersCount}`;
  if (lastRenderedTableState[tab] === stateKey) return;
  lastRenderedTableState[tab] = stateKey;

  priceEl.textContent = formatMoney(total);
  btn.classList.toggle("active", isSelected);
  btn.classList.toggle("is-locked", isLocked);
  btn.classList.toggle("has-guest", hasGuest);
  btn.classList.toggle("has-viewer", hasViewer);
  btn.classList.toggle("is-empty", !hasGuest && !isSelected);

  if (viewerEl) {
    if (hasViewer && !isLocked) {
      viewerEl.textContent = viewersCount > 1 ? `👀 ${viewersCount} đang xem` : "👀 Đang xem";
      viewerEl.style.display = "inline-block";
    } else {
      viewerEl.style.display = "none";
    }
  }

  if (badgeEl) {
    badgeEl.style.display = isLocked ? "block" : "none";
  }

  updateAllTableTimers();
}

function renderAllTableButtons() {
  for (let i = 1; i <= TABLE_COUNT; i++) {
    renderTableButton(i);
  }
}

// ─── CHỌN BÀN & DANH MỤC ──────────────────────────────────────────────────────
function selectTable(tab) {
  if (currentTable === tab) return;

  playSound("nav");

  const prev = currentTable;
  currentTable = tab;

  if (prev) renderTableButton(prev);
  renderTableButton(tab);

  enterViewingTable(tab);

  const hint = document.getElementById("hint");
  if (hint) hint.style.display = "none";

  const mainArea = document.getElementById("main-area");
  if (mainArea) mainArea.style.display = "block";

  renderCategories();
  renderMenu();
  renderBillAsync(tab);

  const modal = document.getElementById("modal");
  if (modal && modal.style.display === "flex") {
    closeModal();
  }
}

function renderCategories() {
  const catDiv = document.getElementById("categories");
  if (!catDiv) return;
  catDiv.innerHTML = "";

  for (const catKey of ["main", "side", "drink", "beer"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-btn" + (catKey === currentCat ? " active" : "");
    btn.textContent = `${CAT_ICONS[catKey]} ${CAT_LABELS[catKey]}`;
    btn.onclick = () => {
      if (currentCat === catKey) return;
      playSound("nav");
      currentCat = catKey;
      renderCategories();
      renderMenu();
    };
    catDiv.appendChild(btn);
  }
}

// ─── RENDER THỰC ĐƠN ──────────────────────────────────────────────────────────
const menuQtyRefs = {};

function renderMenu() {
  const menuDiv = document.getElementById("menu");
  if (!menuDiv) return;
  menuDiv.innerHTML = "";
  for (const k of Object.keys(menuQtyRefs)) delete menuQtyRefs[k];

  const items = MENU_BY_CAT[currentCat] || [];
  const effective = currentTable ? getEffectiveOrder(currentTable) : {};

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "menu-item";

    const info = document.createElement("div");
    info.className = "menu-info";
    const nameSpan = document.createElement("strong");
    nameSpan.textContent = item.name;
    const priceSpan = document.createElement("span");
    priceSpan.textContent = formatMoney(item.price);
    info.append(nameSpan, priceSpan);

    const ctrl = document.createElement("div");
    ctrl.className = "menu-ctrl";

    const minusBtn = document.createElement("button");
    minusBtn.type = "button";
    minusBtn.className = "btn-minus";
    minusBtn.textContent = "−";
    minusBtn.onclick = () => queueItemDelta(currentTable, item.id, -1);

    const qtySpan = document.createElement("span");
    qtySpan.className = "qty";
    qtySpan.textContent = effective[item.id] || 0;
    menuQtyRefs[item.id] = qtySpan;

    const plusBtn = document.createElement("button");
    plusBtn.type = "button";
    plusBtn.className = "btn-plus";
    plusBtn.textContent = "+";
    plusBtn.onclick = () => queueItemDelta(currentTable, item.id, 1);

    ctrl.append(minusBtn, qtySpan, plusBtn);
    row.append(info, ctrl);
    menuDiv.appendChild(row);
  }
}

function renderMenuItemsOnly() {
  if (!currentTable) return;
  const effective = getEffectiveOrder(currentTable);
  for (const [idStr, qtyEl] of Object.entries(menuQtyRefs)) {
    qtyEl.textContent = effective[idStr] || 0;
  }
}

// ─── RENDER HÓA ĐƠN (BILL) ĐA NGÔN NGỮ (FALLBACK 3 TẦNG) ──────────────────────
let billRenderSeq = 0;

async function renderBillAsync(tab) {
  const seq = ++billRenderSeq;
  const targetLang = currentLang;
  const langData = await getLangData(targetLang);
  const enData = targetLang === "en" ? langData : await getLangData("en");
  if (seq !== billRenderSeq || tab !== currentTable) return;

  const billDiv = document.getElementById("bill");
  const payBtn = document.getElementById("pay-btn");
  if (!billDiv || !payBtn) return;

  billDiv.setAttribute("data-bill-lang", targetLang);

  const effective = getEffectiveOrder(tab);
  const entries = Object.entries(effective)
    .map(([idStr, qty]) => {
      const itm = ITEM_MAP.get(Number(idStr));
      return itm ? { itm, qty } : null;
    })
    .filter(Boolean);

  billDiv.innerHTML = "";

  const header = document.createElement("div");
  header.className = "bill-header";
  const titleSpan = document.createElement("span");
  titleSpan.textContent = `BÀN ${tab}`;
  const flagSpan = document.createElement("span");
  flagSpan.id = "txt-lang-flag";
  flagSpan.textContent = langData.flag || "🇻🇳";
  header.append(titleSpan, flagSpan);
  billDiv.appendChild(header);

  if (entries.length === 0) {
    const emptyP = document.createElement("p");
    emptyP.className = "bill-empty";
    emptyP.textContent = "Chưa có món nào được chọn";
    billDiv.appendChild(emptyP);

    payBtn.disabled = true;
    payBtn.textContent = "THANH TOÁN";
    return;
  }

  let total = 0;
  for (const { itm, qty } of entries) {
    const sub = itm.price * qty;
    total += sub;

    // Fallback 3 tầng: Ngôn ngữ đang chọn -> Tiếng Anh -> Tiếng Việt gốc
    const translatedName =
      (langData?.items?.[itm.id] || "").trim() ||
      (targetLang !== "en" ? (enData?.items?.[itm.id] || "").trim() : "") ||
      itm.name;

    const itemRow = document.createElement("div");
    itemRow.className = "bill-item";

    const leftDiv = document.createElement("div");
    leftDiv.className = "bill-item-left";

    const nameDiv = document.createElement("div");
    nameDiv.className = "bill-item-name";
    nameDiv.textContent = translatedName;

    const unitDiv = document.createElement("div");
    unitDiv.className = "bill-item-unit";
    unitDiv.textContent = `${formatMoney(itm.price)} × ${qty}`;

    leftDiv.append(nameDiv, unitDiv);

    const rightDiv = document.createElement("div");
    rightDiv.className = "bill-item-right";

    const subSpan = document.createElement("span");
    subSpan.className = "bill-item-sub";
    subSpan.textContent = formatMoney(sub);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-remove-line";
    delBtn.title = "Bớt 1 phần";
    delBtn.textContent = "−";
    delBtn.onclick = () => queueItemDelta(tab, itm.id, -1);

    rightDiv.append(subSpan, delBtn);
    itemRow.append(leftDiv, rightDiv);
    billDiv.appendChild(itemRow);
  }

  const totalRow = document.createElement("div");
  totalRow.className = "bill-total";
  const totalLabel = document.createElement("span");
  totalLabel.id = "txt-total";
  totalLabel.textContent = langData.total || "TỔNG";
  const totalVal = document.createElement("span");
  totalVal.textContent = formatMoney(total);
  totalRow.append(totalLabel, totalVal);
  billDiv.appendChild(totalRow);

  const thanksDiv = document.createElement("div");
  thanksDiv.id = "txt-thanks";
  thanksDiv.className = "bill-thanks";
  thanksDiv.textContent = langData.thanks || "";
  billDiv.appendChild(thanksDiv);

  const isLocked = Boolean(serverLocked[tab]);
  payBtn.disabled = isLocked;
  payBtn.textContent = isLocked ? "ĐANG THU TIỀN..." : `THANH TOÁN (${formatMoney(total)})`;
}

// ─── CHỌN NGÔN NGỮ & HIỆU ỨNG MÁY IN HÓA ĐƠN ──────────────────────────────────
function initLangButtons() {
  const grid = document.getElementById("lang-grid");
  if (!grid) return;

  const billShell = document.getElementById("bill-shell");
  const printerSlot = document.getElementById("printer-slot");
  let printAnimTimer = null;

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-lang]");
    if (!btn) return;
    const lang = btn.getAttribute("data-lang");
    if (!lang) return;

    playSound("nav");
    currentLang = lang;
    grid.querySelectorAll("[data-lang]").forEach((b) => {
      b.classList.toggle("active-lang", b === btn);
    });

    if (currentTable) {
      if (billShell) {
        if (printAnimTimer) clearTimeout(printAnimTimer);
        billShell.classList.remove("is-printing");
        if (printerSlot) printerSlot.classList.remove("is-active");
        void billShell.offsetWidth;
        billShell.classList.add("is-printing");
        if (printerSlot) printerSlot.classList.add("is-active");

        printAnimTimer = setTimeout(() => {
          billShell.classList.remove("is-printing");
          if (printerSlot) printerSlot.classList.remove("is-active");
        }, 700);
      }
      renderBillAsync(currentTable);
    }
  });

  // Kích hoạt kiểm tra chéo từ điển ngay khi trang mở (không chặn giao diện)
  getLangData("vi").catch(() => {});
}

// ─── THANH TOÁN & MÃ VIETQR ĐỘNG ──────────────────────────────────────────────
function buildVietQrUrl(accountNo, amount, addInfo) {
  const { bankId, accountName, template } = VIETQR_CONFIG;
  return (
    `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-${encodeURIComponent(template)}.png` +
    `?amount=${encodeURIComponent(amount)}` +
    `&addInfo=${encodeURIComponent(addInfo)}` +
    `&accountName=${encodeURIComponent(accountName)}`
  );
}

function loadQrWithFallback(imgEl, amount, addInfo) {
  const primaryUrl = buildVietQrUrl(VIETQR_CONFIG.accountNo, amount, addInfo);
  const fallbackUrl = buildVietQrUrl(VIETQR_CONFIG.fallbackAccountNo, amount, addInfo);

  imgEl.dataset.fallbackTried = "0";
  imgEl.onerror = () => {
    if (imgEl.dataset.fallbackTried === "0") {
      imgEl.dataset.fallbackTried = "1";
      imgEl.src = fallbackUrl;
    } else {
      imgEl.alt = "Không tải được mã QR. Vui lòng kiểm tra mạng!";
    }
  };
  imgEl.src = primaryUrl;
}

async function openPayModal() {
  if (!currentTable) return;
  const tab = currentTable;

  if (serverLocked[tab]) {
    playSound("error");
    showToast(`Bàn ${tab} đang được thu tiền trên thiết bị khác!`);
    return;
  }

  playSound("nav");

  await flushPendingForTable(tab);

  const effective = getEffectiveOrder(tab);
  const total = calculateTotalFromMap(effective);
  if (total <= 0) {
    playSound("error");
    showToast("Bàn đang trống, không thể thanh toán!");
    return;
  }

  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalTotal = document.getElementById("modal-total");
  const qrImg = document.getElementById("qr-img");
  const confirmBtn = document.getElementById("confirm-pay");

  if (!modal || !qrImg || !confirmBtn) return;

  if (modalTitle) modalTitle.textContent = `Thanh toán Bàn ${tab}`;
  if (modalTotal) modalTotal.textContent = formatMoney(total);

  const addInfo = `Ban ${tab}`;
  loadQrWithFallback(qrImg, total, addInfo);

  confirmBtn.disabled = false;
  confirmBtn.textContent = "✅ XÁC NHẬN ĐÃ THU TIỀN";

  modal.style.display = "flex";
}

function closeModal() {
  const modal = document.getElementById("modal");
  if (modal) modal.style.display = "none";
}

function mergePendingDeltasBack(tab, backupDeltas) {
  if (!backupDeltas) return;
  if (!pendingDeltas[tab]) pendingDeltas[tab] = {};
  for (const [idStr, delta] of Object.entries(backupDeltas)) {
    const next = (pendingDeltas[tab][idStr] || 0) + delta;
    if (next === 0) {
      delete pendingDeltas[tab][idStr];
    } else {
      pendingDeltas[tab][idStr] = next;
    }
  }
}

async function clearTableLockAndTimeSafely(tab, expectedStartTime) {
  const key = `table_${tab}`;
  const tasks = [remove(child(lockedRef, key))];

  // Chỉ xóa times/{tab} nếu trên server chưa có lượt khách mới hơn ghi đè vào
  const timeNodeRef = child(timesRef, key);
  tasks.push(
    runTransaction(timeNodeRef, (curTime) => {
      if (curTime === null) return null;
      if (expectedStartTime && Number(curTime) !== Number(expectedStartTime)) {
        return; // Hủy xóa: bàn đã có lượt khách mới sau khi thanh toán!
      }
      return null;
    })
  );

  await Promise.allSettled(tasks);
}

async function doPay() {
  if (!currentTable || isPaying) return;
  const tab = currentTable;

  if (serverLocked[tab]) {
    playSound("error");
    showToast(`Bàn ${tab} đã được thu tiền bởi thiết bị khác!`);
    closeModal();
    return;
  }

  const confirmBtn = document.getElementById("confirm-pay");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "⏳ Đang chốt đơn...";
  }

  isPaying = true;

  await flushPendingForTable(tab);

  const backupServerOrder = { ...(serverOrders[tab] || {}) };
  const backupTime = tableStartTimes[tab];
  // Sao lưu phần delta còn tồn (nếu có) trước khi dọn hiển thị lạc quan
  const backupPendingDeltas = pendingDeltas[tab] ? { ...pendingDeltas[tab] } : null;

  clearPendingForTable(tab);
  serverOrders[tab] = {};
  tableStartTimes[tab] = null;
  renderTableButton(tab);
  recalculateTotalCrowd();
  if (currentTable === tab) {
    renderMenuItemsOnly();
    renderBillAsync(tab);
  }
  closeModal();

  const finalizeSuccessfulPayment = () => {
    playSound("pay");
    showToast(`Đã thanh toán xong Bàn ${tab}!`);
    clearTableLockAndTimeSafely(tab, backupTime);
  };

  let orderDeletedOnServer = false;

  try {
    const tableOrderRef = child(ordersRef, `table_${tab}`);
    const txResult = await runTransaction(tableOrderRef, (currentData) => {
      if (!currentData || Object.keys(currentData).length === 0) {
        return;
      }
      return null;
    });

    if (!txResult.committed) {
      serverOrders[tab] = txResult.snapshot?.val() || backupServerOrder;
      tableStartTimes[tab] = backupTime;
      // Khôi phục lại thao tác bấm món cuối cùng nếu transaction bị hủy do xung đột
      mergePendingDeltasBack(tab, backupPendingDeltas);
      if (pendingDeltas[tab]) {
        for (const itemIdStr of Object.keys(pendingDeltas[tab])) {
          commitPendingItem(tab, Number(itemIdStr));
        }
      }
      renderTableButton(tab);
      recalculateTotalCrowd();
      if (currentTable === tab) {
        renderMenuItemsOnly();
        renderBillAsync(tab);
      }
      playSound("error");
      showToast(`Bàn ${tab} vừa được cập nhật, vui lòng kiểm tra lại!`);
      return;
    }

    orderDeletedOnServer = true;
    finalizeSuccessfulPayment();
  } catch (err) {
    console.warn("Lỗi mạng khi chốt đơn:", err);
    if (orderDeletedOnServer) {
      finalizeSuccessfulPayment();
      return;
    }

    // Chưa xác nhận xóa được trên server: hoàn trả trạng thái bàn để nhân viên biết và thử lại
    serverOrders[tab] = backupServerOrder;
    tableStartTimes[tab] = backupTime;
    mergePendingDeltasBack(tab, backupPendingDeltas);
    if (pendingDeltas[tab]) {
      for (const itemIdStr of Object.keys(pendingDeltas[tab])) {
        commitPendingItem(tab, Number(itemIdStr));
      }
    }
    renderTableButton(tab);
    recalculateTotalCrowd();
    if (currentTable === tab) {
      renderMenuItemsOnly();
      renderBillAsync(tab);
    }
    playSound("error");
    showToast("Lỗi mạng khi chốt đơn, vui lòng kiểm tra kết nối và thử lại!");
  } finally {
    isPaying = false;
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "✅ XÁC NHẬN ĐÃ THU TIỀN";
    }
  }
}

// ─── LẮNG NGHE REALTIME TỪ FIREBASE ───────────────────────────────────────────
function bindBranchWithInitialSync(branchRef, onSingleTableSnapshot, onAllTablesSnapshot) {
  let initialBatchDone = false;
  let initialFallbackTimer = null;

  const handleChildEvent = (snap) => {
    const key = snap.key || "";
    const match = key.match(/^table_(\d+)$/);
    if (!match) return;
    const tab = Number(match[1]);
    if (tab < 1 || tab > TABLE_COUNT) return;
    onSingleTableSnapshot(tab, snap.val());
  };

  const unsubAdded = onChildAdded(branchRef, (snap) => {
    if (!initialBatchDone) return;
    handleChildEvent(snap);
  });

  const unsubChanged = onChildChanged(branchRef, (snap) => {
    if (!initialBatchDone) return;
    handleChildEvent(snap);
  });

  const unsubRemoved = onChildRemoved(branchRef, (snap) => {
    if (!initialBatchDone) return;
    const key = snap.key || "";
    const match = key.match(/^table_(\d+)$/);
    if (!match) return;
    const tab = Number(match[1]);
    if (tab < 1 || tab > TABLE_COUNT) return;
    onSingleTableSnapshot(tab, null);
  });

  const unsubInitial = _fbOnValue(
    branchRef,
    (snap) => {
      if (initialBatchDone) return;
      initialBatchDone = true;
      if (initialFallbackTimer) {
        clearTimeout(initialFallbackTimer);
        initialFallbackTimer = null;
      }
      recordDownload(snap);
      onAllTablesSnapshot(snap.val() || {});
      try {
        unsubInitial();
      } catch (_) {}
    },
    (err) => {
      console.error("Firebase initial sync error:", err);
      initialBatchDone = true;
    }
  );

  initialFallbackTimer = setTimeout(() => {
    if (!initialBatchDone) {
      initialBatchDone = true;
      try {
        unsubInitial();
      } catch (_) {}
    }
  }, 5000);

  return () => {
    try {
      unsubAdded();
      unsubChanged();
      unsubRemoved();
      unsubInitial();
    } catch (_) {}
  };
}

function handleSingleTableOrderSnapshot(tab, rawOrder) {
  if (isPaying && currentTable === tab) return;

  const clean = {};
  if (rawOrder && typeof rawOrder === "object") {
    for (const [idStr, qty] of Object.entries(rawOrder)) {
      if (typeof qty === "number" && qty > 0) {
        const numId = Number(idStr);
        if (!ITEM_MAP.has(numId) && !warnedUnknownItemIds.has(numId)) {
          warnedUnknownItemIds.add(numId);
          showToast("Thực đơn vừa cập nhật món mới, vui lòng tải lại trang!", 4000);
        }
        clean[idStr] = qty;
      }
    }
  }
  serverOrders[tab] = clean;

  if (Object.keys(clean).length === 0) {
    checkAndClearEmptyTableTime(tab);
  }

  renderTableButton(tab);
  recalculateTotalCrowd();
  if (currentTable === tab) {
    renderMenuItemsOnly();
    renderBillAsync(tab);
  }
}

function handleSingleTableLockSnapshot(tab, rawLock) {
  serverLocked[tab] = Boolean(rawLock);
  renderTableButton(tab);
  if (currentTable === tab) {
    renderBillAsync(tab);
  }
}

function handleSingleTableTimeSnapshot(tab, rawTime) {
  tableStartTimes[tab] = typeof rawTime === "number" ? rawTime : null;
  updateAllTableTimers();
}

function initFirebaseListeners() {
  bindBranchWithInitialSync(
    ordersRef,
    (tab, val) => handleSingleTableOrderSnapshot(tab, val),
    (allData) => {
      for (let t = 1; t <= TABLE_COUNT; t++) {
        handleSingleTableOrderSnapshot(t, allData[`table_${t}`] || null);
      }
    }
  );

  bindBranchWithInitialSync(
    lockedRef,
    (tab, val) => handleSingleTableLockSnapshot(tab, val),
    (allData) => {
      for (let t = 1; t <= TABLE_COUNT; t++) {
        handleSingleTableLockSnapshot(t, allData[`table_${t}`] || null);
      }
    }
  );

  bindBranchWithInitialSync(
    timesRef,
    (tab, val) => handleSingleTableTimeSnapshot(tab, val),
    (allData) => {
      for (let t = 1; t <= TABLE_COUNT; t++) {
        handleSingleTableTimeSnapshot(t, allData[`table_${t}`] || null);
      }
    }
  );

  const handleSingleTableViewerSnapshot = (tab, val) => {
    if (val && typeof val === "object") {
      const others = Object.keys(val).filter((cid) => cid !== CLIENT_ID);
      activeViewers[tab] = others.length;
    } else {
      activeViewers[tab] = 0;
    }
    renderTableButton(tab);
  };

  bindBranchWithInitialSync(
    viewersRef,
    (tab, val) => handleSingleTableViewerSnapshot(tab, val),
    (allData) => {
      for (let t = 1; t <= TABLE_COUNT; t++) {
        handleSingleTableViewerSnapshot(t, allData[`table_${t}`] || null);
      }
    }
  );
}

// ─── KHỞI ĐỘNG ỨNG DỤNG ───────────────────────────────────────────────────────
function boot() {
  initTheme();
  initTables();
  initLangButtons();
  initFirebaseListeners();
  fetchDanangWeatherAndAqi();
  initBtcTicker();

  setInterval(fetchDanangWeatherAndAqi, 15 * 60 * 1000);

  const payBtn = document.getElementById("pay-btn");
  if (payBtn) payBtn.onclick = openPayModal;

  const confirmPayBtn = document.getElementById("confirm-pay");
  if (confirmPayBtn) confirmPayBtn.onclick = doPay;

  const cancelPayBtn = document.getElementById("cancel-pay");
  if (cancelPayBtn) {
    cancelPayBtn.onclick = () => {
      playSound("nav");
      closeModal();
    };
  }

  const modal = document.getElementById("modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        playSound("nav");
        closeModal();
      }
    });
  }

  runPaperFlipIntro();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
