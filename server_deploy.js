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
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
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
  const targetDay = instr.includes('SENSEX') ? 5 : instr.includes('BANKNIFTY') ? 3 : 2;
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
    await tgSend('🔐 Step 1/2: Validating TOTP...');
    let r1;
    try {
      r1 = await ft('https://mis.kotaksecurities.com/login/1.0/tradeApiLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': CONSUMER_KEY, 'neo-fin-key': 'neotradeapi' },
        body: JSON.stringify({ mobileNumber: MOBILE, ucc: UCC, totp })
      });
    } catch (e) { await tgSend(`❌ TOTP network error: ${e.message}`); return false; }

    const text1 = await r1.text();
    console.log('TOTP status:', r1.status);
    if (!r1.ok) { await tgSend(`❌ TOTP HTTP ${r1.status}\n<code>${text1.slice(0,200)}</code>`); return false; }

    let d1;
    try { d1 = JSON.parse(text1); } catch { await tgSend(`❌ TOTP non-JSON response`); return false; }
    if (!d1.data?.token) { await tgSend(`❌ TOTP failed: ${d1.message || d1.error || 'Unknown'}`); return false; }

    await tgSend('🔐 Step 2/2: Validating MPIN...');
    let r2;
    try {
      r2 = await ft('https://mis.kotaksecurities.com/login/1.0/tradeApiValidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': CONSUMER_KEY, 'neo-fin-key': 'neotradeapi', 'sid': d1.data.sid, 'Auth': d1.data.token },
        body: JSON.stringify({ mpin: MPIN })
      });
    } catch (e) { await tgSend(`❌ MPIN network error: ${e.message}`); return false; }

    const text2 = await r2.text();
    console.log('MPIN status:', r2.status);
    if (!r2.ok) { await tgSend(`❌ MPIN HTTP ${r2.status}\n<code>${text2.slice(0,200)}</code>`); return false; }

    let d2;
    try { d2 = JSON.parse(text2); } catch { await tgSend(`❌ MPIN non-JSON response`); return false; }
    if (!d2.data?.token) { await tgSend(`❌ MPIN failed: ${d2.message || d2.error || 'Unknown'}`); return false; }

    session.token      = d2.data.token;
    session.sid        = d2.data.sid;
    session.rid        = d2.data.rid        || '';
    session.auth       = d2.data.auth       || '';
    session.hsServerId = d2.data.hsServerId || d2.data.serverId || d2.data.rid || '';
    session.baseUrl    = d2.data.baseUrl    || 'https://gw-napi.kotaksecurities.com';
    session.lastLogin  = Date.now();
    state.paperMode    = false;

    await tgSend(
      `✅ <b>Logged into Kotak Neo!</b>\n` +
      `Mode: 🔴 Live (auto-switched)\n` +
      `Base URL: <code>${session.baseUrl}</code>\n\n` +
      `Ready. Send trades from PWA or use /status.\n` +
      `<i>Market scraper runs automatically 9:15–3:35 IST (no TOTP needed)</i>`
    );
    await saveState();
    return true;
  } catch (e) {
    await tgSend(`❌ Login error: ${e.message}`);
    return false;
  }
}

function isSessionValid() {
  if (!session.token) return false;
  const age = Date.now() - (session.lastLogin || 0);
  if (age > SESSION_MAX_AGE_MS)
    tgAlert(`⚠️ Session ${Math.round(age/3600000)}h old — re-login with TOTP.`);
  return true;
}

// ── SPOT PRICE ────────────────────────────────────────────────────────────────
async function fetchSpot(instrument = 'NIFTY') {
  if (!session.token || !session.baseUrl) return null;
  const tok = SPOT_TOKENS[instrument.toUpperCase()] || SPOT_TOKENS.NIFTY;
  try {
    const r = await ft(`${session.baseUrl}/scriptdetails/1.0/quotes/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': session.token, 'neo-fin-key': 'neotradeapi', 'sid': session.sid },
      body: JSON.stringify({ instrument_tokens: [tok] })
    });
    const d   = await r.json();
    const q   = d.data?.[0] || d[0];
    const ltp = q?.ltp || q?.last_traded_price || q?.lastTradedPrice || q?.c;
    return ltp ? parseFloat(ltp) : null;
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
  if (!force && mins >= 15 * 60 + 35) {
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
    // One NSE API call gives us all indices + breadth together
    const nseData = await fetchNSEAllIndices();
    const [nifty, sensex, banknifty] = ['NIFTY', 'SENSEX', 'BANKNIFTY'].map(inst => {
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
    let existing = { gainers: [], losers: [], breadth: { nifty50: { advancing: 0, declining: 0, unchanged: 0 } } };
    try {
      const r = await ft(`https://raw.githubusercontent.com/${GH_REPO}/main/market.json?t=${Date.now()}`, {}, 5000);
      existing = await r.json();
    } catch {}
    const marketData = {
      marketOpen:  true,
      lastUpdated: new Date().toISOString(),
      indices: {
        NIFTY:     nifty     || existing.indices?.NIFTY     || { price: 0, change: 0, changePct: 0 },
        SENSEX:    sensex    || existing.indices?.SENSEX    || { price: 0, change: 0, changePct: 0 },
        BANKNIFTY: banknifty || existing.indices?.BANKNIFTY || { price: 0, change: 0, changePct: 0 }
      },
      breadth: { nifty50: breadth || existing.breadth?.nifty50 || { advancing: 0, declining: 0, unchanged: 0 } },
      gainers: existing.gainers || [],
      losers:  existing.losers  || []
    };
    await pushMarketToGitHub(marketData);
    console.log(`Market pushed — NIFTY:${nifty?.price} SENSEX:${sensex?.price} BANKNIFTY:${banknifty?.price}`);
  } catch (e) { console.error('runMarketScraper error:', e.message); }
}

