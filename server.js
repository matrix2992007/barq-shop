require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Telegraf, Markup, session } = require("telegraf");
const admin = require("firebase-admin");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

// ─── Validate Required ENV ──────────────────────────────────────────────────
const REQUIRED_ENV = [
  "BOT_TOKEN",
  "OWNER_ID",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_SERVICE_ACCOUNT_KEY",
  "ENCRYPTION_KEY",
  "MINI_APP_URL",
  "WEBHOOK_DOMAIN",
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const OWNER_ID = parseInt(process.env.OWNER_ID, 10);
const MINI_APP_URL = process.env.MINI_APP_URL;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32);

// ─── Firebase Init ───────────────────────────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT_KEY JSON");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.database();

// ─── Encryption Helpers ──────────────────────────────────────────────────────
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(ENCRYPTION_KEY),
    iv
  );
  let encrypted = cipher.update(String(text), "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(encryptedText) {
  try {
    const [ivHex, encrypted] = encryptedText.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(ENCRYPTION_KEY),
      iv
    );
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return "[تعذّر فك التشفير]";
  }
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────
async function getUser(userId) {
  const snap = await db.ref(`users/${userId}`).once("value");
  return snap.val();
}

async function getOrCreateUser(userId, userData = {}) {
  const existing = await getUser(userId);
  if (existing) return existing;
  const newUser = {
    id: userId,
    username: userData.username || null,
    firstName: userData.firstName || "مستخدم",
    balance: 0,
    pendingBalance: 0,
    referredBy: userData.referredBy || null,
    referralCode: userId.toString(),
    joinedAt: Date.now(),
    ...userData,
  };
  await db.ref(`users/${userId}`).set(newUser);
  return newUser;
}

async function isAdmin(userId) {
  if (userId === OWNER_ID) return true;
  const snap = await db.ref(`admins/${userId}`).once("value");
  return snap.exists();
}

async function isSupport(userId) {
  const snap = await db.ref(`support/${userId}`).once("value");
  return snap.exists();
}

async function getAllAdmins() {
  const snap = await db.ref("admins").once("value");
  return snap.val() || {};
}

async function getAllSupport() {
  const snap = await db.ref("support").once("value");
  return snap.val() || {};
}

async function getAllUsers() {
  const snap = await db.ref("users").once("value");
  return snap.val() || {};
}

async function getNextOrderId() {
  const ref = db.ref("meta/lastOrderId");
  const snap = await ref.once("value");
  const next = (snap.val() || 1000) + 1;
  await ref.set(next);
  return next;
}

async function broadcastMessage(bot, message, parseMode = "HTML") {
  const users = await getAllUsers();
  let success = 0;
  let failed = 0;
  for (const uid of Object.keys(users)) {
    try {
      await bot.telegram.sendMessage(uid, message, { parse_mode: parseMode });
      success++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { success, failed };
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Multer — store screenshots in memory as base64
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Telegraf Bot ────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// ── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const startPayload = ctx.startPayload;
  let referredBy = null;
  if (startPayload && startPayload.startsWith("ref_")) {
    const refId = parseInt(startPayload.replace("ref_", ""), 10);
    if (refId !== userId) referredBy = refId;
  }

  await getOrCreateUser(userId, {
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    referredBy,
  });

  const adminStatus = await isAdmin(userId);
  const supportStatus = await isSupport(userId);

  if (userId === OWNER_ID) {
    return sendOwnerPanel(ctx);
  } else if (adminStatus) {
    return sendAdminPanel(ctx);
  } else if (supportStatus) {
    return sendSupportPanel(ctx);
  } else {
    return sendUserPanel(ctx);
  }
});

// ── Owner Panel ──────────────────────────────────────────────────────────────
async function sendOwnerPanel(ctx) {
  const text =
    `👑 <b>لوحة تحكم المالك</b>\n\n` +
    `مرحباً بك يا مالك البوت. اختر إجراءً:`;
  await ctx.replyWithHTML(
    text,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("➕ إضافة أدمن", "owner_add_admin"),
        Markup.button.callback("❌ حذف أدمن", "owner_remove_admin"),
      ],
      [Markup.button.callback("🛠️ تعيين خدمة عملاء", "owner_add_support")],
      [Markup.button.callback("❌ إزالة خدمة عملاء", "owner_remove_support")],
      [Markup.button.callback("📊 الإحصائيات والمالية", "admin_stats")],
      [Markup.button.callback("📨 إرسال إذاعة", "admin_broadcast")],
      [Markup.button.callback("⚙️ إدارة الخدمات والأسعار", "admin_services")],
      [Markup.button.callback("💰 طلبات السحب المعلقة", "admin_withdrawals")],
    ])
  );
}

// ── Admin Panel ──────────────────────────────────────────────────────────────
async function sendAdminPanel(ctx) {
  const text = `🔧 <b>لوحة تحكم الإدارة</b>\n\nاختر إجراءً:`;
  await ctx.replyWithHTML(
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 الإحصائيات والمالية", "admin_stats")],
      [Markup.button.callback("📨 إرسال إذاعة", "admin_broadcast")],
      [Markup.button.callback("⚙️ إدارة الخدمات والأسعار", "admin_services")],
      [Markup.button.callback("💰 طلبات السحب المعلقة", "admin_withdrawals")],
    ])
  );
}

// ── Support Panel ────────────────────────────────────────────────────────────
async function sendSupportPanel(ctx) {
  const text =
    `🎧 <b>لوحة خدمة العملاء</b>\n\n` +
    `ستصلك تذاكر دعم العملاء هنا مباشرة.\n` +
    `للرد على تذكرة استخدم الأزرار المرفقة مع كل تذكرة.`;
  await ctx.replyWithHTML(text);
}

