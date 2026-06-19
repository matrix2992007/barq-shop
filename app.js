/* ═══════════════════════════════════════════════════════════
   Apex Matrix — Frontend Application Logic
   Handles: Telegram WebApp SDK, cart management,
   API calls, UI rendering, order submission
═══════════════════════════════════════════════════════════ */

const API_BASE = "https://your-render-app.onrender.com"; // ← غيّر هذا لرابط سيرفرك

// ─── Telegram WebApp Init ─────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
let TG_USER = null;
let TG_USER_ID = null;

function initTelegram() {
  if (!tg) {
    console.warn("Not running inside Telegram WebApp");
    const urlParams = new URLSearchParams(window.location.search);
    TG_USER_ID = urlParams.get("uid") || "000000000";
    TG_USER = { id: TG_USER_ID, first_name: "مستخدم" };
    return;
  }
  tg.ready();
  tg.expand();
  if (tg.colorScheme === "dark" || !tg.colorScheme) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
  TG_USER = tg.initDataUnsafe?.user || null;
  TG_USER_ID = TG_USER?.id ? String(TG_USER.id) : new URLSearchParams(window.location.search).get("uid");
  if (!TG_USER_ID) {
    showToast("تعذّر تحديد هويتك. افتح التطبيق من خلال بوت تيليجرام.", "error");
  }
}

// ─── Haptic Feedback Helper ──────────────────────────────────────────────────
function haptic(type = "light") {
  try { tg?.HapticFeedback?.impactOccurred(type); } catch {}
}
function hapticNotification(type = "success") {
  try { tg?.HapticFeedback?.notificationOccurred(type); } catch {}
}

// ─── Toast Notification ───────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, type = "info", duration = 3000) {
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, duration);
}

// ─── Loading Overlay ──────────────────────────────────────────────────────────
function showLoading() {
  let overlay = document.getElementById("loading-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "loading-overlay";
    overlay.className = "loading-overlay";
    overlay.innerHTML = '<div class="loading-spinner"></div>';
    document.body.appendChild(overlay);
  }
  overlay.classList.add("visible");
}
function hideLoading() {
  const overlay = document.getElementById("loading-overlay");
  if (overlay) overlay.classList.remove("visible");
}

// ─── API Helpers ──────────────────────────────────────────────────────────────
async function apiFetch(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const defaults = {
    headers: { "Content-Type": "application/json" },
  };
  const merged = {
    ...defaults,
    ...options,
    headers: { ...defaults.headers, ...(options.headers || {}) },
  };
  const res = await fetch(url, merged);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "خطأ في الخادم" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Cart Management (localStorage) ──────────────────────────────────────────
const CART_KEY = "apex_matrix_cart";

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}

function addToCart(item) {
  const cart = getCart();
  const exists = cart.find(
    (c) => c.serviceId === item.serviceId && c.categoryId === item.categoryId
  );
  if (exists) {
    showToast("هذه الخدمة موجودة بالفعل في السلة", "info");
    hapticNotification("warning");
    return false;
  }
  cart.push({ ...item, gameId: "" });
  saveCart(cart);
  haptic("medium");
  showToast(`✅ تم إضافة "${item.serviceName}" للسلة`, "success");
  return true;
}

function removeFromCart(serviceId, categoryId) {
  let cart = getCart();
  cart = cart.filter(
    (c) => !(c.serviceId === serviceId && c.categoryId === categoryId)
  );
  saveCart(cart);
  haptic("light");
}

function clearCart() {
  localStorage.removeItem(CART_KEY);
  updateCartBadge();
}

function updateCartBadge() {
  const cart = getCart();
  const badges = document.querySelectorAll(".cart-badge");
  badges.forEach((badge) => {
    if (cart.length > 0) {
      badge.textContent = cart.length;
      badge.classList.add("visible");
    } else {
      badge.classList.remove("visible");
    }
  });
}

function getCartTotals() {
  const cart = getCart();
  const subtotal = cart.reduce((sum, item) => sum + (item.price || 0), 0);
  const discount = parseFloat((subtotal * 0.03).toFixed(2));
  const total = parseFloat((subtotal - discount).toFixed(2));
  return { subtotal, discount, total, count: cart.length };
}

