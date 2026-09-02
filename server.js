/**
 * Zephyr Client — сайт покупки.
 * Express + EJS + сессии + bcrypt. i18n: be / ru / uk / en.
 * Запуск:  npm install  &&  npm start   →  http://localhost:3000
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Jimp = require('jimp');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || (!IS_PROD ? 'zephyr-local-development-secret' : '');
const BUILD = new Date().toISOString().slice(0, 16).replace('T', ' '); // метка сборки (момент старта)
app.set('trust proxy', 1); // за nginx/Caddy — корректные secure-cookie и протокол
app.disable('x-powered-by');

if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required when NODE_ENV=production');
}

function safeMemoryUsage() {
  try { return process.memoryUsage(); }
  catch (_) { return { rss: 0, heapUsed: 0 }; }
}

// ─────────────── Заморозка покупок ───────────────
// Пока true — покупки/триал недоступны (только предзаказ), и выданные дни НЕ тратятся.
const FROZEN = (process.env.PURCHASES_FROZEN || 'false') === 'true';
const FROZEN_AT = new Date(process.env.FROZEN_AT || '2026-06-26T00:00:00Z'); // момент заморозки
function effectiveNow() { return FROZEN ? new Date(FROZEN_AT) : new Date(); }

// Контакты для предзаказа/поддержки
const CONTACTS = {
  discordUser: process.env.DISCORD_USER || 'maboycrime',
  telegram: process.env.TELEGRAM_URL || 'https://t.me/maboycrime',
  telegramName: process.env.TELEGRAM_NAME || '@maboycrime',
  support: process.env.SUPPORT_URL || 'https://t.me/maboycrime',
  supportName: process.env.SUPPORT_NAME || '@maboycrime',
  email: process.env.SUPPORT_EMAIL || ''
};

// ─────────── Telegram-уведомления о запусках лаунчера ───────────
// Секреты — из env (на Render), пустые = уведомления просто выключены.
// СОЗНАТЕЛЬНО без IP: шлём только аккаунт, UID, HWID, время.
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
// Кто может создавать промокоды в боте (Telegram chat/user id). По умолчанию — твой чат.
const TG_ADMIN_ID = String(process.env.TG_ADMIN_ID || TG_CHAT_ID || '');
// Секрет вебхука (setWebhook secret_token). Обязателен на проде — иначе payload можно подделать.
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || '';
function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}
// Node 20+: глобальный fetch. Fire-and-forget, ошибку глотаем.
function tgSend(chatId, text) {
  if (!TG_BOT_TOKEN || !chatId) return Promise.resolve();
  return fetch('https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  }).catch(() => {});
}
function notifyTelegram(text) { return tgSend(TG_CHAT_ID, text); }

// ─────────────────────────── i18n ───────────────────────────
const LANGS = ['be', 'ru', 'uk', 'en'];
const DEFAULT_LANG = 'ru';
const locales = {};
for (const l of LANGS) {
  locales[l] = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', `${l}.json`), 'utf8'));
}
function t(lang, keyPath) {
  const parts = keyPath.split('.');
  let cur = locales[lang] || locales[DEFAULT_LANG];
  for (const p of parts) { cur = cur && cur[p]; if (cur === undefined) break; }
  if (cur === undefined) {
    cur = locales[DEFAULT_LANG];
    for (const p of parts) { cur = cur && cur[p]; if (cur === undefined) break; }
  }
  return cur === undefined ? keyPath : cur;
}

// ─────────────────────────── Тарифы (₽) ───────────────────────────
const PLANS = {
  month:         { id: 'month',         price: 149, currency: 'RUB', months: 1 },
  season:        { id: 'season',        price: 499, currency: 'RUB', months: 3, popular: true },
  halfyear:      { id: 'halfyear',      price: 699, currency: 'RUB', months: 6 },
  lifetime:      { id: 'lifetime',      price: 999, currency: 'RUB', months: 0 },
  lifetime_beta: { id: 'lifetime_beta', price: 1199, currency: 'RUB', months: 0, beta: true }
};

// ─────────────────────────── Скидки ───────────────────────────
// Общая распродажа 10% для всех до 2027; «олдам» (зареган до 2027) — 13%.
// Не суммируются — берём бо́льшую. Даты правишь тут.
const SALE_PCT = 10;
const OLD_PCT = 13;
const SALE_UNTIL = new Date('2027-01-01T00:00:00+03:00');
const OLD_BEFORE = new Date('2027-01-01T00:00:00+03:00');
function discountPercent(user) {
  let pct = 0;
  if (Date.now() < SALE_UNTIL.getTime()) pct = SALE_PCT;
  if (user && user.createdAt && new Date(user.createdAt) < OLD_BEFORE) pct = Math.max(pct, OLD_PCT);
  return pct;
}
function applyDiscount(price, user) {
  const pct = discountPercent(user);
  return { base: price, pct, final: Math.round(price * (100 - pct) / 100) };
}

// Пробный период — цена за N дней (1..7). Один раз на аккаунт.
const TRIAL_PRICES = { 1: 39, 2: 42, 3: 45, 4: 49, 5: 52, 6: 55, 7: 59 };
function trialPrice(days) {
  days = Math.max(1, Math.min(7, parseInt(days, 10) || 1));
  return TRIAL_PRICES[days];
}

// сколько дней даёт тариф (null = бессрочно)
function planDays(planId) {
  if (planId === 'month') return 30;
  if (planId === 'season') return 90;
  if (planId === 'halfyear') return 180;
  if (planId === 'lifetime' || planId === 'lifetime_beta') return null;
  const m = /^trial_(\d+)d$/.exec(String(planId)); if (m) return parseInt(m[1], 10);
  return null;
}

// применить подписку пользователю: days=число (продлевает) или null (навсегда)
async function applySub(userId, planLabel, days) {
  const user = await db.findById(userId);
  if (!user) return;
  if (days === null) {
    await db.updateUser(userId, { plan: planLabel, subPlan: planLabel, subForever: true, subUntil: null });
  } else {
    const now = effectiveNow();
    const base = (user.subUntil && !user.subForever && new Date(user.subUntil) > now) ? new Date(user.subUntil) : now;
    const until = new Date(base.getTime() + days * 86400000);
    await db.updateUser(userId, { plan: planLabel, subPlan: planLabel, subForever: false, subUntil: until.toISOString() });
  }
}

// ─────────── Расходники (заморозка / сброс HWID) ───────────
const FREEZE_PRICE = 89;
const HWID_RESET_PRICE = 149;
// что идёт в подарок с тарифом
const PLAN_GIFTS = {
  season:        { freezes: 1, hwidResets: 0 },
  halfyear:      { freezes: 1, hwidResets: 1 },
  lifetime:      { freezes: 0, hwidResets: 2 },
  lifetime_beta: { freezes: 0, hwidResets: 2 }
};
async function grantGifts(userId, planId) {
  const g = PLAN_GIFTS[planId];
  if (!g) return;
  const u = await db.findById(userId);
  if (!u) return;
  await db.updateUser(userId, {
    freezes: (u.freezes || 0) + g.freezes,
    hwidResets: (u.hwidResets || 0) + g.hwidResets
  });
}

// ─────────────── Промокоды: визард в Telegram-боте ───────────────
function genPromoCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 7; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// Пошаговый диалог: /promo -> название -> период -> активации -> ник.
// «.» = пусто (название сгенерится, период/активации = без лимита, ник = для всех).
async function handlePromoWizard(chatId, text) {
  const t = (text || '').trim();
  if (t === '/cancel') { await db.clearBotState(chatId); return tgSend(chatId, 'Отменено.'); }
  if (/^\/promo(@\w+)?$/i.test(t)) {
    await db.setBotState(chatId, { step: 'name', data: {} });
    return tgSend(chatId, '🎟 <b>Новый промокод</b> — шаг 1/5.\nУкажи <b>название</b> (или <code>.</code> — сгенерирую):');
  }
  const st = await db.getBotState(chatId);
  if (!st) return tgSend(chatId, 'Команды: /promo — создать промокод, /cancel — отмена.');
  const d = st.data || {};
  if (st.step === 'name') {
    d.code = (t === '.' || !t) ? genPromoCode() : t.replace(/\s+/g, '');
    if (await db.getPromo(d.code)) { await db.clearBotState(chatId); return tgSend(chatId, 'Код <code>' + esc(d.code) + '</code> уже есть. Начни заново: /promo'); }
    await db.setBotState(chatId, { step: 'kind', data: d });
    return tgSend(chatId, 'Шаг 2/5. Промик на <b>скидку</b> или на <b>дни</b>?\nНапиши <code>скидка</code> или <code>дни</code>:');
  }
  if (st.step === 'kind') {
    const v = t.toLowerCase();
    if (v.startsWith('скид') || v === 'discount' || v === '1') d.kind = 'discount';
    else if (v.startsWith('дн') || v === 'days' || v === '2') d.kind = 'days';
    else return tgSend(chatId, 'Напиши <code>скидка</code> или <code>дни</code>.');
    if (d.kind === 'discount') {
      await db.setBotState(chatId, { step: 'percent', data: d });
      return tgSend(chatId, 'Шаг 3/5. <b>Процент скидки</b> (1–100):');
    }
    await db.setBotState(chatId, { step: 'period', data: d });
    return tgSend(chatId, 'Шаг 3/5. <b>Период</b> в днях (число, <code>404</code> или <code>.</code> = навсегда):');
  }
  if (st.step === 'percent') {
    const n = parseInt(t, 10);
    if (isNaN(n) || n < 1 || n > 100) return tgSend(chatId, 'Нужен процент 1–100.');
    d.percent = n;
    await db.setBotState(chatId, { step: 'uses', data: d });
    return tgSend(chatId, 'Шаг 4/5. <b>Кол-во активаций</b> (число, <code>404</code> или <code>.</code> = безлимит):');
  }
  if (st.step === 'period') {
    if (t === '.' || t === '404') { d.forever = true; d.days = null; }
    else { const n = parseInt(t, 10); if (isNaN(n) || n < 1) return tgSend(chatId, 'Нужно число дней, или <code>404</code>/<code>.</code> = навсегда.'); d.forever = false; d.days = n; }
    await db.setBotState(chatId, { step: 'uses', data: d });
    return tgSend(chatId, 'Шаг 4/5. <b>Кол-во активаций</b> (число, <code>404</code> или <code>.</code> = безлимит):');
  }
  if (st.step === 'uses') {
    if (t === '.' || t === '404') d.maxUses = 0;
    else { const n = parseInt(t, 10); if (isNaN(n) || n < 1) return tgSend(chatId, 'Нужно число активаций, или <code>404</code>/<code>.</code> = безлимит.'); d.maxUses = n; }
    await db.setBotState(chatId, { step: 'target', data: d });
    return tgSend(chatId, 'Шаг 5/5. <b>Ник</b> кому выдать (<code>.</code> = для всех):');
  }
  if (st.step === 'target') {
    d.target = (t === '.' || !t) ? '' : t.toLowerCase();
    await db.createPromo({ code: d.code, kind: d.kind, days: d.days, forever: d.forever, percent: d.percent, maxUses: d.maxUses, target: d.target });
    await db.clearBotState(chatId);
    const what = d.kind === 'discount' ? ('скидка ' + d.percent + '%') : (d.forever ? 'навсегда' : (d.days + ' дн.'));
    const uses = d.maxUses ? (d.maxUses + ' активаций') : 'безлимит';
    const who = d.target ? ('@' + esc(d.target)) : 'для всех';
    const where = d.kind === 'discount' ? 'на странице «Купить»' : 'в профиле → «Активировать ключ»';
    return tgSend(chatId, '✅ <b>Промокод создан</b>\nКод: <code>' + esc(d.code) + '</code>\nТип: ' + what + '\nАктиваций: ' + uses + '\nКому: ' + who + '\nАктивируют: ' + where);
  }
  await db.clearBotState(chatId);
  return tgSend(chatId, 'Сбой шага. Начни заново: /promo');
}

// ─────────────────────────── Админы ───────────────────────────
// ADMIN_EMAILS = список email через запятую (в окружении Render). Админ
// определяется ТОЛЬКО по почте — ник не важен. (ADMIN_USERS поддержан как
// запасной вариант, если задавали раньше.)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || process.env.ADMIN_USERS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isAdmin(user) {
  if (!user) return false;
  return ADMIN_EMAILS.includes(String(user.email || '').toLowerCase());
}

// ─────────────────────────── Middleware ───────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // для JSON-запросов нативного лаунчера (/api/launcher/*)
// Стор сессий: Postgres (если есть DATABASE_URL) иначе файлы — чтобы логины
// переживали рестарт и на бесплатном хостинге (эфемерная ФС) не терялись.
let sessionStore;
if (process.env.DATABASE_URL) {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = new PgSession({
    conObject: { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } },
    createTableIfMissing: true
  });
} else {
  const FileStore = require('session-file-store')(session);
  sessionStore = new FileStore({
    path: path.join(__dirname, 'data', 'sessions'), retries: 1, ttl: 60 * 60 * 24 * 30, logFn: () => {}
  });
}
app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD && SITE_URL.startsWith('https')
  }
}));

// язык: ?lang= → cookie/session, иначе сохранённый, иначе дефолт
app.use(async (req, res, next) => {
  try {
    if (req.query.lang && LANGS.includes(req.query.lang)) {
      req.session.lang = req.query.lang;
    }
    const lang = (req.session && req.session.lang && LANGS.includes(req.session.lang))
      ? req.session.lang : DEFAULT_LANG;

    res.locals.lang = lang;
    res.locals.build = BUILD;
    res.locals.frozen = FROZEN;
    res.locals.contacts = CONTACTS;
    res.locals.siteUrl = SITE_URL;
    res.locals.langs = LANGS.map(code => ({ code, name: locales[code].lang_name }));
    res.locals.t = (k) => t(lang, k);
    res.locals.plans = PLANS;
    res.locals.user = req.session.userId ? await db.findById(req.session.userId) : null;
    res.locals.isAdmin = isAdmin(res.locals.user);
    res.locals.discPct = discountPercent(res.locals.user);
    res.locals.priceView = (p) => applyDiscount(p, res.locals.user);

    // флеш-сообщения (одноразовые)
    res.locals.flash = req.session.flash || null;
    delete (req.session || {}).flash;

    // текущий путь без query (для подсветки и сохранения языка в ссылках)
    res.locals.currentPath = req.path;
    next();
  } catch (e) { next(e); }
});

function flash(req, type, key) { req.session.flash = { type, key }; }
// ошибка, видимая на ТОМ ЖЕ рендере (middleware-флеш читается раньше роутов)
function rerr(res, key) { res.locals.flash = { type: 'error', key }; }
function requireAuth(req, res, next) {
  if (!req.session.userId) { flash(req, 'error', 'flash.err_login_required'); return res.redirect('/login'); }
  next();
}
async function requireAdmin(req, res, next) {
  try {
    const user = req.session.userId ? await db.findById(req.session.userId) : null;
    if (!isAdmin(user)) return res.status(404).render('404', { page: '404' });
    req.adminUser = user;
    next();
  } catch (e) { next(e); }
}
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

// ─────────── Хелперы аккаунта (для лаунчера и админки) ───────────
const BAN_FOREVER_YEAR = 9999;
// UID: из БД или стабильно выводим из id (как на странице аккаунта)
function accountUid(user) {
  if (user && user.uid) return user.uid;
  let uid = 0; const s = String(user && user.id || '');
  for (let i = 0; i < s.length; i++) uid = (uid * 31 + s.charCodeAt(i)) % 90000;
  return uid + 10000;
}
function isBanned(user) {
  return !!(user && user.bannedUntil && new Date(user.bannedUntil) > new Date());
}
function banMessage(user) {
  const until = new Date(user.bannedUntil);
  if (until.getFullYear() >= BAN_FOREVER_YEAR) return 'Аккаунт заблокирован навсегда.';
  return 'Аккаунт заблокирован до ' + until.toISOString().slice(0, 10) + '.';
}
// активная подписка (админ — всегда; иначе forever или subUntil в будущем)
function subActive(user) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.subForever) return true;
  if (user.subUntil) return new Date(user.subUntil) > effectiveNow();
  return false;
}

// ─────────────────────────── Маршруты ───────────────────────────
app.get('/', (req, res) => res.render('index', { page: 'home' }));
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, service: 'zephyr-client' }));

// ───────────────────── Лаунчер ─────────────────────
// Страница, которую грузит нативный webview-шелл. Отдельный статик-файл,
// не EJS: он самодостаточный и общается с нативом через WebView2-мост.
app.get('/launcher', (req, res) => res.sendFile(path.join(__dirname, 'views', 'launcher.html')));

// Логин из лаунчера теми же кредами, что на сайте. Привязывает HWID к аккаунту.
app.post('/api/launcher/auth', async (req, res) => {
  try {
    const { login, password, hwid } = req.body || {};
    if (!login || !password || !hwid) return res.status(400).json({ ok: false, message: 'Не хватает полей.' });

    const id = String(login).trim();
    let user = await db.findByEmail(id);
    if (!user) user = await db.findByUsername(id);
    if (!user || !bcrypt.compareSync(String(password), user.passwordHash)) {
      return res.status(401).json({ ok: false, message: 'Неверный логин или пароль.' });
    }
    if (isBanned(user)) return res.status(403).json({ ok: false, message: banMessage(user) });
    if (user.frozen) return res.status(403).json({ ok: false, message: 'Подписка заморожена. Разморозь в кабинете.' });
    if (!subActive(user)) return res.status(403).json({ ok: false, message: 'Нет активной подписки.' });

    // HWID-замок: первый вход привязывает, дальше обязан совпасть.
    if (!user.hwid) {
      await db.updateUser(user.id, { hwid: String(hwid) });
      user.hwid = String(hwid);
    } else if (user.hwid !== String(hwid)) {
      return res.status(403).json({ ok: false, message: 'Другой компьютер (HWID не совпал). Сбрось HWID в кабинете.' });
    }

    const token = await db.createLauncherSession({ userId: user.id, hwid: user.hwid });
    res.json({ ok: true, token, uid: accountUid(user), username: user.username });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, message: 'Ошибка сервера.' }); }
});

// Лаунчер сообщает о запуске: пишем статистику (UID+ник+HWID+время, БЕЗ IP) + Telegram.
app.post('/api/launcher/launch', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ ok: false });
    const sess = await db.findLauncherSession(auth.slice(7));
    if (!sess) return res.status(401).json({ ok: false });
    const user = await db.findById(sess.userId);
    if (!user) return res.status(401).json({ ok: false });
    if (isBanned(user)) return res.status(403).json({ ok: false, message: banMessage(user) });
    if (user.frozen) return res.status(403).json({ ok: false, message: 'Подписка заморожена.' });

    const uid = accountUid(user);
    await db.recordLaunch({ userId: user.id, uid, hwid: sess.hwid });
    notifyTelegram(
      '\u{1F7E3} <b>Zephyr запущен</b>\n' +
      'Аккаунт: <b>' + esc(user.username) + '</b> (UID ' + uid + ')\n' +
      'HWID: <code>' + esc(sess.hwid || '—') + '</code>\n' +
      'Время (МСК): ' + new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour12: false })
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
});

// ── Telegram-бот (webhook): только админ создаёт промокоды ──
app.get('/api/tg/webhook', (req, res) => res.json({ ok: true })); // проверка живости
app.post('/api/tg/webhook', async (req, res) => {
  if (TG_WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== TG_WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200); // Telegram ждёт быстрый 200
  try {
    const msg = req.body && req.body.message;
    if (!msg || !msg.text || !msg.chat) return;
    const chatId = String(msg.chat.id);
    if (!TG_ADMIN_ID || chatId !== TG_ADMIN_ID) return; // чужим бот не отвечает
    await handlePromoWizard(chatId, msg.text);
  } catch (e) { console.error('tg webhook', e); }
});

// ── Промокоды ──
// Отдельная страница убрана: скидочные активируются на «Купить», ключи (на дни) — в
// профиле. /promo оставлен редиректом на /buy для старых ссылок.
app.get('/promo', (req, res) => res.redirect('/buy'));

// Применить СКИДОЧНЫЙ промокод к текущей покупке (живёт в сессии до оплаты).
app.post('/buy/promo', requireAuth, async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim();
    const user = await db.findById(req.session.userId);
    const p = code ? await db.getPromo(code) : null;
    if (!p || p.kind !== 'discount') { flash(req, 'error', 'promo.err_notfound'); return res.redirect('/buy'); }
    if (p.target && p.target.toLowerCase() !== String(user.username).toLowerCase()) { flash(req, 'error', 'promo.err_target'); return res.redirect('/buy'); }
    if (p.maxUses > 0 && p.uses >= p.maxUses) { flash(req, 'error', 'promo.err_used_up'); return res.redirect('/buy'); }
    if (await db.hasRedeemed(p.code, user.id)) { flash(req, 'error', 'promo.err_already'); return res.redirect('/buy'); }
    req.session.buyPromo = { code: p.code, percent: p.percent };
    flash(req, 'success', 'promo.applied');
    res.redirect('/buy');
  } catch (e) { next(e); }
});
app.post('/buy/promo/remove', requireAuth, (req, res) => {
  req.session.buyPromo = null;
  res.redirect('/buy');
});

// Активировать КЛЮЧ (промик на дни) в профиле.
app.post('/account/key', requireAuth, async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim();
    const user = await db.findById(req.session.userId);
    const p = code ? await db.getPromo(code) : null;
    if (!p || p.kind !== 'days') { flash(req, 'error', 'promo.err_notfound'); return res.redirect('/account'); }
    if (p.target && p.target.toLowerCase() !== String(user.username).toLowerCase()) { flash(req, 'error', 'promo.err_target'); return res.redirect('/account'); }
    if (p.maxUses > 0 && p.uses >= p.maxUses) { flash(req, 'error', 'promo.err_used_up'); return res.redirect('/account'); }
    if (await db.hasRedeemed(p.code, user.id)) { flash(req, 'error', 'promo.err_already'); return res.redirect('/account'); }
    await applySub(user.id, 'key_' + p.code, p.forever ? null : p.days);
    await db.addRedemption(p.code, user.id);
    await db.incPromoUses(p.code);
    flash(req, 'success', 'promo.ok');
    res.redirect('/account');
  } catch (e) { next(e); }
});

app.get('/buy', async (req, res, next) => {
  try {
    const planId = PLANS[req.query.plan] ? req.query.plan : 'lifetime';
    // использовал ли пользователь пробный период
    let trialUsed = false;
    if (req.session.userId) {
      const orders = await db.getOrdersByUser(req.session.userId);
      trialUsed = orders.some(o => String(o.plan).startsWith('trial'));
    }
    const bp = req.session.buyPromo || null;
    const autoPct = res.locals.discPct || 0;
    const planPct = bp ? Math.max(autoPct, bp.percent) : autoPct; // скидка на тарифы с учётом промика
    res.render('buy', { page: 'buy', plan: PLANS[planId], trialPrices: TRIAL_PRICES, trialUsed,
      freezePrice: FREEZE_PRICE, hwidPrice: HWID_RESET_PRICE, appliedPromo: bp, planPct });
  } catch (e) { next(e); }
});

app.post('/buy', requireAuth, async (req, res, next) => {
  try {
    if (FROZEN) { flash(req, 'error', 'buy.frozen_flash'); return res.redirect('/buy'); }
    // бета теперь отдельный продукт (lifetime_beta), выбирается как обычный тариф
    const plan = PLANS[req.body.plan] || PLANS.lifetime;
    const user = await db.findById(req.session.userId);
    // скидка = авто (10/13%) или промик, что больше; промик валидируем заново и гасим
    let eff = discountPercent(user);
    let promoUsed = null;
    const bp = req.session.buyPromo;
    if (bp) {
      const p = await db.getPromo(bp.code);
      const okTarget = !p || !p.target || p.target.toLowerCase() === String(user.username).toLowerCase();
      const okUses = p && !(p.maxUses > 0 && p.uses >= p.maxUses);
      if (p && p.kind === 'discount' && okTarget && okUses && !(await db.hasRedeemed(p.code, user.id))) {
        eff = Math.max(eff, p.percent);
        promoUsed = p.code;
      }
    }
    const price = Math.round(plan.price * (100 - eff) / 100);
    await db.createOrder({ userId: user.id, plan: plan.id, price, currency: plan.currency });
    await applySub(user.id, plan.id, planDays(plan.id));
    await grantGifts(user.id, plan.id); // подарки: заморозки / сбросы HWID
    if (promoUsed) { await db.addRedemption(promoUsed, user.id); await db.incPromoUses(promoUsed); }
    req.session.buyPromo = null;
    flash(req, 'success', 'buy.order_created');
    res.redirect('/account');
  } catch (e) { next(e); }
});

// Пробный период — один раз на аккаунт
app.post('/buy/trial', requireAuth, async (req, res, next) => {
  try {
    if (FROZEN) { flash(req, 'error', 'buy.frozen_flash'); return res.redirect('/buy'); }
    const orders = await db.getOrdersByUser(req.session.userId);
    if (orders.some(o => String(o.plan).startsWith('trial'))) {
      flash(req, 'error', 'buy.trial_used');
      return res.redirect('/buy');
    }
    const days = Math.max(1, Math.min(7, parseInt(req.body.days, 10) || 1));
    const tprice = applyDiscount(trialPrice(days), await db.findById(req.session.userId)).final;
    await db.createOrder({ userId: req.session.userId, plan: 'trial_' + days + 'd', price: tprice, currency: 'RUB' });
    await applySub(req.session.userId, 'trial_' + days + 'd', days);
    flash(req, 'success', 'buy.order_created');
    res.redirect('/account');
  } catch (e) { next(e); }
});

// покупка расходника: заморозка или сброс HWID (с учётом скидки)
app.post('/buy/item', requireAuth, async (req, res, next) => {
  try {
    if (FROZEN) { flash(req, 'error', 'buy.frozen_flash'); return res.redirect('/buy'); }
    const item = req.body.item;
    if (item !== 'freeze' && item !== 'hwid') return res.redirect('/buy');
    const u = await db.findById(req.session.userId);
    const base = item === 'freeze' ? FREEZE_PRICE : HWID_RESET_PRICE;
    const price = applyDiscount(base, u).final;
    const patch = item === 'freeze'
      ? { freezes: (u.freezes || 0) + 1 }
      : { hwidResets: (u.hwidResets || 0) + 1 };
    await db.createOrder({ userId: u.id, plan: item === 'freeze' ? 'item_freeze' : 'item_hwid', price, currency: 'RUB' });
    await db.updateUser(u.id, patch);
    flash(req, 'success', 'buy.item_bought');
    res.redirect('/account');
  } catch (e) { next(e); }
});

app.get('/support', (req, res) => res.render('support', { page: 'support', sent: false }));
app.post('/support', (req, res) => res.render('support', { page: 'support', sent: true }));

// Документы — контент грузится из docs/<lang>/<doc>.html (фолбэк на ru)
function loadDoc(lang, doc) {
  const tryLangs = [lang, 'ru'];
  for (const l of tryLangs) {
    const f = path.join(__dirname, 'docs', l, `${doc}.html`);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return '<p>—</p>';
}
function renderDoc(doc) {
  return (req, res) => res.render('docs/page', { page: 'docs', doc, body: loadDoc(res.locals.lang, doc) });
}
app.get('/docs', (req, res) => res.redirect('/docs/terms'));
app.get('/docs/terms', renderDoc('terms'));
app.get('/docs/privacy', renderDoc('privacy'));
app.get('/docs/refund', renderDoc('refund'));

// ── Авторизация ──
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/account');
  res.render('register', { page: 'register', form: {} });
});
app.post('/register', async (req, res, next) => {
  try {
    const { username, email, password, password2 } = req.body;
    const form = { username, email };
    if (!username || !email || !password) { rerr(res, 'flash.err_fields'); return res.render('register', { page: 'register', form }); }
    if (!isEmail(email)) { rerr(res, 'flash.err_email'); return res.render('register', { page: 'register', form }); }
    if (password.length < 6) { rerr(res, 'flash.err_pass_short'); return res.render('register', { page: 'register', form }); }
    if (password !== password2) { rerr(res, 'flash.err_pass_match'); return res.render('register', { page: 'register', form }); }
    if (await db.findByEmail(email)) { rerr(res, 'flash.err_email_taken'); return res.render('register', { page: 'register', form }); }
    if (await db.findByUsername(username)) { rerr(res, 'flash.err_user_taken'); return res.render('register', { page: 'register', form }); }

    const passwordHash = bcrypt.hashSync(password, 10);
    const user = await db.createUser({ username, email, passwordHash });
    req.session.userId = user.id;
    flash(req, 'success', 'flash.registered');
    res.redirect('/account');
  } catch (e) { next(e); }
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/account');
  res.render('login', { page: 'login', form: {} });
});
app.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const form = { email };
    if (!email || !password) { rerr(res, 'flash.err_fields'); return res.render('login', { page: 'login', form }); }
    // вход по email ИЛИ по имени пользователя
    const id = String(email).trim();
    let user = await db.findByEmail(id);
    if (!user) user = await db.findByUsername(id);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      rerr(res, 'flash.err_creds');
      return res.render('login', { page: 'login', form });
    }
    req.session.userId = user.id;
    flash(req, 'success', 'flash.logged_in');
    res.redirect('/account');
  } catch (e) { next(e); }
});

app.post('/logout', (req, res) => {
  req.session.userId = null;
  flash(req, 'success', 'flash.logged_out');
  res.redirect('/');
});

function subView(user, admin) {
  if (admin) return { active: true, forever: true, plan: 'lifetime' };
  if (user.frozen) return { active: false, forever: false, paused: true, plan: user.subPlan, daysLeft: user.frozenDays || 0 };
  if (user.subForever) return { active: true, forever: true, plan: user.subPlan || 'lifetime' };
  if (user.subUntil) {
    const until = new Date(user.subUntil), now = effectiveNow();
    return {
      active: until > now, forever: false, plan: user.subPlan,
      until: user.subUntil, daysLeft: Math.max(0, Math.ceil((until - now) / 86400000)),
      frozen: FROZEN
    };
  }
  return null;
}

app.get('/account', requireAuth, async (req, res, next) => {
  try {
    const user = await db.findById(req.session.userId);
    if (!user) { req.session.userId = null; return res.redirect('/login'); }
    const orders = await db.getOrdersByUser(user.id);
    const admin = isAdmin(user);
    res.render('account', { page: 'account', account: user, orders, admin, sub: subView(user, admin) });
  } catch (e) { next(e); }
});

// смена пароля
app.post('/account/password', requireAuth, async (req, res, next) => {
  try {
    const user = await db.findById(req.session.userId);
    const { current, password, password2 } = req.body;
    if (!current || !password || !bcrypt.compareSync(current, user.passwordHash)) { flash(req, 'error', 'flash.err_creds'); return res.redirect('/account'); }
    if (password.length < 6) { flash(req, 'error', 'flash.err_pass_short'); return res.redirect('/account'); }
    if (password !== password2) { flash(req, 'error', 'flash.err_pass_match'); return res.redirect('/account'); }
    await db.updateUser(user.id, { passwordHash: bcrypt.hashSync(password, 10) });
    flash(req, 'success', 'account.pass_changed');
    res.redirect('/account');
  } catch (e) { next(e); }
});

// смена аватара (хранится на сервере в БД, видна везде где показывается юзер)
app.post('/account/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file || !req.file.mimetype || !req.file.mimetype.startsWith('image/')) {
      flash(req, 'error', 'account.avatar_err'); return res.redirect('/account');
    }
    const img = await Jimp.read(req.file.buffer);
    img.cover(160, 160).quality(74);
    const dataUrl = await img.getBase64Async(Jimp.MIME_JPEG);
    await db.updateUser(req.session.userId, { avatar: dataUrl });
    flash(req, 'success', 'account.avatar_ok');
  } catch (e) {
    flash(req, 'error', 'account.avatar_err');
  }
  res.redirect('/account');
});

// сброс HWID — тратит расходник (куплен за 149 или подарок с тарифа)
app.post('/account/hwid/reset', requireAuth, async (req, res, next) => {
  try {
    const u = await db.findById(req.session.userId);
    if (!u.hwid) { flash(req, 'error', 'account.hwid_none_flash'); return res.redirect('/account'); }
    if ((u.hwidResets || 0) < 1) { flash(req, 'error', 'account.no_hwid_reset'); return res.redirect('/account'); }
    await db.updateUser(u.id, { hwid: null, hwidResets: u.hwidResets - 1 });
    flash(req, 'success', 'account.hwid_reset');
    res.redirect('/account');
  } catch (e) { next(e); }
});

// заморозить подписку — тратит расходник; счёт дней встаёт, играть нельзя
app.post('/account/freeze', requireAuth, async (req, res, next) => {
  try {
    const u = await db.findById(req.session.userId);
    if (u.frozen) { flash(req, 'error', 'account.already_frozen'); return res.redirect('/account'); }
    if (isAdmin(u) || u.subForever) { flash(req, 'error', 'account.freeze_na'); return res.redirect('/account'); }
    if (!u.subUntil || new Date(u.subUntil) <= effectiveNow()) { flash(req, 'error', 'account.freeze_no_sub'); return res.redirect('/account'); }
    if ((u.freezes || 0) < 1) { flash(req, 'error', 'account.no_freeze'); return res.redirect('/account'); }
    const days = Math.max(0, Math.ceil((new Date(u.subUntil) - effectiveNow()) / 86400000));
    await db.updateUser(u.id, { frozen: true, frozenDays: days, freezes: u.freezes - 1 });
    flash(req, 'success', 'account.frozen_ok');
    res.redirect('/account');
  } catch (e) { next(e); }
});

// разморозить — бесплатно; оставшиеся дни отсчитываются заново от текущего момента
app.post('/account/unfreeze', requireAuth, async (req, res, next) => {
  try {
    const u = await db.findById(req.session.userId);
    if (!u.frozen) return res.redirect('/account');
    const until = new Date(effectiveNow().getTime() + (u.frozenDays || 0) * 86400000);
    await db.updateUser(u.id, { frozen: false, frozenDays: 0, subUntil: until.toISOString(), subForever: false });
    flash(req, 'success', 'account.unfrozen_ok');
    res.redirect('/account');
  } catch (e) { next(e); }
});

// заглушки (функции в разработке)
app.post('/account/soon', requireAuth, (req, res) => {
  flash(req, 'error', 'account.soon');
  res.redirect('/account');
});

// ───────────────────────── Админ-панель ─────────────────────────
app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const users = await db.getAllUsers();
    const orders = await db.getAllOrders();
    const paid = orders.filter(o => o.status === 'paid');
    const revenue = paid.reduce((s, o) => s + Number(o.price || 0), 0);
    const mem = safeMemoryUsage();
    const stats = {
      users: users.length,
      orders: orders.length,
      paid: paid.length,
      pending: orders.length - paid.length,
      revenue,
      admins: users.filter(isAdmin).length,
      uptimeSec: Math.floor(process.uptime()),
      rssMb: (mem.rss / 1048576).toFixed(1),
      heapMb: (mem.heapUsed / 1048576).toFixed(1),
      node: process.version,
      backend: db.backend,
      now: new Date().toISOString()
    };
    const launches = await db.getLaunches(50);
    res.render('admin', {
      page: 'admin',
      stats,
      users: users.slice(0, 50),
      orders: orders.slice(0, 50),
      launches,
      isAdminFn: isAdmin,
      isBannedFn: isBanned,
      uidFn: accountUid
    });
  } catch (e) { next(e); }
});

// выдать подписку по дням (404 = навсегда)
app.post('/admin/grant', requireAdmin, async (req, res, next) => {
  try {
    const { userId } = req.body;
    const rawDays = parseInt(req.body.days, 10);
    const forever = rawDays === 404 || req.body.days === 'forever';
    const days = forever ? null : Math.max(1, rawDays || 30);
    const label = forever ? 'lifetime' : ('grant_' + days + 'd');
    const order = await db.createOrder({ userId, plan: label, price: 0, currency: 'RUB' });
    await db.setOrderStatus(order.id, 'paid');
    await applySub(userId, label, days);
    res.redirect('/admin');
  } catch (e) { next(e); }
});

// заказ: оплачен / в ожидании / удалить
app.post('/admin/order/:id/:status', requireAdmin, async (req, res, next) => {
  try {
    if (req.params.status === 'delete') { await db.deleteOrder(req.params.id); }
    else { await db.setOrderStatus(req.params.id, req.params.status === 'paid' ? 'paid' : 'pending'); }
    res.redirect('/admin');
  } catch (e) { next(e); }
});

// удалить (сбросить) подписку пользователя
app.post('/admin/sub/:userId/delete', requireAdmin, async (req, res, next) => {
  try {
    await db.updateUser(req.params.userId, { plan: null, subPlan: null, subUntil: null, subForever: false });
    res.redirect('/admin');
  } catch (e) { next(e); }
});

// заблокировать юзера на N дней (404 = навсегда)
app.post('/admin/ban/:userId', requireAdmin, async (req, res, next) => {
  try {
    const rawDays = parseInt(req.body.days, 10);
    const forever = rawDays === 404 || req.body.days === 'forever';
    const until = forever
      ? new Date(Date.UTC(BAN_FOREVER_YEAR, 0, 1))
      : new Date(Date.now() + Math.max(1, rawDays || 1) * 86400000);
    await db.updateUser(req.params.userId, { bannedUntil: until.toISOString() });
    res.redirect('/admin');
  } catch (e) { next(e); }
});

// снять блокировку
app.post('/admin/unban/:userId', requireAdmin, async (req, res, next) => {
  try {
    await db.updateUser(req.params.userId, { bannedUntil: null });
    res.redirect('/admin');
  } catch (e) { next(e); }
});

// сбросить HWID юзеру (переезд на новый ПК)
app.post('/admin/hwid/:userId/reset', requireAdmin, async (req, res, next) => {
  try {
    await db.updateUser(req.params.userId, { hwid: null });
    res.redirect('/admin');
  } catch (e) { next(e); }
});

// заморозить/разморозить подписку юзера (админ, без расходника)
app.post('/admin/freeze/:userId', requireAdmin, async (req, res, next) => {
  try {
    const u = await db.findById(req.params.userId);
    if (!u || u.frozen) return res.redirect('/admin');
    const days = (!u.subForever && u.subUntil)
      ? Math.max(0, Math.ceil((new Date(u.subUntil) - effectiveNow()) / 86400000)) : 0;
    await db.updateUser(u.id, { frozen: true, frozenDays: days });
    res.redirect('/admin');
  } catch (e) { next(e); }
});
app.post('/admin/unfreeze/:userId', requireAdmin, async (req, res, next) => {
  try {
    const u = await db.findById(req.params.userId);
    if (!u || !u.frozen) return res.redirect('/admin');
    const patch = { frozen: false, frozenDays: 0 };
    if (!u.subForever && u.frozenDays)
      patch.subUntil = new Date(effectiveNow().getTime() + u.frozenDays * 86400000).toISOString();
    await db.updateUser(u.id, patch);
    res.redirect('/admin');
  } catch (e) { next(e); }
});

// JSON для живого мониторинга (автообновление на странице)
app.get('/admin/stats.json', requireAdmin, async (req, res, next) => {
  try {
    const users = await db.getAllUsers();
    const orders = await db.getAllOrders();
    const paid = orders.filter(o => o.status === 'paid');
    const mem = safeMemoryUsage();
    res.json({
      users: users.length, orders: orders.length, paid: paid.length,
      pending: orders.length - paid.length,
      revenue: paid.reduce((s, o) => s + Number(o.price || 0), 0),
      uptimeSec: Math.floor(process.uptime()),
      rssMb: +(mem.rss / 1048576).toFixed(1),
      heapMb: +(mem.heapUsed / 1048576).toFixed(1),
      now: new Date().toISOString()
    });
  } catch (e) { next(e); }
});

// 404
app.use((req, res) => res.status(404).render('404', { page: '404' }));

// обработчик ошибок
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('404', { page: '404' });
});

db.init().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`\n  Zephyr site listening on ${HOST}:${PORT}`);
    console.log(`  Public: ${SITE_URL}\n`);
  });
}).catch((e) => {
  console.error('DB init failed:', e);
  process.exit(1);
});
