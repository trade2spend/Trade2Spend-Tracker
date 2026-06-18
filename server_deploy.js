/**
 * Trade2Spend Algo Bot — server.js v5.0
 * Runs on VM via PM2. No Redis — in-memory state with file backup.
 * Uses only: node-fetch, dotenv (already installed), and Node built-ins.
 *
 * Required in .env:
 *   TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 *   NEO_ACCESS_TOKEN, NEO_MOBILE, NEO_ID, NEO_MPIN
 *   PORT (optional, defaults to 3000)
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/home/trade2spend/t2s-bot/.env' });
import http from 'http';
import https from 'https';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'state.json');
const PORT       = process.env.PORT || 3000;

// ── ENV ──────────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.TELEGRAM_TOKEN;
const CHAT_ID      = process.env.TELEGRAM_CHAT_ID;
const CONSUMER_KEY = process.env.KOTAK_CONSUMER_KEY;
const MOBILE       = process.env.KOTAK_MOBILE;
const UCC          = process.env.KOTAK_UCC;
const MPIN         = process.env.KOTAK_MPIN;
const SB_URL       = process.env.SUPABASE_URL || 'https://keuzqxoxtlozlqjjjqvr.supabase.co';
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldXpxeG94dGxvemxxampqcXZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MDk3ODcsImV4cCI6MjA5NTE4NTc4N30.VAxiflefz816geWOE7Onq8SE6dXST46MNk0LBJqGNTs';
const GH_TOKEN     = process.env.GH_TOKEN || '';
const GH_REPO      = process.env.GH_REPO  || 'Trade2spend/Trade2Spend-Tracker';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('FATAL: TELEGRAM_TOKEN and TELEGRAM_CHAT_ID must be set in .env');
  process.exit(1);
}
console.log(`Starting with CHAT_ID=${CHAT_ID}, token=${BOT_TOKEN.slice(0,8)}...`);

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const LOT_SIZES          = { NIFTY: 65, BANKNIFTY: 15, SENSEX: 10 };
const MAX_DAILY_LOSS     = 15000;
const MAX_QTY            = 100;
const MAX_ORDERS         = 10;
const FETCH_TIMEOUT      = 7000;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const VALID_INSTRUMENTS  = ['NIFTY','BANKNIFTY','SENSEX','FINNIFTY','BANKEX'];

// ── SUPABASE HELPER ───────────────────────────────────────────────────────────
async function sbFetch(path, opts = {}) {
  const { headers: extraHdrs, ...rest } = opts;
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...rest,
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation', ...(extraHdrs || {}) }
  });
  const text = await r.text();
  return text ? JSON.parse(text) : [];
}

// ── WEB PUSH — native implementation (RFC 8291 + RFC 8292, no npm dep) ───────
import crypto from 'crypto';
const { subtle } = crypto.webcrypto;
const VAPID_PUB  = process.env.VAPID_PUBLIC_KEY  || 'jyMeYNEtZyQ7qaJVeeroanUIn0TUhmRRdzVnVvlPYi2nvlGqLgG1m714pD02fF6gJmlwlpPwjBO8ZeJM_X4lyg';
const VAPID_PRIV = process.env.VAPID_PRIVATE_KEY || '7aRPkRJKJT5RlkA4_XAhFy2nZwi2HdRmzp8HBkppGOo';

function b64uDec(s) { const p='='.repeat((4-s.length%4)%4); return Buffer.from((s+p).replace(/-/g,'+').replace(/_/g,'/'),'base64'); }
function b64uEnc(b) { return Buffer.from(b).toString('base64url'); }

async function hmacSha256(key, data) {
  const k = await subtle.importKey('raw', key, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return Buffer.from(await subtle.sign('HMAC', k, data));
}
async function hkdfExpand(prk, info, len) {
  let prev = Buffer.alloc(0), out = [];
  for (let i = 1; i <= Math.ceil(len/32); i++) {
    prev = await hmacSha256(prk, Buffer.concat([prev, Buffer.from(info,'binary'), Buffer.from([i])]));
    out.push(prev);
  }
  return Buffer.concat(out).slice(0, len);
}

async function vapidJwt(audience) {
  const hdr  = b64uEnc(JSON.stringify({typ:'JWT',alg:'ES256'}));
  const pay  = b64uEnc(JSON.stringify({aud:audience, exp:Math.floor(Date.now()/1000)+43200, sub:'mailto:tusharsood.2010@gmail.com'}));
  const tbs  = `${hdr}.${pay}`;
  const pub  = b64uDec(VAPID_PUB);
  const key  = await subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:b64uEnc(pub.slice(1,33)),y:b64uEnc(pub.slice(33,65)),d:b64uEnc(b64uDec(VAPID_PRIV))},{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const sig  = Buffer.from(await subtle.sign({name:'ECDSA',hash:'SHA-256'}, key, Buffer.from(tbs)));
  return `${tbs}.${b64uEnc(sig)}`;
}

async function encryptPush(subKeys, plaintext) {
  const recvPub = b64uDec(subKeys.p256dh), authSec = b64uDec(subKeys.auth);
  const sKP = await subtle.generateKey({name:'ECDH',namedCurve:'P-256'}, true, ['deriveBits']);
  const sPub = Buffer.from(await subtle.exportKey('raw', sKP.publicKey));
  const rKey = await subtle.importKey('raw', recvPub, {name:'ECDH',namedCurve:'P-256'}, false, []);
  const ss   = Buffer.from(await subtle.deriveBits({name:'ECDH',public:rKey}, sKP.privateKey, 256));
  const prk1 = await hmacSha256(authSec, ss);
  const ikm  = await hkdfExpand(prk1, 'WebPush: info\x00' + recvPub.toString('binary') + sPub.toString('binary'), 32);
  const salt = crypto.randomBytes(16);
  const prk2 = await hmacSha256(salt, ikm);
  const cek  = await hkdfExpand(prk2, 'Content-Encoding: aes128gcm\x00', 16);
  const iv   = await hkdfExpand(prk2, 'Content-Encoding: nonce\x00', 12);
  const aKey = await subtle.importKey('raw', cek, {name:'AES-GCM'}, false, ['encrypt']);
  const ct   = Buffer.from(await subtle.encrypt({name:'AES-GCM',iv}, aKey, Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])));
  const rs   = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([sPub.length]), sPub, ct]);
}

async function sendWebPush(subJson, payload) {
  const sub  = typeof subJson === 'string' ? JSON.parse(subJson) : subJson;
  const ep   = new URL(sub.endpoint);
  const jwt  = await vapidJwt(`${ep.protocol}//${ep.host}`);
  const body = await encryptPush(sub.keys, payload);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:ep.hostname, port:ep.port||443, path:ep.pathname+ep.search, method:'POST', family:4,
      headers:{'Authorization':`vapid t=${jwt},k=${VAPID_PUB}`,'Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','Content-Length':body.length,'TTL':'86400'}
    }, r => { r.resume(); resolve(r.statusCode); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
console.log('Web push ready (native) ✓');
const VALID_EXPIRIES     = ['weekly','next weekly','monthly'];
const SPOT_TOKENS = {
  NIFTY:     { exchange_segment: 'nse_cm', instrument_token: '26000' },
  BANKNIFTY: { exchange_segment: 'nse_cm', instrument_token: '26009' },
  SENSEX:    { exchange_segment: 'bse_cm', instrument_token: '1'     }
};

// ── IN-MEMORY STATE ───────────────────────────────────────────────────────────
let session = { token: null, sid: null, rid: null, auth: null, hsServerId: null, baseUrl: null, lastLogin: 0 };
let state   = { trades: {}, paperMode: true, dailyPnl: 0, orderCount: 0, pendingAction: null, lastResetDate: null };

// In-memory lock replaces Redis NX
const _locks = new Map();
function kvLock(key, ttlSec = 45) {
  const now = Date.now();
  if (_locks.has(key) && _locks.get(key) > now) return false;
  _locks.set(key, now + ttlSec * 1000);
  return true;
}
function kvUnlock(key) { _locks.delete(key); }

let marketScraperInterval = null;
let _latestMarketData    = null;
let _optionChain         = {}; // key: "NIFTY-23900-PE" → LTP (Kotak primary, NSE fallback)
let _scripMaster         = {}; // key: "NIFTY-23900-PE-19JUN2025" → numeric token string
let _scripMasterTs       = 0;  // last successful scrip master download (with current data)
let _scripMasterAttemptTs = 0; // last attempt — rate-limits retries to 10 min when stale
let _expiryDates         = {}; // { NIFTY:{current,next,monthly}, BANKNIFTY:{...}, ... } from scrip master
let _activeContracts     = []; // [{instrument,strike,type,expiry}] parsed from Supabase
let _activeContractsTs   = 0;  // last Supabase refresh timestamp
let _kotakLtpInterval    = null; // 5-second Kotak LTP fetch interval
let _sbAlertDate         = null; // date string of last daily reset for SL alerts
let _sbSlAlertedToday    = new Set(); // post IDs where SL auto-follow-up already posted today
let _resolveAlertSentDate = null; // date string when 3:20 PM resolve alert was sent

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.session) session = { ...session, ...data.session };
      if (data.state)   state   = { ...state,   ...data.state };
      console.log(`State loaded: ${Object.keys(state.trades).length} trades`);
    }
  } catch (e) { console.error('loadState error:', e.message); }
}

async function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ session, state }, null, 2));
  } catch (e) {
    console.error('saveState error:', e.message);
    tgAlert(`⚠️ State save failed: ${e.message}`).catch(() => {});
  }
}

// ── FETCH WITH TIMEOUT ────────────────────────────────────────────────────────
async function ft(url, options = {}, ms = FETCH_TIMEOUT) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── KOTAK FETCH (native https, forces IPv4 — Kotak rejects IPv6 from GCloud) ──
function ftKotak(url, options = {}, ms = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const body = options.body ? (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body))) : null;
    const reqOpts = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + (u.search || ''),
      method:   (options.method || 'GET').toUpperCase(),
      headers:  { ...(options.headers || {}), ...(body ? { 'Content-Length': body.length } : {}) },
      family:   4  // force IPv4 — Kotak servers don't respond on IPv6
    };
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`Timed out after ${ms}ms`)); }, ms);
    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok:     res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text:   () => Promise.resolve(text),
          json:   () => { try { return Promise.resolve(JSON.parse(text)); } catch(e) { return Promise.reject(e); } }
        });
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
async function tgSend(text, keyboard = null) {
  const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = JSON.stringify(keyboard);
  if (body.text.length > 4000) body.text = body.text.slice(0, 4000) + '\n<i>...truncated</i>';
  try {
    const r = await ft(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, 5000);
    const d = await r.json();
    if (d.ok) return d.result.message_id;
    console.error('tgSend API error:', d.description);
  } catch (e) { console.error('tgSend error:', e.message); }
  return null;
}

async function tgEdit(msgId, text, keyboard = null) {
  if (!msgId) return;
  const body = { chat_id: CHAT_ID, message_id: msgId, text, parse_mode: 'HTML' };
  if (keyboard !== null) body.reply_markup = JSON.stringify(keyboard);
  if (body.text.length > 4000) body.text = body.text.slice(0, 4000) + '\n<i>...truncated</i>';
  try {
    await ft(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, 5000);
  } catch (e) { console.error('tgEdit error:', e.message); }
}

async function tgAnswer(cbId, text = '') {
  try {
    await ft(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cbId, text })
    }, 3000);
  } catch {}
}

async function tgAlert(text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch {}
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function istTime() {
  return new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}
function pnlSign(n) { return n >= 0 ? '🟢 +' : '🔴 '; }
function fmtINR(n)  { return `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }

function resolveExpiry(expiryStr, instrument) {
  const s = (expiryStr || '').toLowerCase().trim();
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  if (MONTHS.some(m => s.includes(m.toLowerCase()))) return expiryStr.toUpperCase();
  const now   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const instr = (instrument || '').toUpperCase();
  // NSE NIFTY weekly expiry: Thursday (4). BANKNIFTY: Wednesday (3). SENSEX/BSE: Friday (5).
  const targetDay = instr.includes('SENSEX') ? 5 : instr.includes('BANKNIFTY') ? 3 : 4;
  function fmt(d) { return String(d.getDate()).padStart(2,'0') + MONTHS[d.getMonth()] + d.getFullYear(); }
  function nextExp(from, mustBeAfter) {
    const d = new Date(from);
    let days = (targetDay - d.getDay() + 7) % 7;
    if (days === 0 && mustBeAfter) days = 7;
    d.setDate(d.getDate() + days);
    return d;
  }
  if (s === 'weekly' || s === 'current weekly') return fmt(nextExp(now, false));
  if (s === 'next weekly') { const c = nextExp(now, false); c.setDate(c.getDate() + 7); return fmt(c); }
  if (s === 'monthly') {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    while (d.getDay() !== targetDay) d.setDate(d.getDate() - 1);
    return fmt(d);
  }
  return expiryStr;
}

function fmtTrade(trade, title, extra = '') {
  const mode = trade.mode === 'PAPER' ? '📝 Paper' : '🔴 Live';
  let msg =
    `${title}\n━━━━━━━━━━━━━━━━━━\n` +
    `<b>${trade.action} ${trade.instrument} ${trade.strike} ${trade.expiry} ${trade.option_type}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `<b>Entry:</b> ₹${trade.entry}\n` +
    `<b>CMP:</b> ₹${trade.opt_cmp || '—'}\n` +
    `<b>Qty:</b> ${trade.qty} lots\n` +
    `<b>SL Spot:</b> ${trade.sl_spot} (${trade.sl_direction})\n` +
    `<b>Mode:</b> ${mode}\n━━━━━━━━━━━━━━━━━━\n`;
  if (trade.exit_history?.length > 0) {
    msg += `<b>Exit History:</b>\n`;
    for (const ex of trade.exit_history) msg += `  • ${ex.qty} lots @ ₹${ex.price} (${ex.time})\n`;
  }
  if (extra) msg += `\n${extra}`;
  return msg;
}

function tradeKeyboard(tid) {
  return { inline_keyboard: [
    [{ text: '📤 Exit',       callback_data: `exit_${tid}`    },
     { text: '🛑 SL Order',   callback_data: `slorder_${tid}` }],
    [{ text: '🎯 Set Target', callback_data: `settgt_${tid}`  },
     { text: '📊 Status',     callback_data: 'status_all'     }]
  ]};
}

// ── DAILY RESET ───────────────────────────────────────────────────────────────
function maybeDailyReset() {
  const todayIST = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  if (state.lastResetDate !== todayIST) {
    state.dailyPnl = 0; state.orderCount = 0; state.lastResetDate = todayIST;
    for (const t of Object.values(state.trades)) { t.sl_cancelled = false; t.sl_breach_time = null; }
  }
}

// ── PAYLOAD VALIDATION ────────────────────────────────────────────────────────
function validatePayload(trade) {
  const required = ['source','action','instrument','strike','expiry','option_type','entry','sl_spot','sl_direction','qty'];
  for (const f of required)
    if (trade[f] === undefined || trade[f] === null || trade[f] === '') return `Missing: ${f}`;
  if (!VALID_INSTRUMENTS.includes(String(trade.instrument).toUpperCase()))
    return `Unknown instrument: ${trade.instrument}`;
  if (!['CE','PE'].includes(String(trade.option_type).toUpperCase()))
    return `option_type must be CE or PE`;
  if (!['above','below'].includes(String(trade.sl_direction).toLowerCase()))
    return `sl_direction must be above or below`;
  if (String(trade.qty).includes('.')) return `qty must be a whole number`;
  const qty = parseInt(trade.qty);
  if (isNaN(qty) || qty <= 0) return `Invalid qty`;
  if (qty > MAX_QTY)          return `qty exceeds max ${MAX_QTY}`;
  if (isNaN(parseFloat(trade.entry)) || parseFloat(trade.entry) <= 0) return `Invalid entry price`;
  if (isNaN(parseFloat(trade.sl_spot)) || parseFloat(trade.sl_spot) <= 0) return `Invalid sl_spot`;
  const expLower = String(trade.expiry).toLowerCase().trim();
  const months   = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  if (!VALID_EXPIRIES.includes(expLower) && !months.some(m => expLower.includes(m)))
    return `Unrecognised expiry: ${trade.expiry}`;
  if (trade.message && String(trade.message).length > 500) return `message too long`;
  return null;
}

// ── KOTAK ─────────────────────────────────────────────────────────────────────
function neoHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json', 'Accept': 'application/json',
    'Authorization': session.token, 'neo-fin-key': 'neotradeapi',
    'sid': session.sid, 'rid': session.rid || '', 'Auth': session.auth || '',
    ...extra
  };
}

async function findScripToken(trade) {
  if (trade.scrip_token) return trade.scrip_token;
  const sym = `${trade.instrument.toUpperCase()}${resolveExpiry(trade.expiry, trade.instrument)}${trade.option_type.toUpperCase()}${trade.strike}`;
  trade.scrip_token = sym;
  return sym;
}

async function loginKotak(totp) {
  try {
    tgSend('🔐 Step 1/2: Validating TOTP...').catch(()=>{});
    let r1;
    try {
      r1 = await ftKotak('https://mis.kotaksecurities.com/login/1.0/tradeApiLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': CONSUMER_KEY, 'neo-fin-key': 'neotradeapi' },
        body: JSON.stringify({ mobileNumber: MOBILE, ucc: UCC, totp })
      });
    } catch (e) { tgSend(`❌ TOTP network error: ${e.message}`).catch(()=>{}); return false; }

    const text1 = await r1.text();
    console.log('TOTP status:', r1.status);
    if (!r1.ok) { tgSend(`❌ TOTP HTTP ${r1.status}\n<code>${text1.slice(0,200)}</code>`).catch(()=>{}); return false; }

    let d1;
    try { d1 = JSON.parse(text1); } catch { tgSend(`❌ TOTP non-JSON response`).catch(()=>{}); return false; }
    if (!d1.data?.token) { tgSend(`❌ TOTP failed: ${d1.message || d1.error || 'Unknown'}`).catch(()=>{}); return false; }

    tgSend('🔐 Step 2/2: Validating MPIN...').catch(()=>{});
    let r2;
    try {
      r2 = await ftKotak('https://mis.kotaksecurities.com/login/1.0/tradeApiValidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': CONSUMER_KEY, 'neo-fin-key': 'neotradeapi', 'sid': d1.data.sid, 'Auth': d1.data.token },
        body: JSON.stringify({ mpin: MPIN })
      });
    } catch (e) { tgSend(`❌ MPIN network error: ${e.message}`).catch(()=>{}); return false; }

    const text2 = await r2.text();
    console.log('MPIN status:', r2.status);
    if (!r2.ok) { tgSend(`❌ MPIN HTTP ${r2.status}\n<code>${text2.slice(0,200)}</code>`).catch(()=>{}); return false; }

    let d2;
    try { d2 = JSON.parse(text2); } catch { tgSend(`❌ MPIN non-JSON response`).catch(()=>{}); return false; }
    if (!d2.data?.token) { tgSend(`❌ MPIN failed: ${d2.message || d2.error || 'Unknown'}`).catch(()=>{}); return false; }

    session.token      = d2.data.token;
    session.sid        = d2.data.sid;
    session.rid        = d2.data.rid        || '';
    session.auth       = d2.data.auth       || '';
    session.hsServerId = d2.data.hsServerId || d2.data.serverId || d2.data.rid || '';
    // Always use gw-napi — Kotak-assigned URLs (e.g. e21.*) may be unreachable from this VM
    session.baseUrl    = 'https://gw-napi.kotaksecurities.com';
    session.lastLogin  = Date.now();
    state.paperMode    = false;

    tgSend(
      `✅ <b>Logged into Kotak Neo!</b>\n` +
      `Mode: 🔴 Live (auto-switched)\n` +
      `Base URL: <code>${session.baseUrl}</code>\n\n` +
      `Ready. Send trades from PWA or use /status.\n` +
      `<i>Market scraper runs automatically 9:15–3:35 IST (no TOTP needed)</i>`
    ).catch(()=>{});
    await saveState();
    // Download scrip master in background after login so option tokens are ready
    downloadScripMaster().catch(e => console.error('[scrip] post-login download error:', e.message));
    return true;
  } catch (e) {
    tgSend(`❌ Login error: ${e.message}`).catch(()=>{});
    return false;
  }
}

function isSessionValid() {
  if (!session.token) return false;
  const age = Date.now() - (session.lastLogin || 0);
  if (age > SESSION_MAX_AGE_MS)
    tgAlert(`⚠️ Session ${Math.round(age/3600000)}h old — re-connect via PWA Setup tab.`);
  return true;
}

// ── SPOT PRICE ────────────────────────────────────────────────────────────────
async function fetchSpot(instrument = 'NIFTY') {
  if (!session.token || !session.baseUrl) return null;
  const tok = SPOT_TOKENS[instrument.toUpperCase()] || SPOT_TOKENS.NIFTY;
  try {
    const url = `${session.baseUrl}/script-details/1.0/quotes/neosymbol/${tok.exchange_segment}|${tok.instrument_token}/ltp`;
    const r = await ftKotak(url, {
      method: 'GET',
      headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' }
    });
    const d   = await r.json();
    const ltp = parseFloat(d?.data?.[0]?.ltp || (Array.isArray(d) ? d[0]?.ltp : null) || d?.ltp);
    return ltp > 0 ? ltp : null;
  } catch (e) { console.error('fetchSpot error:', e.message); return null; }
}

// NSE India session cookie — refreshed every 10 min, no login needed
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com'
};
let _nseCookies = '';
let _nseCookieTs = 0;

async function refreshNSECookies() {
  try {
    const r = await ft('https://www.nseindia.com', {
      headers: { ...NSE_HEADERS, 'Accept': 'text/html,application/xhtml+xml' }
    }, 10000);
    const raw = r.headers.raw?.()?.['set-cookie'] || [];
    const cookies = Array.isArray(raw) ? raw.map(c => c.split(';')[0]).join('; ') : (r.headers.get('set-cookie') || '').split(',').map(c => c.split(';')[0]).join('; ');
    if (cookies) { _nseCookies = cookies; _nseCookieTs = Date.now(); }
    return !!cookies;
  } catch (e) { console.error('refreshNSECookies error:', e.message); return false; }
}

async function fetchNSEAllIndices() {
  // Refresh cookies if older than 10 minutes
  if (!_nseCookies || Date.now() - _nseCookieTs > 10 * 60 * 1000) await refreshNSECookies();
  try {
    const r = await ft('https://www.nseindia.com/api/allIndices', {
      headers: { ...NSE_HEADERS, 'Cookie': _nseCookies }
    }, 8000);
    if (!r.ok) { _nseCookieTs = 0; return null; } // force cookie refresh next time
    return await r.json();
  } catch (e) { console.error('fetchNSEAllIndices error:', e.message); _nseCookieTs = 0; return null; }
}

const NSE_INDEX_NAMES = { NIFTY: 'NIFTY 50', BANKNIFTY: 'NIFTY BANK', SENSEX: 'S&P BSE SENSEX' };

async function fetchIndexQuote(instrument) {
  const d = await fetchNSEAllIndices();
  if (!d) return null;
  const name = NSE_INDEX_NAMES[instrument.toUpperCase()];
  const idx  = d.data?.find(x => x.indexSymbol === name || x.index === name);
  if (!idx) return null;
  const price     = parseFloat(idx.last || idx.indexValue || 0);
  const change    = parseFloat(idx.variation || idx.change || 0);
  const changePct = parseFloat(idx.percentChange || idx.pChange || 0);
  return { price: parseFloat(price.toFixed(2)), change: parseFloat(change.toFixed(2)), changePct: parseFloat(changePct.toFixed(2)) };
}

async function fetchNSEBreadth() {
  const d = await fetchNSEAllIndices();
  if (!d) return null;
  const n50 = d.data?.find(x => x.indexSymbol === 'NIFTY 50' || x.index === 'NIFTY 50');
  if (!n50) return null;
  return {
    advancing: parseInt(n50.advances) || 0,
    declining: parseInt(n50.declines) || 0,
    unchanged: parseInt(n50.unchanged) || 0
  };
}

async function fetchNSEMovers() {
  if (!_nseCookies || Date.now() - _nseCookieTs > 10 * 60 * 1000) await refreshNSECookies();

  // Primary: equity-stockIndices gives ALL 50 stocks so count matches advance/decline bar
  try {
    const r = await ft('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050', {
      headers: { ...NSE_HEADERS, 'Cookie': _nseCookies }
    }, 8000);
    if (r.ok) {
      const d = await r.json();
      const stocks = (d?.data || []).filter(s => s.symbol && s.symbol !== 'NIFTY 50');
      if (stocks.length > 0) {
        const mapStock = s => ({
          symbol: s.symbol,
          price:  parseFloat(parseFloat(s.lastPrice || s.ltp || 0).toFixed(2)),
          change: parseFloat(parseFloat(s.pChange || s.perChange || 0).toFixed(2))
        });
        const pctField = s => parseFloat(s.pChange || s.perChange || 0);
        return {
          gainers: stocks.filter(s => pctField(s) > 0).sort((a,b) => pctField(b)-pctField(a)).map(mapStock),
          losers:  stocks.filter(s => pctField(s) < 0).sort((a,b) => pctField(a)-pctField(b)).map(mapStock)
        };
      }
    }
    console.log('[movers] equity-stockIndices returned no data, trying fallback');
  } catch(e) { console.error('[movers] equity-stockIndices failed:', e.message); }

  // Fallback: significant movers — shows subset but works reliably
  try {
    const [gr, lr] = await Promise.all([
      ft('https://www.nseindia.com/api/live-analysis-variations?index=gainers', { headers: { ...NSE_HEADERS, 'Cookie': _nseCookies } }, 8000),
      ft('https://www.nseindia.com/api/live-analysis-variations?index=loosers', { headers: { ...NSE_HEADERS, 'Cookie': _nseCookies } }, 8000)
    ]);
    if (!gr.ok || !lr.ok) { _nseCookieTs = 0; return null; }
    const [gd, ld] = await Promise.all([gr.json(), lr.json()]);
    const mapStock = s => ({ symbol: s.symbol, price: parseFloat(parseFloat(s.ltp||0).toFixed(2)), change: parseFloat(parseFloat(s.perChange||0).toFixed(2)) });
    console.log('[movers] fallback succeeded');
    return {
      gainers: (gd?.NIFTY?.data||[]).sort((a,b)=>(b.perChange||0)-(a.perChange||0)).map(mapStock),
      losers:  (ld?.NIFTY?.data||[]).sort((a,b)=>(a.perChange||0)-(b.perChange||0)).map(mapStock)
    };
  } catch(e) { console.error('[movers] fallback also failed:', e.message); return null; }
}

// ── KOTAK OPTION LTP SYSTEM ──────────────────────────────────────────────────

// Download NFO scrip master CSV from Kotak → build token lookup map
// Called once after TOTP login (and refreshed daily)
// Column name variants Kotak uses across API versions
function _findCol(hdrs, ...candidates) {
  for (const c of candidates) {
    const i = hdrs.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

async function downloadScripMaster() {
  if (!session.token || !session.baseUrl) return;
  // 22h cache if we have current data; 10-min retry rate-limit if stale/failed
  if (Date.now() - _scripMasterTs < 22 * 60 * 60 * 1000) return;
  if (Date.now() - _scripMasterAttemptTs < 10 * 60 * 1000) return;
  _scripMasterAttemptTs = Date.now();

  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  // Parse expiry from unix timestamp (seconds) OR multiple date string formats → DDMMMYYYY
  function parseExp(raw) {
    const s = (raw||'').replace(/"/g,'').trim().toUpperCase();
    if (/^\d{9,11}$/.test(s)) {
      let ts = parseInt(s);
      // Kotak's CDN nse_fo.csv Unix timestamps are ~10 years stale.
      // Kotak Neo SDK (scrip_search.py line 47) applies exactly +315511200s to compensate.
      // pSymbol values in the CSV are already correct for current contracts.
      const rawYear = new Date(ts * 1000).getUTCFullYear();
      if (rawYear < new Date().getFullYear()) ts += 315511200;
      const d = new Date(ts * 1000);
      return String(d.getUTCDate()).padStart(2,'0') + MONTHS[d.getUTCMonth()] + d.getUTCFullYear();
    }
    const m1 = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);       // DDMMMYYYY / DMMMYYYY
    if (m1) return m1[1].padStart(2,'0') + m1[2] + m1[3];
    const m2 = s.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);      // DD-MMM-YYYY
    if (m2) return m2[1].padStart(2,'0') + m2[2] + m2[3];
    const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);           // YYYY-MM-DD
    if (m3) { const d=new Date(s); if(!isNaN(d.getTime())) return String(d.getUTCDate()).padStart(2,'0')+MONTHS[d.getUTCMonth()]+d.getUTCFullYear(); }
    return s;
  }

  // Parse CSV → token map. Handles:
  //   old format: lExpiryDate (unix seconds), dStrikePrice (×100), headers may have semicolons
  //   new format: pExpDt (DDMMMYYYY string), pStrikePrc (actual value), clean headers
  function parseCsv(csv) {
    const lines = csv.split('\n');
    const hdrs  = lines[0].split(',').map(h => h.trim().replace(/[";]/g,''));
    const iName = _findCol(hdrs,'pSymbolName','symbolName','pScrip');
    const iType = _findCol(hdrs,'pOptionType','optionType','pOptType','pInstrumentType');
    const iExp  = _findCol(hdrs,'lExpiryDate','pExpiryDate','pExpDt','expiryDate','pExpiry','expiry');
    const iStr  = _findCol(hdrs,'dStrikePrice','pStrikePrice','strikePrice','pStrikePrc','pStrike','strike');
    const iTok  = _findCol(hdrs,'pSymbol','token','pToken','instrumentToken');
    if ([iName,iType,iExp,iStr,iTok].some(i=>i<0)) {
      return { map:{}, err:`Col missing — iName:${iName} iType:${iType} iExp:${iExp} iStr:${iStr} iTok:${iTok} | Hdrs: ${hdrs.join(',')}` };
    }
    // Auto-detect if strike is stored ×100 (old: 2400000) or actual value (new: 24000)
    const firstStrike = parseFloat(lines[1]?.split(',')?.[iStr]?.replace(/[";]/g,'').trim()||'0');
    const strikeDiv   = firstStrike > 100000 ? 100 : 1;
    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      if (c.length <= Math.max(iName,iType,iExp,iStr,iTok)) continue;
      const name   = c[iName]?.replace(/"/g,'').trim().toUpperCase();
      const type   = c[iType]?.replace(/"/g,'').trim().toUpperCase();
      const exp    = parseExp(c[iExp]);
      const strRaw = parseFloat(c[iStr]?.replace(/[";]/g,'').trim()||'0');
      const strike = String(Math.round(strRaw/strikeDiv));
      const token  = c[iTok]?.replace(/"/g,'').trim();
      if (!name||!type||!exp||strRaw===0||!token||!['CE','PE'].includes(type)) continue;
      map[`${name}-${strike}-${type}-${exp}`] = token;
    }
    return { map, err:null };
  }

  const d2s = d => `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
  const cdnBase = 'https://lapi.kotaksecurities.com/wso2-scripmaster/1.0/prod/prod/v1';
  const dates = [new Date(), new Date(Date.now()-86400000), new Date(Date.now()-172800000)].map(d2s);

  let csvText = null, sourceLabel = '';

  // Approach 1: gw-napi Dist/master — Kotak Neo SDK's own endpoint, Bearer session token, has current data
  const gwNapiUrls = [
    'https://gw-napi.kotaksecurities.com/Dist/master/nse_fo.csv',
    `${session.baseUrl}/Dist/master/nse_fo.csv`
  ];
  for (const url of gwNapiUrls) {
    for (const authHdr of [`Bearer ${session.token}`, session.token]) {
      try {
        const r = await ftKotak(url, {
          headers: { 'Authorization': authHdr, 'Sid': session.sid, 'Auth': session.auth, 'neo-fin-key': 'neotradeapi', 'Content-Type': 'application/json' }
        }, 60000);
        if (r.ok) {
          const t = await r.text();
          if (t && t.length > 5000 && t.includes(',')) { csvText = t; sourceLabel = `gw-napi(${authHdr.slice(0,12)})`; break; }
          else console.log(`[scrip] gw-napi ${url.slice(-20)} → too short or not CSV (${t?.length}b)`);
        } else { console.log(`[scrip] gw-napi ${url.slice(-20)} HTTP ${r.status}`); }
      } catch(e) { console.log(`[scrip] gw-napi ${url.slice(-20)}: ${e.message}`); }
      if (csvText) break;
    }
    if (csvText) break;
  }

  // Approach 2-4: Kotak public CDN — date-stamped URL, no auth needed
  if (!csvText) {
    for (const dateStr of dates) {
      try {
        const r = await ftKotak(`${cdnBase}/${dateStr}/nfo/transformed/scrip_master.csv`, {}, 30000);
        if (r.ok) {
          const t = await r.text();
          if (t && t.length > 5000) { csvText = t; sourceLabel = `CDN-${dateStr}`; break; }
          else console.log(`[scrip] CDN ${dateStr} → too short (${t?.length} bytes)`);
        } else { console.log(`[scrip] CDN ${dateStr} → HTTP ${r.status}`); }
      } catch(e) { console.log(`[scrip] CDN ${dateStr}: ${e.message}`); }
    }
  }

  // Approach 5: file-paths API with session bearer token (may return different/current file)
  if (!csvText) {
    try {
      const r1 = await ftKotak(`${session.baseUrl}/script-details/1.0/masterscrip/file-paths`, {
        headers: { 'Authorization': session.token, 'Content-Type':'application/json','neo-fin-key':'neotradeapi','sid':session.sid,'Auth':session.token }
      }, 10000);
      if (r1.ok) {
        const d1 = await r1.json();
        const allPaths = d1?.data?.filesPaths || [];
        console.log('[scrip] file-paths(session) filenames:', JSON.stringify(allPaths.map(p=>{try{return new URL(p).pathname.split('/').pop();}catch{return String(p).slice(0,60);}})));
        const nfoPaths = allPaths.filter(p=>typeof p==='string'&&p.toLowerCase().includes('nse_fo'));
        for (const url of [...nfoPaths].reverse()) { // try last URL first (most likely most recent)
          try {
            const r2 = await ftKotak(url, {}, 60000);
            if (r2.ok) { const t = await r2.text(); if (t&&t.length>5000) { csvText=t; sourceLabel='file-paths-session'; break; } }
          } catch {}
        }
      }
    } catch(e) { console.log('[scrip] file-paths session error:', e.message); }
  }

  // Approach 5: file-paths API with consumer key (original — known to return stale archive)
  if (!csvText) {
    try {
      const r1 = await ftKotak(`${session.baseUrl}/script-details/1.0/masterscrip/file-paths`, {
        headers: { 'Authorization': CONSUMER_KEY,'Content-Type':'application/json','neo-fin-key':'neotradeapi' }
      }, 10000);
      if (r1.ok) {
        const d1 = await r1.json();
        const paths = d1?.data?.filesPaths || [];
        const nfoCsvUrl = paths.find(p=>typeof p==='string'&&p.toLowerCase().includes('nse_fo'));
        if (nfoCsvUrl) {
          const r2 = await ftKotak(nfoCsvUrl, {}, 60000);
          if (r2.ok) { const t = await r2.text(); if (t&&t.length>5000) { csvText=t; sourceLabel='file-paths-consumer-key'; } }
        }
      }
    } catch(e) { console.log('[scrip] file-paths consumer error:', e.message); }
  }

  if (!csvText) {
    console.error('[scrip] All download approaches failed');
    tgAlert('⚠️ Scrip master: all download approaches failed. CMP from NSE option chain only.').catch(() => {});
    return;
  }

  const { map: newMap, err } = parseCsv(csvText);
  const count = Object.keys(newMap).length;

  if (err) {
    console.error('[scrip] Parse error:', err.slice(0, 200));
    return;
  }
  if (count === 0) {
    console.error('[scrip] 0 contracts parsed from', sourceLabel);
    return;
  }

  // Verify data is current — at least some contracts must expire this calendar year or later
  const currentYear = new Date().getFullYear();
  const hasCurrentData = Object.keys(newMap).some(k => parseInt(k.slice(-4)) >= currentYear);
  if (!hasCurrentData) {
    const latestKey = Object.keys(newMap).sort().pop();
    console.error(`[scrip] Stale data from ${sourceLabel}: ${count} contracts, no ${currentYear}+ expiries. Latest: ${latestKey}`);
    return; // _scripMasterTs not updated → 10-min retry via _scripMasterAttemptTs
  }

  _scripMaster   = newMap;
  _scripMasterTs = Date.now();
  buildExpiryDates();
  const sample = Object.keys(newMap).filter(k=>k.startsWith('NIFTY-')&&k.includes(String(currentYear))).slice(0,3);
  console.log(`[scrip] ✅ ${count} contracts from ${sourceLabel}. Sample: ${sample.join(', ')}`);
}

// Look up Kotak numeric token for a specific option contract
function getOptionToken(instrument, strike, type, expiry) {
  // expiry from resolveExpiry() is already "DDMMMYYYY" e.g. "19JUN2025"
  const key = `${instrument.toUpperCase()}-${strike}-${type.toUpperCase()}-${expiry.toUpperCase()}`;
  return _scripMaster[key] || null;
}

// Build expiry date map from scrip master — actual dates from Kotak, no guessing
function buildExpiryDates() {
  const MONS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const nowIST = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
  nowIST.setHours(0,0,0,0);
  const result = {};
  for (const instr of ['NIFTY','BANKNIFTY','SENSEX','FINNIFTY','BANKEX']) {
    const prefix = instr + '-';
    const expSet = new Set();
    for (const key of Object.keys(_scripMaster)) {
      if (!key.startsWith(prefix)) continue;
      const parts = key.split('-');
      expSet.add(parts[parts.length - 1]); // DDMMMYYYY
    }
    const sorted = [...expSet].map(s => ({
      str: s,
      ts: Date.UTC(parseInt(s.slice(5)), MONS.indexOf(s.slice(2,5)), parseInt(s.slice(0,2)))
    })).filter(x => x.ts >= nowIST.getTime()).sort((a,b) => a.ts - b.ts);
    if (!sorted.length) continue;
    // "24 Jun 2025" display format
    const fmt = s => `${parseInt(s.slice(0,2))} ${s.slice(2,5).charAt(0)+s.slice(3,5).toLowerCase()} ${s.slice(5)}`;
    const curMon = nowIST.getMonth(), curYr = nowIST.getFullYear();
    const thisMonExps = sorted.filter(x => { const d=new Date(x.ts); return d.getUTCMonth()===curMon&&d.getUTCFullYear()===curYr; });
    const nextMonExps = sorted.filter(x => { const d=new Date(x.ts); return d.getUTCMonth()===(curMon+1)%12; });
    const monthly = (thisMonExps.length ? thisMonExps[thisMonExps.length-1] : nextMonExps.length ? nextMonExps[nextMonExps.length-1] : null);
    result[instr] = { current: fmt(sorted[0].str), next: sorted[1]?fmt(sorted[1].str):null, monthly: monthly?fmt(monthly.str):null };
  }
  _expiryDates = result;
  if (_latestMarketData) _latestMarketData.expiry = _expiryDates;
  console.log('[expiry]', JSON.stringify(result));
}

// Parse active option contracts from recent Supabase trade_alert posts
async function refreshActiveContracts() {
  if (Date.now() - _activeContractsTs < 5 * 60 * 1000) return; // refresh every 5 min
  _activeContractsTs = Date.now();
  try {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const r = await ft(
      `${SB_URL}/rest/v1/posts?post_type=eq.trade_alert&is_deleted=eq.false&sent_at=gte.${since}&select=content`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }, 8000
    );
    if (!r.ok) return;
    const posts = await r.json();
    const contracts = [];
    posts.forEach(p => {
      const t = (p.content || '').toUpperCase();
      // Instrument
      const instrM = t.match(/\b(NIFTY|BANKNIFTY|SENSEX|MIDCAP)\b/);
      if (!instrM) return;
      const instr = instrM[1];
      // Strike: first 4-6 digit number after the instrument name
      // (handles "Nifty 23850 Next Weekly CE at 120" — CE is not adjacent to the number)
      const afterInstr = t.slice(t.indexOf(instr) + instr.length);
      const strikeMatch = afterInstr.match(/\b(\d{4,6})\b/);
      if (!strikeMatch) return;
      const strike = parseInt(strikeMatch[1]);
      // Type: CE or PE anywhere in the content
      const typeMatch = t.match(/\b(CE|PE)\b/);
      if (!typeMatch) return;
      const type = typeMatch[1];
      const expM   = t.match(/\b(NEXT\s+WEEKLY|WEEKLY|MONTHLY)\b/i);
      const expiry = resolveExpiry(expM ? expM[1] : 'Weekly', instr);
      // Deduplicate
      if (!contracts.find(c => c.instrument===instr && c.strike===strike && c.type===type && c.expiry===expiry))
        contracts.push({ instrument: instr, strike, type, expiry });
    });
    _activeContracts = contracts;
    console.log(`[contracts] Active: ${contracts.map(c=>`${c.instrument}${c.strike}${c.type}`).join(', ')}`);
  } catch(e) { console.error('[contracts] refresh error:', e.message); }
}

// Build Kotak trading symbol (no-year format: NIFTY19JUN24000CE) from contract fields
// Kotak pTrdSymbol in their CSV uses DDMMMSTRIKECETYPE without year — same format accepted by LTP API
function buildTradingSymbol(instrument, strike, type, expiry) {
  // expiry is DDMMMYYYY e.g. "19JUN2026" — strip year to get "19JUN"
  const m = (expiry||'').match(/^(\d{2})([A-Z]{3})\d{4}$/);
  if (!m) return null;
  return `${instrument.toUpperCase()}${m[1]}${m[2]}${strike}${type.toUpperCase()}`;
}

// Fetch option LTPs from Kotak Neo for all active contracts (runs every 5s)
// Uses numeric token from scrip master if available; falls back to trading symbol string
async function fetchKotakOptionLTPs() {
  if (!session.token || !session.baseUrl || !_activeContracts.length) return;
  for (const c of _activeContracts) {
    const numToken = getOptionToken(c.instrument, c.strike, c.type, c.expiry);
    // Fallback: trading symbol e.g. "NIFTY19JUN24000CE" — Kotak LTP API accepts both formats
    const tradeSym = numToken ? null : buildTradingSymbol(c.instrument, c.strike, c.type, c.expiry);
    const identifier = numToken || tradeSym;
    if (!identifier) {
      console.log(`[ltp] Cannot build identifier for ${c.instrument}-${c.strike}-${c.type}-${c.expiry}`);
      continue;
    }
    try {
      const url = `${session.baseUrl}/script-details/1.0/quotes/neosymbol/nse_fo|${identifier}/ltp`;
      const r = await ftKotak(url, {
        headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' }
      }, 3000);
      if (!r.ok) continue;
      const d = await r.json();
      const ltp = parseFloat(d?.data?.[0]?.ltp || (Array.isArray(d) ? d[0]?.ltp : null) || d?.ltp);
      if (ltp > 0) {
        const key = `${c.instrument}-${c.strike}-${c.type}`;
        _optionChain[key] = ltp;
        if (_latestMarketData) _latestMarketData.optionLTPs = { ..._optionChain };
        if (tradeSym) console.log(`[ltp] ${key}=${ltp} via trading symbol ${tradeSym}`);
        // Cache returned numeric token to avoid repeated symbol-based lookups
        const respToken = String(d?.data?.[0]?.token || d?.data?.[0]?.scripToken || '').trim();
        if (respToken && !numToken) {
          _scripMaster[`${c.instrument}-${c.strike}-${c.type}-${c.expiry}`] = respToken;
        }
      }
    } catch(e) { /* silent — stale data is fine */ }
  }
}