// ── User Panel ───────────────────────────────────────────────────────────────
async function sendUserPanel(ctx) {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  const refLink = `https://t.me/${ctx.botInfo.username}?start=ref_${userId}`;
  const text =
    `👋 <b>أهلاً ${user.firstName}!</b>\n\n` +
    `مرحباً في <b>Apex Matrix</b> للخدمات الرقمية.\n\n` +
    `💰 رصيدك: <b>${(user.balance || 0).toFixed(2)} جنيه</b>\n` +
    `⏳ مكافآت معلقة: <b>${(user.pendingBalance || 0).toFixed(2)} جنيه</b>`;
  await ctx.replyWithHTML(
    text,
    Markup.inlineKeyboard([
      [
        Markup.button.webApp(
          "🛒 فتح المتجر",
          `${MINI_APP_URL}/index.html?uid=${userId}`
        ),
      ],
      [
        Markup.button.webApp(
          "📋 سجل طلباتي",
          `${MINI_APP_URL}/history.html?uid=${userId}`
        ),
      ],
      [
        Markup.button.webApp(
          "🤝 نظام الإحالة",
          `${MINI_APP_URL}/referral.html?uid=${userId}`
        ),
      ],
    ])
  );
  await ctx.reply(`🔗 رابط الإحالة الخاص بك:\n${refLink}`);
}

// ─── Owner Callbacks ─────────────────────────────────────────────────────────

bot.action("owner_add_admin", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ غير مصرح");
  ctx.session = ctx.session || {};
  ctx.session.awaitingInput = "add_admin";
  await ctx.answerCbQuery();
  await ctx.reply(
    "📝 أرسل الـ Telegram ID الخاص بالأدمن الجديد (أرقام فقط):"
  );
});

bot.action("owner_remove_admin", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ غير مصرح");
  const admins = await getAllAdmins();
  const keys = Object.keys(admins);
  if (keys.length === 0) {
    await ctx.answerCbQuery();
    return ctx.reply("لا يوجد أدمنية حالياً.");
  }
  const buttons = keys.map((id) => [
    Markup.button.callback(
      `❌ ${admins[id].name || id}`,
      `remove_admin_${id}`
    ),
  ]);
  await ctx.answerCbQuery();
  await ctx.reply("اختر الأدمن لحذفه:", Markup.inlineKeyboard(buttons));
});

bot.action("owner_add_support", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ غير مصرح");
  ctx.session = ctx.session || {};
  ctx.session.awaitingInput = "add_support";
  await ctx.answerCbQuery();
  await ctx.reply(
    "📝 أرسل الـ Telegram ID لحساب خدمة العملاء الجديد (أرقام فقط):"
  );
});

bot.action("owner_remove_support", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ غير مصرح");
  const support = await getAllSupport();
  const keys = Object.keys(support);
  if (keys.length === 0) {
    await ctx.answerCbQuery();
    return ctx.reply("لا يوجد فريق خدمة عملاء حالياً.");
  }
  const buttons = keys.map((id) => [
    Markup.button.callback(
      `❌ ${support[id].name || id}`,
      `remove_support_${id}`
    ),
  ]);
  await ctx.answerCbQuery();
  await ctx.reply("اختر الحساب لإزالته:", Markup.inlineKeyboard(buttons));
});

// Dynamic remove admin callbacks
bot.action(/^remove_admin_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ غير مصرح");
  const targetId = ctx.match[1];
  await db.ref(`admins/${targetId}`).remove();
  await ctx.answerCbQuery("✅ تم حذف الأدمن");
  await ctx.editMessageText(`✅ تم حذف الأدمن رقم ${targetId} بنجاح.`);
  try {
    await bot.telegram.sendMessage(
      targetId,
      "⚠️ تم إلغاء صلاحياتك كأدمن في Apex Matrix."
    );
  } catch {}
});

// Dynamic remove support callbacks
bot.action(/^remove_support_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery("❌ غير مصرح");
  const targetId = ctx.match[1];
  await db.ref(`support/${targetId}`).remove();
  await ctx.answerCbQuery("✅ تم إزالة حساب خدمة العملاء");
  await ctx.editMessageText(
    `✅ تم إزالة الحساب ${targetId} من فريق خدمة العملاء.`
  );
  try {
    await bot.telegram.sendMessage(
      targetId,
      "⚠️ تم إلغاء صلاحياتك كخدمة عملاء في Apex Matrix."
    );
  } catch {}
});

// ─── Admin Callbacks ──────────────────────────────────────────────────────────

bot.action("admin_stats", async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  await ctx.answerCbQuery();

  const usersSnap = await db.ref("users").once("value");
  const users = usersSnap.val() || {};
  const totalUsers = Object.keys(users).length;

  const ordersSnap = await db.ref("orders").once("value");
  const orders = ordersSnap.val() || {};
  let pending = 0,
    processing = 0,
    completed = 0,
    rejected = 0,
    totalRevenue = 0;
  for (const o of Object.values(orders)) {
    if (o.status === "pending") pending++;
    else if (o.status === "processing") processing++;
    else if (o.status === "completed") {
      completed++;
      totalRevenue += o.total || 0;
    } else if (o.status === "rejected") rejected++;
  }

  const withdrawSnap = await db.ref("withdrawals").once("value");
  const withdrawals = withdrawSnap.val() || {};
  const pendingWithdrawals = Object.values(withdrawals).filter(
    (w) => w.status === "pending"
  ).length;

  const text =
    `📊 <b>إحصائيات Apex Matrix</b>\n\n` +
    `👥 إجمالي المستخدمين: <b>${totalUsers}</b>\n\n` +
    `📦 <b>الطلبات:</b>\n` +
    `  🟡 قيد المراجعة: <b>${pending}</b>\n` +
    `  🔵 قيد التنفيذ: <b>${processing}</b>\n` +
    `  🟢 مكتملة: <b>${completed}</b>\n` +
    `  🔴 مرفوضة: <b>${rejected}</b>\n\n` +
    `💰 إجمالي الإيرادات المستلمة: <b>${totalRevenue.toFixed(2)} جنيه</b>\n` +
    `⏳ طلبات سحب معلقة: <b>${pendingWithdrawals}</b>`;

  await ctx.replyWithHTML(text);
});

