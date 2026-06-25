/**
 * Двухрежимное хранилище (async):
 *  • если задан DATABASE_URL  → Postgres (постоянно, для прод/бесплатного Render).
 *  • иначе                    → JSON-файлы в data/ (для локальной разработки).
 * Интерфейс одинаковый и асинхронный в обоих случаях.
 */
const fs = require('fs');
const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─────────────────────────── Postgres backend ───────────────────────────
let pg = null;
async function initPg() {
  const { Pool } = require('pg');
  pg = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Neon/Render требуют SSL
  });
  await pg.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      plan          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      plan       TEXT NOT NULL,
      price      NUMERIC NOT NULL,
      currency   TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // новые поля (для уже существующих таблиц)
  await pg.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS uid       INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS hwid      TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_plan  TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_forever BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
  `);
}
function rowUser(r) {
  if (!r) return null;
  return {
    id: r.id, username: r.username, email: r.email, passwordHash: r.password_hash,
    plan: r.plan, uid: r.uid, hwid: r.hwid, avatar: r.avatar,
    subPlan: r.sub_plan,
    subUntil: r.sub_until instanceof Date ? r.sub_until.toISOString() : r.sub_until,
    subForever: !!r.sub_forever,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
  };
}
const USER_COLS = { plan: 'plan', hwid: 'hwid', uid: 'uid', passwordHash: 'password_hash',
  subPlan: 'sub_plan', subUntil: 'sub_until', subForever: 'sub_forever', avatar: 'avatar' };
function rowOrder(r) {
  return r && {
    id: r.id, userId: r.user_id, plan: r.plan, price: Number(r.price), currency: r.currency,
    status: r.status, createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
  };
}

const pgApi = {
  async findByEmail(email) {
    const { rows } = await pg.query('SELECT * FROM users WHERE email=$1', [String(email || '').toLowerCase().trim()]);
    return rowUser(rows[0]) || null;
  },
  async findById(id) {
    const { rows } = await pg.query('SELECT * FROM users WHERE id=$1', [id]);
    return rowUser(rows[0]) || null;
  },
  async findByUsername(username) {
    const { rows } = await pg.query('SELECT * FROM users WHERE LOWER(username)=$1', [String(username || '').toLowerCase().trim()]);
    return rowUser(rows[0]) || null;
  },
  async createUser({ username, email, passwordHash }) {
    const id = newId('u');
    const uid = 10000 + Math.floor(Math.random() * 89999);
    const { rows } = await pg.query(
      'INSERT INTO users (id, username, email, password_hash, uid) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [id, username.trim(), email.toLowerCase().trim(), passwordHash, uid]
    );
    return rowUser(rows[0]);
  },
  async updateUser(id, patch) {
    const sets = [], vals = []; let i = 1;
    for (const k in patch) {
      if (USER_COLS[k]) { sets.push(`${USER_COLS[k]}=$${i++}`); vals.push(patch[k]); }
    }
    if (!sets.length) return this.findById(id);
    vals.push(id);
    const { rows } = await pg.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    return rowUser(rows[0]);
  },
  async createOrder({ userId, plan, price, currency }) {
    const id = newId('o');
    const { rows } = await pg.query(
      'INSERT INTO orders (id, user_id, plan, price, currency) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [id, userId, plan, price, currency]
    );
    return rowOrder(rows[0]);
  },
  async getOrdersByUser(userId) {
    const { rows } = await pg.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
    return rows.map(rowOrder);
  },
  async getAllUsers() {
    const { rows } = await pg.query('SELECT * FROM users ORDER BY created_at DESC');
    return rows.map(rowUser);
  },
  async getAllOrders() {
    const { rows } = await pg.query('SELECT * FROM orders ORDER BY created_at DESC');
    return rows.map(rowOrder);
  },
  async setOrderStatus(orderId, status) {
    await pg.query('UPDATE orders SET status=$1 WHERE id=$2', [status, orderId]);
  }
};

// ─────────────────────────── JSON-file backend ───────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
}
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8') || '[]'); } catch { return []; } }
function writeJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

const fileApi = {
  async findByEmail(email) {
    email = String(email || '').toLowerCase().trim();
    return readJSON(USERS_FILE).find(u => u.email === email) || null;
  },
  async findById(id) { return readJSON(USERS_FILE).find(u => u.id === id) || null; },
  async findByUsername(username) {
    username = String(username || '').toLowerCase().trim();
    return readJSON(USERS_FILE).find(u => u.username.toLowerCase() === username) || null;
  },
  async createUser({ username, email, passwordHash }) {
    const users = readJSON(USERS_FILE);
    const user = {
      id: newId('u'), username: username.trim(), email: email.toLowerCase().trim(),
      passwordHash, plan: null, uid: 10000 + Math.floor(Math.random() * 89999),
      hwid: null, avatar: null, subPlan: null, subUntil: null, subForever: false,
      createdAt: new Date().toISOString()
    };
    users.push(user); writeJSON(USERS_FILE, users);
    return user;
  },
  async updateUser(id, patch) {
    const users = readJSON(USERS_FILE);
    const i = users.findIndex(u => u.id === id);
    if (i === -1) return null;
    users[i] = { ...users[i], ...patch }; writeJSON(USERS_FILE, users);
    return users[i];
  },
  async createOrder({ userId, plan, price, currency }) {
    const orders = readJSON(ORDERS_FILE);
    const order = { id: newId('o'), userId, plan, price, currency, status: 'pending', createdAt: new Date().toISOString() };
    orders.push(order); writeJSON(ORDERS_FILE, orders);
    return order;
  },
  async getOrdersByUser(userId) {
    return readJSON(ORDERS_FILE).filter(o => o.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async getAllUsers() {
    return readJSON(USERS_FILE).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async getAllOrders() {
    return readJSON(ORDERS_FILE).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async setOrderStatus(orderId, status) {
    const orders = readJSON(ORDERS_FILE);
    const i = orders.findIndex(o => o.id === orderId);
    if (i !== -1) { orders[i].status = status; writeJSON(ORDERS_FILE, orders); }
  }
};

// ─────────────────────────── init ───────────────────────────
async function init() {
  if (USE_PG) { await initPg(); console.log('  DB: Postgres (DATABASE_URL)'); }
  else { ensureFiles(); console.log('  DB: JSON files (data/)'); }
}

module.exports = { init, backend: USE_PG ? 'pg' : 'file', ...(USE_PG ? pgApi : fileApi) };