// NSE option chain fallback — used when Kotak is not logged in
async function fetchNSEOptionChainFallback(symbol) {
  try {
    if (!_nseCookies || Date.now() - _nseCookieTs > 10 * 60 * 1000) await refreshNSECookies();
    const r = await ft(`https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`,
      { headers: { ...NSE_HEADERS, 'Cookie': _nseCookies } }, 10000);
    if (!r.ok) return;
    const data = await r.json();
    const today = new Date(); today.setHours(0,0,0,0);
    const sorted = [...(data?.records?.data || [])].sort((a,b) => new Date(a.expiryDate)-new Date(b.expiryDate));
    const seen = {};
    sorted.forEach(row => {
      const exp = new Date(row.expiryDate); exp.setHours(0,0,0,0);
      if (exp < today) return;
      ['CE','PE'].forEach(type => {
        const key = `${symbol}-${row.strikePrice}-${type}`;
        if (seen[key]) return;
        const ltp = row[type]?.lastPrice;
        if (ltp > 0) { _optionChain[key] = ltp; seen[key] = true; }
      });
    });
  } catch(e) { console.error(`[options-nse] ${symbol}:`, e.message); }
}

function startKotakLtpInterval() {
  if (_kotakLtpInterval) return;
  _kotakLtpInterval = setInterval(fetchKotakOptionLTPs, 5000);
  fetchKotakOptionLTPs(); // immediate first run
  console.log('[ltp] Kotak option LTP interval started (5s)');
}