bot.action("admin_broadcast", async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  ctx.session = ctx.session || {};
  ctx.session.awaitingInput = "broadcast";
  await ctx.answerCbQuery();
  await ctx.reply(
    "📢 أرسل نص رسالة الإذاعة:\n(يمكنك استخدام HTML: <b>عريض</b> <i>مائل</i>)"
  );
});

bot.action("admin_services", async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  await ctx.answerCbQuery();

  const catSnap = await db.ref("categories").once("value");
  const cats = catSnap.val() || {};
  const buttons = Object.entries(cats).map(([id, cat]) => [
    Markup.button.callback(`📁 ${cat.name}`, `cat_manage_${id}`),
  ]);
  buttons.push([
    Markup.button.callback("➕ إضافة قسم جديد", "admin_add_category"),
  ]);

  await ctx.reply("⚙️ <b>إدارة الأقسام والخدمات:</b>", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.action("admin_add_category", async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  ctx.session = ctx.session || {};
  ctx.session.awaitingInput = "add_category";
  await ctx.answerCbQuery();
  await ctx.reply("📝 أرسل اسم القسم الجديد:");
});

bot.action(/^cat_manage_(.+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const catId = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.currentCategoryId = catId;
  await ctx.answerCbQuery();

  const catSnap = await db.ref(`categories/${catId}`).once("value");
  const cat = catSnap.val();
  const services = cat.services || {};
  const buttons = Object.entries(services).map(([sid, svc]) => [
    Markup.button.callback(
      `✏️ ${svc.name} (${svc.price} جنيه)`,
      `edit_service_${catId}_${sid}`
    ),
  ]);
  buttons.push([
    Markup.button.callback("➕ إضافة خدمة", `add_service_${catId}`),
  ]);
  buttons.push([
    Markup.button.callback("🗑️ حذف القسم", `delete_cat_${catId}`),
  ]);

  await ctx.reply(`📁 <b>قسم: ${cat.name}</b>\nاختر خدمة للتعديل:`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.action(/^add_service_(.+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const catId = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.awaitingInput = "add_service";
  ctx.session.currentCategoryId = catId;
  await ctx.answerCbQuery();
  await ctx.reply(
    "📝 أرسل بيانات الخدمة بالصيغة التالية:\n<b>اسم الخدمة | السعر</b>\n\nمثال: شدات ببجي 60 | 25",
    { parse_mode: "HTML" }
  );
});

bot.action(/^edit_service_(.+)_(.+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const catId = ctx.match[1];
  const serviceId = ctx.match[2];
  ctx.session = ctx.session || {};
  ctx.session.awaitingInput = "edit_service_price";
  ctx.session.editingService = { catId, serviceId };
  await ctx.answerCbQuery();
  await ctx.reply("💰 أرسل السعر الجديد للخدمة (أرقام فقط):");
});

bot.action(/^delete_cat_(.+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const catId = ctx.match[1];
  await db.ref(`categories/${catId}`).remove();
  await ctx.answerCbQuery("✅ تم حذف القسم");
  await ctx.editMessageText("✅ تم حذف القسم بنجاح.");
});

bot.action("admin_withdrawals", async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  await ctx.answerCbQuery();

  const snap = await db.ref("withdrawals").once("value");
  const all = snap.val() || {};
  const pending = Object.entries(all).filter(([, w]) => w.status === "pending");

  if (pending.length === 0) {
    return ctx.reply("✅ لا توجد طلبات سحب معلقة حالياً.");
  }

  for (const [wid, w] of pending) {
    const netAmount = w.amount - 2;
    const text =
      `💰 <b>طلب سحب #${wid}</b>\n\n` +
      `👤 المستخدم: <code>${w.userId}</code>\n` +
      `📱 رقم الكاش: <b>${w.cashNumber}</b>\n` +
      `💵 المبلغ المطلوب: <b>${w.amount} جنيه</b>\n` +
      `💸 بعد العمولة (2 جنيه): <b>${netAmount} جنيه</b>\n` +
      `📅 التاريخ: ${new Date(w.createdAt).toLocaleString("ar-EG")}`;
    await ctx.replyWithHTML(
      text,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ تأكيد التحويل",
            `approve_withdrawal_${wid}`
          ),
          Markup.button.callback("❌ رفض", `reject_withdrawal_${wid}`),
        ],
      ])
    );
  }
});

bot.action(/^approve_withdrawal_(.+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const wid = ctx.match[1];
  const wSnap = await db.ref(`withdrawals/${wid}`).once("value");
  const w = wSnap.val();
  if (!w || w.status !== "pending") {
    return ctx.answerCbQuery("❌ الطلب غير موجود أو تمت معالجته.");
  }
  const netAmount = w.amount - 2;
  await db.ref(`withdrawals/${wid}`).update({ status: "approved" });
  await ctx.answerCbQuery("✅ تم تأكيد التحويل");
  await ctx.editMessageText(
    `✅ تم تأكيد تحويل ${netAmount} جنيه لـ ${w.cashNumber}`
  );
  try {
    await bot.telegram.sendMessage(
      w.userId,
      `✅ <b>تمت الموافقة على طلب السحب!</b>\n\n` +
        `تم تحويل <b>${netAmount} جنيه</b> على رقم الكاش: <b>${w.cashNumber}</b>\n` +
        `(تم خصم 2 جنيه عمولة تحويل)`,
      { parse_mode: "HTML" }
    );
  } catch {}
});

