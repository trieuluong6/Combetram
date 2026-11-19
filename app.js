// app.js
import { menu } from './menu.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue, set } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ==========================================
// 1. CẤU HÌNH FIREBASE
// ==========================================
const firebaseConfig = {
    databaseURL: "https://combetram-224d8-default-rtdb.asia-southeast1.firebasedatabase.app"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ==========================================
// 2. ÂM THANH & HIỆU ỨNG
// ==========================================
let audioCtx = null;

function playPop(freq = 600, type = 'sine', dur = 0.05) {
    try {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;
            audioCtx = new AudioContextClass();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + dur);
    } catch (e) {}
}

function haptic(ms = 35) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
}

// ==========================================
// 3. QUẢN LÝ TRẠNG THÁI (STATE)
// ==========================================
const initialTableNames = [
    "Bàn 1", "Bàn 2", "Bàn 3", "Bàn 4", "Bàn 5", 
    "Bàn 6", "Bàn 7", "Bàn 8", "Bàn 9", "Bàn 10", 
    "Mang về 1", "Mang về 2", "Mang về 3"
];

let tableNames = JSON.parse(localStorage.getItem('tableNames')) || initialTableNames;
let activeTab = 0; 
let orders = Array(13).fill(null).map(() => ({}));
let lastTimestamps = Array(13).fill(0);
let tabColors = Array(13).fill(''); 
let currentBillLang = 'vi';
let isInitialLoad = true; 

let localSaveFlags = Array(13).fill(0);

// Các biến phục vụ hiệu ứng Gợn sóng + Sáng tức thời & Khóa Double-Tap
let lastPointerX = window.innerWidth / 2;
let lastPointerY = window.innerHeight / 2;
let isSyncing = false;
let lastActionTime = 0;

function formatMoney(num) {
    return (num || 0).toLocaleString('vi-VN') + 'đ';
}

function triggerTabHighlight() {
    const tabEl = document.querySelectorAll('.tab')[activeTab];
    if (!tabEl) return;

    const existingRipple = tabEl.querySelector('.tab-ripple');
    if (existingRipple) existingRipple.remove();

    const ripple = document.createElement('span');
    ripple.className = 'tab-ripple';

    const rect = tabEl.getBoundingClientRect();
    let clickX = lastPointerX - rect.left;
    let clickY = lastPointerY - rect.top;
    if (clickX < 0 || clickX > rect.width) clickX = rect.width / 2;
    if (clickY < 0 || clickY > rect.height) clickY = rect.height / 2;

    ripple.style.left = clickX + 'px';
    ripple.style.top = clickY + 'px';

    tabEl.appendChild(ripple);
    setTimeout(() => { if (ripple.parentNode) ripple.remove(); }, 550);
}

// ==========================================
// 4. ĐỒNG BỘ DỮ LIỆU FIREBASE
// ==========================================
const allTablesRef = ref(db, 'tables');
onValue(allTablesRef, (snapshot) => {
    const data = snapshot.val();
    let needTabRender = false;
    let needMenuRender = false;

    for (let i = 0; i < 13; i++) {
        const tableData = data ? data[i] : null;
        if (tableData) {
            if (tableData.name && tableNames[i] !== tableData.name) {
                tableNames[i] = tableData.name;
                localStorage.setItem('tableNames', JSON.stringify(tableNames));
                needTabRender = true;
            }
            if (tableData.color !== undefined && tabColors[i] !== tableData.color) {
                tabColors[i] = tableData.color;
                needTabRender = true;
            }
        }
        
        if (Date.now() - localSaveFlags[i] < 1500) {
            continue;
        }
        
        const incomingOrder = (tableData && tableData.order) ? tableData.order : {};
        const incomingTime = (tableData && tableData.timestamp) ? tableData.timestamp : 0;
        
        if (JSON.stringify(orders[i]) !== JSON.stringify(incomingOrder) || lastTimestamps[i] !== incomingTime) {
            orders[i] = incomingOrder;
            lastTimestamps[i] = incomingTime;
            needTabRender = true;
            if (i === activeTab) {
                needMenuRender = true;
            }
        }
    }

    if (needTabRender) {
        renderTabs();
        updateBottomBar();
        if (activeTab === 12) renderOverview();
    }
    if (needMenuRender) {
        renderMenu();
    }

    if (isInitialLoad) {
        isInitialLoad = false;
        const loader = document.getElementById('loading-overlay');
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => loader.remove(), 300);
        }
    }
});