function stopKotakLtpInterval() {
  if (_kotakLtpInterval) { clearInterval(_kotakLtpInterval); _kotakLtpInterval = null; }
}

// SENSEX via BSE India public API — no login needed, works independently of TOTP
async function fetchSensexBSE() {
  try {
    const r = await ft(
      'https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=1&seriesid=',
      { headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.bseindia.com/',
          'Accept': 'application/json, */*'
      }},
      8000
    );
    if (!r.ok) return null;
    const d     = await r.json();
    const price = parseFloat(d?.CurrRate?.LTP  || d?.Header?.LTP       || 0);
    const prev  = parseFloat(d?.Header?.PrevClose || 0);
    if (!price) return null;
    const change    = parseFloat((price - prev).toFixed(2));
    const changePct = prev ? parseFloat(((change / prev) * 100).toFixed(2)) : 0;
    return { price, change, changePct };
  } catch(e) { console.log(`[BSE] error: ${e.message}`); return null; }
}

async function pushMarketToGitHub(marketData) {
  if (!GH_TOKEN) { console.error('GH_TOKEN not set — cannot push market.json'); return false; }
  const api = `https://api.github.com/repos/${GH_REPO}/contents/market.json`;
  const headers = { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
  try {
    const r   = await ft(api, { headers }, 8000);
    const cur = await r.json();
    const sha = cur.sha || '';
    await ft(api, {
      method: 'PUT', headers,
      body: JSON.stringify({ message: 'market data update', content: Buffer.from(JSON.stringify(marketData, null, 2)).toString('base64'), sha, branch: 'main' })
    }, 12000);
    return true;
  } catch (e) { console.error('pushMarketToGitHub error:', e.message); return false; }
}

async function runMarketScraper(force = false) {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const mins = now.getHours() * 60 + now.getMinutes();
  if (!force && !isMarketHours()) {
    stopMarketScraper();
    // push marketOpen:false
    try {
      const r = await ft(`https://raw.githubusercontent.com/${GH_REPO}/main/market.json?t=${Date.now()}`, {}, 5000);
      const existing = await r.json();
      existing.marketOpen = false;
      existing.lastUpdated = new Date().toISOString();
      await pushMarketToGitHub(existing);
    } catch {}
    await tgAlert('🔴 <b>Market scraper auto-stopped</b> (3:35 PM IST). market.json marked closed.');
    return;
  }
  try {
    // NSE for NIFTY + BANKNIFTY + movers; BSE India public API for SENSEX
    const [nseData, sensex, movers] = await Promise.all([fetchNSEAllIndices(), fetchSensexBSE(), fetchNSEMovers()]);
    // Refresh active contracts from Supabase every 5 min (feeds the 5s Kotak LTP interval)
    refreshActiveContracts().catch(e => console.error('[contracts] bg refresh error:', e.message));
    // NSE option chain — always fetch as baseline; Kotak 5s interval overrides per-contract if scrip master works
    await Promise.all([
      fetchNSEOptionChainFallback('NIFTY').catch(()=>{}),
      fetchNSEOptionChainFallback('BANKNIFTY').catch(()=>{})
    ]);
    const [nifty, banknifty] = ['NIFTY', 'BANKNIFTY'].map(inst => {
      if (!nseData) return null;
      const name = NSE_INDEX_NAMES[inst];
      const idx  = nseData.data?.find(x => x.indexSymbol === name || x.index === name);
      if (!idx) return null;
      return {
        price:     parseFloat((parseFloat(idx.last || idx.indexValue || 0)).toFixed(2)),
        change:    parseFloat((parseFloat(idx.variation || idx.change || 0)).toFixed(2)),
        changePct: parseFloat((parseFloat(idx.percentChange || idx.pChange || 0)).toFixed(2))
      };
    });
    const n50 = nseData?.data?.find(x => x.indexSymbol === 'NIFTY 50' || x.index === 'NIFTY 50');
    const breadth = n50 ? { advancing: parseInt(n50.advances)||0, declining: parseInt(n50.declines)||0, unchanged: parseInt(n50.unchanged)||0 } : null;
    const existing = _latestMarketData || { gainers: [], losers: [], breadth: { nifty50: { advancing: 0, declining: 0, unchanged: 0 } } };
    const day = now.getDay(); // 0=Sun, 6=Sat
    const isWeekday = day >= 1 && day <= 5;
    const isMarketOpen = isWeekday && mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
    const marketData = {
      marketOpen:  isMarketOpen,
      lastUpdated: new Date().toISOString(),
      indices: {
        NIFTY:     nifty     || existing.indices?.NIFTY     || { price: 0, change: 0, changePct: 0 },
        SENSEX:    sensex    || existing.indices?.SENSEX    || { price: 0, change: 0, changePct: 0 },
        BANKNIFTY: banknifty || existing.indices?.BANKNIFTY || { price: 0, change: 0, changePct: 0 }
      },
      breadth: { nifty50: breadth || existing.breadth?.nifty50 || { advancing: 0, declining: 0, unchanged: 0 } },
      gainers: movers?.gainers || existing.gainers || [],
      losers:  movers?.losers  || existing.losers  || []
    };
    // optionLTPs is served live from memory but NOT pushed to GitHub (too dynamic, too large)
    _latestMarketData = { ...marketData, optionLTPs: { ..._optionChain }, expiry: _expiryDates };
    await pushMarketToGitHub(marketData);
    console.log(`Market pushed — NIFTY:${nifty?.price} SENSEX:${sensex?.price} BANKNIFTY:${banknifty?.price}`);
  } catch (e) { console.error('runMarketScraper error:', e.message); }
}

function startMarketScraper() {
  if (marketScraperInterval) return false;
  marketScraperInterval = setInterval(runMarketScraper, 15_000);
  runMarketScraper();
  startKotakLtpInterval(); // start 5s Kotak option LTP fetch (uses _activeContracts)
  return true;
}

function stopMarketScraper() {
  if (marketScraperInterval) { clearInterval(marketScraperInterval); marketScraperInterval = null; }
  stopKotakLtpInterval();
}

// ── SL MONITOR ────────────────────────────────────────────────────────────────
async function checkSLs() {
  const active = Object.entries(state.trades).filter(([, t]) => !t.pending);
  if (!active.length || !session.token) return;
  if (!kvLock('sl_lock', 50)) return;
  try {
    const instruments = [...new Set(active.map(([, t]) => t.instrument))];
    const spots = {};
    for (const inst of instruments) spots[inst] = await fetchSpot(inst);
    let changed = false;
    const now = Date.now();
    for (const [tid, trade] of active) {
      const spot = spots[trade.instrument];
      if (!spot) continue;
      const slSpot  = parseFloat(trade.sl_spot);
      const sustain = Math.max(1, parseInt(trade.sl_sustain_minutes) || 5) * 60_000;
      const breached = (trade.sl_direction === 'above' && spot >= slSpot) ||
                       (trade.sl_direction === 'below' && spot <= slSpot);
      if (breached && !trade.sl_cancelled) {
        if (!trade.sl_breach_time) {
          trade.sl_breach_time = now; changed = true;
          const cmp = parseFloat(trade.opt_cmp) || parseFloat(trade.entry);
          await tgAlert(`🚨 <b>SL BREACHED!</b>\n<b>${trade.instrument} ${trade.strike} ${trade.option_type}</b>\nSpot: <b>${spot}</b> | SL: <b>${slSpot}</b> (${trade.sl_direction})\nPremium CMP: ₹${cmp}\n⏳ Auto-exit in ${trade.sl_sustain_minutes || 5} min`);
          await tgSend(`🚨 <b>SL ALERT — tap to act:</b>`, { inline_keyboard: [[
            { text: `✅ Exit Now (₹${cmp})`, callback_data: `slconfirm_${tid}_${trade.qty}_${cmp}` },
            { text: '❌ Cancel SL',          callback_data: `slcancel_${tid}` }
          ]]});
        } else if (now - trade.sl_breach_time >= sustain) {
          const cmp = parseFloat(trade.opt_cmp) || parseFloat(trade.entry);
          await tgAlert(`🛑 <b>AUTO-EXIT</b>\n${trade.instrument} ${trade.strike} ${trade.option_type} | Spot: ${spot}`);
          await exitPosition(tid, parseInt(trade.qty), cmp); changed = true;
        }
      } else if (!breached && trade.sl_breach_time) {
        trade.sl_breach_time = null; trade.sl_cancelled = false; changed = true;
        await tgAlert(`✅ <b>SL Recovered</b> — ${trade.instrument} spot: ${spot}\nAuto-SL re-armed.`);
      }
    }
    if (changed) await saveState();
  } finally { kvUnlock('sl_lock'); }
}

// ── PLACE ORDER ───────────────────────────────────────────────────────────────
async function placeOrder(trade) {
  const qty = parseInt(trade.qty);
  if (qty <= 0)                         { await tgSend('❌ Invalid qty.');                                   return null; }
  if (qty > MAX_QTY)                    { await tgSend(`❌ Qty ${qty} exceeds max ${MAX_QTY}`);              return null; }
  if (state.orderCount >= MAX_ORDERS)   { await tgSend(`❌ Daily order limit ${MAX_ORDERS} reached`);        return null; }
  if (state.dailyPnl < -MAX_DAILY_LOSS) { await tgSend(`🚫 Daily loss limit ${fmtINR(MAX_DAILY_LOSS)} hit`); return null; }
  if (trade._placing) { await tgSend('⚠️ Order already in progress.'); return null; }
  trade._placing = true;

  if (trade.mode === 'PAPER' || !session.token) {
    delete trade._placing;
    const oid = `PAPER_${Date.now()}`;
    state.orderCount++;
    await tgSend(fmtTrade(trade, '📝 <b>ORDER SIMULATED</b>', `<b>Order ID:</b> ${oid}\n<i>Paper mode — no real order placed</i>`));
    return oid;
  }

  try {
    if (!isSessionValid()) { delete trade._placing; return null; }
    const lotSize    = LOT_SIZES[trade.instrument] || 25;
    const totalQty   = qty * lotSize;
    const trans      = trade.action.toUpperCase().includes('BUY') ? 'B' : 'S';
    const scripToken = await findScripToken(trade);
    const jData = JSON.stringify({
      am:'NO', dq:'0', es:'nse_fo', ig:'Trade2Spend', mp:'0',
      os:'NEOTRADEAPI', pc:'NRML', pf:'N', pr:String(trade.entry),
      pt:'L', qt:totalQty.toString(), rt:'DAY', tp:'0', ts:scripToken, tt:trans
    });
    const sId = session.hsServerId || session.rid || '';
    const or  = await ftKotak(`${session.baseUrl}/quick/order/rule/ms/place?sId=${sId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sid': session.sid, 'Auth': session.token, 'neo-fin-key': 'neotradeapi' },
      body: `jData=${encodeURIComponent(jData)}`
    });
    delete trade._placing;
    state.orderCount++;

    if (or.ok) {
      const od = await or.json();
      const liveOid = od.data?.nOrdNo || od.data?.orderId || `LIVE_${Date.now()}`;
      trade.scrip_token = scripToken;
      await tgSend(fmtTrade(trade, '✅ <b>LIVE ORDER PLACED</b>', `<b>Order ID:</b> ${liveOid}\n<b>Exchange qty:</b> ${totalQty} units`));
      setTimeout(async () => {
        try {
          const sr  = await ftKotak(`${session.baseUrl}/quick/order/history`, { headers: neoHeaders(), method: 'GET' }, 5000);
          const sd  = await sr.json();
          const ord = (sd.data || []).find(o => o.nOrdNo === liveOid || o.orderId === liveOid);
          if (ord?.status && !['complete','open','trigger pending'].includes(String(ord.status).toLowerCase()))
            await tgAlert(`⚠️ Order ${liveOid} status: <b>${ord.status}</b> — verify on Kotak app!`);
        } catch {}
      }, 2000);
      return liveOid;
    } else {
      const err = await or.json().catch(() => ({}));
      state.orderCount--;
      if (err.stCode === 100008 || err.errMsg === 'unauthorized') {
        const ipR  = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) }).catch(() => null);
        const newIp = ipR ? (await ipR.json()).ip : 'check with: curl ifconfig.me';
        await tgAlert(`🚨 <b>Order Blocked — IP Not Whitelisted</b>\nServer IP: <code>${newIp}</code>\nAdd this to Kotak Neo API IP whitelist.`);
      } else {
        await tgSend(`❌ <b>Broker rejected order</b>\n${err.message || err.errMsg || JSON.stringify(err).slice(0,200)}`);
      }
      return null;
    }
  } catch (e) {
    delete trade._placing;
    await tgSend(`❌ <b>Order error:</b> ${e.message}\n<i>Verify no order was placed on Kotak app!</i>`);
    return null;
  }
}

// ── EXIT POSITION ─────────────────────────────────────────────────────────────
async function exitPosition(tid, qtyExit, priceExit) {
  const trade = state.trades[tid];
  if (!trade) { await tgSend('❌ Trade not found.'); return; }
  if (qtyExit <= 0) { await tgSend('❌ Invalid qty.'); return; }
  const remaining = parseInt(trade.qty);
  if (qtyExit > remaining) { await tgSend(`❌ Cannot exit ${qtyExit} — only ${remaining} remaining.`); return; }

  const lotSize  = LOT_SIZES[trade.instrument] || 65;
  const isBuy    = trade.action.toUpperCase().includes('BUY');
  const pnlPaise = (isBuy
    ? Math.round(priceExit * 100) - Math.round(parseFloat(trade.entry) * 100)
    : Math.round(parseFloat(trade.entry) * 100) - Math.round(priceExit * 100)
  ) * qtyExit * lotSize;
  const pnl     = pnlPaise / 100;
  state.dailyPnl = Math.round((state.dailyPnl + pnl) * 100) / 100;

  if (!trade.exit_history) trade.exit_history = [];
  trade.exit_history.push({ qty: qtyExit, price: priceExit, time: istTime() });

  if (qtyExit >= remaining) {
    const icon = trade.sl_breach_time ? '🛑' : '✅';
    const msg  = fmtTrade(trade, `${icon} <b>POSITION EXITED</b>`,
      `<b>Exit:</b> ${qtyExit} lots @ ₹${priceExit}\n` +
      `<b>P&amp;L:</b> ${pnlSign(pnl)}${fmtINR(pnl)}\n` +
      `<b>Daily P&amp;L:</b> ${pnlSign(state.dailyPnl)}${fmtINR(state.dailyPnl)}\n` +
      `<i>${istTime()}</i>`);
    if (trade.active_msg_id) await tgEdit(trade.active_msg_id, msg, { inline_keyboard: [] });
    else await tgSend(msg);
    delete state.trades[tid];
  } else {
    state.trades[tid].qty = remaining - qtyExit;
    await tgSend(fmtTrade(state.trades[tid], '📤 <b>PARTIAL EXIT</b>',
      `Exited: ${qtyExit} lots @ ₹${priceExit}\nP&amp;L: ${pnlSign(pnl)}${fmtINR(pnl)}\nRemaining: ${state.trades[tid].qty} lots`),
      tradeKeyboard(tid));
  }
  await saveState();
}

// ── KILL SWITCH ───────────────────────────────────────────────────────────────
async function killSwitch() {
  await tgSend('🔴 <b>KILL SWITCH ACTIVATED</b>\nClosing all bot-tracked positions...');
  let count = 0; const log = [];
  for (const [tid, trade] of Object.entries(state.trades)) {
    if (trade.pending) { delete state.trades[tid]; continue; }
    const cmp = parseFloat(trade.opt_cmp) || parseFloat(trade.entry);
    await exitPosition(tid, parseInt(trade.qty), cmp);
    log.push(`${trade.instrument} ${trade.strike} ${trade.option_type} — ₹${cmp}`);
    count++;
  }
  state.trades = {}; state.pendingAction = null;
  await saveState();
  await tgSend(
    `🔴 <b>KILL SWITCH COMPLETE</b>\nExited: ${count} position(s)\n` +
    (log.length ? `\n${log.map(l=>`• ${l}`).join('\n')}\n` : '\nNo active bot trades.\n') +
    `\n⚠️ Long-term holdings untouched. Verify on Kotak app.`
  );
}

// ── STATUS ────────────────────────────────────────────────────────────────────
async function sendStatus() {
  const active = Object.entries(state.trades).filter(([, t]) => !t.pending);
  const mode   = state.paperMode ? '📝 Paper' : '🔴 Live';
  const age    = session.lastLogin ? `${Math.round((Date.now()-session.lastLogin)/60000)}m ago` : 'N/A';
  const login  = session.token ? `✅ ${age}` : '❌ Not logged in';
  if (!active.length) {
    await tgSend(`📊 <b>No open positions</b>\n<b>Daily P&amp;L:</b> ${pnlSign(state.dailyPnl)}${fmtINR(state.dailyPnl)}\n<b>Orders today:</b> ${state.orderCount}\n<b>Mode:</b> ${mode} | <b>Login:</b> ${login}`);
    return;
  }
  let msg = `📊 <b>OPEN POSITIONS</b>\n━━━━━━━━━━━━━━━━━━\n`;
  const rows = []; let i = 1;
  for (const [tid, t] of active) {
    msg += `\n${i}️⃣ <b>${t.action} ${t.instrument} ${t.strike} ${t.option_type}</b>${t.sl_breach_time?' 🚨':''}\n` +
           `Entry ₹${t.entry} | Qty ${t.qty} lots | SL: ${t.sl_spot} (${t.sl_direction})\n`;
    rows.push([{ text: `${i}️⃣ Manage`, callback_data: `manage_${tid}` }]); i++;
  }
  msg += `\n<b>Daily P&amp;L:</b> ${pnlSign(state.dailyPnl)}${fmtINR(state.dailyPnl)}\n<b>Mode:</b> ${mode} | <b>Login:</b> ${login}`;
  rows.push([{ text: '🔄 Refresh', callback_data: 'status_all' }, { text: '🚨 EXIT ALL', callback_data: 'exit_all' }]);
  await tgSend(msg, { inline_keyboard: rows });
}

// ── PROCESS TRADE PAYLOAD ─────────────────────────────────────────────────────
async function processTrade(text) {
  try {
    const idx = text.indexOf('PAYLOAD:');
    if (idx === -1) return;
    let trade;
    try { trade = JSON.parse(text.slice(idx + 8)); }
    catch { await tgSend('❌ <b>Malformed PAYLOAD</b> — invalid JSON.'); return; }
    if (trade.source !== 'Trade2SpendPWA') return;
    const err = validatePayload(trade);
    if (err) { await tgSend(`❌ <b>Invalid payload:</b> ${err}`); return; }
    trade.option_type  = trade.option_type.toUpperCase();
    trade.sl_direction = trade.sl_direction.toLowerCase();
    for (const [, t] of Object.entries(state.trades)) {
      if (t.instrument === trade.instrument && t.strike === trade.strike && t.option_type === trade.option_type) {
        await tgSend(`⚠️ ${trade.instrument} ${trade.strike} ${trade.option_type} already ${t.pending?'pending':'active'}. Exit first.`);
        return;
      }
    }
    const tid = String(Date.now());
    trade.mode = state.paperMode ? 'PAPER' : 'LIVE'; trade.pending = true;
    state.trades[tid] = trade;
    const mid = await tgSend(
      fmtTrade(trade, `⚡ <b>CONFIRM ORDER ${trade.mode === 'PAPER'?'📝 PAPER':'🔴 LIVE'}</b>`,
        `<b>Expiry resolved:</b> ${resolveExpiry(trade.expiry, trade.instrument)}\n` +
        `<b>Sustain:</b> ${trade.sl_sustain_minutes || 5} min\n<i>Tap Confirm to place</i>`),
      { inline_keyboard: [[
        { text: '✅ Confirm & Place', callback_data: `confirm_${tid}` },
        { text: '❌ Cancel',          callback_data: `reject_${tid}`  }
      ]]}
    );
    state.trades[tid].confirm_msg_id = mid;
    await saveState();
  } catch (e) { await tgSend(`❌ Trade error: ${e.message}`); }
}

// ── CALLBACKS ─────────────────────────────────────────────────────────────────
async function handleCallback(cb) {
  const cbId = cb.id, action = cb.data, msgId = cb.message.message_id;

  if (action.startsWith('confirm_') && !action.startsWith('confirm_exit') && action !== 'confirm_live' && action !== 'confirm_kill') {
    const tid = action.slice(8), trade = state.trades[tid];
    if (!trade?.pending) { await tgAnswer(cbId, 'Expired'); return; }
    await tgAnswer(cbId, 'Placing...');
    if (trade.confirm_msg_id) await tgEdit(trade.confirm_msg_id, fmtTrade(trade, '⏳ <b>PLACING ORDER...</b>'), { inline_keyboard: [] });
    delete trade.pending; delete trade.confirm_msg_id; trade.exit_history = [];
    const oid = await placeOrder(trade);
    if (oid) {
      trade.order_id = oid; trade.placed_at = istTime();
      const mid = await tgSend(fmtTrade(trade, '✅ <b>TRADE ACTIVE</b>', `<b>Order ID:</b> ${oid}\n<b>Time:</b> ${trade.placed_at}`), tradeKeyboard(tid));
      if (mid) trade.active_msg_id = mid;
    } else { delete state.trades[tid]; }
    await saveState(); return;
  }
  if (action.startsWith('reject_')) {
    delete state.trades[action.slice(7)];
    await tgAnswer(cbId, 'Cancelled'); await tgEdit(msgId, '❌ Order cancelled.', { inline_keyboard: [] });
    await saveState(); return;
  }
  if (action.startsWith('exit_') && action !== 'exit_all') {
    const tid = action.slice(5), trade = state.trades[tid];
    if (!trade) { await tgAnswer(cbId, 'Trade not found'); return; }
    const qty = parseInt(trade.qty), half = Math.max(1, Math.floor(qty/2));
    await tgAnswer(cbId, '');
    const rows = qty > 1
      ? [[{ text: `All ${qty} lots`, callback_data: `exitqty_${tid}_${qty}` }, { text: `Half ${half} lots`, callback_data: `exitqty_${tid}_${half}` }]]
      : [[{ text: `Exit ${qty} lot`, callback_data: `exitqty_${tid}_${qty}` }]];
    rows.push([{ text: '✏️ Custom qty', callback_data: `exitqty_${tid}_custom` }, { text: '⬅️ Back', callback_data: `manage_${tid}` }]);
    await tgSend(`📤 <b>Exit ${trade.instrument} ${trade.strike} ${trade.option_type}</b>\nRemaining: ${qty} lots\n\nSelect qty:`, { inline_keyboard: rows }); return;
  }
  if (action.startsWith('exitqty_')) {
    const [, tid, qtyStr] = action.split('_'), trade = state.trades[tid];
    if (!trade) { await tgAnswer(cbId, 'Trade not found'); return; }
    await tgAnswer(cbId, '');
    if (qtyStr === 'custom') {
      state.pendingAction = { action: 'exit_qty', tid };
      await tgSend(`Enter qty to exit:\n<b>Remaining:</b> ${trade.qty} lots`); await saveState();
    } else {
      const qtyExit = parseInt(qtyStr), cmp = parseFloat(trade.opt_cmp) || parseFloat(trade.entry);
      state.pendingAction = { action: 'exit_price', tid, qty: qtyExit };
      await tgSend(`📤 Exiting <b>${qtyExit} lots</b>\nCMP: ₹${cmp}\n\nSelect exit price:`, { inline_keyboard: [
        [{ text: `Market (₹${cmp})`, callback_data: `exitprice_${tid}_${qtyExit}_${Math.round(cmp)}` }, { text: '✏️ Custom', callback_data: `exitprice_${tid}_${qtyExit}_custom` }],
        [{ text: '⬅️ Back', callback_data: `exit_${tid}` }]
      ]});
      await saveState();
    }
    return;
  }
  if (action.startsWith('exitprice_')) {
    const parts = action.split('_'), tid = parts[1], qtyExit = parseInt(parts[2]), priceStr = parts[3];
    if (priceStr === 'custom') {
      state.pendingAction = { action: 'exit_price', tid, qty: qtyExit };
      await tgAnswer(cbId, ''); await tgSend(`Enter exit price for <b>${qtyExit} lots</b>:`); await saveState();
    } else { await tgAnswer(cbId, 'Placing exit...'); await exitPosition(tid, qtyExit, parseFloat(priceStr)); }
    return;
  }
  if (action === 'exit_all') {
    await tgAnswer(cbId, '');
    const count = Object.values(state.trades).filter(t=>!t.pending).length;
    await tgSend(`⚠️ <b>EXIT ALL ${count} positions?</b>`, { inline_keyboard: [[
      { text: '✅ Yes Exit All', callback_data: 'confirm_exit_all' }, { text: '❌ Cancel', callback_data: 'status_all' }
    ]]}); return;
  }
  if (action === 'confirm_exit_all') {
    await tgAnswer(cbId, 'Exiting all...');
    for (const [tid, t] of Object.entries(state.trades))
      if (!t.pending) await exitPosition(tid, parseInt(t.qty), parseFloat(t.opt_cmp)||parseFloat(t.entry));
    return;
  }
  if (action.startsWith('slconfirm_')) {
    const parts = action.split('_');
    await tgAnswer(cbId, 'Exiting...'); await tgEdit(msgId, '🛑 <b>SL EXIT PLACED</b>', { inline_keyboard: [] });
    await exitPosition(parts[1], parseInt(parts[2]), parseFloat(parts[3])); return;
  }
  if (action.startsWith('slcancel_')) {
    const tid = action.slice(9), trade = state.trades[tid];
    if (!trade) { await tgAnswer(cbId, 'Not found'); return; }
    trade.sl_cancelled = true; trade.sl_breach_time = null;
    await tgAnswer(cbId, 'Auto-SL paused');
    await tgEdit(msgId, '⏸️ <b>Auto-SL paused</b> — re-arms if spot recovers', { inline_keyboard: [] });
    await saveState(); return;
  }
  if (action.startsWith('slorder_')) {
    const tid = action.slice(8), trade = state.trades[tid];
    if (!trade) { await tgAnswer(cbId, 'Not found'); return; }
    await tgAnswer(cbId, '');
    if (trade.sl_orders?.length > 0) {
      const used = trade.sl_orders.reduce((s,o)=>s+o.qty,0);
      let msg = `🛑 <b>Active SL Orders</b>\n━━━━━━━━━━━━━━━━━━\n`;
      trade.sl_orders.forEach((o,i) => { msg += `${i+1}. Qty: ${o.qty} | Trigger: ₹${o.trigger} | Limit: ₹${o.limit}\n`; });
      msg += `SL allocated: ${used} / ${trade.qty} lots`;
      const rows = trade.sl_orders.map((o,i) => [
        { text: `✏️ Edit ${i+1}`, callback_data: `editsl_${tid}_${i}` },
        { text: `❌ Cancel ${i+1}`, callback_data: `cancelsl_${tid}_${i}` }
      ]);
      if (parseInt(trade.qty) - used > 0) rows.push([{ text: '➕ Add SL', callback_data: `addsl_${tid}` }]);
      rows.push([{ text: '⬅️ Back', callback_data: `manage_${tid}` }]);
      await tgSend(msg, { inline_keyboard: rows });
    } else {
      state.pendingAction = { action: 'sl_qty', tid };
      await tgSend(`🛑 <b>New SL Order</b>\n${trade.instrument} ${trade.strike} ${trade.option_type}\nQty: ${trade.qty} lots\n\nEnter qty:`);
      await saveState();
    }
    return;
  }
  if (action.startsWith('addsl_')) {
    const tid = action.slice(6); state.pendingAction = { action: 'sl_qty', tid };
    await tgAnswer(cbId, ''); await tgSend(`Enter qty for new SL order (/cancel to abort):`); await saveState(); return;
  }
  if (action.startsWith('editsl_')) {
    const [, tid, idx] = action.split('_'), trade = state.trades[tid];
    if (!trade?.sl_orders?.[idx]) { await tgAnswer(cbId, 'Not found'); return; }
    state.pendingAction = { action: 'sl_qty', tid, editIdx: parseInt(idx) };
    await tgAnswer(cbId, ''); await tgSend(`Edit SL ${parseInt(idx)+1}: enter new qty:`); await saveState(); return;
  }
  if (action.startsWith('cancelsl_')) {
    const [, tid, idx] = action.split('_'), trade = state.trades[tid];
    if (!trade?.sl_orders?.[parseInt(idx)]) { await tgAnswer(cbId, 'Not found'); return; }
    trade.sl_orders.splice(parseInt(idx), 1);
    await tgAnswer(cbId, 'Cancelled'); await tgEdit(msgId, `✅ SL Order ${parseInt(idx)+1} cancelled.`, { inline_keyboard: [] });
    await saveState(); return;
  }
  if (action.startsWith('settgt_')) {
    const tid = action.slice(7);
    if (!state.trades[tid]) { await tgAnswer(cbId, 'Not found'); return; }
    state.pendingAction = { action: 'set_target', tid }; await tgAnswer(cbId, '');
    await tgSend(`🎯 Enter target premium price:\n<b>Entry:</b> ₹${state.trades[tid].entry}`); await saveState(); return;
  }
  if (action.startsWith('manage_')) {
    const tid = action.slice(7);
    if (!state.trades[tid]) { await tgAnswer(cbId, 'Not found'); return; }
    await tgAnswer(cbId, ''); await tgSend(fmtTrade(state.trades[tid], '📊 <b>MANAGING POSITION</b>'), tradeKeyboard(tid)); return;
  }
  // ── MEMBER UNLOCK CALLBACKS ──────────────────────────────────────────────
  if (action.startsWith('unlock_member_')) {
    const memberId = action.slice('unlock_member_'.length);
    await tgAnswer(cbId, 'Unlocking...');
    try {
      if (SB_KEY) {
        await fetch(`${SB_URL}/rest/v1/sessions?member_id=eq.${memberId}`, {
          method: 'PATCH',
          headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ locked_until: null, failed_attempts_today: 0 })
        });
      }
      await tgEdit(msgId, '✅ <b>Member Unlocked</b>\nThey can now log in again.', { inline_keyboard: [] });
    } catch(e) { await tgAnswer(cbId, 'Error: ' + e.message); }
    return;
  }
  if (action.startsWith('ignore_unlock_')) {
    await tgAnswer(cbId, 'Ignored');
    await tgEdit(msgId, '🚫 <b>Unlock request ignored.</b>', { inline_keyboard: [] });
    return;
  }
  if (action.startsWith('msg_member_')) {
    const mobile = action.slice('msg_member_'.length);
    await tgAnswer(cbId, '');
    await tgSend(`📱 <b>Member Mobile:</b> <code>${mobile}</code>\nContact them directly via phone/WhatsApp.`);
    return;
  }

  // ── ADMIN PIN RESET FLOW ─────────────────────────────────────────────────────
  if (action === 'admin_pin_reset_ask') {
    await tgAnswer(cbId, '');
    await tgEdit(msgId,
      `🔐 <b>Confirm PIN Reset</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `This will clear the existing PIN.\n` +
      `After confirming, open admin.html — you will land on Setup to create a new PIN.\n\n` +
      `⚠️ <b>Only confirm if this was you.</b>`,
      { inline_keyboard: [[
        { text: '✅ Yes, Reset PIN', callback_data: 'admin_pin_reset_confirm' },
        { text: '❌ Cancel',         callback_data: 'admin_pin_reset_cancel'  }
      ]]}
    );
    return;
  }
  if (action === 'admin_pin_reset_confirm') {
    await tgAnswer(cbId, 'Resetting PIN...');
    try {
      if (SB_KEY) {
        await fetch(`${SB_URL}/rest/v1/keep_alive_log?source=eq.admin_pwa_locked`, {
          method: 'DELETE', headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
        });
        await fetch(`${SB_URL}/rest/v1/keep_alive_log?source=like.admin_session_%25`, {
          method: 'DELETE', headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
        });
        await fetch(`${SB_URL}/rest/v1/keep_alive_log`, {
          method: 'POST',
          headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ source: 'admin_pin_reset', pinged_at: new Date().toISOString() })
        });
      }
      await tgEdit(msgId,
        `✅ <b>PIN Reset Done</b>\n━━━━━━━━━━━━━━━━━━\n` +
        `Open <b>app.trade2spend.com/admin.html</b>\n` +
        `You will land on Setup tab — set your new PIN there.\n\n` +
        `<i>Done at ${istTime()} IST</i>`,
        { inline_keyboard: [] }
      );
    } catch(e) {
      await tgEdit(msgId, `❌ Reset failed: ${e.message}`, { inline_keyboard: [] });
    }
    return;
  }
  if (action === 'admin_pin_reset_cancel') {
    await tgAnswer(cbId, 'Cancelled');
    await tgEdit(msgId,
      `🚨 <b>Admin PWA — Alert Dismissed</b>\n` +
      `PIN reset cancelled. Lock remains active.\n<i>${istTime()} IST</i>`,
      { inline_keyboard: [] }
    );
    return;
  }
  if (action === 'admin_pin_ignore') {
    await tgAnswer(cbId, 'Dismissed');
    await tgEdit(msgId,
      `⚠️ <b>Admin alert dismissed.</b>\n` +
      `Lock remains active.\n<i>${istTime()} IST</i>`,
      { inline_keyboard: [] }
    );
    return;
  }

  if (action === 'status_all')   { await tgAnswer(cbId, 'Refreshing...'); await sendStatus(); return; }
  if (action === 'confirm_live') { state.paperMode = false; await tgAnswer(cbId, 'LIVE ON'); await tgSend('🔴 <b>LIVE mode ON</b>'); await saveState(); return; }
  if (action === 'stay_paper')   { await tgAnswer(cbId, 'Staying Paper'); return; }
  if (action === 'confirm_kill') { await tgAnswer(cbId, 'Executing...'); await killSwitch(); return; }
  await tgAnswer(cbId, '');
}