// ─── User Data ────────────────────────────────────────────────────────────────
let cachedUser = null;

async function fetchUserData() {
  if (!TG_USER_ID) return null;
  try {
    cachedUser = await apiFetch(`/api/user/${TG_USER_ID}`);
    return cachedUser;
  } catch (e) {
    console.error("fetchUserData error:", e);
    return null;
  }
}

// ─── Categories & Services ────────────────────────────────────────────────────
let cachedCategories = null;

async function fetchCategories() {
  if (cachedCategories) return cachedCategories;
  try {
    cachedCategories = await apiFetch("/api/categories");
    return cachedCategories;
  } catch (e) {
    console.error("fetchCategories error:", e);
    return {};
  }
}

// ─── INDEX PAGE ───────────────────────────────────────────────────────────────
async function initIndexPage() {
  initTelegram();
  updateCartBadge();
  await loadUserHero();
  await loadCategories();
}

async function loadUserHero() {
  const hero = document.getElementById("hero-section");
  if (!hero) return;
  const user = await fetchUserData();
  const firstName = user?.firstName || TG_USER?.first_name || "بطل";
  hero.innerHTML = `
    <div class="hero-banner">
      <div class="hero-greeting">مرحباً في Apex Matrix 🎮</div>
      <div class="hero-name">أهلاً، <span>${firstName}</span>!</div>
      <div class="hero-balance-row">
        <div class="hero-balance-item">
          <div class="hero-balance-value">${(user?.balance || 0).toFixed(2)}</div>
          <div class="hero-balance-label">💰 رصيدك (جنيه)</div>
        </div>
        <div class="hero-balance-item">
          <div class="hero-balance-value" style="color:var(--orange)">${(user?.pendingBalance || 0).toFixed(2)}</div>
          <div class="hero-balance-label">⏳ معلق (جنيه)</div>
        </div>
      </div>
    </div>
    <div class="discount-banner">
      <div class="discount-banner-icon">🏷️</div>
      <div class="discount-banner-text">
        استمتع بـ <strong>خصم 3% تلقائي</strong> على كل طلبات السلة المجمعة!
      </div>
    </div>
  `;
}