function saveOrderToFirebase(tabIndex) {
    localSaveFlags[tabIndex] = Date.now();
    
    const hasItems = Object.keys(orders[tabIndex]).length > 0;
    const newTimestamp = hasItems ? (lastTimestamps[tabIndex] || Date.now()) : 0;
    lastTimestamps[tabIndex] = newTimestamp;
    
    if (!hasItems) {
        tabColors[tabIndex] = '';
    }
    
    set(ref(db, 'tables/' + tabIndex), {
        order: orders[tabIndex],
        timestamp: newTimestamp,
        name: tableNames[tabIndex],
        color: tabColors[tabIndex]
    });
}

// ==========================================
// 5. KHỞI TẠO & CÁC HÀM RENDER GIAO DIỆN
// ==========================================
const tabsContainer = document.getElementById('tabs');
const menuContainer = document.getElementById('menu-container');
const overviewContainer = document.getElementById('overview-container');

function getTabTotal(tabIndex) {
    const order = orders[tabIndex];
    let total = 0;
    for (let id in order) {
        total += order[id].price * order[id].qty;
    }
    return total;
}

function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function renderTabs() {
    tabsContainer.innerHTML = '';
    tableNames.forEach((name, idx) => {
        const total = getTabTotal(idx);
        const btn = document.createElement('button');
        const cClass = (total > 0 && tabColors[idx]) ? `color-${tabColors[idx]}` : '';
        
        btn.className = `tab ${idx === activeTab ? 'active' : ''} ${total > 0 ? 'has-items' : ''} ${cClass}`;
        btn.dataset.index = idx;
        
        let badgeHtml = total > 0 ? `<span class="tab-badge">${(total/1000)}k</span>` : '';
        btn.innerHTML = `${name}${badgeHtml}`;
        
        tabsContainer.appendChild(btn);
    });
}

function renderOverview() {
    overviewContainer.innerHTML = '';
    let activeCount = 0;
    let totalRevenue = 0;

    for (let i = 0; i < 12; i++) {
        const total = getTabTotal(i);
        if (total > 0) {
            activeCount++;
            totalRevenue += total;

            const card = document.createElement('div');
            const cClass = tabColors[i] ? `card-color-${tabColors[i]}` : '';
            card.className = `overview-card ${cClass}`;
            card.dataset.gotoTab = i;

            let itemsHtml = '';
            for (let id in orders[i]) {
                const itm = orders[i][id];
                itemsHtml += `
                    <div class="ov-item">
                        <div><span class="ov-item-qty">${itm.qty}x</span> ${itm.name}</div>
                        <div>${formatMoney(itm.price * itm.qty)}</div>
                    </div>
                `;
            }

            const timeStr = lastTimestamps[i] ? `🕒 Mở lúc ${formatTime(lastTimestamps[i])}` : '';

            card.innerHTML = `
                <div class="ov-header">
                    <div>
                        <span class="ov-title">${tableNames[i]}</span>
                        <div class="ov-time">${timeStr}</div>
                    </div>
                    <span class="ov-total">${formatMoney(total)}</span>
                </div>
                <div class="ov-items">${itemsHtml}</div>
                <div class="ov-footer">
                    <span class="ov-hint">Chạm để mở bàn &rarr;</span>
                    <button class="ov-btn-pay" data-pay-tab="${i}">Tính Tiền</button>
                </div>
            `;
            overviewContainer.appendChild(card);
        }
    }

    if (activeCount === 0) {
        overviewContainer.innerHTML = `<div class="empty-overview">Hiện chưa có bàn nào đang gọi món 🍃</div>`;
    } else {
        const sumBox = document.createElement('div');
        sumBox.style.cssText = "text-align:center; padding: 12px; color: #666; font-size: 13px; font-weight: bold;";
        sumBox.innerHTML = `Đang phục vụ: ${activeCount} bàn • Tạm tính: <span style="color:#d32f2f; font-size:15px;">${formatMoney(totalRevenue)}</span>`;
        overviewContainer.prepend(sumBox);
    }
}

