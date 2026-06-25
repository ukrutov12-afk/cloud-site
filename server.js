/**
 * Cloud Client — сайт покупки.
 * Express + EJS + сессии + bcrypt. i18n: be / ru / uk / en.
 * Запуск:  npm install  &&  npm start   →  http://localhost:3000
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SITE_URL = process.env.SITE_URL || 'http://cloudlegit.work.gd';
const IS_PROD = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1); // за nginx/Caddy — корректные secure-cookie и протокол

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
  month:         { id: 'month',         price: 129, currency: 'RUB', months: 1 },
  season:        { id: 'season',        price: 349, currency: 'RUB', months: 3, popular: true },
  lifetime:      { id: 'lifetime',      price: 799, currency: 'RUB', months: 0 },
  lifetime_beta: { id: 'lifetime_beta', price: 999, currency: 'RUB', months: 0, beta: true }
};
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
    const now = new Date();
    const base = (user.subUntil && !user.subForever && new Date(user.subUntil) > now) ? new Date(user.subUntil) : now;
    const until = new Date(base.getTime() + days * 86400000);
    await db.updateUser(userId, { plan: planLabel, subPlan: planLabel, subForever: false, subUntil: until.toISOString() });
  }
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
  secret: process.env.SESSION_SECRET || 'cloud-client-secret-change-me',
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
    res.locals.siteUrl = SITE_URL;
    res.locals.langs = LANGS.map(code => ({ code, name: locales[code].lang_name }));
    res.locals.t = (k) => t(lang, k);
    res.locals.plans = PLANS;
    res.locals.user = req.session.userId ? await db.findById(req.session.userId) : null;
    res.locals.isAdmin = isAdmin(res.locals.user);

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

// ─────────────────────────── Маршруты ───────────────────────────
app.get('/', (req, res) => res.render('index', { page: 'home' }));

app.get('/buy', async (req, res, next) => {
  try {
    const planId = PLANS[req.query.plan] ? req.query.plan : 'lifetime';
    // использовал ли пользователь пробный период
    let trialUsed = false;
    if (req.session.userId) {
      const orders = await db.getOrdersByUser(req.session.userId);
      trialUsed = orders.some(o => String(o.plan).startsWith('trial'));
    }
    res.render('buy', { page: 'buy', plan: PLANS[planId], trialPrices: TRIAL_PRICES, trialUsed });
  } catch (e) { next(e); }
});

app.post('/buy', requireAuth, async (req, res, next) => {
  try {
    let plan = PLANS[req.body.plan] || PLANS.lifetime;
    // чекбокс беты применим только к «навсегда»
    if (plan.id === 'lifetime' && (req.body.beta === 'on' || req.body.beta === '1')) {
      plan = PLANS.lifetime_beta;
    }
    await db.createOrder({ userId: req.session.userId, plan: plan.id, price: plan.price, currency: plan.currency });
    await applySub(req.session.userId, plan.id, planDays(plan.id));
    flash(req, 'success', 'buy.order_created');
    res.redirect('/account');
  } catch (e) { next(e); }
});

// Пробный период — один раз на аккаунт
app.post('/buy/trial', requireAuth, async (req, res, next) => {
  try {
    const orders = await db.getOrdersByUser(req.session.userId);
    if (orders.some(o => String(o.plan).startsWith('trial'))) {
      flash(req, 'error', 'buy.trial_used');
      return res.redirect('/buy');
    }
    const days = Math.max(1, Math.min(7, parseInt(req.body.days, 10) || 1));
    await db.createOrder({ userId: req.session.userId, plan: 'trial_' + days + 'd', price: trialPrice(days), currency: 'RUB' });
    await applySub(req.session.userId, 'trial_' + days + 'd', days);
    flash(req, 'success', 'buy.order_created');
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
    const user = await db.findByEmail(email);
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
  if (user.subForever) return { active: true, forever: true, plan: user.subPlan || 'lifetime' };
  if (user.subUntil) {
    const until = new Date(user.subUntil), now = new Date();
    return {
      active: until > now, forever: false, plan: user.subPlan,
      until: user.subUntil, daysLeft: Math.max(0, Math.ceil((until - now) / 86400000))
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

// сброс HWID
app.post('/account/hwid/reset', requireAuth, async (req, res, next) => {
  try {
    await db.updateUser(req.session.userId, { hwid: null });
    flash(req, 'success', 'account.hwid_reset');
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
    const mem = process.memoryUsage();
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
    res.render('admin', {
      page: 'admin',
      stats,
      users: users.slice(0, 50),
      orders: orders.slice(0, 50),
      isAdminFn: isAdmin
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

// пометить заказ оплаченным / в ожидании
app.post('/admin/order/:id/:status', requireAdmin, async (req, res, next) => {
  try {
    const st = req.params.status === 'paid' ? 'paid' : 'pending';
    await db.setOrderStatus(req.params.id, st);
    res.redirect('/admin');
  } catch (e) { next(e); }
});

// JSON для живого мониторинга (автообновление на странице)
app.get('/admin/stats.json', requireAdmin, async (req, res, next) => {
  try {
    const users = await db.getAllUsers();
    const orders = await db.getAllOrders();
    const paid = orders.filter(o => o.status === 'paid');
    const mem = process.memoryUsage();
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
    console.log(`\n  Cloud site listening on ${HOST}:${PORT}`);
    console.log(`  Public: ${SITE_URL}\n`);
  });
}).catch((e) => {
  console.error('DB init failed:', e);
  process.exit(1);
});