bot.action(/^reject_withdrawal_(.+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const wid = ctx.match[1];
  const wSnap = await db.ref(`withdrawals/${wid}`).once("value");
  const w = wSnap.val();
  if (!w) return ctx.answerCbQuery("❌ الطلب غير موجود.");
  await db.ref(`withdrawals/${wid}`).update({ status: "rejected" });
  // Refund balance
  await db
    .ref(`users/${w.userId}/balance`)
    .transaction((bal) => (bal || 0) + w.amount);
  await ctx.answerCbQuery("🔴 تم رفض الطلب");
  await ctx.editMessageText("🔴 تم رفض طلب السحب وإعادة الرصيد للمستخدم.");
  try {
    await bot.telegram.sendMessage(
      w.userId,
      `❌ <b>تم رفض طلب السحب الخاص بك.</b>\n` +
        `تم إعادة مبلغ <b>${w.amount} جنيه</b> لرصيدك.`,
      { parse_mode: "HTML" }
    );
  } catch {}
});

// ─── Order Management Callbacks ───────────────────────────────────────────────

bot.action(/^order_accept_(\d+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const orderId = parseInt(ctx.match[1], 10);
  const orderSnap = await db.ref(`orders/${orderId}`).once("value");
  const order = orderSnap.val();
  if (!order) return ctx.answerCbQuery("❌ الطلب غير موجود");
  if (order.status !== "pending")
    return ctx.answerCbQuery("❌ الطلب لم يعد قيد الانتظار");

  await db.ref(`orders/${orderId}`).update({
    status: "processing",
    acceptedAt: Date.now(),
    acceptedBy: ctx.from.id,
  });

  await ctx.answerCbQuery("✅ تم استلام الطلب");

  // Update message
  const servicesText = order.items
    .map(
      (item, i) =>
        `  ${i + 1}. ${item.serviceName} (${item.categoryName}) — ${item.price} جنيه`
    )
    .join("\n");
  await ctx.editMessageText(
    `🔵 <b>طلب #${orderId} — قيد التنفيذ</b>\n\n` +
      `الخدمات:\n${servicesText}\n\n` +
      `📍 استخدم الأزرار أدناه لإدارة كل خدمة:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(
        order.items.map((item, i) => [
          Markup.button.callback(
            `🟢 تم — ${item.serviceName}`,
            `item_done_${orderId}_${i}`
          ),
          Markup.button.callback(
            `🔴 رفض — ${item.serviceName}`,
            `item_reject_${orderId}_${i}`
          ),
        ])
      ),
    }
  );

  // Notify user
  try {
    await bot.telegram.sendMessage(
      order.userId,
      `🔵 <b>تحديث على طلبك #${orderId}</b>\n\nتم استلام طلبك وبدأنا في التنفيذ!\nسيصلك إشعار عند اكتمال كل خدمة.`,
      { parse_mode: "HTML" }
    );
  } catch {}
});

bot.action(/^order_reject_all_(\d+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const orderId = parseInt(ctx.match[1], 10);
  ctx.session = ctx.session || {};
  ctx.session.awaitingInput = "reject_order_reason";
  ctx.session.rejectingOrderId = orderId;
  await ctx.answerCbQuery();
  await ctx.reply(
    `📝 أرسل سبب رفض الطلب #${orderId} (سيتم إرساله للعميل):`
  );
});

bot.action(/^item_done_(\d+)_(\d+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const orderId = parseInt(ctx.match[1], 10);
  const itemIndex = parseInt(ctx.match[2], 10);

  const orderSnap = await db.ref(`orders/${orderId}`).once("value");
  const order = orderSnap.val();
  if (!order) return ctx.answerCbQuery("❌ الطلب غير موجود");

  const items = [...order.items];
  items[itemIndex].status = "completed";
  items[itemIndex].completedAt = Date.now();

  const allDone = items.every((it) => it.status === "completed" || it.status === "rejected");
  const newStatus = allDone ? "completed" : "processing";

  await db.ref(`orders/${orderId}`).update({ items, status: newStatus });
  await ctx.answerCbQuery("✅ تم تنفيذ الخدمة");

  if (allDone) {
    await ctx.editMessageText(
      `✅ <b>طلب #${orderId} مكتمل!</b>\nتم تنفيذ جميع الخدمات.`,
      { parse_mode: "HTML" }
    );
    // Add cashback 1.5 to user
    await db
      .ref(`users/${order.userId}/balance`)
      .transaction((bal) => (bal || 0) + 1.5);
    // If user was referred, credit referrer 1 EGP (was already pending — now activate)
    const userSnap = await db.ref(`users/${order.userId}`).once("value");
    const user = userSnap.val();
    const isFirstOrder = !order.isReferralCredited;
    if (user.referredBy && isFirstOrder) {
      await db
        .ref(`users/${user.referredBy}/balance`)
        .transaction((bal) => (bal || 0) + 1);
      await db
        .ref(`users/${user.referredBy}/pendingBalance`)
        .transaction((bal) => Math.max((bal || 0) - 1, 0));
      await db
        .ref(`orders/${orderId}`)
        .update({ isReferralCredited: true });
      try {
        await bot.telegram.sendMessage(
          user.referredBy,
          `🎉 <b>مكافأة الإحالة!</b>\nصديقك أتم أول عملية شراء ناجحة وتمت الموافقة عليها.\n✅ تم إضافة <b>1 جنيه</b> لرصيدك القابل للسحب!`,
          { parse_mode: "HTML" }
        );
      } catch {}
    }
    try {
      await bot.telegram.sendMessage(
        order.userId,
        `🎉 <b>طلبك #${orderId} مكتمل!</b>\nتم تنفيذ جميع خدماتك بنجاح.\n💰 تم إضافة <b>1.5 جنيه كاش باك</b> لرصيدك!`,
        { parse_mode: "HTML" }
      );
    } catch {}
  } else {
    const item = items[itemIndex];
    await ctx.editMessageText(
      `✅ تم تنفيذ "<b>${item.serviceName}</b>" في طلب #${orderId}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(
          items
            .map((it, i) => {
              if (it.status === "completed" || it.status === "rejected")
                return null;
              return [
                Markup.button.callback(
                  `🟢 تم — ${it.serviceName}`,
                  `item_done_${orderId}_${i}`
                ),
                Markup.button.callback(
                  `🔴 رفض — ${it.serviceName}`,
                  `item_reject_${orderId}_${i}`
                ),
              ];
            })
            .filter(Boolean)
        ),
      }
    );
    try {
      await bot.telegram.sendMessage(
        order.userId,
        `✅ <b>تحديث طلب #${orderId}</b>\nتم تنفيذ خدمة "<b>${item.serviceName}</b>" بنجاح!`,
        { parse_mode: "HTML" }
      );
    } catch {}
  }
});