async function loadCategories() {
  const container = document.getElementById("categories-container");
  if (!container) return;

  container.innerHTML = `<div class="empty-state"><div class="loading-spinner" style="margin:0 auto"></div></div>`;

  const categories = await fetchCategories();
  const catList = Object.values(categories).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  if (catList.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🛒</div>
        <div class="empty-title">لا توجد خدمات متاحة حالياً</div>
        <div class="empty-sub">تابع قناتنا للاطلاع على أحدث الخدمات</div>
      </div>`;
    return;
  }

  const CATEGORY_ICONS = {
    ببجي: "🎮", "فري فاير": "🔥", بلاك: "⚔️", كلاش: "🏆",
    موبايل: "📱", بابجي: "🎮", default: "🎯",
  };

  let html = "";
  for (const cat of catList) {
    const services = Object.values(cat.services || {}).sort((a, b) => a.price - b.price);
    if (services.length === 0) continue;

    const icon = Object.entries(CATEGORY_ICONS).find(([k]) => cat.name?.includes(k))?.[1] || CATEGORY_ICONS.default;

    html += `
      <div class="category-header">
        <div class="category-icon">${icon}</div>
        <div>
          <div class="category-name">${escapeHtml(cat.name)}</div>
          <div class="category-count">${services.length} خدمة متاحة</div>
        </div>
      </div>
      <div class="services-grid">
    `;

    for (const svc of services) {
      html += `
        <div class="service-card" id="card-${cat.id}-${svc.id}"
          onclick="toggleService('${cat.id}','${svc.id}','${escapeHtml(svc.name)}','${escapeHtml(cat.name)}',${svc.price})">
          <div class="service-check">✓</div>
          <div class="service-name">${escapeHtml(svc.name)}</div>
          <div class="service-price">${svc.price}<span class="service-price-unit"> جنيه</span></div>
        </div>
      `;
    }
    html += `</div>`;
  }

  container.innerHTML = html;

  // Mark already-in-cart items
  const cart = getCart();
  cart.forEach((item) => {
    const card = document.getElementById(`card-${item.categoryId}-${item.serviceId}`);
    if (card) card.classList.add("selected");
  });
}

function toggleService(catId, serviceId, serviceName, categoryName, price) {
  const cart = getCart();
  const existing = cart.find(
    (c) => c.serviceId === serviceId && c.categoryId === catId
  );
  const card = document.getElementById(`card-${catId}-${serviceId}`);

  if (existing) {
    removeFromCart(serviceId, catId);
    card?.classList.remove("selected");
    showToast(`تم إزالة "${serviceName}" من السلة`, "info");
  } else {
    const added = addToCart({ serviceId, categoryId: catId, serviceName, categoryName, price });
    if (added) card?.classList.add("selected");
  }
}

// ─── CART PAGE ────────────────────────────────────────────────────────────────
const WALLET_NUMBER = "01XXXXXXXXXX"; // ← غيّر هذا لرقم محفظتك الفعلي

async function initCartPage() {
  initTelegram();
  renderCartItems();
  setupScreenshotUpload();
}

function renderCartItems() {
  const container = document.getElementById("cart-items-container");
  const summarySection = document.getElementById("cart-summary-section");
  const emptyState = document.getElementById("cart-empty");
  const cart = getCart();

  if (!container) return;

  if (cart.length === 0) {
    container.innerHTML = "";
    if (summarySection) summarySection.style.display = "none";
    if (emptyState) emptyState.style.display = "block";
    return;
  }

  if (emptyState) emptyState.style.display = "none";
  if (summarySection) summarySection.style.display = "block";

  container.innerHTML = cart
    .map(
      (item, idx) => `
    <div class="cart-item-card ${item.gameId ? "has-id" : ""}" id="cart-card-${idx}">
      <div class="cart-item-header">
        <div class="cart-item-info">
          <div class="cart-item-service">${escapeHtml(item.serviceName)}</div>
          <div class="cart-item-category">${escapeHtml(item.categoryName)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="cart-item-price">${item.price} جنيه</div>
          <button class="cart-item-remove" onclick="removeCartItem(${idx})">✕</button>
        </div>
      </div>
      <div style="margin-top:8px">
        <div class="field-label">
          🎮 ID حساب ${escapeHtml(item.categoryName)} <span class="field-required">*</span>
        </div>
        <input
          class="input-field"
          type="text"
          id="gameid-${idx}"
          placeholder="أدخل الـ ID الخاص بلعبة ${escapeHtml(item.serviceName)}"
          value="${escapeHtml(item.gameId || "")}"
          onchange="updateGameId(${idx}, this.value)"
          oninput="updateGameId(${idx}, this.value)"
          autocomplete="off"
        />
        <div class="field-error" id="gameid-error-${idx}">هذا الحقل مطلوب</div>
      </div>
    </div>
  `
    )
    .join("");

  renderOrderSummary();
}

function updateGameId(index, value) {
  const cart = getCart();
  if (!cart[index]) return;
  cart[index].gameId = value.trim();
  saveCart(cart);
  const card = document.getElementById(`cart-card-${index}`);
  if (card) card.classList.toggle("has-id", value.trim().length > 0);
}

function removeCartItem(index) {
  const cart = getCart();
  const item = cart[index];
  if (!item) return;
  removeFromCart(item.serviceId, item.categoryId);
  renderCartItems();
}

function renderOrderSummary() {
  const totalsDiv = document.getElementById("order-totals");
  if (!totalsDiv) return;
  const { subtotal, discount, total } = getCartTotals();
  totalsDiv.innerHTML = `
    <div class="summary-row">
      <span class="summary-label">المجموع الأصلي</span>
      <span class="summary-value">${subtotal.toFixed(2)} جنيه</span>
    </div>
    <div class="summary-row">
      <span class="summary-label">🏷️ خصم 3%</span>
      <span class="summary-value discount">- ${discount.toFixed(2)} جنيه</span>
    </div>
    <div class="summary-row total">
      <span class="summary-label">الإجمالي المطلوب</span>
      <span class="summary-value total">${total.toFixed(2)} جنيه</span>
    </div>
  `;
}

function setupScreenshotUpload() {
  const input = document.getElementById("screenshot-input");
  const preview = document.getElementById("screenshot-preview");
  const area = document.getElementById("upload-area");
  if (!input) return;

  input.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("يرجى رفع صورة فقط (JPG, PNG)", "error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast("حجم الصورة يجب أن لا يتجاوز 5 ميجابايت", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (preview) {
        preview.src = ev.target.result;
        preview.classList.add("visible");
      }
      if (area) area.classList.add("has-file");
      showToast("✅ تم رفع صورة التحويل", "success");
    };
    reader.readAsDataURL(file);
  });
}

function getScreenshotBase64() {
  const preview = document.getElementById("screenshot-preview");
  if (!preview || !preview.src || !preview.src.startsWith("data:")) return null;
  const parts = preview.src.split(",");
  return {
    data: parts[1],
    mime: parts[0].replace("data:", "").replace(";base64", ""),
  };
}

function copyWalletNumber() {
  navigator.clipboard?.writeText(WALLET_NUMBER).then(() => {
    haptic("medium");
    showToast("✅ تم نسخ رقم المحفظة", "success");
  }).catch(() => {
    showToast("يرجى نسخ الرقم يدوياً: " + WALLET_NUMBER, "info");
  });
}

async function submitOrder() {
  if (!TG_USER_ID) {
    showToast("تعذّر تحديد هويتك. افتح التطبيق من خلال البوت.", "error");
    return;
  }

  const cart = getCart();
  if (cart.length === 0) {
    showToast("السلة فارغة!", "error");
    return;
  }

  // Validate all game IDs are filled
  let hasError = false;
  cart.forEach((item, idx) => {
    const idInput = document.getElementById(`gameid-${idx}`);
    const errorEl = document.getElementById(`gameid-error-${idx}`);
    if (!item.gameId || item.gameId.trim() === "") {
      hasError = true;
      idInput?.classList.add("error");
      if (errorEl) errorEl.classList.add("visible");
      hapticNotification("error");
    } else {
      idInput?.classList.remove("error");
      if (errorEl) errorEl.classList.remove("visible");
    }
  });

  if (hasError) {
    showToast("يرجى إدخال الـ ID لكل الألعاب في السلة", "error");
    return;
  }

  // Screenshot is optional but strongly encouraged
  const screenshot = getScreenshotBase64();
  const submitBtn = document.getElementById("submit-order-btn");

  showLoading();
  if (submitBtn) submitBtn.disabled = true;

  try {
    const payload = {
      userId: TG_USER_ID,
      items: cart.map((item) => ({
        serviceId: item.serviceId,
        categoryId: item.categoryId,
        serviceName: item.serviceName,
        categoryName: item.categoryName,
        price: item.price,
        gameId: item.gameId,
      })),
      screenshotBase64: screenshot?.data || null,
      screenshotMime: screenshot?.mime || null,
    };

    const result = await apiFetch("/api/orders", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    hapticNotification("success");
    clearCart();
    showOrderSuccess(result.orderId, result.total);
  } catch (e) {
    hapticNotification("error");
    showToast(`❌ فشل إرسال الطلب: ${e.message}`, "error", 5000);
    if (submitBtn) submitBtn.disabled = false;
  } finally {
    hideLoading();
  }
}

function showOrderSuccess(orderId, total) {
  const page = document.getElementById("cart-page-content");
  if (!page) return;
  page.innerHTML = `
    <div style="text-align:center;padding:40px 20px">
      <div style="font-size:72px;margin-bottom:16px;animation:pulse 1s ease">✅</div>
      <div style="font-size:22px;font-weight:900;margin-bottom:8px">تم إرسال طلبك!</div>
      <div style="font-size:14px;color:var(--text-secondary);margin-bottom:24px;line-height:1.7">
        رقم طلبك: <strong style="color:var(--cyan);font-family:var(--font-mono)">#${orderId}</strong><br>
        المبلغ الإجمالي: <strong style="color:var(--gold)">${total} جنيه</strong><br>
        سيصلك إشعار من البوت فور بدء التنفيذ
      </div>
      <a href="history.html?uid=${TG_USER_ID}" class="btn btn-primary" style="display:inline-flex;width:auto;padding:12px 28px">
        📋 عرض سجل طلباتي
      </a>
    </div>
  `;
  // Add CSS pulse animation
  const style = document.createElement("style");
  style.textContent = `@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}`;
  document.head.appendChild(style);
}

// ─── HISTORY PAGE ─────────────────────────────────────────────────────────────
let currentTicketOrder = null;
let currentTicketItemIndex = null;

async function initHistoryPage() {
  initTelegram();
  await loadOrderHistory();
}

async function loadOrderHistory() {
  const container = document.getElementById("orders-container");
  if (!container) return;

  container.innerHTML = `<div style="text-align:center;padding:40px"><div class="loading-spinner" style="margin:0 auto"></div></div>`;

  if (!TG_USER_ID) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">تعذّر تحميل الطلبات</div><div class="empty-sub">افتح التطبيق من خلال البوت</div></div>`;
    return;
  }

  try {
    const orders = await apiFetch(`/api/orders/${TG_USER_ID}`);
    if (!orders || orders.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <div class="empty-title">لا توجد طلبات بعد</div>
          <div class="empty-sub">ابدأ بتصفح الخدمات وإضافتها للسلة</div>
        </div>`;
      return;
    }

    const sorted = orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    container.innerHTML = sorted.map((order) => renderOrderCard(order)).join("");
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">فشل تحميل الطلبات</div><div class="empty-sub">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderOrderCard(order) {
  const STATUS_MAP = {
    pending:    { label: "🟡 قيد المراجعة",  cls: "status-pending" },
    processing: { label: "🔵 قيد التنفيذ",   cls: "status-processing" },
    completed:  { label: "🟢 مكتمل",          cls: "status-completed" },
    rejected:   { label: "🔴 مرفوض",          cls: "status-rejected" },
  };
  const statusInfo = STATUS_MAP[order.status] || STATUS_MAP.pending;
  const date = order.createdAt ? new Date(order.createdAt).toLocaleDateString("ar-EG", { day: "numeric", month: "short", year: "numeric" }) : "";

  const itemsHtml = (order.items || []).map((item, idx) => {
    const itemStatus = STATUS_MAP[item.status] || STATUS_MAP.pending;
    const showTicketBtn = item.status === "rejected";
    return `
      <div class="order-item-row">
        <div>
          <div class="order-item-name">${escapeHtml(item.serviceName)}</div>
          ${item.rejectionReason ? `<div style="font-size:11px;color:var(--red);margin-top:3px">السبب: ${escapeHtml(item.rejectionReason)}</div>` : ""}
          ${showTicketBtn ? `<button class="ticket-btn" onclick="openTicketModal('${order.id}', ${idx}, '${escapeHtml(item.serviceName)}')">🎫 فتح تذكرة دعم</button>` : ""}
        </div>
        <span class="status-badge ${itemStatus.cls}">${itemStatus.label}</span>
      </div>
    `;
  }).join("");

  const rejectionNote = order.status === "rejected" && order.rejectionReason
    ? `<div style="background:rgba(255,68,68,0.08);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:10px;margin-top:8px;font-size:13px;color:var(--red)">📋 سبب الرفض: ${escapeHtml(order.rejectionReason)}</div>`
    : "";

  return `
    <div class="order-card">
      <div class="order-card-header">
        <div>
          <div class="order-id">#${order.id}</div>
          <div class="order-date">${date}</div>
        </div>
        <span class="status-badge ${statusInfo.cls}">${statusInfo.label}</span>
      </div>
      <div class="order-items-list">${itemsHtml}</div>
      ${rejectionNote}
      <div class="order-total-row">
        <span class="order-total-label">
          الإجمالي المدفوع
          ${order.discount ? `<span style="color:var(--green);font-size:11px"> (وفّرت ${order.discount} جنيه)</span>` : ""}
        </span>
        <span class="order-total-value">${(order.total || 0).toFixed(2)} جنيه</span>
      </div>
    </div>
  `;
}

function openTicketModal(orderId, itemIndex, itemName) {
  currentTicketOrder = orderId;
  currentTicketItemIndex = itemIndex;
  const modal = document.getElementById("ticket-modal");
  const titleEl = document.getElementById("ticket-modal-title");
  if (titleEl) titleEl.textContent = `تذكرة دعم — ${itemName}`;
  if (modal) {
    modal.classList.add("visible");
    haptic("medium");
  }
}

function closeTicketModal() {
  const modal = document.getElementById("ticket-modal");
  if (modal) modal.classList.remove("visible");
  currentTicketOrder = null;
  currentTicketItemIndex = null;
  const textarea = document.getElementById("ticket-message");
  if (textarea) textarea.value = "";
}

async function submitTicket() {
  if (!TG_USER_ID || !currentTicketOrder) return;
  const messageEl = document.getElementById("ticket-message");
  const message = messageEl?.value?.trim();
  if (!message) {
    showToast("يرجى كتابة تفاصيل المشكلة", "error");
    return;
  }
  const submitBtn = document.getElementById("ticket-submit-btn");
  showLoading();
  if (submitBtn) submitBtn.disabled = true;
  try {
    await apiFetch("/api/tickets", {
      method: "POST",
      body: JSON.stringify({
        userId: TG_USER_ID,
        orderId: currentTicketOrder,
        itemIndex: currentTicketItemIndex,
        message,
      }),
    });
    hapticNotification("success");
    closeTicketModal();
    showToast("✅ تم إرسال التذكرة. سيرد عليك فريق الدعم قريباً", "success", 4000);
  } catch (e) {
    hapticNotification("error");
    showToast(`❌ فشل إرسال التذكرة: ${e.message}`, "error");
  } finally {
    hideLoading();
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ─── REFERRAL PAGE ────────────────────────────────────────────────────────────
async function initReferralPage() {
  initTelegram();
  await loadReferralData();
}

async function loadReferralData() {
  const container = document.getElementById("referral-content");
  if (!container) return;

  container.innerHTML = `<div style="text-align:center;padding:40px"><div class="loading-spinner" style="margin:0 auto"></div></div>`;

  if (!TG_USER_ID) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">تعذّر تحميل البيانات</div></div>`;
    return;
  }

  try {
    const data = await apiFetch(`/api/referral/${TG_USER_ID}`);

    container.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-value gold">${(data.balance || 0).toFixed(2)}</span>
          <span class="stat-label">💰 رصيد قابل للسحب (جنيه)</span>
        </div>
        <div class="stat-card">
          <span class="stat-value" style="color:var(--orange)">${(data.pendingBalance || 0).toFixed(2)}</span>
          <span class="stat-label">⏳ مكافآت معلقة (جنيه)</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${data.totalReferred || 0}</span>
          <span class="stat-label">👥 إجمالي المدعوين</span>
        </div>
        <div class="stat-card">
          <span class="stat-value" style="color:var(--green)">${data.activeReferred || 0}</span>
          <span class="stat-label">✅ مدعوون نشطون</span>
        </div>
      </div>

      <div class="section-label">رابط الإحالة الخاص بك</div>
      <div class="ref-link-box">
        <div class="ref-link-text" id="ref-link-text">${escapeHtml(data.refLink || "")}</div>
        <button class="ref-copy-btn" onclick="copyRefLink('${escapeHtml(data.refLink || "")}')">📋</button>
      </div>

      <div class="how-it-works">
        <div class="how-title">🤝 كيف يعمل نظام الإحالة؟</div>
        <div class="how-step">
          <div class="how-step-num">1</div>
          <div class="how-step-text">شارك رابطك الخاص مع أصدقائك وادعهم للانضمام لـ Apex Matrix</div>
        </div>
        <div class="how-step">
          <div class="how-step-num">2</div>
          <div class="how-step-text">عند انضمام صديقك، يُضاف <strong style="color:var(--orange)">1 جنيه معلق</strong> لحسابك (ينتظر أول عملية شراء)</div>
        </div>
        <div class="how-step">
          <div class="how-step-num">3</div>
          <div class="how-step-text">بمجرد إتمام صديقك أول شراء ناجح، يتحول الجنيه لـ <strong style="color:var(--green)">رصيد قابل للسحب</strong></div>
        </div>
        <div class="how-step">
          <div class="how-step-num">4</div>
          <div class="how-step-text">تحصل أيضاً على <strong style="color:var(--cyan)">كاش باك 1.5 جنيه</strong> على كل عملية شراء شخصية ناجحة!</div>
        </div>
      </div>

      <div class="withdraw-box">
        <div class="withdraw-balance">${(data.balance || 0).toFixed(2)} جنيه</div>
        <div class="withdraw-balance-label">رصيدك القابل للسحب</div>
        ${
          data.balance >= 10
            ? `
          <div class="field-label" style="margin-bottom:6px">📱 رقم محفظة الكاش للتحويل <span class="field-required">*</span></div>
          <input class="input-field" type="tel" id="cash-number-input" placeholder="01XXXXXXXXXX" maxlength="11" />
          <div class="withdraw-note">سيتم خصم <strong>2 جنيه</strong> عمولة تحويل. ستستلم <strong>${(data.balance - 2).toFixed(2)} جنيه</strong> صافي.</div>
          <button class="btn btn-gold" style="margin-top:16px" onclick="requestWithdrawal()">
            💸 طلب سحب ${(data.balance - 2).toFixed(2)} جنيه صافي
          </button>`
            : `<div class="withdraw-note">الحد الأدنى للسحب <strong>10 جنيه</strong>. رصيدك الحالي: <strong>${(data.balance || 0).toFixed(2)} جنيه</strong></div>`
        }
      </div>

      <button class="btn btn-ghost" style="margin-top:8px" onclick="shareRefLink('${escapeHtml(data.refLink || "")}')">
        📤 مشاركة رابط الإحالة
      </button>
    `;
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">فشل تحميل البيانات</div><div class="empty-sub">${escapeHtml(e.message)}</div></div>`;
  }
}

async function requestWithdrawal() {
  const cashInput = document.getElementById("cash-number-input");
  const cashNumber = cashInput?.value?.trim();
  if (!cashNumber || cashNumber.length < 10) {
    showToast("يرجى إدخال رقم الكاش بشكل صحيح", "error");
    cashInput?.classList.add("error");
    return;
  }
  cashInput.classList.remove("error");

  showLoading();
  const btn = document.querySelector(".btn-gold");
  if (btn) btn.disabled = true;

  try {
    const result = await apiFetch("/api/withdraw", {
      method: "POST",
      body: JSON.stringify({ userId: TG_USER_ID, cashNumber }),
    });
    hapticNotification("success");
    showToast(`✅ تم إرسال طلب السحب! ستستلم ${result.netAmount.toFixed(2)} جنيه`, "success", 5000);
    setTimeout(() => loadReferralData(), 1500);
  } catch (e) {
    hapticNotification("error");
    showToast(`❌ ${e.message}`, "error", 5000);
    if (btn) btn.disabled = false;
  } finally {
    hideLoading();
  }
}

function copyRefLink(link) {
  navigator.clipboard?.writeText(link).then(() => {
    haptic("medium");
    showToast("✅ تم نسخ رابط الإحالة", "success");
  }).catch(() => {
    showToast("يرجى النسخ يدوياً من الرابط أعلاه", "info");
  });
}

function shareRefLink(link) {
  if (tg?.shareURL) {
    tg.shareURL(link, "🎮 انضم لـ Apex Matrix واحصل على خصومات وشدات ببجي وفري فاير بأفضل الأسعار!");
  } else if (navigator.share) {
    navigator.share({
      title: "Apex Matrix",
      text: "🎮 انضم لـ Apex Matrix للحصول على خدمات الألعاب بأفضل الأسعار!",
      url: link,
    }).catch(() => {});
  } else {
    copyRefLink(link);
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (typeof str !== "string") return String(str || "");
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleDateString("ar-EG", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Auto-init on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "index")   initIndexPage();
  if (page === "cart")    initCartPage();
  if (page === "history") initHistoryPage();
  if (page === "referral") initReferralPage();
});
