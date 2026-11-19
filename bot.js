/**
 * bot.js — Telegram USDT Seller Bot (Node.js, CommonJS)
 * Supabase (Postgres) storage + Render webhook hosting
 * Web3 Hot Wallet (Polygon & BEP20) + payment verification + Admin Panel + User Ban/Unban
 *
 * npm i telegraf ethers pg
 *
 * Env vars: BOT_TOKEN, DATABASE_URL, WALLET_PRIVATE_KEY, VERIFY_ET_API_KEY
 *           (Render provides PORT and RENDER_EXTERNAL_URL automatically; or set WEBHOOK_URL)
 * Without WEBHOOK_URL / RENDER_EXTERNAL_URL the bot falls back to long polling (local testing).
 */

const { Telegraf } = require('telegraf');
const { Contract, formatUnits, JsonRpcProvider, parseUnits, Wallet } = require('ethers');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Pool } = require('pg');

// ======================== WEB3 CHAINS & ABI ========================
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const CHAIN_CONFIG = {
  polygon: {
    chainId: 137,
    name: 'Polygon POS',
    nativeSymbol: 'POL',
    usdtAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    decimals: 6,
    rpcs: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://1rpc.io/matic',
      'https://polygon-rpc.com',
    ],
  },
  bep20: {
    chainId: 56,
    name: 'BNB Smart Chain (BEP20)',
    nativeSymbol: 'BNB',
    usdtAddress: '0x55d398326f99059fF775485246999027B3197955',
    decimals: 18,
    rpcs: [
      'https://bsc-dataseed.binance.org',
      'https://bsc-rpc.publicnode.com',
      'https://1rpc.io/bnb',
    ],
  },
};

// ======================== TELEGRAM PREMIUM EMOJIS ========================
const EMOJI_IDS = {
  hi: '5461130232025078672',
  rateChart: '5451882707875276247',
  available: '5332533929020761310',
  polygon: '5830130569144439663',
  bep20: '5829978819359937589',
  payFirst: '5282843764451195532',
  rateSheet: '5377336227533969892',
  tieredRate: '5197434882321567830',
  buyUsdt: '5402186569006210455',
  telebirr: '5796366529855494419',
  boa: '5796558527778527912',
  cbe: '5796436189930069862',
  awash: '5796252438344244434',
  dashen: '5796636442780244593',
  ebirr: '5796522802240559529',
  coop: '5796401744292354501',
  myOrders: '5875033614705495771',
  support: '6323538349139169899',
  help: '5818678700274617758',
  back: '5332819376842226496',
  cancel: '6275999280285094803',
  num1: '5794164805065514131',
  num2: '5794085322400733645',
  num3: '5794280000383358988',
  num4: '5794241397217304511',
  num5: '5793985348446984682',
  warning: '6276132901012640832',
  alert: '5395695537687123235',
  globe: '5334734562889047862',
  wallet: '5215420556089776398',
  receipt: '5444856076954520455',
  copy: '5258400839281681797',
  edit: '5197269100878907942',
  refresh: '5375338737028841420',
  next: '5416117059207572332',
  hourglass: '5325583469344989152',
  expired: '5386367538735104399',
  search: '5231012545799666522',
  sending: '5445355530111437729',
  blocked: '5922712343011135025',
  greenDot: '5416081784641168838',
  redDot: '5411225014148014586',
  whiteDot: '5255865365468030913',
  link: '5271604874419647061',
  attach: '5305265301917549162',
  settings: '5341715473882955310',
  adminTools: '5988023995125993550',
  broadcast: '5424818078833715060',
  chat: '5303138782004924588',
  moneyBag: '5417924076503062111',
  lock: '5296369303661067030',
};

