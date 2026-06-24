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

// ─────────────────────────── Тарифы ───────────────────────────
const PLANS = {
  month:    { id: 'month',    price: 6,  currency: 'EUR', months: 1 },
  season:   { id: 'season',   price: 14, currency: 'EUR', months: 3, popular: true },
  lifetime: { id: 'lifetime', price: 39, currency: 'EUR', months: 0 }
};

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
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

// ─────────────────────────── Маршруты ───────────────────────────
app.get('/', (req, res) => res.render('index', { page: 'home' }));

app.get('/buy', (req, res) => {
  const planId = PLANS[req.query.plan] ? req.query.plan : 'season';
  res.render('buy', { page: 'buy', plan: PLANS[planId] });
});

app.post('/buy', requireAuth, async (req, res, next) => {
  try {
    const plan = PLANS[req.body.plan] || PLANS.season;
    await db.createOrder({ userId: req.session.userId, plan: plan.id, price: plan.price, currency: plan.currency });
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

app.get('/account', requireAuth, async (req, res, next) => {
  try {
    const user = await db.findById(req.session.userId);
    if (!user) { req.session.userId = null; return res.redirect('/login'); }
    const orders = await db.getOrdersByUser(user.id);
    res.render('account', { page: 'account', account: user, orders });
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