bot.action(/^item_reject_(\d+)_(\d+)$/, async (ctx) => {
  const adminOk = await isAdmin(ctx.from.id);
  if (!adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const orderId = parseInt(ctx.match[1], 10);
  const itemIndex = parseInt(ctx.match[2], 10);
  ctx.session = ctx.session || {};
  ctx.session.awaitingInput = "reject_item_reason";
  ctx.session.rejectingItem = { orderId, itemIndex };
  await ctx.answerCbQuery();
  await ctx.reply(`📝 أرسل سبب رفض الخدمة (سيتم إرساله للعميل):`);
});

// ─── Support Ticket Callbacks ─────────────────────────────────────────────────

bot.action(/^ticket_reply_(.+)$/, async (ctx) => {
  const suppOk = await isSupport(ctx.from.id);
  const adminOk = await isAdmin(ctx.from.id);
  if (!suppOk && !adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const ticketId = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.awaitingInput = "ticket_reply";
  ctx.session.replyingTicketId = ticketId;
  await ctx.answerCbQuery();
  await ctx.reply(
    "✍️ أرسل ردك على التذكرة (سيتم إرساله للعميل مباشرة عبر البوت):"
  );
});

bot.action(/^ticket_close_(.+)$/, async (ctx) => {
  const suppOk = await isSupport(ctx.from.id);
  const adminOk = await isAdmin(ctx.from.id);
  if (!suppOk && !adminOk) return ctx.answerCbQuery("❌ غير مصرح");
  const ticketId = ctx.match[1];
  await db.ref(`tickets/${ticketId}`).update({ status: "closed" });
  await ctx.answerCbQuery("✅ تم إغلاق التذكرة");
  await ctx.editMessageText(
    `✅ تم إغلاق التذكرة #${ticketId}\n` + ctx.callbackQuery.message.text
  );
});

// ─── Text Message Handler (handles all awaiting inputs) ─────────────────────
bot.on("text", async (ctx) => {
  ctx.session = ctx.session || {};
  const input = ctx.session.awaitingInput;
  const text = ctx.message.text.trim();

  if (!input) {
    // No awaiting state — show panel
    const uid = ctx.from.id;
    if (uid === OWNER_ID) return sendOwnerPanel(ctx);
    if (await isAdmin(uid)) return sendAdminPanel(ctx);
    if (await isSupport(uid)) return sendSupportPanel(ctx);
    return sendUserPanel(ctx);
  }

  // Clear session input first
  ctx.session.awaitingInput = null;

  switch (input) {
    case "add_admin": {
      if (ctx.from.id !== OWNER_ID) return;
      const newAdminId = parseInt(text, 10);
      if (isNaN(newAdminId)) return ctx.reply("❌ ID غير صالح.");
      let adminName = String(newAdminId);
      try {
        const chat = await bot.telegram.getChat(newAdminId);
        adminName = chat.first_name || String(newAdminId);
      } catch {}
      await db.ref(`admins/${newAdminId}`).set({
        id: newAdminId,
        name: adminName,
        addedAt: Date.now(),
      });
      await ctx.reply(`✅ تم إضافة ${adminName} (${newAdminId}) كأدمن.`);
      try {
        await bot.telegram.sendMessage(
          newAdminId,
          `🎉 تم تعيينك أدمناً في <b>Apex Matrix</b>!\nأرسل /start للوصول للوحة التحكم.`,
          { parse_mode: "HTML" }
        );
      } catch {}
      break;
    }

    case "add_support": {
      if (ctx.from.id !== OWNER_ID) return;
      const newSuppId = parseInt(text, 10);
      if (isNaN(newSuppId)) return ctx.reply("❌ ID غير صالح.");
      let suppName = String(newSuppId);
      try {
        const chat = await bot.telegram.getChat(newSuppId);
        suppName = chat.first_name || String(newSuppId);
      } catch {}
      await db.ref(`support/${newSuppId}`).set({
        id: newSuppId,
        name: suppName,
        addedAt: Date.now(),
      });
      await ctx.reply(`✅ تم تعيين ${suppName} (${newSuppId}) كخدمة عملاء.`);
      try {
        await bot.telegram.sendMessage(
          newSuppId,
          `🎧 تم تعيينك ضمن فريق خدمة العملاء في <b>Apex Matrix</b>!\nأرسل /start للوصول للوحة التحكم.`,
          { parse_mode: "HTML" }
        );
      } catch {}
      break;
    }

    case "broadcast": {
      if (!(await isAdmin(ctx.from.id))) return;
      await ctx.reply("📡 جاري إرسال الإذاعة...");
      const result = await broadcastMessage(
        bot,
        `📢 <b>إذاعة من Apex Matrix:</b>\n\n${text}`
      );
      await ctx.reply(
        `✅ تم الإرسال!\n✔️ نجح: ${result.success}\n❌ فشل: ${result.failed}`
      );
      break;
    }

    case "add_category": {
      if (!(await isAdmin(ctx.from.id))) return;
      const catId = uuidv4().slice(0, 8);
      await db.ref(`categories/${catId}`).set({
        id: catId,
        name: text,
        services: {},
        createdAt: Date.now(),
      });
      await ctx.reply(`✅ تم إضافة قسم "<b>${text}</b>" بنجاح!`, {
        parse_mode: "HTML",
      });
      break;
    }

    case "add_service": {
      if (!(await isAdmin(ctx.from.id))) return;
      const parts = text.split("|").map((p) => p.trim());
      if (parts.length !== 2) {
        return ctx.reply(
          "❌ الصيغة غير صحيحة. مثال: شدات ببجي 60 | 25",
          { parse_mode: "HTML" }
        );
      }
      const [serviceName, priceStr] = parts;
      const price = parseFloat(priceStr);
      if (isNaN(price)) return ctx.reply("❌ السعر يجب أن يكون رقماً.");
      const catId = ctx.session.currentCategoryId;
      const sid = uuidv4().slice(0, 8);
      await db.ref(`categories/${catId}/services/${sid}`).set({
        id: sid,
        name: serviceName,
        price,
        createdAt: Date.now(),
      });
      await ctx.reply(
        `✅ تم إضافة خدمة "<b>${serviceName}</b>" بسعر <b>${price} جنيه</b>!`,
        { parse_mode: "HTML" }
      );
      break;
    }

    case "edit_service_price": {
      if (!(await isAdmin(ctx.from.id))) return;
      const price = parseFloat(text);
      if (isNaN(price)) return ctx.reply("❌ أدخل رقماً صحيحاً للسعر.");
      const { catId, serviceId } = ctx.session.editingService || {};
      if (!catId || !serviceId) return ctx.reply("❌ حدث خطأ. حاول مرة أخرى.");
      await db.ref(`categories/${catId}/services/${serviceId}`).update({ price });
      await ctx.reply(`✅ تم تحديث السعر إلى <b>${price} جنيه</b>.`, {
        parse_mode: "HTML",
      });
      break;
    }

    case "reject_order_reason": {
      if (!(await isAdmin(ctx.from.id))) return;
      const orderId = ctx.session.rejectingOrderId;
      const orderSnap = await db.ref(`orders/${orderId}`).once("value");
      const order = orderSnap.val();
      if (!order) return ctx.reply("❌ الطلب غير موجود.");
      await db.ref(`orders/${orderId}`).update({
        status: "rejected",
        rejectionReason: text,
        rejectedAt: Date.now(),
      });
      await ctx.reply(`✅ تم رفض الطلب #${orderId}.`);
      try {
        await bot.telegram.sendMessage(
          order.userId,
          `🔴 <b>تم رفض طلبك #${orderId}</b>\n\n📋 السبب: ${text}\n\nإذا كان لديك استفسار يرجى فتح تذكرة دعم.`,
          { parse_mode: "HTML" }
        );
      } catch {}
      break;
    }

    case "reject_item_reason": {
      if (!(await isAdmin(ctx.from.id))) return;
      const { orderId, itemIndex } = ctx.session.rejectingItem || {};
      const orderSnap = await db.ref(`orders/${orderId}`).once("value");
      const order = orderSnap.val();
      if (!order) return ctx.reply("❌ الطلب غير موجود.");
      const items = [...order.items];
      const item = items[itemIndex];
      items[itemIndex].status = "rejected";
      items[itemIndex].rejectionReason = text;
      items[itemIndex].rejectedAt = Date.now();
      const allDone = items.every(
        (it) => it.status === "completed" || it.status === "rejected"
      );
      await db
        .ref(`orders/${orderId}`)
        .update({ items, status: allDone ? "completed" : "processing" });
      await ctx.reply(`✅ تم رفض الخدمة "${item.serviceName}".`);
      try {
        await bot.telegram.sendMessage(
          order.userId,
          `🔴 <b>تحديث طلب #${orderId}</b>\n\n` +
            `تم رفض خدمة "<b>${item.serviceName}</b>"\n` +
            `📋 السبب: ${text}\n\n` +
            `يمكنك فتح تذكرة دعم بخصوص هذه الخدمة من سجل طلباتك.`,
          { parse_mode: "HTML" }
        );
      } catch {}
      break;
    }

    case "ticket_reply": {
      const ticketId = ctx.session.replyingTicketId;
      const ticketSnap = await db.ref(`tickets/${ticketId}`).once("value");
      const ticket = ticketSnap.val();
      if (!ticket) return ctx.reply("❌ التذكرة غير موجودة.");
      await db.ref(`tickets/${ticketId}/replies`).push({
        fromSupport: true,
        agentId: ctx.from.id,
        message: text,
        timestamp: Date.now(),
      });
      await ctx.reply("✅ تم إرسال الرد للعميل.");
      try {
        await bot.telegram.sendMessage(
          ticket.userId,
          `💬 <b>رد من خدمة العملاء على تذكرتك #${ticketId}</b>\n\n` +
            `${text}\n\n` +
            `للرد مجدداً، افتح سجل الطلبات واضغط على التذكرة.`,
          { parse_mode: "HTML" }
        );
      } catch {}
      break;
    }

    default:
      break;
  }
});

// ─── REST API Endpoints ───────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => res.json({ status: "ok", app: "Apex Matrix" }));

// Get all categories and services (public)
app.get("/api/categories", async (req, res) => {
  try {
    const snap = await db.ref("categories").once("value");
    res.json(snap.val() || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get user data
app.get("/api/user/:userId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    // Never expose internal fields
    const { id, firstName, username, balance, pendingBalance, referralCode, joinedAt } = user;
    res.json({ id, firstName, username, balance, pendingBalance, referralCode, joinedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get user orders (history)
app.get("/api/orders/:userId", async (req, res) => {
  try {
    const snap = await db
      .ref("orders")
      .orderByChild("userId")
      .equalTo(parseInt(req.params.userId, 10))
      .once("value");
    const orders = snap.val() || {};
    // Strip encrypted IDs from response (client only sees masked version)
    const safeOrders = Object.entries(orders).map(([id, order]) => ({
      ...order,
      id,
      items: (order.items || []).map((item) => ({
        ...item,
        gameId: item.gameId ? "****" + item.gameId.slice(-4) : null,
        gameIdEncrypted: undefined,
      })),
    }));
    res.json(safeOrders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create new order (accepts screenshot as base64 in body)
app.post("/api/orders", async (req, res) => {
  try {
    const { userId, items, screenshotBase64, screenshotMime } = req.body;
    if (!userId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "بيانات غير مكتملة." });
    }

    // Validate each item has gameId
    for (const item of items) {
      if (!item.gameId || !item.serviceName || !item.categoryName || !item.price) {
        return res.status(400).json({ error: "كل خدمة يجب أن تحتوي على ID اللعبة والاسم والسعر." });
      }
    }

    const user = await getOrCreateUser(parseInt(userId, 10));

    // Encrypt game IDs
    const secureItems = items.map((item) => ({
      ...item,
      gameIdEncrypted: encrypt(item.gameId),
      gameId: item.gameId.slice(-4).padStart(item.gameId.length, "*"),
      status: "pending",
    }));

    const subtotal = secureItems.reduce((sum, it) => sum + it.price, 0);
    const discount = subtotal * 0.03;
    const total = parseFloat((subtotal - discount).toFixed(2));

    const orderId = await getNextOrderId();

    const orderData = {
      id: orderId,
      userId: parseInt(userId, 10),
      items: secureItems,
      subtotal,
      discount: parseFloat(discount.toFixed(2)),
      total,
      status: "pending",
      screenshotBase64: screenshotBase64 || null,
      screenshotMime: screenshotMime || null,
      isReferralCredited: false,
      createdAt: Date.now(),
    };

    await db.ref(`orders/${orderId}`).set(orderData);

    // Notify admins
    const admins = await getAllAdmins();
    const adminIds = [OWNER_ID, ...Object.keys(admins).map(Number)];

    const itemsText = items
      .map((it, i) => `  ${i + 1}. ${it.serviceName} (${it.categoryName}) — ${it.price} جنيه`)
      .join("\n");

    const notifyText =
      `🛎️ <b>طلب جديد #${orderId}</b>\n\n` +
      `👤 المستخدم: ${user.firstName} (<code>${userId}</code>)\n\n` +
      `📦 الخدمات:\n${itemsText}\n\n` +
      `💰 الإجمالي: <b>${subtotal} جنيه</b>\n` +
      `🏷️ خصم 3%: <b>- ${discount.toFixed(2)} جنيه</b>\n` +
      `✅ المدفوع: <b>${total} جنيه</b>\n\n` +
      `🔐 IDs اللعب المشفرة:\n` +
      secureItems.map((it, i) => `  ${i + 1}. ${it.serviceName}: ${decrypt(it.gameIdEncrypted)}`).join("\n");

    const orderButtons = Markup.inlineKeyboard([
      [
        Markup.button.callback("🟡 استلام وبدء التنفيذ", `order_accept_${orderId}`),
        Markup.button.callback("🔴 رفض الطلب بالكامل", `order_reject_all_${orderId}`),
      ],
    ]);

    for (const adminId of adminIds) {
      try {
        if (screenshotBase64) {
          const imgBuffer = Buffer.from(screenshotBase64, "base64");
          await bot.telegram.sendPhoto(
            adminId,
            { source: imgBuffer },
            { caption: notifyText, parse_mode: "HTML", ...orderButtons }
          );
        } else {
          await bot.telegram.sendMessage(adminId, notifyText, {
            parse_mode: "HTML",
            ...orderButtons,
          });
        }
      } catch {}
    }

    // Notify user
    try {
      await bot.telegram.sendMessage(
        userId,
        `✅ <b>تم استلام طلبك بنجاح!</b>\n\n` +
          `رقم طلبك: <b>#${orderId}</b>\n` +
          `الإجمالي المدفوع: <b>${total} جنيه</b>\n` +
          `الحالة: 🟡 قيد المراجعة\n\nسيصلك إشعار عند بدء التنفيذ.`,
        { parse_mode: "HTML" }
      );
    } catch {}

    res.json({ success: true, orderId, total, discount });
  } catch (e) {
    console.error("Order error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Open support ticket
app.post("/api/tickets", async (req, res) => {
  try {
    const { userId, orderId, itemIndex, message } = req.body;
    if (!userId || !orderId || !message) {
      return res.status(400).json({ error: "بيانات غير مكتملة." });
    }

    const ticketId = uuidv4().slice(0, 12);
    const orderSnap = await db.ref(`orders/${orderId}`).once("value");
    const order = orderSnap.val();
    const itemName =
      order && order.items && order.items[itemIndex]
        ? order.items[itemIndex].serviceName
        : "خدمة";

    const ticketData = {
      id: ticketId,
      userId: parseInt(userId, 10),
      orderId,
      itemIndex: itemIndex ?? null,
      itemName,
      message,
      status: "open",
      replies: [],
      createdAt: Date.now(),
    };

    await db.ref(`tickets/${ticketId}`).set(ticketData);

    const user = await getUser(parseInt(userId, 10));
    const supportAccounts = await getAllSupport();
    const suppIds = Object.keys(supportAccounts).map(Number);
    if (suppIds.length === 0) suppIds.push(OWNER_ID);

    const ticketText =
      `🎫 <b>تذكرة دعم جديدة #${ticketId}</b>\n\n` +
      `👤 العميل: ${user?.firstName || "مستخدم"} (<code>${userId}</code>)\n` +
      `📦 الطلب: #${orderId}\n` +
      `🔧 الخدمة: ${itemName}\n\n` +
      `💬 الرسالة:\n${message}`;

    const ticketButtons = Markup.inlineKeyboard([
      [
        Markup.button.callback("✍️ الرد على التذكرة", `ticket_reply_${ticketId}`),
        Markup.button.callback("✅ إغلاق التذكرة", `ticket_close_${ticketId}`),
      ],
    ]);

    for (const suppId of suppIds) {
      try {
        await bot.telegram.sendMessage(suppId, ticketText, {
          parse_mode: "HTML",
          ...ticketButtons,
        });
      } catch {}
    }

    res.json({ success: true, ticketId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get user tickets
app.get("/api/tickets/:userId", async (req, res) => {
  try {
    const snap = await db
      .ref("tickets")
      .orderByChild("userId")
      .equalTo(parseInt(req.params.userId, 10))
      .once("value");
    res.json(snap.val() || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Request withdrawal
app.post("/api/withdraw", async (req, res) => {
  try {
    const { userId, cashNumber } = req.body;
    if (!userId || !cashNumber) {
      return res.status(400).json({ error: "بيانات غير مكتملة." });
    }

    const user = await getUser(parseInt(userId, 10));
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

    const balance = user.balance || 0;
    if (balance < 10) {
      return res.status(400).json({
        error: `الحد الأدنى للسحب 10 جنيه. رصيدك الحالي: ${balance.toFixed(2)} جنيه.`,
      });
    }

    // Deduct from user balance
    await db
      .ref(`users/${userId}/balance`)
      .transaction((bal) => Math.max((bal || 0) - balance, 0));

    const wid = uuidv4().slice(0, 10);
    const withdrawalData = {
      id: wid,
      userId: parseInt(userId, 10),
      amount: balance,
      cashNumber,
      status: "pending",
      createdAt: Date.now(),
    };

    await db.ref(`withdrawals/${wid}`).set(withdrawalData);

    // Notify admins
    const admins = await getAllAdmins();
    const adminIds = [OWNER_ID, ...Object.keys(admins).map(Number)];
    const netAmount = balance - 2;

    for (const adminId of adminIds) {
      try {
        await bot.telegram.sendMessage(
          adminId,
          `💰 <b>طلب سحب جديد!</b>\n\n` +
            `👤 المستخدم: ${user.firstName} (<code>${userId}</code>)\n` +
            `📱 رقم الكاش: <b>${cashNumber}</b>\n` +
            `💵 المبلغ: <b>${balance.toFixed(2)} جنيه</b>\n` +
            `💸 بعد العمولة: <b>${netAmount.toFixed(2)} جنيه</b>`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "✅ تأكيد التحويل",
                  `approve_withdrawal_${wid}`
                ),
                Markup.button.callback(
                  "❌ رفض",
                  `reject_withdrawal_${wid}`
                ),
              ],
            ]),
          }
        );
      } catch {}
    }

    res.json({ success: true, withdrawalId: wid, amount: balance, netAmount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get referral stats
app.get("/api/referral/:userId", async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const user = await getUser(userId);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

    // Count referred users
    const usersSnap = await db.ref("users").once("value");
    const allUsers = usersSnap.val() || {};
    const referredUsers = Object.values(allUsers).filter(
      (u) => u.referredBy === userId
    );

    // Count referred users with successful orders
    const ordersSnap = await db
      .ref("orders")
      .orderByChild("status")
      .equalTo("completed")
      .once("value");
    const completedOrders = ordersSnap.val() || {};
    const referredWithPurchase = referredUsers.filter((u) =>
      Object.values(completedOrders).some((o) => o.userId === u.id)
    );

    const botUsername = (await bot.telegram.getMe()).username;
    const refLink = `https://t.me/${botUsername}?start=ref_${userId}`;

    res.json({
      balance: user.balance || 0,
      pendingBalance: user.pendingBalance || 0,
      referralCode: user.referralCode || String(userId),
      refLink,
      totalReferred: referredUsers.length,
      activeReferred: referredWithPurchase.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Webhook Setup ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const WEBHOOK_PATH = "/webhook/" + process.env.BOT_TOKEN;

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  console.log(`🚀 Apex Matrix server running on port ${PORT}`);
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
    console.log(`✅ Webhook set to: ${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
  } catch (e) {
    console.error("❌ Failed to set webhook:", e.message);
  }
});

module.exports = { app, bot };