const tgEmoji = (id, fallback) => `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
const backBtn = (callback_data = 'home', text = 'Back') => ({
  text,
  callback_data,
  icon_custom_emoji_id: EMOJI_IDS.back,
});
const cancelBtn = (callback_data = 'home', text = 'Cancel') => ({
  text,
  callback_data,
  icon_custom_emoji_id: EMOJI_IDS.cancel,
});

// ======================== DEFAULT CONFIG & PERSISTENT DB ========================
const DEFAULT_CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  ADMIN_IDS: [8453713398, 6198000263],
  SUPPORT_USERNAME: 'your_support',
  MAINTENANCE_MODE: false,
  AUTO_APPROVE: true,
  WALLET_PRIVATE_KEY:
    process.env.WALLET_PRIVATE_KEY || '',
  VERIFY_ET_API_KEY:
    process.env.VERIFY_ET_API_KEY || '',
  VERIFY_ET_ENABLED: true,
  VERIFY_ET_WAIT_MS: 5000,
  RATE: 192.5,
  SMALL_ORDER_RATE: 200,
  MIN_USDT: 0.01,
  MAX_USDT: 500,
  DAILY_LIMIT_USDT: 1000,
  PAYMENT_WINDOW_MIN: 30,
  VERIFY_ATTEMPTS: 3,
  HELP_TEXT:
    '<tg-emoji emoji-id="5818678700274617758">👮</tg-emoji> <b>How to Buy USDT</b>\n\n' +
    '<tg-emoji emoji-id="5794164805065514131">1️⃣</tg-emoji> Tap <tg-emoji emoji-id="5402186569006210455">💱</tg-emoji> <b>Buy USDT</b> and pick your <tg-emoji emoji-id="5282843764451195532">💳</tg-emoji> <b>Payment Method</b> first (<tg-emoji emoji-id="5796366529855494419">📱</tg-emoji> Telebirr, <tg-emoji emoji-id="5796436189930069862">🏦</tg-emoji> CBE, <tg-emoji emoji-id="5796558527778527912">🏦</tg-emoji> BOA, <tg-emoji emoji-id="5796252438344244434">🏦</tg-emoji> Awash, <tg-emoji emoji-id="5796636442780244593">🏦</tg-emoji> Dashen, or <tg-emoji emoji-id="5796522802240559529">💳</tg-emoji> eBirr).\n' +
    '<tg-emoji emoji-id="5794085322400733645">2️⃣</tg-emoji> Choose your <tg-emoji emoji-id="5334734562889047862">🌐</tg-emoji> <b>Network</b> (<tg-emoji emoji-id="5830130569144439663">🟣</tg-emoji> Polygon or <tg-emoji emoji-id="5829978819359937589">🟡</tg-emoji> BEP20).\n' +
    '<tg-emoji emoji-id="5794280000383358988">3️⃣</tg-emoji> Select or type the <b>USDT amount</b> and send your <tg-emoji emoji-id="5215420556089776398">👛</tg-emoji> <code>0x...</code> wallet address.\n' +
    '<tg-emoji emoji-id="5794241397217304511">4️⃣</tg-emoji> Pay the exact <tg-emoji emoji-id="5197434882321567830">💵</tg-emoji> <b>ETB total</b> within the time window, then send your <b>Telebirr Transaction ID</b> or <b>Bank Receipt Link (URL)</b>.\n' +
    '<tg-emoji emoji-id="5793985348446984682">5️⃣</tg-emoji> <tg-emoji emoji-id="5332533929020761310">✅</tg-emoji> Verification checks exact amount, receiver name, and payment time, then sends USDT straight to your wallet.\n\n' +
    'Need help with a failed order? Open <tg-emoji emoji-id="6323538349139169899">🎧</tg-emoji> <b>Support</b>, tap the order, and send a screenshot or text of the issue.',
  NETWORKS: {
    polygon: { label: 'Polygon', emoji: '🟣', explorer: 'https://polygonscan.com/tx/', enabled: true },
    bep20: { label: 'BEP20', emoji: '🟡', explorer: 'https://bscscan.com/tx/', enabled: true },
  },
  WITHDRAW_FEE: { polygon: 0, bep20: 0 },
  STOCK: { polygon: 0.190008, bep20: 0 },
  PAYMENTS: {
    telebirr: { label: '📱 Telebirr', account: '0977844356', name: 'AHMED SHEMSU JEMAL', fee: 0, enabled: true, verifyBank: 'telebirr' },
    boa: { label: '🏦 Bank of Abyssinia', account: '266111002', name: 'AHMED SHEMSU JEMAL', fee: 0, enabled: true, verifyBank: 'boa', accountSuffix: '00000' },
    awash: { label: '🏦 Awash Bank', account: '0130000000', name: 'YOUR NAME', fee: 0, enabled: false, verifyBank: 'awash' },
    dashen: { label: '🏦 Dashen Bank', account: '500000000', name: 'YOUR NAME', fee: 0, enabled: false, verifyBank: 'dashen' },
    cbe: { label: '🏦 CBE', account: '1000746587213', name: 'AHMED SHEMSU JEMAL', fee: 0, enabled: true, verifyBank: 'cbe' },
    ebirr_kaafi: { label: '💳 eBirr — KaaFi', account: '0911000000', name: 'YOUR NAME', fee: 0, enabled: false, verifyBank: 'ebirr' },
    ebirr_coopay: { label: '💳 eBirr — COOPay', account: '0911000000', name: 'YOUR NAME', fee: 0, enabled: false, verifyBank: 'ebirr' },
  },
  UPDATED_AT: 0,
};

// ======================== SUPABASE (POSTGRES) STORAGE ========================
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
const LEGACY_DB_FILE = path.resolve(process.cwd(), 'orders.json');
const LEGACY_DB_BACKUP_FILE = path.resolve(process.cwd(), 'orders.backup.json');
const INITIAL_LAST_ID = 14781;

const SCHEMA_SQL = `
create table if not exists bot_state (
  id int primary key default 1,
  config jsonb not null default '{}'::jsonb,
  last_id bigint not null default ${INITIAL_LAST_ID},
  updated_at timestamptz not null default now(),
  constraint bot_state_single_row check (id = 1)
);
create table if not exists bot_users (
  id bigint primary key,
  username text,
  banned boolean not null default false,
  last_active_at bigint not null default 0,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists bot_orders (
  id bigint primary key,
  user_id bigint not null,
  status text not null,
  created_at bigint not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists bot_orders_user_idx on bot_orders (user_id);
create index if not exists bot_orders_status_idx on bot_orders (status);
create table if not exists bot_used_tx (
  ref text primary key,
  created_at timestamptz not null default now()
);
create table if not exists bot_support_tickets (
  id bigint primary key,
  user_id bigint not null,
  status text not null,
  created_at bigint not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists bot_broadcasts (
  id bigint primary key,
  created_at bigint not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table bot_state enable row level security;
alter table bot_users enable row level security;
alter table bot_orders enable row level security;
alter table bot_used_tx enable row level security;
alter table bot_support_tickets enable row level security;
alter table bot_broadcasts enable row level security;
`;

const TABLES = [
  {
    key: 'users',
    sql: `insert into bot_users (id, username, banned, last_active_at, data) values ($1,$2,$3,$4,$5)
          on conflict (id) do update set username=excluded.username, banned=excluded.banned,
          last_active_at=excluded.last_active_at, data=excluded.data, updated_at=now()`,
    params: (r, json) => [r.id, r.username || null, !!r.banned, r.lastActiveAt || 0, json],
  },
  {
    key: 'orders',
    sql: `insert into bot_orders (id, user_id, status, created_at, data) values ($1,$2,$3,$4,$5)
          on conflict (id) do update set user_id=excluded.user_id, status=excluded.status,
          created_at=excluded.created_at, data=excluded.data, updated_at=now()`,
    params: (r, json) => [r.id, r.userId, r.status, r.createdAt || 0, json],
  },
  {
    key: 'supportTickets',
    sql: `insert into bot_support_tickets (id, user_id, status, created_at, data) values ($1,$2,$3,$4,$5)
          on conflict (id) do update set user_id=excluded.user_id, status=excluded.status,
          created_at=excluded.created_at, data=excluded.data, updated_at=now()`,
    params: (r, json) => [r.id, r.userId, r.status, r.createdAt || 0, json],
  },
  {
    key: 'broadcasts',
    sql: `insert into bot_broadcasts (id, created_at, data) values ($1,$2,$3)
          on conflict (id) do update set created_at=excluded.created_at, data=excluded.data, updated_at=now()`,
    params: (r, json) => [r.id, r.createdAt || 0, json],
  },
];

const db = {
  lastId: INITIAL_LAST_ID,
  config: structuredClone(DEFAULT_CONFIG),
  users: [],
  orders: [],
  usedTx: [],
  supportTickets: [],
  broadcasts: [],
};

let pool = null;
const snap = {
  state: '',
  users: new Map(),
  orders: new Map(),
  supportTickets: new Map(),
  broadcasts: new Map(),
  usedTx: new Set(),
};

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (raw) return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`Error reading ${path.basename(filePath)}:`, err);
  }
  return null;
}

// Merge stored data with defaults (same behaviour as the old JSON loader)
function buildDb(parsed) {
  const initial = {
    lastId: INITIAL_LAST_ID,
    config: structuredClone(DEFAULT_CONFIG),
    users: [],
    orders: [],
    usedTx: [],
    supportTickets: [],
    broadcasts: [],
  };
  if (!parsed || typeof parsed !== 'object') return initial;

  const rawCfg = { ...(parsed.config || {}) };
  delete rawCfg.BOT_TOKEN; // token always comes from the environment, never from storage
  const mergedNetworks = structuredClone(DEFAULT_CONFIG.NETWORKS);
  if (rawCfg.NETWORKS && typeof rawCfg.NETWORKS === 'object') {
    for (const [k, v] of Object.entries(rawCfg.NETWORKS)) {
      mergedNetworks[k] = { ...(mergedNetworks[k] || {}), ...v };
    }
  }
  const mergedPayments = structuredClone(DEFAULT_CONFIG.PAYMENTS);
  if (rawCfg.PAYMENTS && typeof rawCfg.PAYMENTS === 'object') {
    for (const [k, v] of Object.entries(rawCfg.PAYMENTS)) {
      mergedPayments[k] = { ...(mergedPayments[k] || {}), ...v };
    }
  }

  return {
    lastId: parsed.lastId ?? initial.lastId,
    config: {
      ...structuredClone(DEFAULT_CONFIG),
      ...rawCfg,
      NETWORKS: mergedNetworks,
      WITHDRAW_FEE: { ...structuredClone(DEFAULT_CONFIG.WITHDRAW_FEE), ...(rawCfg.WITHDRAW_FEE || {}) },
      STOCK: { ...structuredClone(DEFAULT_CONFIG.STOCK), ...(rawCfg.STOCK || {}) },
      PAYMENTS: mergedPayments,
      UPDATED_AT: Number(rawCfg.UPDATED_AT) || 0,
    },
    users: Array.isArray(parsed.users) ? parsed.users : [],
    orders: Array.isArray(parsed.orders) ? parsed.orders : [],
    usedTx: Array.isArray(parsed.usedTx) ? parsed.usedTx : [],
    supportTickets: Array.isArray(parsed.supportTickets) ? parsed.supportTickets : [],
    broadcasts: Array.isArray(parsed.broadcasts) ? parsed.broadcasts : [],
  };
}

function persistableConfig() {
  const { BOT_TOKEN, ...rest } = db.config;
  return rest;
}

async function loadFromSupabase() {
  const [st, users, orders, tickets, broadcasts, tx] = await Promise.all([
    pool.query('select config, last_id from bot_state where id = 1'),
    pool.query('select data from bot_users'),
    pool.query('select data from bot_orders order by id asc'),
    pool.query('select data from bot_support_tickets order by id desc'),
    pool.query('select data from bot_broadcasts order by id desc'),
    pool.query('select ref from bot_used_tx'),
  ]);
  if (!st.rows.length && !users.rows.length && !orders.rows.length) return null;
  const maxOrderId = orders.rows.reduce((m, r) => Math.max(m, Number(r.data?.id) || 0), 0);
  return {
    lastId: Math.max(Number(st.rows[0]?.last_id) || INITIAL_LAST_ID, maxOrderId),
    config: st.rows[0]?.config || {},
    users: users.rows.map((r) => r.data),
    orders: orders.rows.map((r) => r.data),
    supportTickets: tickets.rows.map((r) => r.data),
    broadcasts: broadcasts.rows.map((r) => r.data),
    usedTx: tx.rows.map((r) => r.ref),
  };
}

// Writes only rows that changed since the last successful sync, in one transaction
async function syncToSupabase() {
  const client = await pool.connect();
  const pending = [];
  try {
    await client.query('BEGIN');

    const cfgJson = JSON.stringify(persistableConfig());
    const stateJson = `${cfgJson}|${db.lastId}`;
    if (stateJson !== snap.state) {
      await client.query(
        `insert into bot_state (id, config, last_id, updated_at) values (1, $1, $2, now())
         on conflict (id) do update set config=excluded.config, last_id=excluded.last_id, updated_at=now()`,
        [cfgJson, db.lastId]
      );
      pending.push(() => {
        snap.state = stateJson;
      });
    }

    for (const t of TABLES) {
      for (const row of db[t.key]) {
        const json = JSON.stringify(row);
        if (snap[t.key].get(row.id) === json) continue;
        await client.query(t.sql, t.params(row, json));
        pending.push(() => snap[t.key].set(row.id, json));
      }
    }

    const newTx = db.usedTx.filter((x) => !snap.usedTx.has(x));
    if (newTx.length) {
      await client.query('insert into bot_used_tx (ref) select unnest($1::text[]) on conflict do nothing', [newTx]);
      pending.push(() => newTx.forEach((x) => snap.usedTx.add(x)));
    }

    await client.query('COMMIT');
    pending.forEach((fn) => fn());
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

let flushChain = Promise.resolve();
let flushTimer = null;
let retryTimer = null;

function flushDb() {
  flushChain = flushChain.then(syncToSupabase).catch((err) => {
    console.error('Supabase sync failed (will retry):', err?.message || err);
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        saveDb();
      }, 5000);
    }
  });
  return flushChain;
}

// Same name/behaviour as before, so the rest of the bot is unchanged (now debounced + async)
function saveDb() {
  if (!pool || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDb();
  }, 250);
}

function touchConfig() {
  db.config.UPDATED_AT = Date.now();
  saveDb();
}

async function initStorage() {
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set. Put your Supabase Postgres connection string in the DATABASE_URL env var.');
    process.exit(1);
  }
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
  pool.on('error', (err) => console.error('Postgres pool error:', err?.message || err));

  await pool.query(SCHEMA_SQL);
  console.log('✅ Supabase tables are ready');

  let parsed = await loadFromSupabase();
  let source = 'Supabase';
  if (!parsed) {
    parsed = readJsonSafe(LEGACY_DB_FILE) || readJsonSafe(LEGACY_DB_BACKUP_FILE);
    source = parsed ? 'orders.json (one-time import into Supabase)' : 'fresh start';
  }
  Object.assign(db, buildDb(parsed));
  // Secrets set as environment variables always win over whatever is stored in the database
  for (const k of ['WALLET_PRIVATE_KEY', 'VERIFY_ET_API_KEY']) {
    if (DEFAULT_CONFIG[k]) db.config[k] = DEFAULT_CONFIG[k];
  }
  if (DEFAULT_CONFIG.VERIFY_ET_API_KEY) db.config.VERIFY_ET_ENABLED = true;

  if (source === 'Supabase') {
    snap.state = `${JSON.stringify(persistableConfig())}|${db.lastId}`;
    for (const t of TABLES) for (const row of db[t.key]) snap[t.key].set(row.id, JSON.stringify(row));
    db.usedTx.forEach((x) => snap.usedTx.add(x));
  }

  await flushDb(); // writes the config row (and any imported data)
  console.log(
    `✅ Loaded from ${source}: ${db.users.length} users, ${db.orders.length} orders, ${db.supportTickets.length} tickets`
  );
}

// ======================== HELPERS ========================
const escHtml = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] || c));
const userSafeReason = (reason) => {
  let t = String(reason || '');
  if (/VERIFY_ET_API_KEY|disabled in settings/i.test(t)) return 'Sent to our team for manual review';
  t = t.replace(/Verified via Verify\.et\s*·?\s*/gi, 'Verified · ');
  t = t.replace(/\bon Verify\.et\b/gi, '').replace(/\bby Verify\.et\b/gi, '').replace(/\bVerify\.et\b/gi, 'payment system');
  return t.replace(/\s{2,}/g, ' ').trim();
};
const fmtUsdt = (n) => Number(n || 0).toFixed(4);
const fmtMoney = (n) => Number(n || 0).toFixed(2);
const isAdmin = (userId) => db.config.ADMIN_IDS.includes(Number(userId));
const getOrderById = (id) => db.orders.find((o) => o.id === Number(id));
const stripLeadingEmoji = (label) => String(label || '').replace(/^[^\w\s]+\s*/, '').trim();

function releaseStock(order) {
  if (db.config.STOCK[order.network] !== undefined) {
    db.config.STOCK[order.network] = Number((db.config.STOCK[order.network] + order.usdt).toFixed(6));
  }
}

const rateFor = (amount) => (amount <= 1 ? db.config.SMALL_ORDER_RATE : db.config.RATE);
const paymentFee = (method) => Number(db.config.PAYMENTS[method]?.fee || 0);
const calculateEtb = (amount, method) =>
  Math.round((amount * rateFor(amount) + amount * paymentFee(method)) * 100) / 100;

function orderCategory(status) {
  if (['awaiting_payment', 'pending_review', 'sending'].includes(status)) return 'open';
  if (status === 'completed') return 'done';
  return 'cancelled';
}

function todayTotalUsdt() {
  const day = new Date().toISOString().slice(0, 10);
  const dead = ['cancelled', 'expired', 'rejected', 'failed'];
  return db.orders
    .filter((o) => !dead.includes(o.status) && new Date(o.createdAt).toISOString().slice(0, 10) === day)
    .reduce((sum, o) => sum + o.usdt, 0);
}

function upsertUser(user) {
  const now = Date.now();
  let existing = db.users.find((u) => u.id === user.id);
  if (existing) {
    existing.username = user.username ?? existing.username;
    existing.firstName = user.firstName || existing.firstName;
    existing.lastActiveAt = now;
  } else {
    existing = {
      id: user.id,
      username: user.username || null,
      firstName: user.firstName || 'Trader',
      joinedAt: now,
      lastActiveAt: now,
      banned: false,
    };
    db.users.push(existing);
  }
  saveDb();
  return existing;
}

const stepOf4Html = (step) => {
  const stepMap = {
    1: tgEmoji(EMOJI_IDS.num1, '1️⃣'),
    2: tgEmoji(EMOJI_IDS.num2, '2️⃣'),
    3: tgEmoji(EMOJI_IDS.num3, '3️⃣'),
    4: tgEmoji(EMOJI_IDS.num4, '4️⃣'),
  };
  return `Step ${stepMap[step]} of ${tgEmoji(EMOJI_IDS.num4, '4️⃣')}`;
};

const statusLabelHtml = (status) => {
  switch (status) {
    case 'awaiting_payment':
      return `${tgEmoji(EMOJI_IDS.hourglass, '⏳')} Awaiting payment`;
    case 'pending_review':
      return `${tgEmoji(EMOJI_IDS.search, '🔎')} Verifying payment`;
    case 'sending':
      return `${tgEmoji(EMOJI_IDS.sending, '📤')} Sending USDT`;
    case 'completed':
      return `${tgEmoji(EMOJI_IDS.available, '✅')} Completed`;
    case 'rejected':
      return `${tgEmoji(EMOJI_IDS.cancel, '❌')} Rejected`;
    case 'cancelled':
      return `${tgEmoji(EMOJI_IDS.blocked, '🚫')} Cancelled`;
    case 'expired':
      return `${tgEmoji(EMOJI_IDS.expired, '⌛')} Expired`;
    case 'failed':
      return `${tgEmoji(EMOJI_IDS.warning, '⚠️')} Failed — contact support`;
    default:
      return status;
  }
};

const statusIconId = (status) => {
  switch (status) {
    case 'awaiting_payment':
      return EMOJI_IDS.hourglass;
    case 'pending_review':
      return EMOJI_IDS.search;
    case 'sending':
      return EMOJI_IDS.sending;
    case 'completed':
      return EMOJI_IDS.available;
    case 'rejected':
      return EMOJI_IDS.cancel;
    case 'cancelled':
      return EMOJI_IDS.blocked;
    case 'expired':
      return EMOJI_IDS.expired;
    case 'failed':
      return EMOJI_IDS.warning;
    default:
      return EMOJI_IDS.myOrders;
  }
};

const netEmojiHtml = (netKey, fallback = '🪙') => {
  if (netKey === 'polygon') return tgEmoji(EMOJI_IDS.polygon, '🟣');
  if (netKey === 'bep20') return tgEmoji(EMOJI_IDS.bep20, '🟡');
  return fallback;
};

const netButtonIcon = (netKey) => {
  if (netKey === 'polygon') return EMOJI_IDS.polygon;
  if (netKey === 'bep20') return EMOJI_IDS.bep20;
  return undefined;
};

const payButtonIcon = (methodKey) => {
  if (methodKey === 'telebirr') return EMOJI_IDS.telebirr;
  if (methodKey === 'cbe') return EMOJI_IDS.cbe;
  if (methodKey === 'boa') return EMOJI_IDS.boa;
  if (methodKey === 'awash') return EMOJI_IDS.awash;
  if (methodKey === 'dashen') return EMOJI_IDS.dashen;
  if (methodKey === 'ebirr_kaafi') return EMOJI_IDS.ebirr;
  if (methodKey === 'ebirr_coopay') return EMOJI_IDS.coop;
  return EMOJI_IDS.payFirst;
};

const payLabelHtml = (methodKey, rawLabel) => {
  const clean = escHtml(stripLeadingEmoji(rawLabel || methodKey));
  if (methodKey === 'telebirr') return `${tgEmoji(EMOJI_IDS.telebirr, '📱')} ${clean}`;
  if (methodKey === 'cbe') return `${tgEmoji(EMOJI_IDS.cbe, '🏦')} ${clean}`;
  if (methodKey === 'boa') return `${tgEmoji(EMOJI_IDS.boa, '🏦')} ${clean}`;
  if (methodKey === 'awash') return `${tgEmoji(EMOJI_IDS.awash, '🏦')} ${clean}`;
  if (methodKey === 'dashen') return `${tgEmoji(EMOJI_IDS.dashen, '🏦')} ${clean}`;
  if (methodKey === 'ebirr_kaafi') return `${tgEmoji(EMOJI_IDS.ebirr, '💳')} ${clean}`;
  if (methodKey === 'ebirr_coopay') return `${tgEmoji(EMOJI_IDS.coop, '💳')} ${clean}`;
  return `${tgEmoji(EMOJI_IDS.payFirst, '💳')} ${clean}`;
};

// ======================== WEB3 HOT WALLET ========================
function normalizePrivateKey(raw) {
  const clean = String(raw || '').trim();
  if (!clean) return null;
  const hex = clean.startsWith('0x') ? clean : `0x${clean}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? hex : null;
}

function getWalletAddress(privateKey) {
  const pk = normalizePrivateKey(privateKey);
  if (!pk) return null;
  try {
    return new Wallet(pk).address;
  } catch {
    return null;
  }
}

async function getChainBalances(chain, address) {
  const cfg = CHAIN_CONFIG[chain];
  let lastErr;
  for (const rpc of cfg.rpcs) {
    try {
      const provider = new JsonRpcProvider(rpc, cfg.chainId, { staticNetwork: true });
      const usdtContract = new Contract(cfg.usdtAddress, ERC20_ABI, provider);
      const [rawUsdt, rawGas] = await Promise.race([
        Promise.all([usdtContract.balanceOf(address), provider.getBalance(address)]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), 8000)),
      ]);
      return {
        usdt: Number(Number(formatUnits(rawUsdt, cfg.decimals)).toFixed(6)),
        gas: Number(Number(formatUnits(rawGas, 18)).toFixed(6)),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Failed connecting to ${cfg.name} RPC`);
}

async function fetchHotWalletStatus(privateKey) {
  const address = getWalletAddress(privateKey);
  const out = { configured: !!address, address, polygonUsdt: null, polygonGas: null, bep20Usdt: null, bep20Gas: null, lastError: null };
  if (!address) return out;
  // Each chain is read on its own, so one broken RPC no longer blocks the other chain
  const [poly, bsc] = await Promise.allSettled([
    getChainBalances('polygon', address),
    getChainBalances('bep20', address),
  ]);
  const errs = [];
  if (poly.status === 'fulfilled') {
    out.polygonUsdt = poly.value.usdt;
    out.polygonGas = poly.value.gas;
  } else {
    errs.push(`Polygon: ${poly.reason?.message || poly.reason}`);
  }
  if (bsc.status === 'fulfilled') {
    out.bep20Usdt = bsc.value.usdt;
    out.bep20Gas = bsc.value.gas;
  } else {
    errs.push(`BEP20: ${bsc.reason?.message || bsc.reason}`);
  }
  out.lastError = errs.length ? errs.join(' | ') : null;
  return out;
}

async function sendHotWalletUsdt({ privateKey, network, toAddress, amountUsdt }) {
  const pk = normalizePrivateKey(privateKey);
  if (!pk) throw new Error('Invalid or missing Hot Wallet Private Key');
  const cfg = CHAIN_CONFIG[network];
  if (!cfg) throw new Error(`Unsupported network: ${network}`);

  let lastErr;
  for (const rpc of cfg.rpcs) {
    try {
      const provider = new JsonRpcProvider(rpc, cfg.chainId, { staticNetwork: true });
      const wallet = new Wallet(pk, provider);
      const contract = new Contract(cfg.usdtAddress, ERC20_ABI, wallet);
      const amountUnits = parseUnits(Number(amountUsdt).toFixed(cfg.decimals), cfg.decimals);
      const [usdtBal, gasBal] = await Promise.all([
        contract.balanceOf(wallet.address),
        provider.getBalance(wallet.address),
      ]);

      if (usdtBal < amountUnits) {
        const have = Number(formatUnits(usdtBal, cfg.decimals)).toFixed(4);
        throw new Error(
          `Insufficient ${cfg.name} USDT in Hot Wallet (${wallet.address.slice(0, 8)}...): have ${have} USDT, need ${amountUsdt} USDT`
        );
      }
      if (gasBal === 0n) {
        throw new Error(
          `Hot Wallet (${wallet.address.slice(0, 8)}...) has 0 ${cfg.nativeSymbol} for gas on ${cfg.name}.`
        );
      }

      const tx = await contract.transfer(toAddress, amountUnits);
      return { txHash: tx.hash, from: wallet.address };
    } catch (err) {
      lastErr = err;
      if (String(err?.message || '').includes('Insufficient') || String(err?.message || '').includes('for gas')) {
        throw err;
      }
    }
  }
  throw new Error(lastErr?.shortMessage || lastErr?.message || `Failed sending USDT on ${cfg.name}`);
}

// ======================== VERIFY.ET VERIFICATION ========================
function extractReceiptUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"]+/i);
  return m ? m[0].replace(/[.,;!?)+]+$/, '').trim() : null;
}

function extractTxReference(text) {
  if (!text) return null;
  const url = extractReceiptUrl(text);
  if (url) {
    const tail = url.split(/[/?=&]/).filter(Boolean).pop();
    if (tail && tail.length >= 5) return tail.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  }
  const patterns = [
    /(?:transaction|receipt|reference|ref|trx)\s*(?:number|id|no\.?|code)?\s*(?:is|:|#)?\s*([A-Z0-9]{6,28})/i,
    /\b(FT[A-Z0-9]{8,20})\b/i,
    /\b([A-Z0-9]{8,24})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return null;
}

function normalizePersonName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ');
}

function parseReceiptTimestampMs(rawTs) {
  if (!rawTs) return NaN;
  const str = String(rawTs).trim();
  const isoMs = Date.parse(str);
  if (Number.isFinite(isoMs)) return isoMs;
  const dmy = str.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (dmy) {
    const [, dd, mm, yyyy, hh, min, ss] = dmy;
    return Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+03:00`);
  }
  return NaN;
}

function parseVerifyEtEnvelope(data, options, txId) {
  const verif = data?.verification || data?.data?.verification;
  const firstDataItem = Array.isArray(data?.data) ? data.data[0] : data?.data?.result || data?.data;
  const txResult = verif?.result || firstDataItem || verif || data;
  const spec = txResult?.bankSpecific || {};

  const requestId = data?.requestId || verif?.requestId || data?.data?.requestId || txResult?.requestId || null;
  const statusUrl = data?.links?.statusUrl || null;
  const processingStatus = String(verif?.processingStatus || '').toLowerCase();
  const status = String(txResult?.status || verif?.status || data?.status || '').toLowerCase();

  const isVerified =
    txResult?.verified === true ||
    verif?.verified === true ||
    (['success', 'completed', 'verified'].includes(status) && txResult?.verified !== false);

  const amountVal = Number(
    txResult?.amount ?? spec?.settledAmountValue ?? spec?.amountValue ?? verif?.amount ?? data?.amount ?? NaN
  );
  const senderName = txResult?.senderName || spec?.senderName || spec?.payerName || undefined;
  const receiverName = txResult?.receiverName || spec?.receiverName || spec?.creditedPartyName || undefined;
  const timestamp =
    txResult?.timestamp ||
    spec?.paymentDateIsoUtc ||
    spec?.transactionDateIsoUtc ||
    spec?.paymentDate ||
    spec?.transactionDateRaw ||
    undefined;
  const resolvedTxNumber =
    txResult?.transactionNumber || txResult?.receiptNumber || spec?.receiptNo || spec?.reference || txId;

  if (isVerified) {
    if (!Number.isFinite(amountVal) || Math.abs(amountVal - options.requiredEtb) > 0.01) {
      return {
        verdict: 'bad',
        provider: 'verify.et',
        reason: `Amount mismatch: sent ${Number.isFinite(amountVal) ? amountVal.toFixed(2) : 'unknown'} ETB, expected ${options.requiredEtb.toFixed(2)} ETB`,
        txId: resolvedTxNumber,
        requestId,
      };
    }

    const expectedName = String(options.expectedReceiverName || '').trim();
    if (expectedName) {
      const actualNorm = normalizePersonName(receiverName || '');
      const expectedNorm = normalizePersonName(expectedName);
      if (!actualNorm || actualNorm !== expectedNorm) {
        return {
          verdict: 'bad',
          provider: 'verify.et',
          reason: `Receiver name mismatch: paid to "${receiverName || 'Unknown'}", expected "${expectedName}"`,
          txId: resolvedTxNumber,
          requestId,
        };
      }
    }

    const windowMin = Number(options.paymentWindowMin || db.config.PAYMENT_WINDOW_MIN || 30);
    const windowMs = windowMin * 60 * 1000;
    const txTimeMs = parseReceiptTimestampMs(timestamp);
    const now = Date.now();

    if (!Number.isFinite(txTimeMs)) {
      return {
        verdict: 'bad',
        provider: 'verify.et',
        reason: 'Receipt is missing a valid payment timestamp',
        txId: resolvedTxNumber,
        requestId,
      };
    }

    const ageMs = now - txTimeMs;
    const expiredByAge = ageMs > windowMs;
    const expiredByOrderWindow =
      (options.orderExpiresAt !== undefined && now > options.orderExpiresAt) ||
      (options.orderCreatedAt !== undefined && txTimeMs < options.orderCreatedAt - windowMs);

    if (expiredByAge || expiredByOrderWindow) {
      const ageMin = Math.max(0, Math.round(ageMs / 60000));
      return {
        verdict: 'bad',
        provider: 'verify.et',
        reason: `Payment time expired: receipt timestamp (${timestamp}) is ${ageMin} min old (limit: ${windowMin} min)`,
        txId: resolvedTxNumber,
        requestId,
      };
    }

    return {
      verdict: 'ok',
      provider: 'verify.et',
      reason: `Verified via Verify.et · ${amountVal.toFixed(2)} ETB to ${receiverName || expectedName}${senderName ? ` from ${senderName}` : ''}`,
      txId: resolvedTxNumber,
      requestId,
    };
  }

  if (
    (txResult?.verified === false || verif?.verified === false || data?.success === false) &&
    ['failed', 'invalid', 'not_found', 'rejected', 'completed', 'error'].includes(status || processingStatus)
  ) {
    return {
      verdict: 'bad',
      provider: 'verify.et',
      reason: data?.message || txResult?.message || verif?.message || 'Transaction could not be verified on Verify.et',
      txId: resolvedTxNumber,
      requestId,
    };
  }

  const isPending =
    ['pending', 'processing', 'queued'].includes(status) ||
    ['pending', 'processing', 'queued'].includes(processingStatus);

  if (!isPending && data?.success === false) {
    return {
      verdict: 'bad',
      provider: 'verify.et',
      reason: data?.message || 'Verification failed on Verify.et',
      txId: resolvedTxNumber,
      requestId,
    };
  }

  return {
    verdict: 'manual',
    provider: 'verify.et',
    pending: isPending || Boolean(requestId),
    statusUrl,
    reason: data?.message || verif?.message || 'Verification processing on Verify.et',
    txId: resolvedTxNumber,
    requestId,
  };
}

async function verifyWithVerifyEt(order, txId, rawText) {
  const cfg = db.config;
  const apiKey = (cfg.VERIFY_ET_API_KEY || '').trim();
  const methodCfg = cfg.PAYMENTS[order.method];
  const bank = methodCfg?.verifyBank || 'telebirr';
  const isTelebirr = bank === 'telebirr';

  if (!cfg.VERIFY_ET_ENABLED || !apiKey) {
    return {
      verdict: 'manual',
      provider: 'manual',
      reason: apiKey ? 'Verify.et disabled in settings' : 'VERIFY_ET_API_KEY not configured — routed to manual review',
      txId,
    };
  }

  const receiptUrl = extractReceiptUrl(rawText);
  const transactionNumber = isTelebirr ? txId : receiptUrl || rawText.trim();
  const settlementAccount = (methodCfg?.account || '').trim();
  const waitMs = cfg.VERIFY_ET_WAIT_MS || 5000;

  const validationOpts = {
    requiredEtb: order.etb,
    expectedReceiverName: methodCfg?.name,
    paymentWindowMin: cfg.PAYMENT_WINDOW_MIN,
    orderCreatedAt: order.createdAt,
    orderExpiresAt: order.expiresAt,
  };

  try {
    const res = await fetch(`https://verify.et/api/verify?waitMs=${encodeURIComponent(String(waitMs))}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Idempotency-Key': `verify-${bank}-${order.id || 'test'}-${txId}`,
      },
      body: JSON.stringify({ bank, transactionNumber, settlementAccount }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) {
      if ([400, 404, 422].includes(res.status)) {
        return {
          verdict: 'bad',
          provider: 'verify.et',
          reason: data?.message || data?.error || `Verification rejected by Verify.et (HTTP ${res.status})`,
          txId,
        };
      }
      return {
        verdict: 'manual',
        provider: 'verify.et',
        reason: `Verify.et HTTP ${res.status}: ${data?.message || data?.error || 'Queued for manual review'}`,
        txId,
      };
    }

    const first = parseVerifyEtEnvelope(data, validationOpts, txId);
    if (first.verdict !== 'manual' || !first.pending || !first.requestId) return first;

    const pollPath = first.statusUrl
      ? `https://verify.et${first.statusUrl.startsWith('/') ? first.statusUrl : '/' + first.statusUrl}`
      : `https://verify.et/api/verify/${encodeURIComponent(first.requestId)}`;

    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const pollRes = await fetch(pollPath, {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (pollRes.ok) {
        const pollData = await pollRes.json().catch(() => ({}));
        const nextCheck = parseVerifyEtEnvelope(pollData, validationOpts, txId);
        if (nextCheck.verdict !== 'manual' || !nextCheck.pending) return nextCheck;
      }
    }
    return first;
  } catch (err) {
    return {
      verdict: 'manual',
      provider: 'verify.et',
      reason: `Verify.et network error: ${err?.message || 'unknown'}`,
      txId,
    };
  }
}

// ======================== BOT CONTROLLER ========================
class BotApp {
  constructor() {
    this.bot = null;
    this.sessions = new Map();
    this.hotWallet = { configured: false, address: null, polygonUsdt: null, polygonGas: null, bep20Usdt: null, bep20Gas: null, lastError: null };
  }

  getSession(userId) {
    let s = this.sessions.get(userId);
    if (!s) {
      s = { step: 'idle' };
      this.sessions.set(userId, s);
    }
    return s;
  }

  resetSession(userId) {
    const prev = this.sessions.get(userId);
    const next = { step: 'idle', lastBotMsgId: prev?.lastBotMsgId };
    this.sessions.set(userId, next);
    return next;
  }

  async syncHotWalletBalance() {
    const status = await fetchHotWalletStatus(db.config.WALLET_PRIVATE_KEY);
    this.hotWallet = status;
    this.lastBalanceSync = Date.now();
    if (!status.configured) {
      console.error('Wallet sync: private key missing or invalid');
      return status;
    }
    if (status.lastError) console.error('Wallet sync error:', status.lastError);

    const reserved = (network) =>
      db.orders
        .filter((o) => o.network === network && ['awaiting_payment', 'pending_review', 'sending'].includes(o.status))
        .reduce((sum, o) => sum + Number(o.usdt || 0), 0);

    status.polygonReserved = Number(reserved('polygon').toFixed(6));
    status.bep20Reserved = Number(reserved('bep20').toFixed(6));
    if (typeof status.polygonUsdt === 'number') {
      db.config.STOCK.polygon = Math.max(0, Number((status.polygonUsdt - status.polygonReserved).toFixed(6)));
    }
    if (typeof status.bep20Usdt === 'number') {
      db.config.STOCK.bep20 = Math.max(0, Number((status.bep20Usdt - status.bep20Reserved).toFixed(6)));
    }
    console.log(
      `Wallet ${status.address} | Polygon: ${status.polygonUsdt} USDT (stock ${db.config.STOCK.polygon}) | BEP20: ${status.bep20Usdt} USDT (stock ${db.config.STOCK.bep20})`
    );
    saveDb();
    return status;
  }

  // Refresh balances right before showing them to a user (at most every 10s)
  async refreshStock(maxAgeMs = 10000) {
    if (!db.config.WALLET_PRIVATE_KEY) return;
    if (this.lastBalanceSync && Date.now() - this.lastBalanceSync < maxAgeMs) return;
    await this.syncHotWalletBalance().catch((err) => console.error('refreshStock failed:', err?.message || err));
  }

  buildHomeScreen(userId, firstName) {
    const netLines = Object.entries(db.config.NETWORKS)
      .filter(([, n]) => n.enabled)
      .map(([k, v]) => `${netEmojiHtml(k, v.emoji)} ${escHtml(v.label)}: <b>${fmtUsdt(db.config.STOCK[k] ?? 0)} USDT</b>`)
      .join('\n');

    const maint = db.config.MAINTENANCE_MODE
      ? `\n\n${tgEmoji(EMOJI_IDS.warning, '⚠️')} <b>Maintenance mode is active</b> — new orders are paused.`
      : '';
    const text =
      `${tgEmoji(EMOJI_IDS.hi, '👋')} <b>Hi ${escHtml(firstName)}</b>\n\n` +
      `${tgEmoji(EMOJI_IDS.rateChart, '📊')} Rate: <b>${fmtMoney(db.config.RATE)} ETB/USDT</b>\n` +
      `${tgEmoji(EMOJI_IDS.available, '✅')} Available (min ${db.config.MIN_USDT} · max ${db.config.MAX_USDT})\n` +
      `${netLines || 'No networks enabled'}\n\n` +
      `${tgEmoji(EMOJI_IDS.buyUsdt, '💱')} Buy USDT on ${tgEmoji(EMOJI_IDS.polygon, '🟣')} <b>Polygon</b> or ${tgEmoji(EMOJI_IDS.bep20, '🟡')} <b>BEP20</b> — pay with ${tgEmoji(EMOJI_IDS.telebirr, '📱')} Telebirr, ${tgEmoji(EMOJI_IDS.cbe, '🏦')} CBE or ${tgEmoji(EMOJI_IDS.boa, '🏦')} BOA.` +
      `${maint}`;

    const buttons = [
      [
        { text: 'Buy USDT', callback_data: 'buy', icon_custom_emoji_id: EMOJI_IDS.buyUsdt },
        { text: 'My Orders', callback_data: 'orders', icon_custom_emoji_id: EMOJI_IDS.myOrders },
      ],
      [
        { text: 'USDT Rate Sheet', callback_data: 'rate', icon_custom_emoji_id: EMOJI_IDS.rateChart },
        { text: 'Help', callback_data: 'help', icon_custom_emoji_id: EMOJI_IDS.help },
      ],
      [{ text: 'Support', callback_data: 'support', icon_custom_emoji_id: EMOJI_IDS.support }],
    ];
    if (isAdmin(userId)) {
      buttons.push([{ text: 'Admin Panel', callback_data: 'admin:home', icon_custom_emoji_id: EMOJI_IDS.adminTools }]);
    }
    return { text, buttons };
  }

  buildHelpScreen() {
    return {
      text: db.config.HELP_TEXT,
      buttons: [
        [
          { text: 'Buy USDT', callback_data: 'buy', icon_custom_emoji_id: EMOJI_IDS.buyUsdt },
          { text: 'Support', callback_data: 'support', icon_custom_emoji_id: EMOJI_IDS.support },
        ],
        [backBtn('home'), cancelBtn('home')],
      ],
    };
  }

  buildRateScreen() {
    const netLines = Object.entries(db.config.NETWORKS)
      .filter(([, n]) => n.enabled)
      .map(([k, v]) => `• ${netEmojiHtml(k, v.emoji)} <b>${escHtml(v.label)}</b>: ${fmtUsdt(db.config.STOCK[k] ?? 0)} USDT available`)
      .join('\n');

    const payLines = Object.entries(db.config.PAYMENTS)
      .filter(([, p]) => p.enabled)
      .map(([k, p]) => `• ${payLabelHtml(k, p.label)}: ${p.fee ? `+${p.fee} ETB/USDT` : '0 fee'}`)
      .join('\n');

    return {
      text:
        `${tgEmoji(EMOJI_IDS.rateSheet, '📊')} <b>USDT Rate Sheet</b>\n\n` +
        `${tgEmoji(EMOJI_IDS.tieredRate, '💵')} <b>Tiered Rate</b>\n` +
        `• Orders ≤ 1 USDT: <b>${fmtMoney(db.config.SMALL_ORDER_RATE)} ETB/USDT</b>\n` +
        `• Orders > 1 USDT: <b>${fmtMoney(db.config.RATE)} ETB/USDT</b>\n\n` +
        `${tgEmoji(EMOJI_IDS.globe, '🌐')} <b>Networks & Stock</b>\n${netLines || 'None'}\n\n` +
        `${tgEmoji(EMOJI_IDS.payFirst, '💳')} <b>Payment Methods</b>\n${payLines || 'None'}`,
      buttons: [
        [{ text: 'Buy USDT', callback_data: 'buy', icon_custom_emoji_id: EMOJI_IDS.buyUsdt }],
        [backBtn('home'), cancelBtn('home')],
      ],
    };
  }

  buildPaymentMethodsScreen(userId) {
    if (db.config.MAINTENANCE_MODE && !isAdmin(userId)) {
      return {
        text: `${tgEmoji(EMOJI_IDS.warning, '⚠️')} <b>Maintenance Mode</b>\n\nNew orders are temporarily paused. Please check back shortly.`,
        buttons: [[backBtn('home')]],
      };
    }
    const enabled = Object.entries(db.config.PAYMENTS).filter(([, p]) => p.enabled);
    if (!enabled.length) {
      return {
        text: `${tgEmoji(EMOJI_IDS.warning, '⚠️')} No payment methods are currently enabled.`,
        buttons: [[backBtn('home')]],
      };
    }

    const s = this.getSession(userId);
    s.step = 'payment_method';

    const rows = [];
    for (let i = 0; i < enabled.length; i += 2) {
      rows.push(
        enabled.slice(i, i + 2).map(([k, p]) => ({
          text: `${stripLeadingEmoji(p.label)}${p.fee ? ` (+${p.fee})` : ''}`,
          callback_data: `pay:${k}`,
          icon_custom_emoji_id: payButtonIcon(k),
        }))
      );
    }
    rows.push([backBtn('home'), cancelBtn('home')]);

    return {
      text: `${tgEmoji(EMOJI_IDS.payFirst, '💳')} <b>${stepOf4Html(1)} — Choose Payment Method</b>\n\nSelect the bank or wallet you will pay with first:`,
      buttons: rows,
    };
  }

  buildNetworkScreen(userId, methodKey) {
    const method = db.config.PAYMENTS[methodKey];
    if (!method || !method.enabled) return this.buildPaymentMethodsScreen(userId);

    const s = this.getSession(userId);
    s.method = methodKey;
    s.step = 'network';

    const enabled = Object.entries(db.config.NETWORKS).filter(([, n]) => n.enabled);
    const rows = enabled.map(([k, n]) => [
      {
        text: `${n.label} (${fmtUsdt(db.config.STOCK[k] ?? 0)} USDT)`,
        callback_data: `net:${k}`,
        icon_custom_emoji_id: netButtonIcon(k),
      },
    ]);
    rows.push([backBtn('buy'), cancelBtn('home')]);

    return {
      text:
        `${tgEmoji(EMOJI_IDS.globe, '🌐')} <b>${stepOf4Html(2)} — Select Network</b>\n` +
        `Payment: <b>${payLabelHtml(methodKey, method.label)}</b>\n\n` +
        `Choose which blockchain network to receive your USDT on:`,
      buttons: rows,
    };
  }

  buildAmountScreen(userId) {
    const s = this.getSession(userId);
    if (!s.method || !s.network) return this.buildPaymentMethodsScreen(userId);

    s.step = 'amount_choice';
    const net = db.config.NETWORKS[s.network];
    const pay = db.config.PAYMENTS[s.method];
    const stock = db.config.STOCK[s.network] ?? 0;
    const max = Math.min(db.config.MAX_USDT, stock);

    const presets = [10, 20, 30];
    const rows = [
      presets.map((p) => ({
        text: `${p} USDT`,
        callback_data: `amount:preset:${p}`,
        icon_custom_emoji_id: EMOJI_IDS.tieredRate,
      })),
    ];
    rows.push([{ text: 'Custom Amount', callback_data: 'amount:custom', icon_custom_emoji_id: EMOJI_IDS.edit }]);
    rows.push([backBtn(`pay:${s.method}`), cancelBtn('home')]);

    return {
      text:
        `${tgEmoji(EMOJI_IDS.moneyBag, '💰')} <b>${stepOf4Html(3)} — Select USDT Amount</b>\n` +
        `Payment: <b>${payLabelHtml(s.method, pay.label)}</b> · Network: <b>${netEmojiHtml(s.network, net.emoji)} ${escHtml(net.label)}</b>\n` +
        `Limits: <b>${fmtMoney(db.config.MIN_USDT)} – ${fmtMoney(max)} USDT</b>\n\n` +
        `Pick a preset amount or tap <b>Custom Amount</b>:`,
      buttons: rows,
    };
  }

  buildWalletPromptScreen(userId, amount) {
    const s = this.getSession(userId);
    if (!s.method || !s.network) return this.buildPaymentMethodsScreen(userId);

    const stock = db.config.STOCK[s.network] ?? 0;
    const max = Math.min(db.config.MAX_USDT, stock);
    const rounded = Math.round(amount * 10000) / 10000;

    if (!Number.isFinite(rounded) || rounded < db.config.MIN_USDT || rounded > max) {
      return {
        text: `${tgEmoji(EMOJI_IDS.cancel, '❌')} Invalid amount. Enter between <b>${fmtMoney(db.config.MIN_USDT)}</b> and <b>${fmtMoney(max)} USDT</b>.`,
        buttons: [[backBtn('amount:back'), cancelBtn('home')]],
      };
    }

    if (todayTotalUsdt() + rounded > db.config.DAILY_LIMIT_USDT) {
      return {
        text: `${tgEmoji(EMOJI_IDS.warning, '⚠️')} Daily platform limit reached. Please try a smaller amount or contact support.`,
        buttons: [[{ text: 'Support', callback_data: 'support', icon_custom_emoji_id: EMOJI_IDS.support }, backBtn('home')]],
      };
    }

    s.amount = rounded;
    s.step = 'wallet';
    const net = db.config.NETWORKS[s.network];
    const etbTotal = calculateEtb(rounded, s.method);

    return {
      text:
        `${tgEmoji(EMOJI_IDS.wallet, '👛')} <b>${stepOf4Html(4)} — Send Wallet Address</b>\n\n` +
        `${tgEmoji(EMOJI_IDS.moneyBag, '💰')} Amount: <b>${fmtMoney(rounded)} USDT</b> (${fmtMoney(etbTotal)} ETB)\n` +
        `${tgEmoji(EMOJI_IDS.globe, '🌐')} Network: <b>${netEmojiHtml(s.network, net.emoji)} ${escHtml(net.label)}</b>\n\n` +
        `Send your <code>0x...</code> wallet address now.\n` +
        `${tgEmoji(EMOJI_IDS.warning, '⚠️')} Double-check carefully — blockchain transfers cannot be reversed.`,
      buttons: [[backBtn('amount:back'), cancelBtn('home')]],
    };
  }

  buildOrderCardScreen(o) {
    const pay = db.config.PAYMENTS[o.method];
    const net = db.config.NETWORKS[o.network];
    const exp = new Date(o.expiresAt).toISOString().slice(11, 16);
    const isTelebirr = (pay?.verifyBank || o.method) === 'telebirr';
    const proofPrompt = isTelebirr
      ? `${tgEmoji(EMOJI_IDS.attach, '📎')} <b>Send payment proof now:</b>\n• Send your <b>Telebirr Transaction ID</b> (e.g. <code>DIH4TABDII</code>)`
      : `${tgEmoji(EMOJI_IDS.link, '🔗')} <b>Send payment proof now:</b>\n• Send your <b>Transaction Receipt Link (URL)</b> (e.g. <code>https://...</code>)`;

    const text =
      `${tgEmoji(EMOJI_IDS.available, '✅')} <b>Order #${o.id}</b> · ${statusLabelHtml(o.status)}\n\n` +
      `${tgEmoji(EMOJI_IDS.moneyBag, '💰')} Amount: <b>${fmtMoney(o.usdt)} USDT</b>\n` +
      `${tgEmoji(EMOJI_IDS.tieredRate, '💵')} Pay exactly: <b>${fmtMoney(o.etb)} ETB</b>\n` +
      `${payLabelHtml(o.method, pay?.label)}\n` +
      `Account: <code>${escHtml(pay?.account || '-')}</code>\n` +
      `Name: <b>${escHtml(pay?.name || '-')}</b>\n\n` +
      `${tgEmoji(EMOJI_IDS.globe, '🌐')} Network: <b>${netEmojiHtml(o.network, net?.emoji)} ${escHtml(net?.label || o.network)}</b>\n` +
      `${tgEmoji(EMOJI_IDS.wallet, '👛')} Wallet: <code>${escHtml(o.wallet)}</code>\n` +
      `${tgEmoji(EMOJI_IDS.hourglass, '⏳')} Expires: <b>${exp} UTC</b> (${db.config.PAYMENT_WINDOW_MIN} min)\n\n` +
      `${proofPrompt}`;

    const buttons = [
      [
        { text: `Copy ${fmtMoney(o.etb)} ETB`, copy_text: { text: fmtMoney(o.etb) }, icon_custom_emoji_id: EMOJI_IDS.copy },
        { text: 'Copy Account', copy_text: { text: pay?.account || '' }, icon_custom_emoji_id: EMOJI_IDS.copy },
      ],
      [
        { text: 'Order Status', callback_data: `order:${o.id}`, icon_custom_emoji_id: EMOJI_IDS.myOrders },
        cancelBtn(`cancel:${o.id}`, 'Cancel Order'),
      ],
      [backBtn('home', 'Back to Menu')],
    ];
    return { text, buttons };
  }

  buildOrdersScreen(userId, category = 'open', page = 0) {
    const mine = db.orders
      .filter((o) => o.userId === userId && orderCategory(o.status) === category)
      .sort((a, b) => b.createdAt - a.createdAt);

    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(mine.length / pageSize));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const shown = mine.slice(safePage * pageSize, safePage * pageSize + pageSize);

    const title =
      category === 'open'
        ? `${tgEmoji(EMOJI_IDS.greenDot, '🟢')} Open`
        : category === 'done'
          ? `${tgEmoji(EMOJI_IDS.available, '✅')} Done`
          : `${tgEmoji(EMOJI_IDS.redDot, '🔴')} Cancelled / Failed`;
    const lines = shown.length
      ? shown.map((o) => `#${o.id} · ${fmtMoney(o.usdt)} USDT · ${statusLabelHtml(o.status)}`).join('\n')
      : 'No orders in this category.';

    const orderButtons = shown.map((o) => [
      {
        text: `#${o.id} · ${fmtMoney(o.usdt)} USDT · ${o.status}`,
        callback_data: `order:${o.id}`,
        icon_custom_emoji_id: statusIconId(o.status),
      },
    ]);

    const nav = [];
    if (safePage > 0) nav.push(backBtn(`orders:${category}:${safePage - 1}`, 'Prev'));
    nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'noop' });
    if (safePage + 1 < totalPages) {
      nav.push({ text: 'Next', callback_data: `orders:${category}:${safePage + 1}`, icon_custom_emoji_id: EMOJI_IDS.next });
    }

    return {
      text: `${tgEmoji(EMOJI_IDS.myOrders, '📋')} <b>My Orders — ${title}</b>\nPage ${safePage + 1}/${totalPages} · ${mine.length} total\n\n${lines}\n\nTap an order for details:`,
      buttons: [
        ...orderButtons,
        [
          { text: category === 'open' ? '• Open' : 'Open', callback_data: 'orders:open:0', icon_custom_emoji_id: EMOJI_IDS.greenDot },
          { text: category === 'done' ? '• Done' : 'Done', callback_data: 'orders:done:0', icon_custom_emoji_id: EMOJI_IDS.available },
          { text: category === 'cancelled' ? '• Cancelled' : 'Cancelled', callback_data: 'orders:cancelled:0', icon_custom_emoji_id: EMOJI_IDS.redDot },
        ],
        nav,
        [
          { text: 'Refresh', callback_data: `orders:${category}:${safePage}`, icon_custom_emoji_id: EMOJI_IDS.refresh },
          backBtn('home'),
          cancelBtn('home'),
        ],
      ],
    };
  }

  buildOrderDetailScreen(userId, orderId) {
    const o = getOrderById(orderId);
    if (!o || (o.userId !== userId && !isAdmin(userId))) {
      return {
        text: `${tgEmoji(EMOJI_IDS.cancel, '❌')} Order not found.`,
        buttons: [[backBtn('orders'), cancelBtn('home')]],
      };
    }

    const net = db.config.NETWORKS[o.network];
    const pay = db.config.PAYMENTS[o.method];
    const expUrl = o.txHash && net?.explorer ? `${net.explorer}${o.txHash}` : null;
    const text =
      `${tgEmoji(EMOJI_IDS.receipt, '🧾')} <b>Order #${o.id}</b>\n\n` +
      `Status: ${statusLabelHtml(o.status)}\n` +
      `Amount: <b>${fmtMoney(o.usdt)} USDT</b>\n` +
      `Payable: <b>${fmtMoney(o.etb)} ETB</b>\n` +
      `Network: ${netEmojiHtml(o.network, net?.emoji)} ${escHtml(net?.label || o.network)}\n` +
      `Payment: ${payLabelHtml(o.method, pay?.label)}\n` +
      `Wallet: <code>${escHtml(o.wallet)}</code>\n` +
      `Created: ${new Date(o.createdAt).toLocaleString()}` +
      `${o.txRef ? `\nPayment Ref: <code>${escHtml(o.txRef)}</code>` : ''}` +
      `${o.withdrawId ? `\nWithdrawal ID: <code>${escHtml(o.withdrawId)}</code>` : ''}` +
      `${o.txHash ? `\nTX Hash: <code>${escHtml(o.txHash)}</code>` : ''}` +
      `${expUrl ? `\n${tgEmoji(EMOJI_IDS.link, '🔗')} <a href="${expUrl}">View Transaction on ${escHtml(net?.label || o.network)} Explorer</a>` : ''}` +
      `${o.error ? `\nNote: <i>${escHtml(userSafeReason(o.error))}</i>` : ''}`;

    const actionRow = [];
    if (o.status === 'awaiting_payment') actionRow.push(cancelBtn(`cancel:${o.id}`, 'Cancel Order'));
    if (['failed', 'rejected', 'expired', 'cancelled'].includes(o.status)) {
      actionRow.push({ text: 'Report Failed Issue', callback_data: `supportorder:failed:${o.id}`, icon_custom_emoji_id: EMOJI_IDS.support });
    }

    const buttons = [];
    if (actionRow.length) buttons.push(actionRow);
    buttons.push([backBtn(`orders:${orderCategory(o.status)}:0`), cancelBtn('home')]);
    return { text, buttons };
  }

  // ======================== SUPPORT ========================
  buildSupportMenuScreen(userId) {
    this.resetSession(userId);
    return {
      text: `${tgEmoji(EMOJI_IDS.support, '🎧')} <b>Support Center</b>\n\nWhat do you need help with?`,
      buttons: [
        [{ text: 'Failed Order', callback_data: 'support:failed', icon_custom_emoji_id: EMOJI_IDS.warning }],
        [{ text: 'USDT Not Received', callback_data: 'support:not_received', icon_custom_emoji_id: EMOJI_IDS.greenDot }],
        [{ text: 'Other Issue', callback_data: 'support:other', icon_custom_emoji_id: EMOJI_IDS.alert }],
        [backBtn('home'), cancelBtn('home')],
      ],
    };
  }

  buildSupportOrderListScreen(userId, type) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const candidates = db.orders
      .filter(
        (o) =>
          o.userId === userId &&
          o.createdAt >= cutoff &&
          (type === 'failed'
            ? ['rejected', 'failed', 'expired', 'cancelled'].includes(o.status)
            : ['completed', 'sending', 'failed'].includes(o.status))
      )
      .sort((a, b) => b.createdAt - a.createdAt);

    if (!candidates.length) {
      return {
        text: `${tgEmoji(EMOJI_IDS.receipt, '🧾')} No matching ${type === 'failed' ? 'failed' : 'recent'} orders were found in the last 7 days.`,
        buttons: [
          [{ text: 'Other Issue', callback_data: 'support:other', icon_custom_emoji_id: EMOJI_IDS.alert }],
          [backBtn('support'), cancelBtn('home')],
        ],
      };
    }

    const rows = candidates.slice(0, 8).map((o) => [
      {
        text: `#${o.id} · ${o.status} · ${fmtMoney(o.usdt)} USDT`,
        callback_data: `supportorder:${type}:${o.id}`,
        icon_custom_emoji_id: statusIconId(o.status),
      },
    ]);
    rows.push([{ text: 'Switch to Other', callback_data: 'support:other', icon_custom_emoji_id: EMOJI_IDS.alert }]);
    rows.push([backBtn('support'), cancelBtn('home')]);

    return {
      text:
        `${tgEmoji(EMOJI_IDS.receipt, '🧾')} <b>${type === 'failed' ? 'Failed Orders' : 'USDT Not Received'}</b>\n` +
        `${candidates.length} order(s) found · Tap an order to report your issue:`,
      buttons: rows,
    };
  }

  buildSupportIssuePromptScreen(userId, type, orderId) {
    const o = getOrderById(orderId);
    if (!o || o.userId !== userId) {
      return {
        text: `${tgEmoji(EMOJI_IDS.cancel, '❌')} Order not found.`,
        buttons: [[backBtn(`support:${type}`), cancelBtn('home')]],
      };
    }

    const s = this.getSession(userId);
    s.step = 'support_issue_input';
    s.supportType = type;
    s.supportOrderId = orderId;

    return {
      text:
        `${tgEmoji(EMOJI_IDS.attach, '📎')} <b>Describe Issue for Order #${o.id}</b>\n\n` +
        `Amount: <b>${fmtMoney(o.usdt)} USDT</b> (${statusLabelHtml(o.status)})\n\n` +
        `Please send an <b>image (screenshot)</b> or a <b>text message</b> explaining what went wrong.`,
      buttons: [[backBtn(`support:${type}`), cancelBtn('home')]],
    };
  }

  // ======================== ADMIN SCREENS (WITH USERS & BAN/UNBAN) ========================
  buildWalletBalanceLines() {
    const hw = this.hotWallet;
    if (!hw || !hw.configured) return '';
    const f = (v) => (typeof v === 'number' ? v.toFixed(4) : 'n/a');
    let out =
      `${tgEmoji(EMOJI_IDS.polygon, '🟣')} Polygon: <b>${f(hw.polygonUsdt)} USDT</b> in wallet · reserved ${f(hw.polygonReserved)} · <b>shown to users ${f(db.config.STOCK.polygon)}</b> · gas ${f(hw.polygonGas)} POL\n` +
      `${tgEmoji(EMOJI_IDS.bep20, '🟡')} BEP20: <b>${f(hw.bep20Usdt)} USDT</b> in wallet · reserved ${f(hw.bep20Reserved)} · <b>shown to users ${f(db.config.STOCK.bep20)}</b> · gas ${f(hw.bep20Gas)} BNB\n`;
    if (hw.lastError) out += `${tgEmoji(EMOJI_IDS.warning, '⚠️')} ${escHtml(String(hw.lastError).slice(0, 160))}\n`;
    return out;
  }

  buildAdminHomeScreen() {
    const pending = db.orders.filter((o) => o.status === 'pending_review').length;
    const failed = db.orders.filter((o) => o.status === 'failed').length;
    const openTickets = db.supportTickets.filter((t) => t.status === 'open').length;
    const bannedCount = db.users.filter((u) => u.banned).length;
    const hwAddr = getWalletAddress(db.config.WALLET_PRIVATE_KEY);

    return {
      text:
        `${tgEmoji(EMOJI_IDS.adminTools, '🛠')} <b>Admin Control Panel</b>\n\n` +
        `Hot Wallet: <b>${hwAddr ? `${tgEmoji(EMOJI_IDS.available, '✅')} ${hwAddr.slice(0, 8)}...${hwAddr.slice(-4)}` : `${tgEmoji(EMOJI_IDS.whiteDot, '⚪')} Not Set`}</b>\n` +
        `${this.buildWalletBalanceLines()}` +
        `Verify.et: <b>${db.config.VERIFY_ET_ENABLED && db.config.VERIFY_ET_API_KEY ? `${tgEmoji(EMOJI_IDS.available, '✅')} Active` : `${tgEmoji(EMOJI_IDS.whiteDot, '⚪')} Manual Review`}</b>\n` +
        `Users: <b>${db.users.length}</b> (${bannedCount} banned) · Pending: <b>${pending}</b> · Failed: <b>${failed}</b> · Tickets: <b>${openTickets}</b>`,
      buttons: [
        [
          { text: `Orders (${pending + failed})`, callback_data: 'admin:orders', icon_custom_emoji_id: EMOJI_IDS.receipt },
          { text: `Tickets (${openTickets})`, callback_data: 'admin:tickets', icon_custom_emoji_id: EMOJI_IDS.support },
        ],
        [
          { text: `Registered Users (${db.users.length})`, callback_data: 'admin:users:0', icon_custom_emoji_id: EMOJI_IDS.help },
        ],
        [
          { text: 'Edit Config & Fields', callback_data: 'admin:config', icon_custom_emoji_id: EMOJI_IDS.settings },
          { text: 'Payment Methods', callback_data: 'admin:payments', icon_custom_emoji_id: EMOJI_IDS.payFirst },
        ],
        [
          { text: 'Sync Wallet Balance', callback_data: 'admin:sync_balance', icon_custom_emoji_id: EMOJI_IDS.refresh },
          { text: 'Broadcast Message', callback_data: 'admin:broadcast', icon_custom_emoji_id: EMOJI_IDS.broadcast },
        ],
        [
          {
            text: db.config.MAINTENANCE_MODE ? 'Resume Bot' : 'Maintenance Mode',
            callback_data: 'admin:toggle:maintenance',
            icon_custom_emoji_id: db.config.MAINTENANCE_MODE ? EMOJI_IDS.greenDot : EMOJI_IDS.warning,
          },
          backBtn('home', 'Back to Menu'),
        ],
      ],
    };
  }

  buildAdminUsersScreen(page = 0) {
    const sorted = db.users.slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const shown = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);

    const lines = shown.length
      ? shown
          .map(
            (u) =>
              `• <b>${escHtml(u.firstName)}</b> ${u.username ? `(@${escHtml(u.username)})` : ''} — <code>${u.id}</code> [${u.banned ? '🚫 BANNED' : '✅ Active'}]`
          )
          .join('\n')
      : 'No registered users yet.';

    const rows = shown.map((u) => [
      {
        text: `${u.banned ? '🚫' : '✅'} ${u.firstName} (${u.username ? '@' + u.username : u.id})`,
        callback_data: `admin:user:${u.id}:${safePage}`,
        icon_custom_emoji_id: u.banned ? EMOJI_IDS.blocked : EMOJI_IDS.greenDot,
      },
      {
        text: u.banned ? 'Unban' : 'Ban',
        callback_data: `admin:ban:${u.id}:${safePage}`,
        icon_custom_emoji_id: u.banned ? EMOJI_IDS.available : EMOJI_IDS.blocked,
      },
    ]);

    const nav = [];
    if (safePage > 0) nav.push(backBtn(`admin:users:${safePage - 1}`, 'Prev'));
    nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'noop' });
    if (safePage + 1 < totalPages) {
      nav.push({ text: 'Next', callback_data: `admin:users:${safePage + 1}`, icon_custom_emoji_id: EMOJI_IDS.next });
    }
    rows.push(nav);
    rows.push([backBtn('admin:home'), cancelBtn('home')]);

    return {
      text:
        `${tgEmoji(EMOJI_IDS.help, '👮')} <b>Registered Users (${db.users.length})</b>\n` +
        `Page ${safePage + 1}/${totalPages} · Tap a user for details or tap <b>Ban / Unban</b>:\n\n` +
        `${lines}`,
      buttons: rows,
    };
  }

  buildAdminUserDetailScreen(targetUserId, page = 0) {
    const u = db.users.find((x) => x.id === Number(targetUserId));
    if (!u) {
      return {
        text: `${tgEmoji(EMOJI_IDS.cancel, '❌')} User not found.`,
        buttons: [[backBtn(`admin:users:${page}`)]],
      };
    }
    const userOrders = db.orders.filter((o) => o.userId === u.id);
    const completedOrders = userOrders.filter((o) => o.status === 'completed');
    const totalUsdt = completedOrders.reduce((s, o) => s + o.usdt, 0);

    return {
      text:
        `${tgEmoji(EMOJI_IDS.help, '👮')} <b>User Details</b>\n\n` +
        `Name: <b>${escHtml(u.firstName)}</b>\n` +
        `Username: ${u.username ? '@' + escHtml(u.username) : '<i>none</i>'}\n` +
        `Telegram ID: <code>${u.id}</code>\n` +
        `Status: <b>${u.banned ? `${tgEmoji(EMOJI_IDS.blocked, '🚫')} BANNED` : `${tgEmoji(EMOJI_IDS.available, '✅')} Active`}</b>\n` +
        `Orders: <b>${userOrders.length} total</b> (${completedOrders.length} completed · ${fmtMoney(totalUsdt)} USDT)\n` +
        `Joined: ${new Date(u.joinedAt).toLocaleString()}\n` +
        `Last Active: ${new Date(u.lastActiveAt).toLocaleString()}`,
      buttons: [
        [
          {
            text: u.banned ? 'Unban User' : 'Ban User',
            callback_data: `admin:banview:${u.id}:${page}`,
            icon_custom_emoji_id: u.banned ? EMOJI_IDS.available : EMOJI_IDS.blocked,
          },
        ],
        [backBtn(`admin:users:${page}`), cancelBtn('home')],
      ],
    };
  }

  buildAdminConfigScreen() {
    const c = db.config;
    return {
      text:
        `${tgEmoji(EMOJI_IDS.settings, '⚙️')} <b>Bot Configuration</b>\n\n` +
        `• Rate: <b>${fmtMoney(c.RATE)} ETB</b> (Small ≤1: ${fmtMoney(c.SMALL_ORDER_RATE)})\n` +
        `• Min / Max: <b>${c.MIN_USDT}</b> / <b>${c.MAX_USDT} USDT</b>\n` +
        `• Daily Limit: <b>${c.DAILY_LIMIT_USDT} USDT</b>\n` +
        `• Window / Attempts: <b>${c.PAYMENT_WINDOW_MIN}m</b> / <b>${c.VERIFY_ATTEMPTS}</b>\n` +
        `• Stock Polygon / BEP20: <b>${fmtUsdt(c.STOCK.polygon)}</b> / <b>${fmtUsdt(c.STOCK.bep20)}</b>\n` +
        `• Auto-Approve Verify.et: <b>${c.AUTO_APPROVE ? 'ON' : 'OFF'}</b>\n\n` +
        `Tap any field below to edit it directly:`,
      buttons: [
        [
          { text: 'Edit Rate', callback_data: 'admin:edit:RATE', icon_custom_emoji_id: EMOJI_IDS.rateChart },
          { text: 'Edit Small Rate', callback_data: 'admin:edit:SMALL_ORDER_RATE', icon_custom_emoji_id: EMOJI_IDS.tieredRate },
        ],
        [
          { text: 'Edit Min USDT', callback_data: 'admin:edit:MIN_USDT', icon_custom_emoji_id: EMOJI_IDS.edit },
          { text: 'Edit Max USDT', callback_data: 'admin:edit:MAX_USDT', icon_custom_emoji_id: EMOJI_IDS.edit },
        ],
        [
          { text: 'Stock Polygon', callback_data: 'admin:edit:STOCK_POLYGON', icon_custom_emoji_id: EMOJI_IDS.polygon },
          { text: 'Stock BEP20', callback_data: 'admin:edit:STOCK_BEP20', icon_custom_emoji_id: EMOJI_IDS.bep20 },
        ],
        [
          { text: 'Hot Wallet Private Key', callback_data: 'admin:edit:WALLET_PRIVATE_KEY', icon_custom_emoji_id: EMOJI_IDS.wallet },
          { text: 'Verify.et API Key', callback_data: 'admin:edit:VERIFY_ET_API_KEY', icon_custom_emoji_id: EMOJI_IDS.lock },
        ],
        [
          { text: 'Payment Window (min)', callback_data: 'admin:edit:PAYMENT_WINDOW_MIN', icon_custom_emoji_id: EMOJI_IDS.hourglass },
          { text: 'Edit Daily Limit', callback_data: 'admin:edit:DAILY_LIMIT_USDT', icon_custom_emoji_id: EMOJI_IDS.edit },
        ],
        [{ text: 'Edit Help Text', callback_data: 'admin:edit:HELP_TEXT', icon_custom_emoji_id: EMOJI_IDS.help }],
        [backBtn('admin:home'), cancelBtn('home')],
      ],
    };
  }

  buildAdminOrdersScreen() {
    const actionable = db.orders
      .filter((o) => ['pending_review', 'failed', 'awaiting_payment'].includes(o.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8);

    const rows = actionable.map((o) => [
      {
        text: `#${o.id} · ${o.status} · ${fmtMoney(o.usdt)} USDT`,
        callback_data: `admin:order:${o.id}`,
        icon_custom_emoji_id: statusIconId(o.status),
      },
    ]);
    rows.push([backBtn('admin:home'), cancelBtn('home')]);

    return {
      text: actionable.length
        ? `${tgEmoji(EMOJI_IDS.receipt, '🧾')} <b>Actionable Orders (${actionable.length})</b>\nTap an order to approve, reject, or retry:`
        : `${tgEmoji(EMOJI_IDS.receipt, '🧾')} <b>Actionable Orders</b>\n\nNo pending or failed orders right now.`,
      buttons: rows,
    };
  }

  buildAdminOrderActionsScreen(orderId) {
    const o = getOrderById(orderId);
    if (!o) {
      return {
        text: `${tgEmoji(EMOJI_IDS.cancel, '❌')} Order not found.`,
        buttons: [[backBtn('admin:orders')]],
      };
    }

    const buttons = [];
    if (o.status === 'pending_review') {
      buttons.push([
        { text: 'Approve & Send', callback_data: `approve:${o.id}`, icon_custom_emoji_id: EMOJI_IDS.available },
        cancelBtn(`reject:${o.id}`, 'Reject'),
      ]);
    } else if (o.status === 'failed') {
      buttons.push([
        { text: 'Retry Send', callback_data: `admin:retry:${o.id}`, icon_custom_emoji_id: EMOJI_IDS.refresh },
        cancelBtn(`admin:refund:${o.id}`, 'Cancel & Refund Stock'),
      ]);
    }
    buttons.push([backBtn('admin:orders'), cancelBtn('home')]);

    return {
      text:
        `${tgEmoji(EMOJI_IDS.receipt, '🧾')} <b>Admin Order #${o.id}</b>\n` +
        `Status: ${statusLabelHtml(o.status)}\n` +
        `User: ${o.username ? '@' + escHtml(o.username) : o.userId}\n` +
        `Amount: <b>${fmtMoney(o.usdt)} USDT</b> (${fmtMoney(o.etb)} ETB)\n` +
        `Network: ${netEmojiHtml(o.network)} ${o.network} · Method: ${payLabelHtml(o.method, db.config.PAYMENTS[o.method]?.label)}\n` +
        `Wallet: <code>${escHtml(o.wallet)}</code>` +
        `${o.txRef ? `\nTX Ref: <code>${escHtml(o.txRef)}</code>` : ''}` +
        `${o.error ? `\nError: <i>${escHtml(o.error)}</i>` : ''}`,
      buttons,
    };
  }

  buildAdminTicketsScreen() {
    const open = db.supportTickets.filter((t) => t.status === 'open').slice(0, 8);
    const rows = open.map((t) => [
      {
        text: `Ticket #${t.id} · ${t.orderId ? `Order #${t.orderId}` : 'General'}`,
        callback_data: `admin:ticket:${t.id}`,
        icon_custom_emoji_id: EMOJI_IDS.support,
      },
    ]);
    rows.push([backBtn('admin:home'), cancelBtn('home')]);

    return {
      text: open.length
        ? `${tgEmoji(EMOJI_IDS.support, '🎧')} <b>Open Support Tickets (${open.length})</b>`
        : `${tgEmoji(EMOJI_IDS.support, '🎧')} <b>Open Support Tickets</b>\n\nAll tickets are resolved.`,
      buttons: rows,
    };
  }

  // ======================== ORDER LIFECYCLE ========================
  async createOrderFromSession(userId, username, wallet) {
    const s = this.getSession(userId);
    if (!s.method || !s.network || !s.amount) return this.buildPaymentMethodsScreen(userId);

    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet.trim())) {
      return {
        text: `${tgEmoji(EMOJI_IDS.cancel, '❌')} Invalid wallet address. Please send a valid <code>0x...</code> Polygon/BEP20 address (42 characters).`,
        buttons: [[backBtn('amount:back'), cancelBtn('home')]],
      };
    }

    const order = {
      id: ++db.lastId,
      userId,
      username,
      network: s.network,
      method: s.method,
      usdt: s.amount,
      etb: calculateEtb(s.amount, s.method),
      wallet: wallet.trim(),
      status: 'awaiting_payment',
      createdAt: Date.now(),
      expiresAt: Date.now() + db.config.PAYMENT_WINDOW_MIN * 60000,
      attemptsRemaining: db.config.VERIFY_ATTEMPTS,
    };

    db.config.STOCK[order.network] = Math.max(0, Number(((db.config.STOCK[order.network] ?? 0) - order.usdt).toFixed(6)));
    db.orders.push(order);
    saveDb();
    this.resetSession(userId);
    return this.buildOrderCardScreen(order);
  }

  async processPaymentProof(userId, order, rawText, photoFileId, onProgress) {
    if ((order.attemptsRemaining ?? db.config.VERIFY_ATTEMPTS) <= 0) {
      return {
        text: `${tgEmoji(EMOJI_IDS.warning, '⚠️')} No automatic verification attempts remain for this order. Please contact Support.`,
        buttons: [
          [{ text: 'Contact Support', callback_data: `supportorder:failed:${order.id}`, icon_custom_emoji_id: EMOJI_IDS.support }],
          [backBtn('home')],
        ],
      };
    }

    const payCfg = db.config.PAYMENTS[order.method];
    const isTelebirr = (payCfg?.verifyBank || order.method) === 'telebirr';
    const receiptUrl = extractReceiptUrl(rawText);
    const txId = extractTxReference(rawText);

    if (isTelebirr && !txId) {
      order.attemptsRemaining = Math.max(0, order.attemptsRemaining - 1);
      saveDb();
      return {
        text:
          `${tgEmoji(EMOJI_IDS.cancel, '❌')} Please send a valid <b>Telebirr Transaction ID</b> (e.g. <code>DIH4TABDII</code>).\n\n` +
          `Attempts remaining: <b>${order.attemptsRemaining}</b>`,
        buttons: [[cancelBtn(`cancel:${order.id}`, 'Cancel Order')], [backBtn('home')]],
      };
    }

    if (!isTelebirr && !receiptUrl) {
      order.attemptsRemaining = Math.max(0, order.attemptsRemaining - 1);
      saveDb();
      return {
        text:
          `${tgEmoji(EMOJI_IDS.cancel, '❌')} Please send the <b>Transaction Receipt Link (URL)</b> starting with <code>https://...</code> for ${payLabelHtml(order.method, payCfg?.label)}.\n\n` +
          `Attempts remaining: <b>${order.attemptsRemaining}</b>`,
        buttons: [[cancelBtn(`cancel:${order.id}`, 'Cancel Order')], [backBtn('home')]],
      };
    }

    const verifyInput = isTelebirr ? txId : receiptUrl;
    const effectiveRef = (txId || receiptUrl || `PROOF-${Date.now()}`).toUpperCase();

    if (db.usedTx.includes(effectiveRef)) {
      order.attemptsRemaining = Math.max(0, order.attemptsRemaining - 1);
      saveDb();
      return {
        text: `${tgEmoji(EMOJI_IDS.cancel, '❌')} Transaction reference <code>${escHtml(effectiveRef)}</code> was already used.\nAttempts remaining: <b>${order.attemptsRemaining}</b>`,
        buttons: [[cancelBtn(`cancel:${order.id}`, 'Cancel Order')], [backBtn('home')]],
      };
    }

    db.usedTx.push(effectiveRef);
    order.txRef = verifyInput;
    order.proofText = rawText.slice(0, 1000);
    if (photoFileId) order.proofPhotoId = photoFileId;
    order.status = 'pending_review';
    saveDb();

    if (onProgress) {
      await onProgress({
        text:
          `${tgEmoji(EMOJI_IDS.search, '🔎')} <b>Verifying Payment for Order #${order.id}…</b>\n\n` +
          `${payLabelHtml(order.method, payCfg?.label)}\n` +
          `${tgEmoji(EMOJI_IDS.tieredRate, '💵')} Amount: <b>${fmtMoney(order.etb)} ETB</b> (${fmtMoney(order.usdt)} USDT)\n` +
          `${tgEmoji(EMOJI_IDS.receipt, '🧾')} Ref: <code>${escHtml(verifyInput)}</code>\n\n` +
          `${tgEmoji(EMOJI_IDS.hourglass, '⏳')} Checking your transaction details, please wait…`,
        buttons: [],
      });
    }

    const verify = await verifyWithVerifyEt(order, verifyInput, rawText);

    if (verify.txId && verify.txId.toUpperCase() !== effectiveRef) {
      const resolvedUpper = verify.txId.toUpperCase();
      if (db.usedTx.includes(resolvedUpper)) {
        order.status = 'rejected';
        order.error = `Transaction ID ${verify.txId} was already used`;
        releaseStock(order);
        saveDb();
        return {
          text: `${tgEmoji(EMOJI_IDS.cancel, '❌')} <b>Order #${order.id} Rejected</b>\n\nReason: Transaction ID <code>${escHtml(verify.txId)}</code> was already used.`,
          buttons: [
            [{ text: 'Report Issue', callback_data: `supportorder:failed:${order.id}`, icon_custom_emoji_id: EMOJI_IDS.support }],
            [backBtn('home')],
          ],
        };
      }
      db.usedTx.push(resolvedUpper);
      order.txRef = verify.txId;
    }

    order.verifyProvider = verify.provider;
    order.verifyNote = verify.reason;
    saveDb();

    if (verify.verdict === 'ok' && db.config.AUTO_APPROVE) {
      if (onProgress) {
        await onProgress({
          text:
            `${tgEmoji(EMOJI_IDS.sending, '📤')} <b>Payment Verified — Sending USDT…</b>\n\n` +
            `Order: <b>#${order.id}</b> · <b>${fmtMoney(order.usdt)} USDT</b>\n` +
            `Wallet: <code>${escHtml(order.wallet)}</code>`,
          buttons: [],
        });
      }
      await this.fulfillOrder(order, false);
      return this.buildOrderDetailScreen(userId, order.id);
    }

    if (verify.verdict === 'bad') {
      order.status = 'rejected';
      order.error = verify.reason;
      releaseStock(order);
      saveDb();
      return {
        text: `${tgEmoji(EMOJI_IDS.cancel, '❌')} <b>Order #${order.id} Rejected</b>\n\nReason: ${escHtml(userSafeReason(verify.reason))}`,
        buttons: [
          [{ text: 'Report Issue', callback_data: `supportorder:failed:${order.id}`, icon_custom_emoji_id: EMOJI_IDS.support }],
          [backBtn('home')],
        ],
      };
    }

    this.notifyAdminsOrderReview(order, rawText, photoFileId).catch(() => {});
    return {
      text:
        `${tgEmoji(EMOJI_IDS.hourglass, '⏳')} <b>Proof Received for Order #${order.id}</b>\n\n` +
        `Ref: <code>${escHtml(effectiveRef)}</code>\n` +
        `Status: ${escHtml(userSafeReason(verify.reason))}\n\n` +
        `You will be notified immediately once approved.`,
      buttons: [
        [{ text: 'Refresh Status', callback_data: `order:${order.id}`, icon_custom_emoji_id: EMOJI_IDS.refresh }],
        [backBtn('home')],
      ],
    };
  }

  async fulfillOrder(order, notifyUser = true) {
    if (order.status !== 'pending_review' && order.status !== 'failed') {
      return { ok: false, error: 'Order is not pending review or failed' };
    }
    order.status = 'sending';
    order.error = undefined;
    saveDb();

    try {
      if (!db.config.WALLET_PRIVATE_KEY) throw new Error('Hot Wallet Private Key is not configured');
      const net = db.config.NETWORKS[order.network];
      const chainKey = order.network === 'bep20' ? 'bep20' : 'polygon';
      const { txHash } = await sendHotWalletUsdt({
        privateKey: db.config.WALLET_PRIVATE_KEY,
        network: chainKey,
        toAddress: order.wallet,
        amountUsdt: order.usdt,
      });

      order.status = 'completed';
      order.txHash = txHash;
      order.withdrawId = `WEB3-${order.id}`;
      saveDb();
      this.syncHotWalletBalance().catch(() => {});

      if (this.bot && notifyUser) {
        const expUrl = `${net.explorer}${txHash}`;
        this.bot.telegram
          .sendMessage(
            order.userId,
            `${tgEmoji(EMOJI_IDS.available, '✅')} <b>Order #${order.id} Completed!</b>\n\n` +
              `<b>${fmtMoney(order.usdt)} USDT</b> sent on ${netEmojiHtml(order.network, net.emoji)} <b>${net.label}</b> to:\n` +
              `<code>${escHtml(order.wallet)}</code>\n\n` +
              `${tgEmoji(EMOJI_IDS.link, '🔗')} <a href="${expUrl}">View Transaction on ${net.label} Explorer</a>\n` +
              `TX Hash: <code>${escHtml(txHash)}</code>`,
            { parse_mode: 'HTML' }
          )
          .catch(() => {});
      }
      return { ok: true };
    } catch (err) {
      order.status = 'failed';
      order.error = err?.message || 'Hot Wallet transfer error';
      saveDb();

      if (this.bot) {
        if (notifyUser) {
          this.bot.telegram
            .sendMessage(
              order.userId,
              `${tgEmoji(EMOJI_IDS.warning, '⚠️')} Problem sending Order #${order.id}. Open ${tgEmoji(EMOJI_IDS.support, '🎧')} <b>Support -> Failed Order</b> to report or contact admin.`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }
        for (const aid of db.config.ADMIN_IDS) {
          this.bot.telegram
            .sendMessage(aid, `${tgEmoji(EMOJI_IDS.warning, '⚠️')} <b>Order #${order.id} FAILED:</b> ${escHtml(order.error)}`, { parse_mode: 'HTML' })
            .catch(() => {});
        }
      }
      return { ok: false, error: order.error };
    }
  }

  async notifyAdminsOrderReview(order, rawText, photoFileId) {
    if (!this.bot) return;
    const msg =
      `${tgEmoji(EMOJI_IDS.receipt, '🧾')} <b>Order #${order.id}</b> needs review\n` +
      `User: ${order.username ? '@' + escHtml(order.username) : order.userId}\n` +
      `${fmtMoney(order.usdt)} USDT (${order.network}) · ${fmtMoney(order.etb)} ETB\n` +
      `TX: <code>${escHtml(order.txRef || '-')}</code>\n\n` +
      `<pre>${escHtml(rawText.slice(0, 500))}</pre>`;
    const extra = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: `approve:${order.id}`, icon_custom_emoji_id: EMOJI_IDS.available },
          cancelBtn(`reject:${order.id}`, 'Reject'),
        ]],
      },
    };
    for (const adminId of db.config.ADMIN_IDS) {
      if (photoFileId) {
        await this.bot.telegram.sendPhoto(adminId, photoFileId, { caption: msg, ...extra }).catch(() => {});
      } else {
        await this.bot.telegram.sendMessage(adminId, msg, extra).catch(() => {});
      }
    }
  }

  async sendBroadcast(message, photoFileId, photoUrl) {
    let sent = 0;
    let failed = 0;
    for (const user of db.users) {
      if (user.banned || !this.bot) continue;
      try {
        if (photoFileId || photoUrl) {
          await this.bot.telegram.sendPhoto(user.id, photoFileId || photoUrl, { caption: message, parse_mode: 'HTML' });
        } else {
          await this.bot.telegram.sendMessage(user.id, message, { parse_mode: 'HTML' });
        }
        sent++;
      } catch {
        failed++;
      }
    }
    db.broadcasts.unshift({
      id: (db.broadcasts[0]?.id || 0) + 1,
      message,
      photoUrl,
      sent,
      failed,
      createdAt: Date.now(),
    });
    saveDb();
    return { sent, failed };
  }

  expireOrders() {
    const now = Date.now();
    let changed = false;
    for (const o of db.orders) {
      if (o.status === 'awaiting_payment' && now > o.expiresAt) {
        o.status = 'expired';
        releaseStock(o);
        changed = true;
        if (this.bot) {
          this.bot.telegram
            .sendMessage(
              o.userId,
              `${tgEmoji(EMOJI_IDS.expired, '⌛')} <b>Order #${o.id}</b> expired because no payment was received.`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }
      }
    }
    if (changed) saveDb();
  }

  async renderTelegramScreen(ctx, screen) {
    const userId = ctx.from?.id;
    const s = userId ? this.getSession(userId) : undefined;
    const extra = {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: screen.buttons },
    };

    if (ctx.message && !ctx._userMsgDeleted) {
      ctx._userMsgDeleted = true;
      ctx.deleteMessage().catch(() => {});
    }

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(screen.text, extra);
        return;
      } catch (err) {
        if (String(err?.message || '').includes('message is not modified')) return;
      }
    }

    if (s?.lastBotMsgId && ctx.chat?.id) {
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, s.lastBotMsgId, undefined, screen.text, extra);
        return;
      } catch (err) {
        if (String(err?.message || '').includes('message is not modified')) return;
        const oldId = s.lastBotMsgId;
        ctx.telegram.deleteMessage(ctx.chat.id, oldId).catch(() => {});
      }
    }

    const sent = await ctx.reply(screen.text, extra);
    if (s && sent?.message_id) s.lastBotMsgId = sent.message_id;
  }

  registerHandlers(bot) {
    // Middleware: Track every user and block banned non-admin users
    bot.use(async (ctx, next) => {
      if (ctx.from) {
        const u = upsertUser({
          id: ctx.from.id,
          username: ctx.from.username || null,
          firstName: ctx.from.first_name || 'Trader',
        });
        if (u.banned && !isAdmin(ctx.from.id)) {
          if (ctx.callbackQuery) {
            await ctx.answerCbQuery('🚫 Your account is banned from using this bot.', { show_alert: true }).catch(() => {});
          } else if (ctx.message) {
            await ctx.reply(`${tgEmoji(EMOJI_IDS.blocked, '🚫')} <b>Access Denied</b>\n\nYour account has been banned by an administrator.`, { parse_mode: 'HTML' }).catch(() => {});
          }
          return;
        }
      }
      return next();
    });

    bot.start(async (ctx) => {
      this.resetSession(ctx.from.id);
      await this.refreshStock();
      await this.renderTelegramScreen(ctx, this.buildHomeScreen(ctx.from.id, ctx.from.first_name || 'Trader'));
    });

    bot.command('buy', (ctx) => this.renderTelegramScreen(ctx, this.buildPaymentMethodsScreen(ctx.from.id)));
    bot.command('orders', (ctx) => this.renderTelegramScreen(ctx, this.buildOrdersScreen(ctx.from.id, 'open', 0)));
    bot.command('rate', (ctx) => this.renderTelegramScreen(ctx, this.buildRateScreen()));
    bot.command('support', (ctx) => this.renderTelegramScreen(ctx, this.buildSupportMenuScreen(ctx.from.id)));
    bot.command('help', (ctx) => this.renderTelegramScreen(ctx, this.buildHelpScreen()));
    bot.command('cancel', (ctx) => {
      this.resetSession(ctx.from.id);
      return this.renderTelegramScreen(ctx, this.buildHomeScreen(ctx.from.id, ctx.from.first_name || 'Trader'));
    });
    bot.command('admin', async (ctx) => {
      if (!isAdmin(ctx.from.id)) {
        if (ctx.message) ctx.deleteMessage().catch(() => {});
        return ctx.reply(`${tgEmoji(EMOJI_IDS.blocked, '🚫')} Admins only.`, { parse_mode: 'HTML' });
      }
      await this.refreshStock(5000);
      await this.renderTelegramScreen(ctx, this.buildAdminHomeScreen());
    });

    bot.action('noop', (ctx) => ctx.answerCbQuery());
    bot.action('home', async (ctx) => {
      await ctx.answerCbQuery();
      this.resetSession(ctx.from.id);
      await this.refreshStock();
      await this.renderTelegramScreen(ctx, this.buildHomeScreen(ctx.from.id, ctx.from.first_name || 'Trader'));
    });
    bot.action('help', async (ctx) => {
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildHelpScreen());
    });
    bot.action('rate', async (ctx) => {
      await ctx.answerCbQuery();
      await this.refreshStock();
      await this.renderTelegramScreen(ctx, this.buildRateScreen());
    });
    bot.action('buy', async (ctx) => {
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildPaymentMethodsScreen(ctx.from.id));
    });
    bot.action(/^pay:(\w+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.refreshStock();
      await this.renderTelegramScreen(ctx, this.buildNetworkScreen(ctx.from.id, ctx.match[1]));
    });
    bot.action(/^net:(\w+)$/, async (ctx) => {
      const net = ctx.match[1];
      await this.refreshStock();
      if ((db.config.STOCK[net] ?? 0) < db.config.MIN_USDT) {
        return ctx.answerCbQuery('Out of stock on this network', { show_alert: true });
      }
      const s = this.getSession(ctx.from.id);
      s.network = net;
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildAmountScreen(ctx.from.id));
    });
    bot.action(/^amount:preset:(\d+)$/, async (ctx) => {
      const sPre = this.getSession(ctx.from.id);
      const maxPre = Math.min(db.config.MAX_USDT, db.config.STOCK[sPre.network || 'polygon'] ?? 0);
      if (Number(ctx.match[1]) > maxPre) {
        return ctx.answerCbQuery(`Only ${fmtUsdt(maxPre)} USDT available right now`, { show_alert: true });
      }
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildWalletPromptScreen(ctx.from.id, Number(ctx.match[1])));
    });
    bot.action('amount:custom', async (ctx) => {
      const s = this.getSession(ctx.from.id);
      s.step = 'amount_custom';
      const max = Math.min(db.config.MAX_USDT, db.config.STOCK[s.network || 'polygon'] ?? 0);
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, {
        text: `${tgEmoji(EMOJI_IDS.edit, '✍️')} <b>Enter Custom USDT Amount</b>\n\nMin: ${fmtMoney(db.config.MIN_USDT)} · Max: ${fmtMoney(max)} USDT`,
        buttons: [[backBtn('amount:back'), cancelBtn('home')]],
      });
    });
    bot.action('amount:back', async (ctx) => {
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildAmountScreen(ctx.from.id));
    });
    bot.action('orders', async (ctx) => {
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildOrdersScreen(ctx.from.id, 'open', 0));
    });
    bot.action(/^orders:(open|done|cancelled):(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildOrdersScreen(ctx.from.id, ctx.match[1], Number(ctx.match[2])));
    });
    bot.action(/^order:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildOrderDetailScreen(ctx.from.id, Number(ctx.match[1])));
    });
    bot.action(/^cancel:(\d+)$/, async (ctx) => {
      const o = getOrderById(ctx.match[1]);
      if (!o || o.userId !== ctx.from.id) return ctx.answerCbQuery('Order not found', { show_alert: true });
      if (o.status !== 'awaiting_payment') return ctx.answerCbQuery('Order can no longer be cancelled', { show_alert: true });
      o.status = 'cancelled';
      releaseStock(o);
      saveDb();
      await ctx.answerCbQuery('Order cancelled');
      await this.renderTelegramScreen(ctx, this.buildOrderDetailScreen(ctx.from.id, o.id));
    });

    // Support actions
    bot.action('support', async (ctx) => {
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildSupportMenuScreen(ctx.from.id));
    });
    bot.action(/^support:(failed|not_received)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildSupportOrderListScreen(ctx.from.id, ctx.match[1]));
    });
    bot.action(/^supportorder:(failed|not_received):(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildSupportIssuePromptScreen(ctx.from.id, ctx.match[1], Number(ctx.match[2])));
    });
    bot.action('support:other', async (ctx) => {
      const s = this.getSession(ctx.from.id);
      s.step = 'support_other_input';
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, {
        text: `${tgEmoji(EMOJI_IDS.alert, '🚨')} <b>Other Support Issue</b>\n\nSend a screenshot photo or text describing your issue:`,
        buttons: [[backBtn('support'), cancelBtn('home')]],
      });
    });

    // Admin actions
    bot.action('admin:home', async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      await ctx.answerCbQuery();
      this.resetSession(ctx.from.id);
      await this.refreshStock(5000);
      await this.renderTelegramScreen(ctx, this.buildAdminHomeScreen());
    });

    bot.action(/^admin:users:(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildAdminUsersScreen(Number(ctx.match[1])));
    });

    bot.action(/^admin:user:(\d+):(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildAdminUserDetailScreen(Number(ctx.match[1]), Number(ctx.match[2])));
    });

    bot.action(/^admin:ban:(\d+):(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const targetId = Number(ctx.match[1]);
      const page = Number(ctx.match[2]);
      if (isAdmin(targetId)) {
        return ctx.answerCbQuery('Cannot ban an admin account', { show_alert: true });
      }
      const u = db.users.find((x) => x.id === targetId);
      if (!u) return ctx.answerCbQuery('User not found');
      u.banned = !u.banned;
      saveDb();
      await ctx.answerCbQuery(u.banned ? `Banned ${u.firstName}` : `Unbanned ${u.firstName}`);
      await this.renderTelegramScreen(ctx, this.buildAdminUsersScreen(page));
    });

    bot.action(/^admin:banview:(\d+):(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const targetId = Number(ctx.match[1]);
      const page = Number(ctx.match[2]);
      if (isAdmin(targetId)) {
        return ctx.answerCbQuery('Cannot ban an admin account', { show_alert: true });
      }
      const u = db.users.find((x) => x.id === targetId);
      if (!u) return ctx.answerCbQuery('User not found');
      u.banned = !u.banned;
      saveDb();
      await ctx.answerCbQuery(u.banned ? `Banned ${u.firstName}` : `Unbanned ${u.firstName}`);
      await this.renderTelegramScreen(ctx, this.buildAdminUserDetailScreen(targetId, page));
    });

    bot.action('admin:sync_balance', async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const hw = await this.syncHotWalletBalance();
      const msg = !hw.configured
        ? 'Wallet sync error: Set Private Key first'
        : `Polygon: ${hw.polygonUsdt ?? 'n/a'} USDT (gas ${hw.polygonGas ?? 'n/a'}) · BEP20: ${hw.bep20Usdt ?? 'n/a'} USDT (gas ${hw.bep20Gas ?? 'n/a'})` +
          (hw.lastError ? `\nErrors: ${hw.lastError}`.slice(0, 150) : '');
      await ctx.answerCbQuery(msg, { show_alert: true });
      await this.refreshStock(5000);
      await this.renderTelegramScreen(ctx, this.buildAdminHomeScreen());
    });

    bot.action('admin:config', async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildAdminConfigScreen());
    });

    bot.action('admin:payments', async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      await ctx.answerCbQuery();
      const rows = Object.entries(db.config.PAYMENTS).map(([k, p]) => [
        {
          text: `${p.enabled ? 'ON' : 'OFF'} · ${stripLeadingEmoji(p.label)} (${p.account})`,
          callback_data: `admin:paymethod:${k}`,
          icon_custom_emoji_id: payButtonIcon(k),
        },
      ]);
      rows.push([backBtn('admin:home'), cancelBtn('home')]);
      await this.renderTelegramScreen(ctx, {
        text: `${tgEmoji(EMOJI_IDS.payFirst, '💳')} <b>Payment Methods</b>\n\nTap a payment method to toggle ON/OFF or edit its Account Number & Receiver Name:`,
        buttons: rows,
      });
    });

    bot.action(/^admin:paymethod:(\w+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const k = ctx.match[1];
      const p = db.config.PAYMENTS[k];
      if (!p) return ctx.answerCbQuery('Method not found');
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, {
        text:
          `${payLabelHtml(k, p.label)}\n\n` +
          `Status: <b>${p.enabled ? 'ENABLED (ON)' : 'DISABLED (OFF)'}</b>\n` +
          `Account: <code>${escHtml(p.account)}</code>\n` +
          `Receiver Name: <b>${escHtml(p.name)}</b>\n` +
          `Verify.et Bank: <code>${escHtml(p.verifyBank)}</code>`,
        buttons: [
          [{ text: p.enabled ? 'Disable Method' : 'Enable Method', callback_data: `admin:paytoggle:${k}`, icon_custom_emoji_id: p.enabled ? EMOJI_IDS.redDot : EMOJI_IDS.greenDot }],
          [
            { text: 'Edit Account Number', callback_data: `admin:edit:PAY_ACC_${k}`, icon_custom_emoji_id: EMOJI_IDS.edit },
            { text: 'Edit Receiver Name', callback_data: `admin:edit:PAY_NAME_${k}`, icon_custom_emoji_id: EMOJI_IDS.edit },
          ],
          [backBtn('admin:payments'), cancelBtn('home')],
        ],
      });
    });

    bot.action(/^admin:paytoggle:(\w+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const k = ctx.match[1];
      const p = db.config.PAYMENTS[k];
      if (p) {
        p.enabled = !p.enabled;
        touchConfig();
      }
      await ctx.answerCbQuery('Updated');
      if (!p) return;
      await this.renderTelegramScreen(ctx, {
        text:
          `${payLabelHtml(k, p.label)}\n\n` +
          `Status: <b>${p.enabled ? 'ENABLED (ON)' : 'DISABLED (OFF)'}</b>\n` +
          `Account: <code>${escHtml(p.account)}</code>\n` +
          `Receiver Name: <b>${escHtml(p.name)}</b>\n` +
          `Verify.et Bank: <code>${escHtml(p.verifyBank)}</code>`,
        buttons: [
          [{ text: p.enabled ? 'Disable Method' : 'Enable Method', callback_data: `admin:paytoggle:${k}`, icon_custom_emoji_id: p.enabled ? EMOJI_IDS.redDot : EMOJI_IDS.greenDot }],
          [
            { text: 'Edit Account Number', callback_data: `admin:edit:PAY_ACC_${k}`, icon_custom_emoji_id: EMOJI_IDS.edit },
            { text: 'Edit Receiver Name', callback_data: `admin:edit:PAY_NAME_${k}`, icon_custom_emoji_id: EMOJI_IDS.edit },
          ],
          [backBtn('admin:payments'), cancelBtn('home')],
        ],
      });
    });

    bot.action('admin:orders', async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildAdminOrdersScreen());
    });
    bot.action(/^admin:order:(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildAdminOrderActionsScreen(Number(ctx.match[1])));
    });
    bot.action(/^admin:retry:(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const o = getOrderById(ctx.match[1]);
      if (!o) return ctx.answerCbQuery('Order not found');
      await ctx.answerCbQuery('Retrying send…');
      await this.fulfillOrder(o);
      await this.renderTelegramScreen(ctx, this.buildAdminOrderActionsScreen(o.id));
    });
    bot.action(/^admin:refund:(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const o = getOrderById(ctx.match[1]);
      if (o) {
        o.status = 'cancelled';
        releaseStock(o);
        saveDb();
      }
      await ctx.answerCbQuery('Order cancelled & stock released');
      await this.renderTelegramScreen(ctx, this.buildAdminOrdersScreen());
    });
    bot.action('admin:tickets', async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, this.buildAdminTicketsScreen());
    });
    bot.action(/^admin:ticket:(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const t = db.supportTickets.find((x) => x.id === Number(ctx.match[1]));
      if (!t) return ctx.answerCbQuery('Ticket not found');
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, {
        text:
          `${tgEmoji(EMOJI_IDS.support, '🎧')} <b>Ticket #${t.id}</b> (${t.status})\n` +
          `User: ${t.username ? '@' + escHtml(t.username) : t.userId}\n` +
          `Order: ${t.orderId ? '#' + t.orderId : 'General'}\n\n` +
          `${escHtml(t.message)}`,
        buttons: [
          [
            { text: 'Reply to User', callback_data: `admin:replyticket:${t.id}`, icon_custom_emoji_id: EMOJI_IDS.chat },
            { text: 'Mark Resolved', callback_data: `admin:resolveticket:${t.id}`, icon_custom_emoji_id: EMOJI_IDS.available },
          ],
          [backBtn('admin:tickets'), cancelBtn('home')],
        ],
      });
    });
    bot.action(/^admin:replyticket:(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const s = this.getSession(ctx.from.id);
      s.step = 'admin_ticket_reply';
      s.adminTicketId = Number(ctx.match[1]);
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, {
        text: `${tgEmoji(EMOJI_IDS.chat, '💬')} Type your reply for Ticket #${s.adminTicketId}:`,
        buttons: [[backBtn('admin:tickets'), cancelBtn('home')]],
      });
    });
    bot.action(/^admin:resolveticket:(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const t = db.supportTickets.find((x) => x.id === Number(ctx.match[1]));
      if (t) {
        t.status = 'resolved';
        saveDb();
      }
      await ctx.answerCbQuery('Ticket resolved');
      await this.renderTelegramScreen(ctx, this.buildAdminTicketsScreen());
    });
    bot.action(/^admin:edit:(\w+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const field = ctx.match[1];
      const s = this.getSession(ctx.from.id);
      s.step = 'admin_config_input';
      s.adminField = field;
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, {
        text: `${tgEmoji(EMOJI_IDS.edit, '✍️')} <b>Edit ${field}</b>\n\nSend the new value for <b>${field}</b>:`,
        buttons: [[backBtn('admin:config'), cancelBtn('home')]],
      });
    });
    bot.action('admin:broadcast', async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const s = this.getSession(ctx.from.id);
      s.step = 'admin_broadcast_input';
      await ctx.answerCbQuery();
      await this.renderTelegramScreen(ctx, {
        text: `${tgEmoji(EMOJI_IDS.broadcast, '📢')} <b>Broadcast to ${db.users.length} Users</b>\n\nSend the text or photo+caption you want to broadcast:`,
        buttons: [[backBtn('admin:home'), cancelBtn('home')]],
      });
    });
    bot.action('admin:broadcast:confirm', async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const s = this.getSession(ctx.from.id);
      const draft = s.broadcastDraft;
      if (!draft) return ctx.answerCbQuery('No draft');
      await ctx.answerCbQuery('Sending broadcast…');
      const res = await this.sendBroadcast(draft.text, draft.photoFileId);
      this.resetSession(ctx.from.id);
      await this.renderTelegramScreen(ctx, {
        text: `${tgEmoji(EMOJI_IDS.available, '✅')} <b>Broadcast Complete</b>\n\nSent: <b>${res.sent}</b> · Failed: <b>${res.failed}</b>`,
        buttons: [[backBtn('admin:home', 'Back to Admin')]],
      });
    });
    bot.action('admin:toggle:maintenance', async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      db.config.MAINTENANCE_MODE = !db.config.MAINTENANCE_MODE;
      touchConfig();
      await ctx.answerCbQuery(`Maintenance = ${db.config.MAINTENANCE_MODE}`);
      await this.refreshStock(5000);
      await this.renderTelegramScreen(ctx, this.buildAdminHomeScreen());
    });
    bot.action(/^approve:(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const o = getOrderById(ctx.match[1]);
      if (!o || o.status !== 'pending_review') return ctx.answerCbQuery('Already handled', { show_alert: true });
      await ctx.answerCbQuery('Approved, sending USDT…');
      await this.fulfillOrder(o);
      await this.renderTelegramScreen(ctx, this.buildAdminOrderActionsScreen(o.id));
    });
    bot.action(/^reject:(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
      const o = getOrderById(ctx.match[1]);
      if (!o || o.status !== 'pending_review') return ctx.answerCbQuery('Already handled', { show_alert: true });
      o.status = 'rejected';
      releaseStock(o);
      saveDb();
      await ctx.answerCbQuery('Rejected');
      bot.telegram
        .sendMessage(
          o.userId,
          `${tgEmoji(EMOJI_IDS.cancel, '❌')} Order #${o.id} was rejected. Open ${tgEmoji(EMOJI_IDS.support, '🎧')} <b>Support -> Failed Order</b> if you already paid.`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      await this.renderTelegramScreen(ctx, this.buildAdminOrderActionsScreen(o.id));
    });

    bot.on('photo', async (ctx) => {
      const uid = ctx.from.id;
      const s = this.getSession(uid);
      const photos = ctx.message.photo;
      const fileId = photos[photos.length - 1]?.file_id;
      const caption = (ctx.message.caption || '').trim();

      if (s.step === 'support_issue_input' && s.supportOrderId) {
        return this.submitSupportTicket(ctx, s.supportType || 'failed', s.supportOrderId, caption || '[Image attached]', fileId);
      }
      if (s.step === 'support_other_input') {
        return this.submitSupportTicket(ctx, 'other', null, caption || '[Image attached]', fileId);
      }
      if (s.step === 'admin_broadcast_input' && isAdmin(uid)) {
        s.broadcastDraft = { text: caption, photoFileId: fileId };
        return this.renderTelegramScreen(ctx, {
          text: `${tgEmoji(EMOJI_IDS.broadcast, '📢')} <b>Confirm Photo Broadcast</b>\n\nRecipients: <b>${db.users.length}</b>\nCaption: ${escHtml(caption || '(no caption)')}`,
          buttons: [
            [{ text: 'Send Now', callback_data: 'admin:broadcast:confirm', icon_custom_emoji_id: EMOJI_IDS.available }],
            [backBtn('admin:home'), cancelBtn('home')],
          ],
        });
      }

      const open = db.orders.slice().reverse().find((o) => o.userId === uid && o.status === 'awaiting_payment');
      if (open) {
        const screen = await this.processPaymentProof(uid, open, caption, fileId, (p) => this.renderTelegramScreen(ctx, p));
        return this.renderTelegramScreen(ctx, screen);
      }
      await this.renderTelegramScreen(ctx, this.buildHomeScreen(uid, ctx.from.first_name || 'Trader'));
    });

    bot.on('text', async (ctx) => {
      const uid = ctx.from.id;
      const text = ctx.message.text.trim();
      const s = this.getSession(uid);

      if (s.step === 'amount_custom') {
        const amount = Number(text.replace(',', '.'));
        return this.renderTelegramScreen(ctx, this.buildWalletPromptScreen(uid, amount));
      }
      if (s.step === 'wallet') {
        const screen = await this.createOrderFromSession(uid, ctx.from.username || null, text);
        return this.renderTelegramScreen(ctx, screen);
      }
      if (s.step === 'support_issue_input' && s.supportOrderId) {
        return this.submitSupportTicket(ctx, s.supportType || 'failed', s.supportOrderId, text);
      }
      if (s.step === 'support_other_input') {
        return this.submitSupportTicket(ctx, 'other', null, text);
      }
      if (s.step === 'admin_config_input' && s.adminField && isAdmin(uid)) {
        const resultMsg = await this.applyAdminTextConfig(s.adminField, text);
        this.resetSession(uid);
        return this.renderTelegramScreen(ctx, {
          text: resultMsg,
          buttons: [[backBtn('admin:config', 'Back to Config'), { text: 'Admin Home', callback_data: 'admin:home', icon_custom_emoji_id: EMOJI_IDS.adminTools }]],
        });
      }
      if (s.step === 'admin_broadcast_input' && isAdmin(uid)) {
        s.broadcastDraft = { text };
        return this.renderTelegramScreen(ctx, {
          text: `${tgEmoji(EMOJI_IDS.broadcast, '📢')} <b>Confirm Broadcast</b>\n\nRecipients: <b>${db.users.length}</b>\n\n${escHtml(text)}`,
          buttons: [
            [{ text: 'Send Now', callback_data: 'admin:broadcast:confirm', icon_custom_emoji_id: EMOJI_IDS.available }],
            [backBtn('admin:home'), cancelBtn('home')],
          ],
        });
      }
      if (s.step === 'admin_ticket_reply' && s.adminTicketId && isAdmin(uid)) {
        const t = db.supportTickets.find((x) => x.id === s.adminTicketId);
        if (t) {
          t.adminReply = text;
          t.repliedAt = Date.now();
          t.status = 'resolved';
          saveDb();
          bot.telegram.sendMessage(t.userId, `${tgEmoji(EMOJI_IDS.support, '🎧')} <b>Support Reply (Ticket #${t.id})</b>\n\n${escHtml(text)}`, { parse_mode: 'HTML' }).catch(() => {});
        }
        this.resetSession(uid);
        return this.renderTelegramScreen(ctx, {
          text: `${tgEmoji(EMOJI_IDS.available, '✅')} Reply sent for Ticket #${s.adminTicketId} and marked resolved.`,
          buttons: [[backBtn('admin:tickets', 'Back to Tickets')]],
        });
      }

      const open = db.orders.slice().reverse().find((o) => o.userId === uid && o.status === 'awaiting_payment');
      if (open) {
        const screen = await this.processPaymentProof(uid, open, text, undefined, (p) => this.renderTelegramScreen(ctx, p));
        return this.renderTelegramScreen(ctx, screen);
      }
      await this.renderTelegramScreen(ctx, this.buildHomeScreen(uid, ctx.from.first_name || 'Trader'));
    });
  }

  async submitSupportTicket(ctx, type, orderId, message, photoFileId) {
    const ticket = {
      id: (db.supportTickets[0]?.id || 0) + 1,
      userId: ctx.from.id,
      username: ctx.from.username || null,
      orderId,
      type,
      message: message.slice(0, 1500),
      photoFileId,
      status: 'open',
      createdAt: Date.now(),
    };
    db.supportTickets.unshift(ticket);
    saveDb();
    this.resetSession(ctx.from.id);

    await this.renderTelegramScreen(ctx, {
      text: `${tgEmoji(EMOJI_IDS.available, '✅')} <b>Support Ticket #${ticket.id} Submitted</b>\n\n${orderId ? `Order #${orderId} · ` : ''}Our support team received your details and will reply shortly.`,
      buttons: [[backBtn('support', 'Back to Support'), cancelBtn('home', 'Close')]],
    });

    if (this.bot) {
      const adminMsg =
        `${tgEmoji(EMOJI_IDS.support, '🎧')} <b>Support Ticket #${ticket.id}</b>\n` +
        `User: ${ctx.from.username ? '@' + escHtml(ctx.from.username) : ctx.from.id}\n` +
        `Order: ${orderId ? '#' + orderId : 'General'} · Type: ${type}\n\n` +
        `${escHtml(ticket.message)}`;
      for (const adminId of db.config.ADMIN_IDS) {
        if (photoFileId) {
          this.bot.telegram.sendPhoto(adminId, photoFileId, { caption: adminMsg, parse_mode: 'HTML' }).catch(() => {});
        } else {
          this.bot.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    }
  }

  async applyAdminTextConfig(field, value) {
    if (field === 'WALLET_PRIVATE_KEY') {
      db.config.WALLET_PRIVATE_KEY = value.trim();
      touchConfig();
      const hw = await this.syncHotWalletBalance();
      return hw.configured && !hw.lastError
        ? `${tgEmoji(EMOJI_IDS.available, '✅')} Hot Wallet connected: <code>${hw.address}</code>\nPolygon: ${hw.polygonUsdt} USDT (${hw.polygonGas} POL)\nBEP20: ${hw.bep20Usdt} USDT (${hw.bep20Gas} BNB)`
        : `${tgEmoji(EMOJI_IDS.warning, '⚠️')} Private key saved, error: ${hw.lastError || 'Invalid format'}`;
    }
    if (field === 'VERIFY_ET_API_KEY') {
      db.config.VERIFY_ET_API_KEY = value.trim();
      db.config.VERIFY_ET_ENABLED = Boolean(value.trim());
      touchConfig();
      return `${tgEmoji(EMOJI_IDS.available, '✅')} Verify.et API key updated.`;
    }
    if (field === 'HELP_TEXT') {
      db.config.HELP_TEXT = value;
      touchConfig();
      return `${tgEmoji(EMOJI_IDS.available, '✅')} Help message updated.`;
    }
    if (field.startsWith('PAY_ACC_')) {
      const k = field.replace('PAY_ACC_', '');
      if (db.config.PAYMENTS[k]) {
        db.config.PAYMENTS[k].account = value.trim();
        touchConfig();
        return `${tgEmoji(EMOJI_IDS.available, '✅')} Updated <b>${escHtml(stripLeadingEmoji(db.config.PAYMENTS[k].label))}</b> account to <code>${escHtml(value.trim())}</code>.`;
      }
    }
    if (field.startsWith('PAY_NAME_')) {
      const k = field.replace('PAY_NAME_', '');
      if (db.config.PAYMENTS[k]) {
        db.config.PAYMENTS[k].name = value.trim();
        touchConfig();
        return `${tgEmoji(EMOJI_IDS.available, '✅')} Updated <b>${escHtml(stripLeadingEmoji(db.config.PAYMENTS[k].label))}</b> receiver name to <b>${escHtml(value.trim())}</b>.`;
      }
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return `${tgEmoji(EMOJI_IDS.cancel, '❌')} Invalid numeric value.`;
    if (field === 'RATE') db.config.RATE = num;
    else if (field === 'SMALL_ORDER_RATE') db.config.SMALL_ORDER_RATE = num;
    else if (field === 'MIN_USDT') db.config.MIN_USDT = num;
    else if (field === 'MAX_USDT') db.config.MAX_USDT = num;
    else if (field === 'DAILY_LIMIT_USDT') db.config.DAILY_LIMIT_USDT = num;
    else if (field === 'PAYMENT_WINDOW_MIN') db.config.PAYMENT_WINDOW_MIN = Math.max(1, Math.round(num));
    else if (field === 'STOCK_POLYGON') db.config.STOCK.polygon = num;
    else if (field === 'STOCK_BEP20') db.config.STOCK.bep20 = num;
    touchConfig();
    return `${tgEmoji(EMOJI_IDS.available, '✅')} Updated <b>${field}</b> to <b>${value}</b>.`;
  }

  async start() {
    if (db.config.WALLET_PRIVATE_KEY) {
      await this.syncHotWalletBalance().catch(() => {});
    }
    setInterval(() => {
      this.expireOrders();
      if (db.config.WALLET_PRIVATE_KEY) this.syncHotWalletBalance().catch(() => {});
    }, 30000);

    const baseUrl = (process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
    const commands = [
      { command: 'start', description: 'Main menu & live stock' },
      { command: 'buy', description: 'Buy USDT (Polygon / BEP20)' },
      { command: 'orders', description: 'View my orders' },
      { command: 'rate', description: 'USDT rate sheet & fees' },
      { command: 'support', description: 'Support center & report issue' },
      { command: 'help', description: 'How to buy USDT' },
      { command: 'cancel', description: 'Cancel current step & return home' },
      { command: 'admin', description: 'Admin control panel' },
    ];

    // ---------- WEBHOOK MODE (Render) ----------
    if (baseUrl) {
      const bot = new Telegraf(db.config.BOT_TOKEN);
      bot.catch((err) => console.error('Telegram error:', err?.message || err));
      this.registerHandlers(bot);
      this.bot = bot;

      const secret = crypto.createHash('sha256').update(String(db.config.BOT_TOKEN)).digest('hex').slice(0, 48);
      const hookPath = `/telegram/${secret}`;
      const port = Number(process.env.PORT) || 3000;

      this.server = http.createServer((req, res) => {
        const url = (req.url || '').split('?')[0];
        if (req.method === 'POST' && url === hookPath) {
          if (req.headers['x-telegram-bot-api-secret-token'] !== secret) {
            res.writeHead(401);
            return res.end();
          }
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 2_000_000) req.destroy();
          });
          req.on('end', () => {
            // Answer Telegram immediately so slow work (payment checks) never causes re-delivery
            res.writeHead(200);
            res.end('ok');
            try {
              const update = JSON.parse(body);
              bot.handleUpdate(update).catch((err) => console.error('Update error:', err?.message || err));
            } catch (err) {
              console.error('Bad webhook body:', err?.message || err);
            }
          });
          return;
        }
        if (req.method === 'GET' && (url === '/' || url === '/health')) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end('ok');
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((resolve) => this.server.listen(port, '0.0.0.0', resolve));
      console.log(`🌐 HTTP server listening on port ${port}`);

      const me = await bot.telegram.getMe();
      await bot.telegram.setMyCommands(commands).catch(() => {});
      await bot.telegram.setWebhook(`${baseUrl}${hookPath}`, { secret_token: secret, drop_pending_updates: false });
      console.log(`✅ Telegram bot @${me.username} is online via webhook → ${baseUrl}/telegram/***`);
      return;
    }

    // ---------- POLLING MODE (local testing, no WEBHOOK_URL) ----------
    const launchLoop = async () => {
      try {
        if (this.bot) {
          try {
            this.bot.stop('restart');
          } catch {}
        }
        const bot = new Telegraf(db.config.BOT_TOKEN);
        bot.catch((err) => console.error('Telegram error:', err?.message || err));
        this.registerHandlers(bot);
        this.bot = bot;

        const me = await bot.telegram.getMe();
        await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
        await bot.telegram.setMyCommands(commands).catch(() => {});

        console.log(`✅ Telegram bot @${me.username} is online and polling (local mode)`);
        await bot.launch({ dropPendingUpdates: false });
      } catch (err) {
        console.error('Bot polling interrupted, reconnecting in 5s:', err?.message || err);
        setTimeout(launchLoop, 5000);
      }
    };

    await launchLoop();
  }
}

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));

const app = new BotApp();
(async () => {
  if (!db.config.BOT_TOKEN) {
    console.error('❌ BOT_TOKEN env var is not set.');
    process.exit(1);
  }
  await initStorage();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log(`${sig} received — saving data and shutting down`);
      try {
        app.server?.close();
        await flushDb();
      } catch {}
      process.exit(0);
    });
  }
  await app.start();
})().catch((err) => {
  console.error('Fatal startup error:', err?.message || err);
  process.exit(1);
});