// ── MESSAGES ──────────────────────────────────────────────────────────────────
async function handleMessage(text) {
  const cmd = text.trim().toLowerCase();
  if (cmd === '/cancel') { state.pendingAction = null; await tgSend('❌ Action cancelled.'); await saveState(); return; }

  if (state.pendingAction) {
    const pa = state.pendingAction;
    if (pa.action === 'exit_qty') {
      const qty = parseInt(text.trim()), trade = state.trades[pa.tid];
      if (!trade || isNaN(qty) || qty <= 0) { await tgSend('❌ Invalid qty.'); return; }
      if (qty > parseInt(trade.qty))         { await tgSend(`❌ Only ${trade.qty} lots remaining.`); return; }
      state.pendingAction = { action: 'exit_price', tid: pa.tid, qty };
      const cmp = parseFloat(trade.opt_cmp) || parseFloat(trade.entry);
      await tgSend(`Qty: ${qty} lots | CMP: ₹${cmp}\n\nSelect exit price:`, { inline_keyboard: [[
        { text: `Market (₹${cmp})`, callback_data: `exitprice_${pa.tid}_${qty}_${Math.round(cmp)}` },
        { text: '✏️ Custom',        callback_data: `exitprice_${pa.tid}_${qty}_custom` }
      ]]});
      await saveState(); return;
    }
    if (pa.action === 'exit_price') {
      const price = parseFloat(text.trim());
      if (isNaN(price) || price <= 0) { await tgSend('❌ Invalid price.'); return; }
      state.pendingAction = null; await exitPosition(pa.tid, pa.qty, price); return;
    }
    if (pa.action === 'sl_qty') {
      const qty = parseInt(text.trim()), trade = state.trades[pa.tid];
      if (!trade || isNaN(qty) || qty <= 0) { await tgSend('❌ Invalid qty.'); return; }
      const used    = (trade.sl_orders||[]).reduce((s,o)=>s+o.qty,0);
      const editQty = pa.editIdx !== undefined ? (trade.sl_orders?.[pa.editIdx]?.qty||0) : 0;
      if (qty > parseInt(trade.qty) - used + editQty) { await tgSend(`❌ Max: ${parseInt(trade.qty)-used+editQty} lots.`); return; }
      state.pendingAction = { ...pa, action:'sl_trigger', qty };
      await tgSend(`Qty: ${qty} lots\n\nEnter <b>Trigger Price</b>:`); await saveState(); return;
    }
    if (pa.action === 'sl_trigger') {
      const trigger = parseFloat(text.trim());
      if (isNaN(trigger) || trigger <= 0) { await tgSend('❌ Invalid price.'); return; }
      state.pendingAction = { ...pa, action:'sl_limit', trigger };
      await tgSend(`Trigger: ₹${trigger}\n\nEnter <b>Limit Price</b>:`); await saveState(); return;
    }
    if (pa.action === 'sl_limit') {
      const limit = parseFloat(text.trim());
      if (isNaN(limit) || limit <= 0) { await tgSend('❌ Invalid price.'); return; }
      const trade = state.trades[pa.tid];
      if (!trade.sl_orders) trade.sl_orders = [];
      const slOrder = { qty: pa.qty, trigger: pa.trigger, limit };
      if (pa.editIdx !== undefined) trade.sl_orders[pa.editIdx] = slOrder; else trade.sl_orders.push(slOrder);
      state.pendingAction = null;
      const total = trade.sl_orders.reduce((s,o)=>s+o.qty,0);
      await tgSend(`🛑 <b>SL Saved</b>\n${trade.instrument} ${trade.strike} ${trade.option_type}\nQty: ${pa.qty} | Trigger: ₹${pa.trigger} | Limit: ₹${limit}\nTotal SL: ${total}/${trade.qty} lots`);
      await saveState(); return;
    }
    if (pa.action === 'set_target') {
      const tgt = parseFloat(text.trim());
      if (isNaN(tgt) || tgt <= 0) { await tgSend('❌ Invalid price.'); return; }
      const trade = state.trades[pa.tid]; trade.target = tgt; state.pendingAction = null;
      const lotSz = LOT_SIZES[trade.instrument] || 25;
      const isBuy = trade.action.toUpperCase().includes('BUY');
      const pot   = (isBuy ? tgt - parseFloat(trade.entry) : parseFloat(trade.entry) - tgt) * parseInt(trade.qty) * lotSz;
      await tgSend(`🎯 Target: ₹${tgt}\nPotential P&amp;L: +${fmtINR(pot)}`);
      await saveState(); return;
    }
  }

  if (text.includes('PAYLOAD:')) { await processTrade(text); return; }

  if (cmd === '/debug_spot') {
    const base = session.baseUrl;
    const tok  = session.token;
    if (!base || !tok) {
      await tgSend(`🔬 <b>debug_spot</b>\n<b>loggedIn:</b> ${!!tok}\n<b>baseUrl:</b> ${base || 'NOT SET'}\n\n⚠️ Not logged in — connect via PWA Setup tab.`);
      return;
    }
    await tgSend(`🔬 <b>debug_spot — testing Kotak LTP endpoint</b>\n<b>baseUrl:</b> <code>${base}</code>\n<b>token set:</b> yes (${tok.slice(0,8)}...)`);
    const variants = [
      { label: 'nse_cm|26000 + consumer_key',   exch: 'nse_cm', sym: '26000', hdrs: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' } },
      { label: 'nse_cm|26000 + session bearer',  exch: 'nse_cm', sym: '26000', hdrs: { 'Authorization': tok,          'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi', 'Sid': session.sid, 'Auth': tok } },
      { label: 'nse_cm|Nifty 50 + consumer_key', exch: 'nse_cm', sym: 'Nifty 50', hdrs: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' } },
    ];
    for (const v of variants) {
      const url = `${base}/script-details/1.0/quotes/neosymbol/${v.exch}|${v.sym}/ltp`;
      try {
        const r = await ftKotak(url, { method: 'GET', headers: v.hdrs }, 5000);
        const body = await r.text();
        await tgSend(`<b>${v.label}</b>\nStatus: <b>${r.status}</b>\nBody: <code>${body.slice(0,400) || '(empty)'}</code>`);
      } catch(e) {
        await tgSend(`<b>${v.label}</b>\nException: <code>${e.message}</code>`);
      }
    }
    return;
  }

  if (cmd === '/start' || cmd === '/help') {
    await tgSend(
      '🤖 <b>Trade2Spend v5.0</b>\n━━━━━━━━━━━━━━━━━━\n' +
      '<b>Kotak login:</b> Use PWA Setup tab → Connect Kotak\n\n' +
      '<b>Trading:</b>\n' +
      '/status — Open positions\n' +
      '/spot — Live NIFTY/BankNIFTY spot\n' +
      '/pnl — Today\'s P&amp;L\n' +
      '/paper — Paper mode (safe testing)\n' +
      '/live — Live mode (real orders)\n' +
      '/kill — 🔴 Emergency exit ALL positions\n' +
      '/reset — Reset daily counters\n' +
      '/debug_spot — Raw Kotak LTP API response\n' +
      '/debug_ltp — Test option LTP fetch\n' +
      '/debug_cmp — Scrip master + option chain status\n' +
      '/reload_scrip — Force re-download scrip master\n\n' +
      '<b>Market Data:</b>\n' +
      '/market_on — Start live market scraper\n' +
      '/market_off — Stop market scraper\n' +
      '/market_status — Scraper status\n\n' +
      '<b>Admin Recovery:</b>\n' +
      '/unlock_admin — Unlock admin PWA + reset PIN\n\n' +
      '/cancel — Cancel current action'
    ); return;
  }
  if (cmd === '/status') { await sendStatus(); return; }

  if (cmd === '/debug_cmp') {
    const allKeys = Object.keys(_scripMaster);
    const scripCount = allKeys.length;
    const chainCount = Object.keys(_optionChain).length;
    let msg = `🔬 <b>CMP Debug</b>\n━━━━━━━━━━━━━━━━━━\n`;
    msg += `<b>Kotak session:</b> ${session.token ? '✅ active' : '❌ not logged in'}\n`;
    msg += `<b>Scrip master:</b> ${scripCount} contracts\n`;
    msg += `<b>optionChain entries:</b> ${chainCount}\n`;
    msg += `<b>Active contracts:</b> ${_activeContracts.length}\n`;
    if (_activeContracts.length) {
      msg += `\n<b>Contracts being tracked:</b>\n`;
      for (const c of _activeContracts) {
        const key = `${c.instrument}-${c.strike}-${c.type}-${c.expiry}`;
        const token = _scripMaster[key] || null;
        const ltp = _optionChain[`${c.instrument}-${c.strike}-${c.type}`] || null;
        msg += `• ${c.instrument} ${c.strike} ${c.type} ${c.expiry}\n  token: ${token||'❌ NOT FOUND'} | LTP: ${ltp||'—'}\n`;
      }
    }
    // Search for any 2026 NIFTY keys in scrip master
    const nifty2026 = allKeys.filter(k => k.startsWith('NIFTY-') && k.includes('2026')).slice(0,5);
    msg += `\n<b>Sample NIFTY 2026 keys in scrip:</b>\n`;
    if (nifty2026.length) {
      nifty2026.forEach(k => { msg += `<code>${k}</code>\n`; });
    } else {
      msg += `⚠️ NONE FOUND — scrip master has NO 2026 NIFTY contracts!\n`;
    }
    // Show most recent 3 NIFTY expiry dates
    const niftyExpiries = [...new Set(allKeys.filter(k=>k.startsWith('NIFTY-')).map(k=>k.split('-').slice(3).join('-')))];
    niftyExpiries.sort((a,b) => {
      const M={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
      const parse = s => { const m=s.match(/(\d+)([A-Z]+)(\d+)/); return m?new Date(+m[3],M[m[2]],+m[1]).getTime():0; };
      return parse(a)-parse(b);
    });
    const recentExpiries = niftyExpiries.slice(-5);
    msg += `\n<b>Most recent NIFTY expiries in scrip:</b>\n${recentExpiries.join(', ')}\n`;
    await tgSend(msg); return;
  }

  if (cmd === '/debug_ltp') {
    if (!session.token || !session.baseUrl) { await tgSend('❌ Not logged in'); return; }
    await tgSend('🔬 <b>LTP fetch debug</b> — testing trading symbol approach...');

    // Test active contracts first; fall back to a hardcoded NIFTY weekly
    const testContracts = _activeContracts.length ? _activeContracts.slice(0,3) : [];
    if (!testContracts.length) {
      // Use current NIFTY weekly as a test case
      const expiry = resolveExpiry('weekly', 'NIFTY');
      testContracts.push({ instrument: 'NIFTY', strike: 24000, type: 'CE', expiry });
      testContracts.push({ instrument: 'NIFTY', strike: 24000, type: 'PE', expiry });
    }

    for (const c of testContracts) {
      const numToken = getOptionToken(c.instrument, c.strike, c.type, c.expiry);
      const tradeSym = buildTradingSymbol(c.instrument, c.strike, c.type, c.expiry);
      await tgSend(`\n<b>${c.instrument} ${c.strike} ${c.type} ${c.expiry}</b>\nNumeric token: ${numToken||'❌ (none)'}\nTrading symbol: <code>${tradeSym||'❌'}</code>`);

      // Test 1: numeric token (if available)
      if (numToken) {
        try {
          const url = `${session.baseUrl}/script-details/1.0/quotes/neosymbol/nse_fo|${numToken}/ltp`;
          const r = await ftKotak(url, { headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' } }, 4000);
          const txt = await r.text();
          await tgSend(`Token lookup (${numToken}): HTTP ${r.status}\n<code>${txt.slice(0,300)}</code>`);
        } catch(e) { await tgSend(`Token lookup error: ${e.message}`); }
      }

      // Test 2: trading symbol (fallback path)
      if (tradeSym) {
        try {
          const url = `${session.baseUrl}/script-details/1.0/quotes/neosymbol/nse_fo|${tradeSym}/ltp`;
          const r = await ftKotak(url, { headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' } }, 4000);
          const txt = await r.text();
          await tgSend(`Symbol lookup (${tradeSym}): HTTP ${r.status}\n<code>${txt.slice(0,300)}</code>`);
        } catch(e) { await tgSend(`Symbol lookup error: ${e.message}`); }
      }
    }
    return;
  }

  if (cmd === '/reload_scrip') {
    _scripMasterTs = 0; _scripMasterAttemptTs = 0;
    await tgSend('🔄 Scrip master reset. Downloading now (Kotak file-paths API + CDN)...');
    await downloadScripMaster();
    const count = Object.keys(_scripMaster).length;
    await tgSend(`Reload done. Scrip master: <b>${count}</b> contracts.`);
    return;
  }

  if (cmd === '/debug_scrip') {
    if (!session.token || !session.baseUrl) { await tgSend('❌ Not logged in'); return; }
    await tgSend(`🔍 <b>Scrip master debug</b>\n1️⃣ gw-napi (Bearer)\n2️⃣ CDN\n3️⃣ file-paths API`);

    // Test 1: gw-napi Dist/master — the Kotak Neo SDK's own scrip master endpoint
    const gwUrl = 'https://gw-napi.kotaksecurities.com/Dist/master/nse_fo.csv';
    try {
      const r = await ftKotak(gwUrl, {
        headers: { 'Authorization': `Bearer ${session.token}`, 'Sid': session.sid, 'Auth': session.auth, 'neo-fin-key': 'neotradeapi' }
      }, 60000);
      const txt = await r.text();
      const lines = txt.split('\n');
      await tgSend(
        `<b>gw-napi status:</b> ${r.status} | ${txt.length} bytes | ${lines.length} lines\n` +
        `<b>Headers:</b> <code>${lines[0]?.slice(0,400)}</code>\n` +
        `<b>Row 1:</b> <code>${lines[1]?.slice(0,300)}</code>\n` +
        `<b>Row 2:</b> <code>${lines[2]?.slice(0,300)}</code>`
      );
    } catch(e) { await tgSend(`gw-napi error: <code>${e.message}</code>`); }

    // Test 2: date-stamped CDN URL
    const d2s = d => `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
    const todayStr = d2s(new Date());
    const cdnUrl = `https://lapi.kotaksecurities.com/wso2-scripmaster/1.0/prod/prod/v1/${todayStr}/nfo/transformed/scrip_master.csv`;
    try {
      const r = await ftKotak(cdnUrl, {}, 30000);
      const txt = await r.text();
      const lines = txt.split('\n');
      await tgSend(
        `<b>CDN (${todayStr}) status:</b> ${r.status} | ${txt.length} bytes | ${lines.length} lines\n` +
        `<b>Row 1:</b> <code>${lines[1]?.slice(0,300)}</code>`
      );
    } catch(e) { await tgSend(`CDN error: <code>${e.message}</code>`); }

    // Test 3: file-paths API (original approach, confirmed stale)
    await tgSend('🔍 Fetching file-paths API from Kotak...');
    try {
      const r1 = await ftKotak(`${session.baseUrl}/script-details/1.0/masterscrip/file-paths`, {
        headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' }
      }, 10000);
      const text1 = await r1.text();
      let msg = `<b>file-paths status:</b> ${r1.status}\n<b>Raw response:</b>\n<code>${text1.slice(0,600)}</code>`;
      await tgSend(msg);
      try {
        const d1 = JSON.parse(text1);
        const paths = d1?.data?.filesPaths || [];
        await tgSend(`<b>Paths array (${paths.length} items):</b>\n${JSON.stringify(paths).slice(0,800)}`);
        const nfoCsvUrl = paths.find(p => typeof p === 'string' && p.toLowerCase().includes('nse_fo'));
        if (!nfoCsvUrl) { await tgSend('❌ No nse_fo URL found in paths'); return; }
        await tgSend(`✅ nse_fo URL: <code>${nfoCsvUrl}</code>\nDownloading first 2KB...`);
        const r2 = await ftKotak(nfoCsvUrl, {}, 15000);
        const csvSample = (await r2.text()).slice(0, 1500);
        await tgSend(`<b>CSV sample (first rows):</b>\n<code>${csvSample}</code>`);
      } catch(e) { await tgSend(`Parse error: ${e.message}`); }
    } catch(e) { await tgSend(`Error: ${e.message}`); }
    return;
  }

  if (cmd === '/spot') {
    if (!session.token) { await tgSend('❌ Not logged in — open PWA Setup tab and enter TOTP to connect Kotak.'); return; }
    const [n, b] = await Promise.all([fetchSpot('NIFTY'), fetchSpot('BANKNIFTY')]);
    await tgSend(`📈 <b>Live Spot</b>\nNIFTY: <b>${n||'N/A'}</b>\nBANKNIFTY: <b>${b||'N/A'}</b>`); return;
  }
  if (cmd === '/unlock_admin') {
    try {
      if (SB_KEY) {
        await fetch(`${SB_URL}/rest/v1/keep_alive_log?source=eq.admin_pwa_locked`, {
          method: 'DELETE', headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
        });
        await fetch(`${SB_URL}/rest/v1/keep_alive_log?source=like.admin_session_%25`, {
          method: 'DELETE', headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
        });
        // Signal to admin.html that PIN should be cleared and Setup shown
        await fetch(`${SB_URL}/rest/v1/keep_alive_log`, {
          method: 'POST',
          headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ source: 'admin_pin_reset', pinged_at: new Date().toISOString() })
        });
      }
      await tgSend('✅ <b>Admin PWA unlocked.</b>\nOpen app.trade2spend.com/admin.html — you will land on Setup tab to set a new PIN.');
    } catch(e) { await tgSend('❌ Unlock failed: ' + e.message); }
    return;
  }
  if (cmd === '/market_on') {
    if (!GH_TOKEN) { await tgSend('❌ GH_TOKEN not set in .env — cannot push to GitHub.'); return; }
    const nowIST  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const minsIST = nowIST.getHours() * 60 + nowIST.getMinutes();
    const inMarket = minsIST >= 9 * 60 + 15 && minsIST < 15 * 60 + 35;
    if (inMarket) {
      if (startMarketScraper()) {
        await tgSend('📊 <b>Market scraper started</b>\nFetching NIFTY / SENSEX / BANKNIFTY every 15s\nPushing to market.json on GitHub\nAuto-stops at 3:35 PM IST');
      } else {
        await tgSend('⚠️ Market scraper already running. Use /market_off to stop.');
      }
    } else {
      await tgSend('⏰ Outside market hours — running one-time fetch for testing...');
      await runMarketScraper(true);
      await tgSend('✅ Test fetch done. Check Markets tab on PWA.');
    }
    return;
  }
  if (cmd === '/market_off') {
    stopMarketScraper();
    await tgSend('🔴 <b>Market scraper stopped.</b>');
    return;
  }
  if (cmd === '/market_status') {
    const running = marketScraperInterval !== null;
    await tgSend(`📊 <b>Market Scraper</b>\nStatus: ${running ? '🟢 Running' : '🔴 Stopped'}\nGH_TOKEN: ${GH_TOKEN ? '✅ Set' : '❌ Missing'}`);
    return;
  }
  if (cmd === '/pnl') {
    const open = Object.values(state.trades).filter(t=>!t.pending).length;
    await tgSend(`💰 <b>Today</b>\nP&amp;L: ${pnlSign(state.dailyPnl)}${fmtINR(state.dailyPnl)}\nOrders: ${state.orderCount} | Open: ${open}`); return;
  }
  if (cmd === '/paper') { state.paperMode = true; await tgSend('📝 Paper mode ON.'); await saveState(); return; }
  if (cmd === '/live') {
    if (!session.token) { await tgSend('⚠️ Login with TOTP first.'); return; }
    await tgSend('⚠️ <b>Go LIVE?</b> Real orders will be placed!', { inline_keyboard: [[
      { text: '✅ Go LIVE', callback_data: 'confirm_live' }, { text: '❌ Stay Paper', callback_data: 'stay_paper' }
    ]]}); return;
  }
  if (cmd === '/kill' || cmd === '/killswitch') {
    if (!session.token) await tgSend('⚠️ Not logged in — broker exits unavailable.');
    await tgSend('⚠️ <b>KILL SWITCH — Exit ALL positions?</b>', { inline_keyboard: [[
      { text: '🔴 YES — EXIT ALL', callback_data: 'confirm_kill' }, { text: '❌ Cancel', callback_data: 'status_all' }
    ]]}); return;
  }
  if (cmd === '/reset') {
    state.dailyPnl = 0; state.orderCount = 0;
    await tgSend('✅ Daily counters reset.'); await saveState(); return;
  }

  if (cmd === '/update') {
    await tgSend('⏳ Pulling latest server.js from GitHub…');
    try {
      const r = await ft(`https://raw.githubusercontent.com/${GH_REPO}/main/server_deploy.js?t=${Date.now()}`, {}, 15000);
      if (!r.ok) { await tgSend(`❌ GitHub fetch failed: HTTP ${r.status}`); return; }
      const code = await r.text();
      if (!code || code.length < 1000) { await tgSend('❌ Downloaded file looks empty — aborting.'); return; }
      fs.writeFileSync(path.join(__dirname, 'server.js'), code, 'utf8');
      _scripMasterTs = 0; _scripMasterAttemptTs = 0; // force scrip master re-download after restart
      await tgSend('✅ server.js updated. Restarting in 2s…');
      setTimeout(() => process.exit(0), 2000); // PM2 auto-restarts
    } catch(e) {
      await tgSend(`❌ Update failed: ${e.message}`);
    }
    return;
  }
}

// ── EXECUTE TRADE FROM PWA (no Telegram confirm step) ─────────────────────────
async function executeFromPWA(trade) {
  maybeDailyReset();
  const err = validatePayload(trade);
  if (err) return { ok: false, error: err };

  trade.option_type  = trade.option_type.toUpperCase();
  trade.sl_direction = trade.sl_direction.toLowerCase();

  for (const [, t] of Object.entries(state.trades)) {
    if (t.instrument === trade.instrument && t.strike === trade.strike && t.option_type === trade.option_type) {
      return { ok: false, error: `${trade.instrument} ${trade.strike} ${trade.option_type} already ${t.pending ? 'pending' : 'active'}. Exit first.` };
    }
  }

  const tid = String(Date.now());
  trade.mode = state.paperMode ? 'PAPER' : 'LIVE';
  trade.exit_history = [];
  state.trades[tid] = trade;

  const oid = await placeOrder(trade);
  if (!oid) {
    delete state.trades[tid];
    await saveState();
    return { ok: false, error: 'Order placement failed — check bot logs.' };
  }

  trade.order_id  = oid;
  trade.placed_at = istTime();
  await saveState();

  await tgAlert(
    `📲 <b>PWA Direct Order</b>\n` +
    `<b>${trade.action} ${trade.instrument} ${trade.strike} ${trade.option_type}</b>\n` +
    `Entry: ₹${trade.entry} | Qty: ${trade.qty} lots\n` +
    `Order ID: ${oid} | Mode: ${trade.mode}`
  );

  return { ok: true, orderId: oid, tradeId: tid, mode: trade.mode, placed_at: trade.placed_at };
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // Live market data — GET /market (used by PWA instead of GitHub CDN)
  if (req.method === 'GET' && urlPath === '/market') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store'
    });
    res.end(JSON.stringify(_latestMarketData || { marketOpen: false, indices: {}, lastUpdated: new Date().toISOString() }));
    return;
  }

  // HTTP debug endpoint — GET /debug-scrip?key=T2SMonitor2026
  // Runs scrip master debug without needing Telegram webhook
  if (req.method === 'GET' && urlPath === '/debug-scrip') {
    const key = new URL('https://x' + req.url).searchParams.get('key');
    if (key !== 'T2SMonitor2026') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    const out = { ok: true, loggedIn: !!session.token, baseUrl: session.baseUrl || null };
    if (!session.token || !session.baseUrl) {
      out.error = 'Not logged in — send TOTP via PWA Setup tab first';
      res.end(JSON.stringify(out, null, 2));
      return;
    }
    try {
      const r1 = await ftKotak(`${session.baseUrl}/script-details/1.0/masterscrip/file-paths`, {
        headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' }
      }, 10000);
      const text1 = await r1.text();
      out.filePathsStatus = r1.status;
      let paths = [];
      try {
        const d1 = JSON.parse(text1);
        paths = d1?.data?.filesPaths || [];
        out.pathsCount = paths.length;
        // Show path filenames only (strip auth query params for security)
        out.pathFilenames = paths.map(p => { try { return new URL(p).pathname; } catch { return String(p).slice(0,80); } });
        const nfoCsvUrl = paths.find(p => typeof p === 'string' && p.toLowerCase().includes('nse_fo'));
        out.nfoUrlFound = !!nfoCsvUrl;
        if (nfoCsvUrl) {
          const r2 = await ftKotak(nfoCsvUrl, {}, 30000);
          out.csvStatus = r2.status;
          const csvText = await r2.text();
          const lines = csvText.split('\n');
          out.csvLinesInChunk = lines.length;
          out.csvHeaders = lines[0]?.slice(0, 500);
          out.csvRow1 = lines[1]?.slice(0, 400);
          out.csvRow2 = lines[2]?.slice(0, 400);
          // Show most recent expiry dates
          const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
          const hdrs = lines[0].split(',').map(h => h.trim().replace(/[";]/g, ''));
          const iExp = hdrs.indexOf('lExpiryDate');
          if (iExp >= 0) {
            const expiries = new Set();
            for (let i = lines.length - 1; i > 0 && expiries.size < 10; i--) {
              const c = lines[i].split(',');
              const raw = parseInt(c[iExp]?.replace(/"/g,'').trim() || '0');
              if (raw > 0) {
                const d = new Date(raw * 1000);
                expiries.add(String(d.getUTCDate()).padStart(2,'0') + MONTHS[d.getUTCMonth()] + d.getUTCFullYear());
              }
            }
            out.latestExpiries = [...expiries];
          }
          out.scripMasterCount = Object.keys(_scripMaster).length;
          // Send to Telegram too
          tgAlert(
            `🔬 <b>/debug-scrip via HTTP</b>\n` +
            `Paths: ${out.pathsCount} | nse_fo: ${out.nfoUrlFound ? '✅' : '❌'}\n` +
            `CSV status: ${out.csvStatus} | lines: ${out.csvLinesInChunk}\n` +
            `<b>Headers:</b> <code>${out.csvHeaders?.slice(0,300)}</code>\n` +
            `<b>Row 1:</b> <code>${out.csvRow1?.slice(0,200)}</code>\n` +
            `<b>Latest expiries:</b> ${(out.latestExpiries||[]).join(', ')}`
          ).catch(() => {});
        }
      } catch(e) { out.parseError = e.message; }
    } catch(e) { out.fetchError = e.message; }
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // HTTP update trigger — GET /http-update?key=T2SMonitor2026
  // Deploys latest server_deploy.js from GitHub without needing Telegram webhook
  if (req.method === 'GET' && urlPath === '/http-update') {
    const key = new URL('https://x' + req.url).searchParams.get('key');
    if (key !== 'T2SMonitor2026') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, message: 'Downloading and restarting in 3s…' }));
    try {
      const r = await ft(`https://raw.githubusercontent.com/${GH_REPO}/main/server_deploy.js?t=${Date.now()}`, {}, 15000);
      if (!r.ok) { tgAlert(`❌ HTTP update failed: GitHub ${r.status}`).catch(()=>{}); return; }
      const code = await r.text();
      if (!code || code.length < 1000) { tgAlert('❌ HTTP update: downloaded file too small').catch(()=>{}); return; }
      fs.writeFileSync(path.join(__dirname, 'server.js'), code, 'utf8');
      _scripMasterTs = 0; _scripMasterAttemptTs = 0;
      tgAlert('✅ <b>HTTP update complete.</b> Restarting in 3s…').catch(()=>{});
      setTimeout(() => process.exit(0), 3000);
    } catch(e) { tgAlert(`❌ HTTP update error: ${e.message}`).catch(()=>{}); }
    return;
  }

  // Debug — GET /debug
  if (req.method === 'GET' && urlPath === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    // Try one live LTP fetch to expose the actual Kotak API response
    let ltpTest = null;
    if (session.token) {
      // Try gw-napi with first available scrip master token
      const firstToken = Object.entries(_scripMaster).find(([k,v]) => k.startsWith('NIFTY-'));
      const testKey = firstToken ? firstToken[0] : null;
      const testToken = firstToken ? firstToken[1] : null;
      const gwBase = 'https://gw-napi.kotaksecurities.com';
      if (testToken) {
        try {
          const url = `${gwBase}/script-details/1.0/quotes/neosymbol/nse_fo|${testToken}/ltp`;
          const r = await fetch(url, { headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi', 'Sid': session.sid, 'Auth': session.token }, signal: AbortSignal.timeout(4000) });
          const txt = await r.text();
          ltpTest = { url, status: r.status, body: txt.slice(0, 400), key: testKey, token: testToken };
        } catch(e) { ltpTest = { error: e.message, key: testKey, token: testToken }; }
      } else { ltpTest = { note: 'no scrip master token available yet' }; }
    }
    const smNiftySample = Object.keys(_scripMaster).filter(k => k.startsWith('NIFTY-')).slice(0, 6);
    const debugVars = { tokenOk: !!session.token, baseUrl: session.baseUrl, contractsLen: _activeContracts.length, nseCookiesAge: _nseCookieTs ? Math.round((Date.now()-_nseCookieTs)/1000)+'s' : 'never' };
    // Quick NSE option chain test
    let nseTest = null;
    try {
      if (!_nseCookies) await refreshNSECookies();
      const nr = await ft('https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY', { headers: { ...NSE_HEADERS, 'Cookie': _nseCookies } }, 6000);
      const ntxt = await nr.text();
      nseTest = { status: nr.status, bodyLen: ntxt.length, sample: ntxt.slice(0, 150) };
    } catch(e) { nseTest = { error: e.message }; }
    res.end(JSON.stringify({
      hasToken: !!session.token,
      sessionAgeMins: Math.round((Date.now() - (session.lastLogin||0)) / 60000),
      activeContracts: _activeContracts.map(c => `${c.instrument}-${c.strike}-${c.type}-${c.expiry}`),
      optionLTPsCount: Object.keys(_optionChain).length,
      optionLTPsSample: Object.entries(_optionChain).slice(0,5),
      activeContractsTs: _activeContractsTs ? Math.round((Date.now()-_activeContractsTs)/1000)+'s ago' : 'never',
      scripMasterSize: Object.keys(_scripMaster).length,
      scripMasterNiftySample: smNiftySample,
      debugVars,
      nseTest,
      marketScraperRunning: !!marketScraperInterval,
      kotakLtpRunning: !!_kotakLtpInterval,
      ltpTest
    }));
    return;
  }

  // Health check — GET /
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // loggedIn is true only if session was created TODAY (IST) and within 8h
    // Stale state.json tokens from prior days correctly report false → triggers TOTP prompt
    const _sessionAge = Date.now() - (session.lastLogin || 0);
    const _isLoggedIn = !!session.token && _sessionAge < SESSION_MAX_AGE_MS;
    res.end(JSON.stringify({
      ok: true, uptime: Math.round(process.uptime()),
      loggedIn: _isLoggedIn, paperMode: state.paperMode,
      openTrades: Object.values(state.trades).filter(t=>!t.pending).length,
      dailyPnl: state.dailyPnl, orders: state.orderCount
    }));
    return;
  }

  // Direct PWA execute — POST /execute (bypasses Telegram confirm)
  if (req.method === 'POST' && urlPath === '/execute') {
    const secret = req.headers['x-t2s-secret'];
    if (!secret || secret !== process.env.EXECUTE_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk.toString(); });
    req.on('end', async () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      let trade;
      try { trade = JSON.parse(rawBody); }
      catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
      try {
        const result = await executeFromPWA(trade);
        res.writeHead(result.ok ? 200 : 400);
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('/execute error:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Member unlock request — POST /request-unlock
  if (req.method === 'POST' && urlPath === '/request-unlock') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      let data = {};
      try { data = JSON.parse(body); } catch {}
      const { memberId, mobile, name, deviceInfo } = data;
      if (!memberId || !mobile) { res.writeHead(400); res.end(JSON.stringify({ ok: false })); return; }
      // Rate-limit: one alert per memberId per 5 min
      const lockKey = `unlock_req_${memberId}`;
      if (!kvLock(lockKey, 300)) { res.writeHead(200); res.end(JSON.stringify({ ok: true, message: 'Already sent recently' })); return; }
      const deviceStr = deviceInfo ? `${deviceInfo.platform || ''} · ${(deviceInfo.userAgent || '').slice(0,60)}` : 'Unknown device';
      await tgSend(
        `🔒 <b>Unlock Request</b>\n━━━━━━━━━━━━━━━━━━\n` +
        `<b>Mobile:</b> <code>${mobile}</code>\n` +
        `<b>Name:</b> ${name || 'Unknown'}\n` +
        `<b>Device:</b> ${deviceStr}\n` +
        `<b>Time:</b> ${istTime()} IST`,
        { inline_keyboard: [[
          { text: '🔓 Unlock',         callback_data: `unlock_member_${memberId}` },
          { text: '❌ Ignore',          callback_data: `ignore_unlock_${memberId}` },
          { text: '💬 Message Member', callback_data: `msg_member_${mobile}` }
        ]]}
      );
      res.writeHead(200); res.end(JSON.stringify({ ok: true, message: 'Unlock request sent to admin' }));
    });
    return;
  }

  // Admin PWA lock alert — POST /admin-alert
  if (req.method === 'POST' && urlPath === '/admin-alert') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      if (!kvLock('admin_lock_alert', 300)) { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }
      let data = {};
      try { data = JSON.parse(body); } catch {}
      const deviceStr = data.deviceInfo ? `${data.deviceInfo.platform || ''} · ${(data.deviceInfo.userAgent || '').slice(0,60)}` : 'Unknown';
      await tgSend(
        `🚨 <b>Admin PWA Locked</b>\n━━━━━━━━━━━━━━━━━━\n` +
        `3 wrong PINs entered.\n` +
        `<b>Device:</b> ${deviceStr}\n` +
        `<b>Time:</b> ${istTime()} IST`,
        { inline_keyboard: [[
          { text: '🔓 Reset PIN', callback_data: 'admin_pin_reset_ask' },
          { text: '❌ Ignore',    callback_data: 'admin_pin_ignore'     }
        ]]}
      );
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Push trades.json to GitHub — POST /push-trades
  if (req.method === 'POST' && urlPath === '/push-trades') {
    const secret = req.headers['x-t2s-secret'];
    if (!secret || secret !== process.env.EXECUTE_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      if (!GH_TOKEN) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'GH_TOKEN not configured on server' })); return; }
      let trades;
      try { trades = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
      try {
        const api     = `https://api.github.com/repos/${GH_REPO}/contents/trades.json`;
        const headers = { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
        const r       = await ft(api, { headers }, 8000);
        const cur     = await r.json();
        await ft(api, {
          method: 'PUT', headers,
          body: JSON.stringify({ message: 'trades update', content: Buffer.from(JSON.stringify(trades, null, 2)).toString('base64'), sha: cur.sha || '', branch: 'main' })
        }, 12000);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // TOTP login from PWA — POST /totp-login
  if (req.method === 'POST' && urlPath === '/totp-login') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    if (!kvLock(`totp_ip_${ip}`, 60)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: 'One attempt per minute. Wait for a fresh TOTP code.' }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      let data = {};
      try { data = JSON.parse(body); } catch {}
      const totp = String(data.totp || '').trim();
      if (!/^\d{6}$/.test(totp)) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Enter your 6-digit TOTP.' }));
        return;
      }
      try {
        const ok = await loginKotak(totp);
        if (ok) {
          if (isMarketHours() && !marketScraperInterval) startMarketScraper();
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, message: 'Kotak connected. Live CMP tracking started.' }));
        } else {
          res.writeHead(401);
          res.end(JSON.stringify({ ok: false, error: 'TOTP rejected by Kotak. Wait for a fresh code and try again.' }));
        }
      } catch(e) {
        kvUnlock(`totp_ip_${ip}`);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: 'Server error: ' + e.message }));
      }
    });
    return;
  }

  // Send push notifications — POST /send-push
  if (req.method === 'POST' && urlPath === '/send-push') {
    const secret = req.headers['x-t2s-secret'];
    if (secret !== 'T2SMonitor2026' && secret !== process.env.EXECUTE_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    let rawBody = '';
    req.on('data', c => { rawBody += c; });
    req.on('end', async () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      let payload = {};
      try { payload = JSON.parse(rawBody); } catch {}
      const { title = 'Trade2Spend', body: msgBody = 'New update', tag = 't2s-notif', url = 'https://app.trade2spend.com/#updates' } = payload;
      try {
        const subs = await sbFetch('push_subscriptions?select=id,subscription_json');
        let sent = 0, failed = 0;
        const toDelete = [];
        for (const sub of subs) {
          try {
            const sc = await sendWebPush(sub.subscription_json, JSON.stringify({ title, body: msgBody, tag, url }));
            if (sc === 410 || sc === 404) toDelete.push(sub.id); else sent++;
          } catch (e) { failed++; }
        }
        for (const id of toDelete) {
          await sbFetch(`push_subscriptions?id=eq.${id}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
        }
        console.log(`Push: ${sent} sent, ${failed} failed, ${toDelete.length} expired cleaned`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, sent, failed, cleaned: toDelete.length, total: subs.length }));
      } catch (e) {
        console.error('/send-push error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // CORS preflight for PWA requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-t2s-secret'
    });
    res.end();
    return;
  }

  // Telegram webhook — POST /
  if (req.method === 'POST') {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk.toString(); });
    req.on('end', async () => {
      // Respond immediately so Telegram doesn't retry
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');

      let body;
      try { body = JSON.parse(rawBody); }
      catch { console.log('Bad JSON from Telegram (ignored)'); return; }

      try {
        maybeDailyReset();
        if (body.callback_query) {
          await handleCallback(body.callback_query);
          checkSLs().catch(e => tgAlert(`⚠️ SL check error: ${e.message}`));
          return;
        }
        const msg = body.message;
        if (!msg?.text) return;
        if (String(msg.chat.id) !== String(CHAT_ID)) {
          console.log(`Ignored message from chat ${msg.chat.id}`);
          return;
        }
        console.log(`MSG from ${msg.chat.id}: ${msg.text.slice(0,50)}`);
        await handleMessage(msg.text);
        checkSLs().catch(e => tgAlert(`⚠️ SL check error: ${e.message}`));
      } catch (e) {
        console.error('Handler error:', e);
        tgAlert(`🆘 <b>Bot Error:</b> ${e.message}`).catch(() => {});
      }
    });
    return;
  }

  res.writeHead(405); res.end('Method Not Allowed');
});

// ── START ─────────────────────────────────────────────────────────────────────
function isMarketHours() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = now.getHours(), m = now.getMinutes(), day = now.getDay();
  return day >= 1 && day <= 5 && (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 35));
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message, err.stack);
  tgAlert(`🆘 <b>Uncaught exception:</b> ${err.message}`).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('Unhandled rejection:', msg);
  tgAlert(`🆘 <b>Unhandled rejection:</b> ${msg}`).catch(() => {});
});

loadState();
server.listen(PORT, () => console.log(`T2S bot v5.0 listening on port ${PORT}`));

// On startup: populate _latestMarketData from GitHub so /market works immediately
setTimeout(async () => {
  try {
    const r = await ft(`https://raw.githubusercontent.com/${GH_REPO}/main/market.json?t=${Date.now()}`, {}, 8000);
    if (r.ok) _latestMarketData = await r.json();
  } catch(e) { console.log('Startup market.json fetch failed:', e.message); }
  // If session was restored from state.json, re-download scrip master (it's in-memory only)
  if (session.token && session.baseUrl) {
    _scripMasterTs = 0; _scripMasterAttemptTs = 0;
    downloadScripMaster().catch(e => console.error('[scrip] startup download error:', e.message));
  }
  // Start scraper if within market hours (GH_TOKEN not required — pushMarketToGitHub handles missing token gracefully)
  if (isMarketHours() && !marketScraperInterval) startMarketScraper();
}, 5000);

// ── SUPABASE TRADE SL MONITOR ─────────────────────────────────────────────────
// Extract option-price SL (< 5000) from reply text — ignores spot-level SLs
function extractOptSL(text) {
  const pats = [
    /(?:revised?|modif|moved?|shifted?|new|updated?)\s+sl\s+(?:to\s+)?(?:₹\s*)?(\d+(?:\.\d+)?)/i,
    /sl\s+(?:to|at|now|=)\s*(?:₹\s*)?(\d+(?:\.\d+)?)/i,
    /(?:sl|stop[\s-]?loss).{0,20}(?:revised?|changed|updated|moved)\s*(?:to\s*)?(?:₹\s*)?(\d+(?:\.\d+)?)/i
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 5000) return v; }
  }
  return null;
}

function sbTradeFullyExited(replies) {
  let cum = 0;
  for (const r of [...replies].reverse()) { // oldest first
    const t = (r.content || '').toLowerCase();
    if (/\bsl\b.{0,20}(?:hit|triggered|gone)|stop[\s-]?loss.{0,10}(?:hit|triggered)|fully\s+exit|full\s+exit|exiting\s+full|exit\s+all|\bfully\s+out\b/.test(t)) return true;
    const pm = t.match(/exiting\s+(\d+)\s*%/); if (pm) { cum += parseInt(pm[1]); if (cum >= 100) return true; }
  }
  return false;
}

// Check Supabase trade posts against live Kotak option CMPs; auto-post SL hit follow-up
async function checkSupabaseSLs() {
  if (!isMarketHours() || !session.token) return;
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const today = ist.toDateString();
  if (_sbAlertDate !== today) { _sbSlAlertedToday.clear(); _sbAlertDate = today; }
  try {
    const since = new Date(ist); since.setHours(0, 0, 0, 0);
    const posts = await sbFetch(
      `posts?post_type=eq.trade_alert&is_deleted=eq.false&parent_id=is.null&sent_at=gte.${encodeURIComponent(since.toISOString())}&select=id,content`,
      { method: 'GET' }
    );
    if (!posts.length) return;
    const reps = await sbFetch(
      `posts?is_deleted=eq.false&parent_id=in.(${posts.map(p => `"${p.id}"`).join(',')})&order=sent_at.desc&select=id,parent_id,content`,
      { method: 'GET' }
    );
    const rMap = {};
    reps.forEach(r => { (rMap[r.parent_id] = rMap[r.parent_id] || []).push(r); });

    for (const post of posts) {
      if (_sbSlAlertedToday.has(post.id)) continue;
      const pr = rMap[post.id] || [];
      if (sbTradeFullyExited(pr)) continue;
      let sl = null;
      for (const r of pr) { const v = extractOptSL(r.content || ''); if (v) { sl = v; break; } }
      if (!sl) continue;
      const t = (post.content || '').toUpperCase();
      const im = t.match(/\b(NIFTY|BANKNIFTY|SENSEX|MIDCAP)\b/); if (!im) continue;
      const am = t.slice(t.indexOf(im[1]) + im[1].length).match(/\b(\d{4,6})\b/); if (!am) continue;
      const tm = t.match(/\b(CE|PE)\b/); if (!tm) continue;
      const key = `${im[1]}-${am[1]}-${tm[1]}`;
      const cmp = _optionChain[key];
      if (!cmp) continue;
      if (cmp <= sl) {
        _sbSlAlertedToday.add(post.id);
        const ep = Math.round(cmp * 100) / 100;
        await sbFetch('posts', {
          method: 'POST',
          body: JSON.stringify({
            content: `🔴 SL hit\nExiting at ₹${ep}\nCMP ₹${ep}`,
            post_type: 'follow_up', audience: 'all',
            allow_sharing: false, is_deleted: false,
            parent_id: post.id, sent_at: new Date().toISOString()
          })
        });
        await tgSend(`🔴 <b>SL HIT (auto)</b>\n<b>${key}</b>\nCMP ₹${cmp} ≤ SL ₹${sl}\nFollow-up posted to PWA.`);
      }
    }
  } catch(e) { console.error('[sb-sl]', e.message); }
}

// 3:20 PM alert: unresolved positions where SL was not auto-triggered
async function checkResolveAlert() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  if (mins < 15 * 60 + 20 || mins > 15 * 60 + 30) return;
  const todayStr = ist.toDateString();
  if (_resolveAlertSentDate === todayStr) return;
  _resolveAlertSentDate = todayStr;
  try {
    const since = new Date(ist); since.setHours(0, 0, 0, 0);
    const posts = await sbFetch(
      `posts?post_type=eq.trade_alert&is_deleted=eq.false&parent_id=is.null&sent_at=gte.${encodeURIComponent(since.toISOString())}&select=id,content`,
      { method: 'GET' }
    );
    if (!posts.length) return;
    const reps = await sbFetch(
      `posts?is_deleted=eq.false&parent_id=in.(${posts.map(p => `"${p.id}"`).join(',')})&order=sent_at.desc&select=id,parent_id,content`,
      { method: 'GET' }
    );
    const rMap = {};
    reps.forEach(r => { (rMap[r.parent_id] = rMap[r.parent_id] || []).push(r); });
    const unresolved = [];
    for (const post of posts) {
      const pr = rMap[post.id] || [];
      if (sbTradeFullyExited(pr)) continue;
      let cum = 0;
      for (const r of [...pr].reverse()) { const pm = (r.content || '').match(/exiting\s+(\d+)\s*%/i); if (pm) cum += parseInt(pm[1]); }
      let sl = null;
      for (const r of pr) { const v = extractOptSL(r.content || ''); if (v) { sl = v; break; } }
      const t = (post.content || '').toUpperCase();
      const im = t.match(/\b(NIFTY|BANKNIFTY|SENSEX|MIDCAP)\b/);
      const am = im ? t.slice(t.indexOf(im[1]) + im[1].length).match(/\b(\d{4,6})\b/) : null;
      const tm = t.match(/\b(CE|PE)\b/);
      const key = (im && am && tm) ? `${im[1]}-${am[1]}-${tm[1]}` : null;
      const cmp = key ? (_optionChain[key] || null) : null;
      unresolved.push({ label: key || 'Trade', cum, sl, cmp });
    }
    if (!unresolved.length) return;
    let msg = `⏰ <b>3:20 PM — Unresolved Positions</b>\n\n`;
    for (const u of unresolved) {
      msg += `• <b>${u.label}</b>`;
      if (u.cum > 0) msg += ` — ${u.cum}% exited, ${100 - u.cum}% remaining`;
      else msg += ` — full position open`;
      if (u.sl) msg += ` | SL ₹${u.sl}`;
      if (u.cmp) msg += ` | CMP ₹${u.cmp}`;
      msg += '\n';
    }
    msg += `\n❓ SL not hit yet. Did you exit? Please update the PWA.`;
    await tgSend(msg);
  } catch(e) { console.error('[resolve-alert]', e.message); }
}

// Periodic check every 30s: SL monitor + market scraper auto-start/stop
setInterval(() => {
  if (isMarketHours()) {
    checkSLs().catch(e => tgAlert(`⚠️ SL poll: ${e.message}`));
    checkSupabaseSLs().catch(e => console.error('[sb-sl]', e.message));
    if (!marketScraperInterval) startMarketScraper();
  }
  checkResolveAlert().catch(e => console.error('[resolve-alert]', e.message));
}, 30_000);

tgAlert(`🟢 <b>Trade2Spend Bot v5.0 started</b>\nServer: api.trade2spend.com\nLoaded: ${Object.keys(state.trades).length} trades`).catch(() => {});