function startMarketScraper() {
  if (marketScraperInterval) return false;
  marketScraperInterval = setInterval(runMarketScraper, 30_000);
  runMarketScraper();
  return true;
}

function stopMarketScraper() {
  if (marketScraperInterval) { clearInterval(marketScraperInterval); marketScraperInterval = null; }
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
    const or  = await ft(`${session.baseUrl}/quick/order/rule/ms/place?sId=${sId}`, {
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
          const sr  = await ft(`${session.baseUrl}/quick/order/history`, { headers: neoHeaders(), method: 'GET' }, 5000);
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

  // 6-digit TOTP or /login TOTP
  if (/^\d{6}$/.test(text.trim()) || cmd.startsWith('/login')) {
    const totp = cmd.startsWith('/login') ? text.trim().split(/\s+/)[1] : text.trim();
    if (!totp || !/^\d{6}$/.test(totp)) { await tgSend('⚠️ Send your 6-digit TOTP, or type /login 123456'); return; }
    await loginKotak(totp); return;
  }

  if (text.includes('PAYLOAD:')) { await processTrade(text); return; }

  if (cmd === '/start' || cmd === '/help') {
    await tgSend(
      '🤖 <b>Trade2Spend v5.0</b>\n━━━━━━━━━━━━━━━━━━\n' +
      '<b>Daily login:</b> Send 6-digit TOTP from Kotak app\n\n' +
      '<b>Trading:</b>\n' +
      '/status — Open positions\n' +
      '/spot — Live NIFTY/BankNIFTY spot\n' +
      '/pnl — Today\'s P&amp;L\n' +
      '/paper — Paper mode (safe testing)\n' +
      '/live — Live mode (real orders)\n' +
      '/kill — 🔴 Emergency exit ALL positions\n' +
      '/reset — Reset daily counters\n\n' +
      '<b>Market Data:</b>\n' +
      '/market_on — Start live market scraper\n' +
      '/market_off — Stop market scraper\n' +
      '/market_status — Scraper status\n\n' +
      '/cancel — Cancel current action'
    ); return;
  }
  if (cmd === '/status') { await sendStatus(); return; }
  if (cmd === '/spot') {
    if (!session.token) { await tgSend('❌ Login first — send your 6-digit TOTP.'); return; }
    const [n, b] = await Promise.all([fetchSpot('NIFTY'), fetchSpot('BANKNIFTY')]);
    await tgSend(`📈 <b>Live Spot</b>\nNIFTY: <b>${n||'N/A'}</b>\nBANKNIFTY: <b>${b||'N/A'}</b>`); return;
  }
  if (cmd === '/market_on') {
    if (!GH_TOKEN) { await tgSend('❌ GH_TOKEN not set in .env — cannot push to GitHub.'); return; }
    const nowIST  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const minsIST = nowIST.getHours() * 60 + nowIST.getMinutes();
    const inMarket = minsIST >= 9 * 60 + 15 && minsIST < 15 * 60 + 35;
    if (inMarket) {
      if (startMarketScraper()) {
        await tgSend('📊 <b>Market scraper started</b>\nFetching NIFTY / SENSEX / BANKNIFTY every 30s\nPushing to market.json on GitHub\nAuto-stops at 3:35 PM IST');
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

  // Health check — GET /
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, uptime: Math.round(process.uptime()),
      loggedIn: !!session.token, paperMode: state.paperMode,
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
      await tgAlert(
        `🚨 <b>Admin PWA Locked</b>\n` +
        `3 wrong PINs entered.\n` +
        `<b>Device:</b> ${deviceStr}\n` +
        `<b>Time:</b> ${istTime()} IST\n\n` +
        `Use the email unlock link on the lock screen.`
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
      catch { console.error('Bad JSON from Telegram'); return; }

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
loadState();
server.listen(PORT, () => console.log(`T2S bot v5.0 listening on port ${PORT}`));

// Periodic check every 30s: SL monitor + market scraper auto-start/stop
setInterval(() => {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h    = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;
  const inMarket = (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 35));

  if (inMarket) {
    checkSLs().catch(e => tgAlert(`⚠️ SL poll: ${e.message}`));
    // Auto-start scraper at market open if GH_TOKEN is available
    if (!marketScraperInterval && GH_TOKEN) startMarketScraper();
  }
}, 30_000);

tgAlert(`🟢 <b>Trade2Spend Bot v5.0 started</b>\nServer: api.trade2spend.com\nLoaded: ${Object.keys(state.trades).length} trades`).catch(() => {});