function renderMenu() {
    menuContainer.innerHTML = '';
    const currentOrder = orders[activeTab];

    menu.forEach(group => {
        const catDiv = document.createElement('div');
        catDiv.className = 'category-title';
        catDiv.innerText = group.cat;
        menuContainer.appendChild(catDiv);

        group.items.forEach(item => {
            const qty = currentOrder[item.id] ? currentOrder[item.id].qty : 0;
            const row = document.createElement('div');
            row.className = `item-row ${qty > 0 ? 'selected' : ''}`;
            row.dataset.id = item.id;

            row.innerHTML = `
                <div class="item-info">
                    <div class="item-name">${item.name}</div>
                    <div class="item-price">${formatMoney(item.price)}</div>
                </div>
                <div class="qty-controls">
                    <button class="btn-qty btn-minus" data-action="minus" data-id="${item.id}" style="visibility: ${qty > 0 ? 'visible' : 'hidden'}">−</button>
                    <span class="qty-text">${qty > 0 ? qty : ''}</span>
                    <button class="btn-qty btn-plus" data-action="plus" data-id="${item.id}">+</button>
                </div>
            `;
            menuContainer.appendChild(row);
        });
    });
}

function updateBottomBar() {
    const btnReset = document.getElementById('btn-reset');
    const btnCheckout = document.getElementById('btn-checkout');
    const totalEl = document.getElementById('total-price');

    if (activeTab === 12) {
        let grandTotal = 0;
        for (let i = 0; i < 12; i++) grandTotal += getTabTotal(i);
        totalEl.innerText = formatMoney(grandTotal);
        btnReset.style.display = 'none';
        btnCheckout.style.display = 'none';
    } else {
        const total = getTabTotal(activeTab);
        totalEl.innerText = formatMoney(total);
        btnReset.style.display = 'block';
        btnCheckout.style.display = 'block';
    }
}

// ==========================================
// 6. TƯƠNG TÁC MÓN & ĐỔI TAB
// ==========================================
let dictCache = { vi: { flag: "🇻🇳", total: "TỔNG", thanks: "Cảm ơn quý khách & hẹn gặp lại!", items: {} } };
let dictLoadPromise = null;
let billAssetsPreloaded = false;
let dictValidated = false;

function renderLangGrid(langButtons) {
    const grid = document.getElementById('lang-grid');
    if (!grid || !Array.isArray(langButtons) || !langButtons.length) return;
    grid.innerHTML = langButtons.map(btn =>
        `<button class="lang-btn${btn.code === currentBillLang ? ' active-lang' : ''}" data-lang="${btn.code}"><span>${btn.flag}</span><span>${btn.label}</span></button>`
    ).join('');
}

async function getLangData(lang) {
    if (dictCache[lang] && dictLoadPromise) return dictCache[lang];
    if (!dictLoadPromise) {
        dictLoadPromise = import('./dict.js').then(m => {
            dictCache = m.dict;
            if (m.LANG_BUTTONS) renderLangGrid(m.LANG_BUTTONS);
            if (!dictValidated && typeof m.validateMenuDict === 'function') {
                dictValidated = true;
                m.validateMenuDict(menu);
            }
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
    const preImg = new Image();
    preImg.src = './qr.jpg';
    getLangData('en');
}

function changeQty(id, delta) {
    if (activeTab === 12) return; 
    let itemObj = null;
    for (let g of menu) {
        itemObj = g.items.find(i => i.id == id);
        if (itemObj) break;
    }
    if (!itemObj) return;

    const currentOrder = orders[activeTab];
    const wasEmpty = Object.keys(currentOrder).length === 0;
    const currentQty = currentOrder[id] ? currentOrder[id].qty : 0;
    const newQty = currentQty + delta;

    if (newQty <= 0) {
        delete currentOrder[id];
    } else {
        currentOrder[id] = { name: itemObj.name, price: itemObj.price, qty: newQty };
        if (wasEmpty) lastTimestamps[activeTab] = Date.now();
    }

    haptic(35);
    playPop(delta > 0 ? 680 : 420);

    const row = menuContainer.querySelector(`.item-row[data-id="${id}"]`);
    if (row) {
        const qtySpan = row.querySelector('.qty-text');
        const btnMinus = row.querySelector('.btn-minus');
        if (newQty > 0) {
            row.classList.add('selected');
            qtySpan.innerText = newQty;
            btnMinus.style.visibility = 'visible';
        } else {
            row.classList.remove('selected');
            qtySpan.innerText = '';
            btnMinus.style.visibility = 'hidden';
        }
    }

    const total = getTabTotal(activeTab);
    const tabBtn = tabsContainer.querySelector(`.tab[data-index="${activeTab}"]`);
    if (tabBtn) {
        const cClass = (total > 0 && tabColors[activeTab]) ? `color-${tabColors[activeTab]}` : '';
        tabBtn.className = `tab active ${total > 0 ? 'has-items' : ''} ${cClass}`;
        let badge = tabBtn.querySelector('.tab-badge');
        if (total > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'tab-badge';
                tabBtn.appendChild(badge);
            }
            badge.innerText = `${total / 1000}k`;
        } else if (badge) {
            badge.remove();
        }
    }

    triggerTabHighlight();
    updateBottomBar();
    saveOrderToFirebase(activeTab);
}

function switchTab(index) {
    activeTab = index;
    haptic(25);
    playPop(520);
    renderTabs();

    if (activeTab === 12) {
        menuContainer.style.display = 'none';
        overviewContainer.style.display = 'block';
        renderOverview();
    } else {
        overviewContainer.style.display = 'none';
        menuContainer.style.display = 'block';
        renderMenu();
    }
    updateBottomBar();
}

// ==========================================
// 7. CÁC MODAL (BILL ĐA NGÔN NGỮ, ĐỔI TÊN & MÀU BÀN)
// ==========================================
let cachedQrDataUrl = null;
async function getQrBase64() {
    if (cachedQrDataUrl) return cachedQrDataUrl;
    try {
        const response = await fetch('./qr.jpg');
        if (!response.ok) return null;
        const blob = await response.blob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                cachedQrDataUrl = reader.result;
                resolve(cachedQrDataUrl);
            };
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        return null;
    }
}

async function renderBillAsync(tabToRender) {
    const order = orders[tabToRender];
    const langData = await getLangData(currentBillLang);
    const billArea = document.getElementById('bill-capture-area');
    
    let itemsHtml = '';
    let total = 0;
    for (let id in order) {
        const itm = order[id];
        const sub = itm.price * itm.qty;
        total += sub;
        
        const displayName = (currentBillLang !== 'vi' && langData.items && langData.items[id]) 
                            ? langData.items[id] 
                            : itm.name;

        itemsHtml += `
            <div class="bill-item">
                <div class="bill-item-name">${displayName} <b>x${itm.qty}</b></div>
                <div>${formatMoney(sub)}</div>
            </div>
        `;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' - ' + now.toLocaleDateString('vi-VN');
    const qrSrc = await getQrBase64() || './qr.jpg';

    billArea.innerHTML = `
        <div class="bill-header">
            <div class="bill-shop">QUÁN CƠM BÉ TRÂM</div>
            <div style="font-size:12px; color:#555;">395 Trần Hưng Đạo, Sơn Trà, ĐN</div>
            <div style="font-size:12px; color:#555;">SĐT: 0905298867</div>
            <div style="font-size:13px; font-weight:bold; margin-top:6px;">${tableNames[tabToRender]} ${langData.flag}</div>
            <div style="font-size:11px; color:#777;">${timeStr}</div>
        </div>
        <div>${itemsHtml}</div>
        <div class="bill-total">
            <span>${langData.total}:</span>
            <span>${formatMoney(total)}</span>
        </div>
        <div class="bill-qr-box">
            <img src="${qrSrc}" class="bill-qr" alt="QR Thanh Toán">
        </div>
        <div style="text-align:center; font-size:12px; margin-top:10px; color:#555;">${langData.thanks}</div>
    `;
}

// ==========================================
// 8. HỆ THỐNG LẮNG NGHE SỰ KIỆN TẬP TRUNG
// ==========================================
function setupEvents() {
    document.addEventListener('pointerdown', (e) => {
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
    }, { passive: true });

    let pressTimer;
    let isLongPress = false;
    let startX = 0, startY = 0;

    tabsContainer.addEventListener('pointerdown', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        const idx = parseInt(tab.dataset.index);
        if (idx === 12) return; 

        isLongPress = false;
        startX = e.clientX;
        startY = e.clientY;

        pressTimer = setTimeout(() => {
            isLongPress = true;
            haptic(50);
            openRenameModal(idx);
        }, 550);
    });

    tabsContainer.addEventListener('pointermove', (e) => {
        if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) {
            clearTimeout(pressTimer);
        }
    });

    tabsContainer.addEventListener('pointerup', () => clearTimeout(pressTimer));
    tabsContainer.addEventListener('pointercancel', () => clearTimeout(pressTimer));

    tabsContainer.addEventListener('click', (e) => {
        if (isLongPress) {
            isLongPress = false;
            return;
        }
        const tab = e.target.closest('.tab');
        if (!tab) return;
        switchTab(parseInt(tab.dataset.index));
    });

    menuContainer.addEventListener('click', (e) => {
        if (isSyncing) return;
        const now = Date.now();
        if (now - lastActionTime < 150) return; 

        const btn = e.target.closest('.btn-qty');
        if (btn) {
            lastActionTime = now;
            const id = btn.dataset.id;
            const delta = btn.dataset.action === 'plus' ? 1 : -1;
            changeQty(id, delta);
            return;
        }
        const row = e.target.closest('.item-row');
        if (row) {
            lastActionTime = now;
            changeQty(row.dataset.id, 1);
        }
    });

    overviewContainer.addEventListener('click', (e) => {
        const payBtn = e.target.closest('.ov-btn-pay');
        if (payBtn) {
            e.stopPropagation();
            const tIdx = parseInt(payBtn.dataset.payTab);
            switchTab(tIdx);
            document.getElementById('btn-checkout').click();
            return;
        }
        const card = e.target.closest('.overview-card');
        if (card) {
            switchTab(parseInt(card.dataset.gotoTab));
        }
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
        if (activeTab === 12) return;
        if (Object.keys(orders[activeTab]).length === 0) return;
        
        if (confirm(`Xóa toàn bộ món của [${tableNames[activeTab]}]?`)) {
            orders[activeTab] = {};
            lastTimestamps[activeTab] = 0;
            tabColors[activeTab] = '';
            haptic(50);
            playPop(300, 'sawtooth', 0.1);
            renderTabs();
            renderMenu();
            updateBottomBar();
            saveOrderToFirebase(activeTab);
        }
    });

    const billModal = document.getElementById('bill-modal');
    document.getElementById('btn-checkout').addEventListener('click', () => {
        if (activeTab === 12) return;
        if (Object.keys(orders[activeTab]).length === 0) {
            alert('Bàn này chưa chọn món nào!');
            return;
        }
        currentBillLang = 'vi';
        document.querySelectorAll('.lang-btn').forEach(b => {
            b.classList.toggle('active-lang', b.dataset.lang === 'vi');
        });
        renderBillAsync(activeTab);
        billModal.style.display = 'flex';
        haptic(30);
        preloadBillAssets();
    });

    document.getElementById('lang-grid').addEventListener('click', (e) => {
        const btn = e.target.closest('.lang-btn');
        if (!btn) return;
        currentBillLang = btn.dataset.lang;
        document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active-lang'));
        btn.classList.add('active-lang');
        haptic(20);
        playPop(600, 'sine', 0.03);
        renderBillAsync(activeTab);
    });

    document.getElementById('btn-close-bill').addEventListener('click', () => {
        billModal.style.display = 'none';
    });

    document.getElementById('btn-done-bill').addEventListener('click', () => {
        if (confirm(`Xác nhận [${tableNames[activeTab]}] đã thanh toán xong và làm trống bàn?`)) {
            orders[activeTab] = {};
            lastTimestamps[activeTab] = 0;
            tabColors[activeTab] = '';
            saveOrderToFirebase(activeTab);
            billModal.style.display = 'none';
            renderTabs();
            renderMenu();
            updateBottomBar();
            haptic(60);
            playPop(800, 'sine', 0.1);
        }
    });

    document.getElementById('btn-save-img').addEventListener('click', () => {
        const billArea = document.getElementById('bill-capture-area');
        const btn = document.getElementById('btn-save-img');
        btn.innerText = 'Đang tạo...';
        
        html2canvas(billArea, { scale: 2, useCORS: true, allowTaint: true }).then(canvas => {
            const link = document.createElement('a');
            link.download = `Bill_${tableNames[activeTab]}_${currentBillLang.toUpperCase()}_${Date.now()}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            btn.innerText = '📸 Lưu Ảnh Bill';
            haptic(40);
        }).catch(() => {
            alert('Lỗi xuất ảnh! Hãy chụp màn hình điện thoại nhé.');
            btn.innerText = '📸 Lưu Ảnh Bill';
        });
    });

    const renameModal = document.getElementById('rename-modal');
    const renameInput = document.getElementById('rename-input');
    const colorPicker = document.getElementById('color-picker');
    let editingTabIndex = null;
    let selectedModalColor = '';

    function openRenameModal(idx) {
        editingTabIndex = idx;
        renameInput.value = tableNames[idx];
        selectedModalColor = tabColors[idx] || '';
        
        colorPicker.querySelectorAll('.color-dot').forEach(dot => {
            dot.classList.toggle('selected-color', dot.dataset.color === selectedModalColor);
        });

        renameModal.style.display = 'flex';
        setTimeout(() => renameInput.focus(), 100);
    }

    colorPicker.addEventListener('click', (e) => {
        const dot = e.target.closest('.color-dot');
        if (!dot) return;
        selectedModalColor = dot.dataset.color;
        colorPicker.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected-color'));
        dot.classList.add('selected-color');
        haptic(20);
        playPop(650, 'sine', 0.03);
    });

    document.getElementById('btn-cancel-rename').addEventListener('click', () => {
        renameModal.style.display = 'none';
    });

    document.getElementById('btn-save-rename').addEventListener('click', () => {
        const newName = renameInput.value.trim();
        if (newName && editingTabIndex !== null) {
            tableNames[editingTabIndex] = newName;
            tabColors[editingTabIndex] = selectedModalColor;
            
            localStorage.setItem('tableNames', JSON.stringify(tableNames));
            saveOrderToFirebase(editingTabIndex);
            renderTabs();
            if (activeTab === 12) renderOverview();
            haptic(35);
            playPop(700);
        }
        renameModal.style.display = 'none';
    });
}

// ==========================================
// 9. KHỞI CHẠY LẦN ĐẦU
// ==========================================
setupEvents();
renderTabs();
renderMenu();
updateBottomBar();
