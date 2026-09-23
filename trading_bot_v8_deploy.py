#!/usr/bin/env python3
"""
Trade2Spend Trading Bot (Complete Full Version)
Merges original v6.0 full feature set (Sustain logic, Target logic, Daily Summary) 
with Kotak Neo direct Quotes API and live execution fixes.
"""
import json
import re
import time
import threading
import requests
import pytz
import os
from datetime import datetime, timedelta
import calendar
from dotenv import load_dotenv
import market_scraper

load_dotenv(os.path.expanduser('~/.deploy-secrets/.env'))

# ============================================================
# 1. CONFIGURATION
# ============================================================
ALGO_BOT_TOKEN     = os.environ["TELEGRAM_TOKEN"]
ALGO_CHAT_ID       = os.environ["TELEGRAM_CHAT_ID"]
KOTAK_CONSUMER_KEY = os.environ["KOTAK_CONSUMER_KEY"]
KOTAK_MOBILE       = os.environ["KOTAK_MOBILE"]
KOTAK_UCC          = os.environ["KOTAK_UCC"]
KOTAK_MPIN         = os.environ["KOTAK_MPIN"]
GITHUB_TOKEN       = os.environ["GITHUB_TOKEN"]

PAPER_MODE         = True
MAX_DAILY_LOSS     = 15000
MAX_QTY_PER_ORDER  = 100
MAX_ORDERS_PER_DAY = 100
LOT_SIZES          = {"NIFTY": 65, "BANKNIFTY": 30, "SENSEX": 20}

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://keuzqxoxtlozlqjjjqvr.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldXpxeG94dGxvemxxampqcXZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MDk3ODcsImV4cCI6MjA5NTE4NTc4N30.VAxiflefz816geWOE7Onq8SE6dXST46MNk0LBJqGNTs")
SERVER_PORT  = int(os.environ.get("PORT", "3000"))  # server.js port for cross-process calls

# Pass keys to scraper module
market_scraper.set_github_token(GITHUB_TOKEN)
market_scraper.set_consumer_key(KOTAK_CONSUMER_KEY)

# ============================================================
# 2. INTERNAL MEMORY
# ============================================================
IST               = pytz.timezone('Asia/Kolkata')
session_data      = {}
session_active    = False
open_trades       = {}
daily_pnl         = 0.0
daily_order_count = 0
pending_actions   = {}
_spot_cache       = {"price": None, "time": 0} 
_cmp_cache        = {}  
_spot_lock        = threading.Lock()
_cmp_lock         = threading.Lock()
_trade_lock       = threading.Lock()

# ============================================================
# 3. TELEGRAM MESSAGING FUNCTIONS
# ============================================================
def tg_send(text, keyboard=None):
    payload = {"chat_id": ALGO_CHAT_ID, "text": text, "parse_mode": "HTML"}
    if keyboard:
        payload["reply_markup"] = json.dumps(keyboard)
    try:
        r = requests.post(f"https://api.telegram.org/bot{ALGO_BOT_TOKEN}/sendMessage", json=payload, timeout=10)
        result = r.json()
        if result.get("ok"):
            return result["result"]["message_id"]
        print(f"Send error: {result}")
    except Exception as e:
        print(f"Send exception: {e}")
    return None

def tg_edit(mid, text, keyboard=None):
    if not mid: return
    payload = {"chat_id": ALGO_CHAT_ID, "message_id": mid, "text": text, "parse_mode": "HTML"}
    if keyboard is not None:
        payload["reply_markup"] = json.dumps(keyboard)
    try:
        requests.post(f"https://api.telegram.org/bot{ALGO_BOT_TOKEN}/editMessageText", json=payload, timeout=10)
    except Exception as e:
        print(f"Edit exception: {e}")

def tg_answer(cid, text=""):
    try:
        requests.post(f"https://api.telegram.org/bot{ALGO_BOT_TOKEN}/answerCallbackQuery", json={"callback_query_id": cid, "text": text}, timeout=5)
    except: pass

def fetch_all_updates(offset=None):
    params = {"timeout": 3, "limit": 100, "allowed_updates": []}
    if offset is not None: params["offset"] = offset
    try:
        r = requests.get(f"https://api.telegram.org/bot{ALGO_BOT_TOKEN}/getUpdates", params=params, timeout=10)
        return r.json().get("result", [])
    except Exception as e:
        print(f"Poll error: {e}")
        return []

# ============================================================
# 4. KOTAK DIRECT QUOTES API & MARKET DATA
# ============================================================
def get_market_quote(exchange_segment, token_or_symbol):
    if not session_active or not session_data.get("baseUrl"): return 0.0
    url = f"{session_data['baseUrl']}/script-details/1.0/quotes/neosymbol/{exchange_segment}|{token_or_symbol}/ltp"
    headers = {"Authorization": KOTAK_CONSUMER_KEY, "Content-Type": "application/json"}
    try:
        res = requests.get(url, headers=headers, timeout=3).json()
        # nested: {"data": [{"ltp": ...}]}
        if isinstance(res, dict) and isinstance(res.get("data"), list) and res["data"]:
            return float(res["data"][0].get("ltp", 0))
        # flat list: [{"ltp": ...}]
        if isinstance(res, list) and res:
            return float(res[0].get("ltp", 0))
        # flat dict: {"ltp": ...}
        if isinstance(res, dict):
            return float(res.get("ltp", 0))
    except: pass
    return 0.0

def _refresh_spot_cache():
    while True:
        now = datetime.now(IST)
        if now.hour < 9 or now.hour >= 16:
            time.sleep(60)
            continue
        try:
            price = get_market_quote("nse_cm", "26000")
            if price > 0:
                with _spot_lock:
                    _spot_cache["price"] = price
                    _spot_cache["time"]  = time.time()
        except: pass
        time.sleep(10)

def get_spot_price():
    with _spot_lock:
        if _spot_cache["price"] and time.time() - _spot_cache["time"] < 5:
            return _spot_cache["price"]
    price = get_market_quote("nse_cm", "26000")
    if price > 0:
        with _spot_lock:
            _spot_cache["price"] = price
            _spot_cache["time"] = time.time()
        return price
    return _spot_cache.get("price")

def get_option_cmp(trade, force_refresh=False):
    tid = trade.get("order_id", str(id(trade)))
    with _cmp_lock:
        cached = _cmp_cache.get(tid)
        if cached and not force_refresh and (time.time() - cached["time"]) < 5:
            return cached["price"]
    token = trade.get("instrument_token", "")
    price = get_market_quote("nse_fo", token) if token else 0.0
    if price <= 0: 
        price = float(trade.get("opt_cmp", 0) or 0)
    with _cmp_lock: 
        _cmp_cache[tid] = {"price": price, "time": time.time()}
    return price

# ============================================================
# 5. KOTAK NEO LOGIN
# ============================================================
def login_kotak(totp_code):
    global session_active, session_data
    try:
        from neo_api_client import NeoAPI
        tg_send("🔐 Logging in to Kotak Neo...")
        client = NeoAPI(environment='prod', consumer_key=KOTAK_CONSUMER_KEY)
        client.totp_login(mobile_number=KOTAK_MOBILE, ucc=KOTAK_UCC, totp=totp_code)
        client.totp_validate(mpin=KOTAK_MPIN)
        session_data["client"] = client
        session_data["token"] = client.session_token if hasattr(client, 'session_token') else ""
        session_data["sid"] = client.session_sid if hasattr(client, 'session_sid') else ""
        session_data["baseUrl"] = client.base_url if hasattr(client, 'base_url') else "https://gw-napi.kotaksecurities.com"
        session_active = True
        tg_send("✅ Logged into Kotak Neo successfully.")
        return True
    except Exception as e:
        tg_send(f"❌ Login error: {str(e)[:150]}")
        return False

# ============================================================
# 6. MESSAGE FORMAT & KEYBOARDS
# ============================================================
def fmt_trade(trade, title, extra="", show_exits=True):
    spot = get_spot_price()
    spot_str = f"₹{spot:,.1f}" if spot else "—"
    mode_str = "📝 Paper" if trade.get("mode") == "PAPER" else "🔴 Live"
    action = str(trade.get('action', '—')).capitalize()
    
    msg = (
        f"{title}\n━━━━━━━━━━━━━━━━━━\n"
        f"<b>Nifty Spot:</b> {spot_str}\n"
        f"<b>{action} {trade.get('instrument','—')} {trade.get('strike','—')} {trade.get('expiry','')} {trade.get('option_type','—')}</b>\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"<b>Entry:</b> ₹{trade.get('entry','—')}\n"
        f"<b>CMP:</b> ₹{trade.get('opt_cmp','—')}\n"
        f"<b>Qty:</b> {trade.get('qty','—')} lots\n"
        f"<b>SL:</b> {trade.get('sl_spot','—')} ({trade.get('sl_direction','—')})\n"
        f"<b>Mode:</b> {mode_str}\n"
    )
    if show_exits and trade.get("exit_history"):
        msg += "━━━━━━━━━━━━━━━━━━\n<b>Exit History:</b>\n"
        for ex in trade["exit_history"]:
            msg += f" • {ex['qty']} lots @ ₹{ex['price']} ({ex['time']})\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    if extra: msg += f"{extra}\n"
    return msg

def trade_keyboard(tid):
    return {"inline_keyboard": [
        [{"text": "📤 Exit", "callback_data": f"exit_{tid}"}, {"text": "🛑 SL Order", "callback_data": f"slorder_{tid}"}],
        [{"text": "🎯 Set Target", "callback_data": f"settgt_{tid}"}, {"text": "📊 Status", "callback_data": "status_all"}]
    ]}

def close_trade(tid, status, extra="", original_qty=None):
    trade = open_trades.pop(tid, None)
    if not trade: return
    if ALGO_CHAT_ID in pending_actions and pending_actions[ALGO_CHAT_ID].get("tid") == tid:
        pending_actions.pop(ALGO_CHAT_ID, None)
    with _cmp_lock: _cmp_cache.pop(trade.get("order_id", ""), None)
    
    icon = {"exited": "📤", "cancelled": "❌", "sl_hit": "🛑", "target_hit": "🎯"}.get(status, "✅")
    title = f"{icon} <b>POSITION {status.upper().replace('_', ' ')}</b>"
    if original_qty: trade["qty"] = original_qty
    
    final = fmt_trade(trade, title, extra=f"Time: {datetime.now(IST).strftime('%H:%M:%S')}\n{extra}\n<i>Position closed</i>", show_exits=True)
    msg_id = trade.get("active_msg_id")
    if msg_id: tg_edit(msg_id, final, keyboard={"inline_keyboard": []})
    else: tg_send(final)

def send_status():
    active = {k: v for k, v in open_trades.items() if not k.startswith("pending_")}
    spot = get_spot_price()
    if not active:
        tg_send(f"📊 <b>No open positions</b>\n<b>Nifty Spot:</b> {'₹'+f'{spot:,.1f}' if spot else '—'}\n<b>Daily P&L:</b> {'+'if daily_pnl>=0 else ''}₹{daily_pnl:,.0f}\n<b>Orders today:</b> {daily_order_count}")
        return
    msg = "📊 <b>OPEN POSITIONS</b>\n━━━━━━━━━━━━━━━━━━\n"
    rows = []
    for i, (tid, t) in enumerate(active.items(), 1):
        cmp = get_option_cmp(t)
        msg += (f"\n{i}️⃣ <b>{t.get('action')} {t.get('instrument')} {t.get('strike')} {t.get('option_type')}</b>\n"
                f"<b>Entry:</b> ₹{t.get('entry')} | <b>Qty:</b> {t.get('qty')} lots\n"
                f"<b>SL:</b> {t.get('sl_spot')} ({t.get('sl_direction')})\n")
        rows.append([{"text": f"{i}️⃣ Manage", "callback_data": f"manage_{tid}"}])
    if spot: msg += f"\n<b>Nifty Spot:</b> ₹{spot:,.1f}"
    msg += f"\n<b>Daily P&L:</b> {'+'if daily_pnl>=0 else ''}₹{daily_pnl:,.0f}"
    rows.append([{"text": "📊 Refresh", "callback_data": "status_all"}, {"text": "🚨 EXIT ALL", "callback_data": "exit_all"}])
    tg_send(msg, keyboard={"inline_keyboard": rows})

# ============================================================
# 7. ASYNC ORDER EXECUTION & EXITS
# ============================================================
def resolve_expiry(expiry_str, instrument):
    """
    Compute actual expiry date from 'Weekly'/'Next Weekly'/'Monthly'.
    Correct weekdays per NSE/BSE schedule:
      NIFTY       → Tuesday   (weekday 1)
      BANKNIFTY   → Wednesday (weekday 2)
      SENSEX/BSE  → Friday    (weekday 4)
    Holiday handling is done in place_order by retrying with adjacent dates.
    """
    if not expiry_str:
        return ''
    s = str(expiry_str).strip().upper()
    months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
    if any(m in s for m in months):
        return s  # Already a date like "02JUN2026"

    now  = datetime.now(IST)
    today = now.date()
    instr = str(instrument).upper()

    if 'SENSEX' in instr or 'BSE' in instr:
        target_wd = 4   # Friday
    elif 'BANKNIFTY' in instr:
        target_wd = 2   # Wednesday
    else:
        target_wd = 1   # Tuesday (NIFTY and all others)

    if s == 'WEEKLY':
        days = (target_wd - today.weekday()) % 7
        expiry_date = today + timedelta(days=days)

    elif s in ('NEXT WEEKLY', 'NEXT WEEK', 'NEXTWEEK'):
        days_curr = (target_wd - today.weekday()) % 7
        expiry_date = today + timedelta(days=days_curr + 7)

    elif s == 'MONTHLY':
        yr, mo = today.year, today.month
        last = calendar.monthrange(yr, mo)[1]
        expiry_date = today  # fallback
        for d in range(last, last - 14, -1):
            if d < 1:
                break
            if datetime(yr, mo, d).weekday() == target_wd:
                candidate = datetime(yr, mo, d).date()
                if candidate >= today:
                    expiry_date = candidate
                    break
    else:
        return s

    return expiry_date.strftime('%d%b%Y').upper()

def _parse_expiry_date(item):
    """Extract expiry date from a Kotak Neo scrip result item."""
    import re
    # Try dedicated field first
    for field in ('pExpDt', 'expiry', 'pExpiryDate'):
        val = item.get(field, '')
        if val:
            for fmt in ('%d%b%Y', '%d-%b-%Y', '%Y-%m-%d', '%d/%m/%Y'):
                try:
                    return datetime.strptime(str(val)[:10], fmt).date()
                except ValueError:
                    continue
    # Fall back to parsing pTrdSymbol e.g. "NIFTY29MAY2026PE23500"
    sym = item.get('pTrdSymbol', '') or item.get('symbol', '') or ''
    m = re.search(r'(\d{2}[A-Z]{3}\d{4})', sym.upper())
    if m:
        try:
            return datetime.strptime(m.group(1), '%d%b%Y').date()
        except ValueError:
            pass
    return None

def pick_expiry(items, expiry_input):
    """
    Pick the right scrip from Kotak's list based on 'Weekly', 'Monthly',
    or a specific date string. Uses actual API data so holidays are handled
    automatically — no hardcoded day-of-week assumptions.
    """
    today = datetime.now(IST).date()
    months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']

    # Build list of (item, expiry_date), filter out past dates
    dated = [(it, _parse_expiry_date(it)) for it in items]
    dated = [(it, d) for it, d in dated if d and d >= today]
    if not dated:
        return items[0] if items else None  # fallback: return first item
    dated.sort(key=lambda x: x[1])

    s = str(expiry_input).strip().upper()

    if any(m in s for m in months):
        # Specific date already provided — find exact match
        try:
            target = datetime.strptime(s, '%d%b%Y').date()
            for it, d in dated:
                if d == target:
                    return it
        except ValueError:
            pass
        return dated[0][0]  # fallback to nearest

    elif s == 'WEEKLY':
        # Nearest available expiry — Kotak's data already reflects holidays
        return dated[0][0]

    elif s in ('NEXT WEEKLY', 'NEXT WEEK', 'NEXTWEEK'):
        # Skip current week's expiry, return the one after
        # Works correctly whether today is before, on, or after the current expiry day
        return dated[1][0] if len(dated) > 1 else dated[0][0]

    elif s == 'MONTHLY':
        # Last expiry in the current calendar month
        this_month = [(it, d) for it, d in dated if d.month == today.month and d.year == today.year]
        return this_month[-1][0] if this_month else dated[0][0]

    else:
        return dated[0][0]  # Unknown input — nearest expiry as safe default

def place_order(trade):
    global daily_order_count
    qty, entry, mode = int(trade.get("qty", 0)), float(trade.get("entry", 0)), trade.get("mode", "PAPER")


    if qty <= 0 or qty > MAX_QTY_PER_ORDER or daily_order_count >= MAX_ORDERS_PER_DAY or daily_pnl < -MAX_DAILY_LOSS:
        tg_send("❌ Order limits hit or invalid qty.")
        return None

    if mode == "PAPER" or not session_active:
        oid = f"PAPER_{int(time.time())}"
        daily_order_count += 1
        tg_send(fmt_trade(trade, "📝 <b>ORDER SIMULATED</b>", extra=f"<b>Order ID:</b> {oid}\n<i>Paper mode — no real order</i>"))
        return oid
        
    try:
        client = session_data["client"]
        instr = trade.get("instrument", "NIFTY")
        total_qty = qty * LOT_SIZES.get(instr, 65)
        action = trade.get("action", "BUYING")
        trans = "B" if "BUY" in action.upper() else "S"
        
        # Compute expiry date — then retry adjacent days for holiday shifts
        base_expiry = resolve_expiry(trade.get("expiry", "Weekly"), instr)
        dates_to_try = [base_expiry]
        if base_expiry:
            try:
                base_dt = datetime.strptime(base_expiry, '%d%b%Y')
                dates_to_try += [
                    (base_dt - timedelta(days=1)).strftime('%d%b%Y').upper(),
                    (base_dt - timedelta(days=2)).strftime('%d%b%Y').upper(),
                    (base_dt + timedelta(days=1)).strftime('%d%b%Y').upper(),
                ]
            except ValueError:
                pass


        item = None
        used_expiry = base_expiry
        for exp in dates_to_try:
            try:
                result = client.search_scrip(exchange_segment="nse_fo", symbol=instr, expiry=exp, option_type=trade.get("option_type", "CE"), strike_price=str(trade.get("strike", "")))
                if isinstance(result, list):
                    data = result
                elif isinstance(result, dict):
                    data = result.get("data")
                else:
                    data = None
                if data:
                    items = data if isinstance(data, list) else [data]
                    item = pick_expiry(items, trade.get("expiry", "Weekly"))
                    if item:
                        used_expiry = exp
                        break
            except Exception:
                continue

        if not item:
            tg_send(f"❌ No scrip found for {instr} {trade.get('strike')} {trade.get('option_type')}\nTried expiry: {base_expiry}\nCheck strike or market hours.")
            return None
        trd_symbol = item.get("pTrdSymbol", "")
        trade["instrument_token"] = item.get("pSymbol", "")
        trade["expiry_resolved"] = used_expiry
        trade["trd_symbol"] = trd_symbol

        order = client.place_order(
            exchange_segment="nse_fo", product="NRML", price=str(entry), order_type="L", quantity=str(total_qty), validity="DAY",
            trading_symbol=trd_symbol, transaction_type=trans, amo="NO", disclosed_quantity="0", market_protection="0", pf="N", trigger_price="0", tag="Trade2Spend"
        )
        if order and order.get("data"):
            oid = order["data"].get("nOrdNo", "")
            daily_order_count += 1
            tg_send(fmt_trade(trade, "✅ <b>LIVE ORDER PLACED</b>", extra=f"<b>Order ID:</b> {oid}\n<b>Qty on exchange:</b> {total_qty} units"))
            return oid
        else:
            tg_send(f"❌ Order failed: {order}")
            return None
    except Exception as e:
        tg_send(f"❌ Live order error: {str(e)[:150]}")
        return None

def exit_position(tid, qty_exit, price_exit):
    global daily_pnl
    trade = open_trades.get(tid)
    if not trade: return tg_send("❌ Trade not found.")
    if qty_exit <= 0: return tg_send("❌ Invalid qty.")

    with _trade_lock:
        remaining = int(trade.get("qty", 0))
        if qty_exit > remaining: return tg_send(f"❌ Cannot exit {qty_exit} lots. Only {remaining} left.")
        original_qty = remaining
        if "exit_history" not in trade: trade["exit_history"] = []
        trade["exit_history"].append({"qty": qty_exit, "price": price_exit, "time": datetime.now(IST).strftime("%H:%M:%S")})
        pnl = (price_exit - float(trade.get("entry", 0))) * qty_exit * LOT_SIZES.get(trade.get("instrument", "NIFTY"), 65)
        daily_pnl += pnl

    mode = trade.get("mode", "PAPER")
    if mode != "PAPER" and session_active and session_data.get("client"):
        try:
            client = session_data["client"]
            trans = "S" if "BUY" in trade.get("action", "BUYING").upper() else "B"
            client.place_order(
                exchange_segment="nse_fo", product="I", price=str(price_exit), order_type="L", quantity=str(qty_exit * LOT_SIZES.get(trade.get("instrument", "NIFTY"), 65)), 
                validity="DAY", trading_symbol=trade.get("trd_symbol", ""), transaction_type=trans, amo="NO", disclosed_quantity="0", market_protection="0", pf="N", trigger_price="0", tag="Trade2Spend_Exit"
            )
        except Exception as e:
            tg_send(f"⚠ Exit order error: {str(e)[:100]}")

    if qty_exit >= remaining:
        close_trade(tid, "exited", extra=f"<b>P&L this exit:</b> {'+'if pnl>=0 else ''}₹{pnl:,.0f}\n<b>Daily P&L:</b> {'+'if daily_pnl>=0 else ''}₹{daily_pnl:,.0f}", original_qty=original_qty)
    else:
        open_trades[tid]["qty"] = remaining - qty_exit
        msg = fmt_trade(open_trades[tid], "📤 <b>PARTIAL EXIT</b>", extra=f"<b>Exited:</b> {qty_exit} lots @ ₹{price_exit}\n<b>P&L this exit:</b> {'+'if pnl>=0 else ''}₹{pnl:,.0f}\n<b>Remaining:</b> {open_trades[tid]['qty']} lots", show_exits=True)
        if "active_msg_id" in open_trades[tid]: tg_edit(open_trades[tid]["active_msg_id"], msg, keyboard=trade_keyboard(tid))
        else: tg_send(msg, keyboard=trade_keyboard(tid))
        tg_send(f"✅ Exit placed: {qty_exit} lots @ ₹{price_exit}")

# ============================================================
# 8. BACKGROUND THREADS
# ============================================================
def _daily_reset_thread():
    global daily_pnl, daily_order_count
    while True:
        now = datetime.now(IST)
        secs = ((24 - now.hour - 1) * 3600 + (60 - now.minute - 1) * 60 + (60 - now.second))
        time.sleep(secs)
        daily_pnl, daily_order_count = 0.0, 0
        print("✅ Daily counters reset at midnight")

class SLMonitor(threading.Thread):
    def __init__(self, tid, trade):
        super().__init__(daemon=True)
        self.tid          = tid
        self.sl_spot      = float(trade.get("sl_spot", 0))
        self.sl_dir       = trade.get("sl_direction", "above")
        self.sustain_mins = int(trade.get("sl_sustain_minutes", 15))
        self.opt_type     = trade.get("option_type", "PE")
        self.breach_time  = None
        self.candle_high  = None
        self.candle_low   = None
        self.running      = True
        self.grace_start  = time.time() 

    def run(self):
        print(f"SL Monitor: {self.tid}")
        while self.running and self.tid in open_trades:
            try:
                if time.time() - self.grace_start < 120:
                    time.sleep(30)
                    continue
                now = datetime.now(IST)
                if now.hour < 9 or now.hour >= 16:
                    time.sleep(60)
                    continue
                spot = get_spot_price()
                if spot is None:
                    time.sleep(60)
                    continue
                breached = (self.sl_dir == "above" and spot > self.sl_spot) or (self.sl_dir == "below" and spot < self.sl_spot)
                
                if breached:
                    if self.breach_time is None:
                        self.breach_time = now
                        self.candle_high, self.candle_low = spot, spot
                        tg_send(f"⚠ <b>SL BREACHED</b>\n<b>Spot:</b> {spot:,.1f} is {self.sl_dir} {self.sl_spot:,.0f}\n⏱ Monitoring {self.sustain_mins}-min sustain...")
                    else:
                        self.candle_high = max(self.candle_high, spot)
                        self.candle_low = min(self.candle_low, spot)
                        elapsed = (now - self.breach_time).seconds / 60
                        if elapsed >= self.sustain_mins:
                            sl_ref = self.candle_high if self.opt_type == "PE" else self.candle_low
                            trade = open_trades.get(self.tid, {})
                            cmp = get_option_cmp(trade)
                            remaining_qty = int(trade.get("qty", 0))
                            if remaining_qty <= 0:
                                self.running = False
                                break
                            tg_send(
                                f"🛑 <b>SL TRIGGERED</b>\n━━━━━━━━━━━━━━━━━━\n"
                                f"Sustained {self.sl_dir} {self.sl_spot:,.0f} for {self.sustain_mins} min\n"
                                f"<b>Candle H:</b> {self.candle_high:,.1f} | <b>L:</b> {self.candle_low:,.1f}\n"
                                f"<b>Ref:</b> {sl_ref:,.1f} | <b>CMP:</b> ₹{cmp:.1f}\n<b>Qty to exit:</b> {remaining_qty} lots\n━━━━━━━━━━━━━━━━━━\n<i>Confirm exit or change price</i>",
                                keyboard={"inline_keyboard": [[
                                    {"text": f"✅ Exit {remaining_qty} @ ₹{cmp:.0f}", "callback_data": f"slconfirm_{self.tid}_{remaining_qty}_{int(cmp)}"},
                                    {"text": "✏ Change price", "callback_data": f"slchangeprice_{self.tid}_{remaining_qty}"}
                                ]]}
                            )
                            self.running = False
                            break
                else:
                    if self.breach_time is not None:
                        self.breach_time = None
                        tg_send(f"✅ Spot back in safe zone ({spot:,.1f}). SL reset.")
                time.sleep(60)
            except Exception as e:
                time.sleep(60)

        # Monitor manual SL order trigger and Target
        while self.running and self.tid in open_trades:
            try:
                now = datetime.now(IST)
                if now.hour < 9 or now.hour >= 16:
                    time.sleep(60)
                    continue
                trade = open_trades.get(self.tid, {})
                sl_order, target, cmp = trade.get("sl_order"), trade.get("target"), get_option_cmp(trade)

                if sl_order and cmp > 0:
                    trigger, limit, sl_qty = float(sl_order.get("trigger", 0)), float(sl_order.get("limit", 0)), int(sl_order.get("qty", int(trade.get("qty", 0))))
                    action = trade.get("action", "BUYING")
                    triggered = ("BUY" in action.upper() and cmp <= trigger) or ("SELL" in action.upper() and cmp >= trigger)
                    if triggered:
                        tg_send(
                            f"🛑 <b>SL ORDER TRIGGERED</b>\n<b>CMP:</b> ₹{cmp:.1f} hit trigger ₹{trigger}\n<b>Limit order:</b> ₹{limit} | <b>Qty:</b> {sl_qty} lots",
                            keyboard={"inline_keyboard": [[
                                {"text": f"✅ Confirm Exit {sl_qty} @ ₹{limit}", "callback_data": f"slconfirm_{self.tid}_{sl_qty}_{int(limit)}"},
                                {"text": "✏ Change price", "callback_data": f"slchangeprice_{self.tid}_{sl_qty}"}
                            ]]}
                        )
                        open_trades[self.tid].pop("sl_order", None)

                if target and cmp > 0:
                    action = trade.get("action", "BUYING")
                    hit = ("BUY" in action.upper() and cmp >= float(target)) or ("SELL" in action.upper() and cmp <= float(target))
                    if hit:
                        qty = int(trade.get("qty", 0))
                        tg_send(
                            f"🎯 <b>TARGET HIT!</b>\n<b>CMP:</b> ₹{cmp:.1f} reached target ₹{target}\n<b>Qty:</b> {qty} lots",
                            keyboard={"inline_keyboard": [[
                                {"text": f"✅ Exit {qty} @ ₹{cmp:.0f}", "callback_data": f"slconfirm_{self.tid}_{qty}_{int(cmp)}"},
                                {"text": "⏳ Hold", "callback_data": f"manage_{self.tid}"}
                            ]]}
                        )
                        open_trades[self.tid].pop("target", None)
                time.sleep(30)
            except Exception as e:
                time.sleep(30)

# ============================================================
# 9. UI & INPUT VALIDATION
# ============================================================
def process_trade(text):
    try:
        idx = text.find("PAYLOAD:")
        if idx == -1: return
        trade = json.loads(text[idx + 8:])
        if trade.get("source") != "Trade2SpendPWA": return

        # --- Payload validation ---
        VALID_INSTRS   = {"NIFTY","BANKNIFTY","SENSEX","FINNIFTY","BANKEX"}
        VALID_OPT_TYPES= {"CE","PE"}
        VALID_EXPIRIES = {"weekly","next weekly","monthly"}
        MONTH_STRS     = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]

        required = ["instrument","strike","expiry","option_type","entry","sl_spot","sl_direction","qty"]
        for f in required:
            if not trade.get(f) and trade.get(f) != 0:
                tg_send(f"❌ Invalid payload: missing field '{f}'"); return

        if trade.get("instrument","").upper() not in VALID_INSTRS:
            tg_send(f"❌ Invalid instrument: {trade.get('instrument')}. Allowed: {VALID_INSTRS}"); return

        if trade.get("option_type","").upper() not in VALID_OPT_TYPES:
            tg_send(f"❌ Invalid option_type: {trade.get('option_type')}"); return

        qty_raw = str(trade.get("qty",""))
        if "." in qty_raw:
            tg_send(f"❌ qty must be whole number, got: {qty_raw}"); return
        qty = int(qty_raw)
        if qty <= 0 or qty > MAX_QTY_PER_ORDER:
            tg_send(f"❌ qty {qty} out of range (1–{MAX_QTY_PER_ORDER})"); return

        try:
            entry = float(trade["entry"])
            if entry <= 0: raise ValueError
        except (ValueError, TypeError):
            tg_send(f"❌ Invalid entry price: {trade.get('entry')}"); return

        expiry_str = str(trade.get("expiry","")).lower().strip()
        is_date_str = any(m in expiry_str for m in MONTH_STRS)
        if expiry_str not in VALID_EXPIRIES and not is_date_str:
            tg_send(f"❌ Unrecognised expiry: {trade.get('expiry')}"); return

        if len(str(trade.get("message","") or "")) > 500:
            tg_send("❌ Message too long (max 500 chars)"); return

        for k in [k for k in open_trades if k.startswith("pending_")]:
            t = open_trades[k]
            if t.get("instrument") == trade.get("instrument") and t.get("strike") == trade.get("strike") and t.get("option_type") == trade.get("option_type"):
                tg_send("⚠ Same trade already pending confirmation. Tap Confirm or Cancel first.")
                return

        tid = str(int(time.time()))
        open_trades[f"pending_{tid}"] = trade
        mode_tag = "📝 PAPER" if trade.get("mode") == "PAPER" else "🔴 LIVE"
        mid = tg_send(
            fmt_trade(trade, f"⚡ <b>CONFIRM ORDER {mode_tag}</b>", extra=f"<b>Sustain:</b> {trade.get('sl_sustain_minutes')} min\n<i>Tap Confirm to place order</i>"),
            keyboard={"inline_keyboard": [[{"text": "✅ Confirm & Place", "callback_data": f"confirm_{tid}"}, {"text": "❌ Cancel", "callback_data": f"reject_{tid}"}]]}
        )
        open_trades[f"pending_{tid}"]["confirm_msg_id"] = mid
        print(f"✅ Trade: {trade.get('instrument')} {trade.get('strike')}")
    except Exception as e:
        print(f"process_trade error: {e}")

def handle_callback(cb):
    global PAPER_MODE
    cid, action, msg_id = cb["id"], cb["data"], cb["message"]["message_id"]

    if action.startswith("confirm_") and not action.startswith("confirm_exit") and not action == "confirm_live":
        tid = action[8:]
        trade = open_trades.pop(f"pending_{tid}", None)
        if not trade: return tg_answer(cid, "Expired")
        tg_answer(cid, "Placing...")
        
        confirm_mid = trade.get("confirm_msg_id")
        if confirm_mid: tg_edit(confirm_mid, fmt_trade(trade, "⏳ <b>PLACING ORDER...</b>"), keyboard={"inline_keyboard": []})

        oid = place_order(trade)
        if oid:
            trade["order_id"] = oid
            trade["placed_at"] = datetime.now(IST).strftime("%H:%M:%S")
            trade["exit_history"] = []
            trade["sl_monitor_started"] = False
            open_trades[tid] = trade
            active_msg_id = tg_send(fmt_trade(trade, "✅ <b>TRADE ACTIVE</b>", extra=f"<b>Order ID:</b> {oid}\n<b>Time:</b> {trade['placed_at']}"), keyboard=trade_keyboard(tid))
            if active_msg_id: open_trades[tid]["active_msg_id"] = active_msg_id
            if not trade.get("sl_monitor_started"):
                open_trades[tid]["sl_monitor_started"] = True
                SLMonitor(tid, trade).start()

    elif action.startswith("reject_"):
        open_trades.pop(f"pending_{action[7:]}", None)
        tg_answer(cid, "Cancelled")
        tg_edit(msg_id, "❌ Order cancelled.", keyboard={"inline_keyboard": []})

    elif action.startswith("exit_") and action != "exit_all":
        tid, trade = action[5:], open_trades.get(action[5:], {})
        qty = int(trade.get("qty", 0))
        tg_answer(cid, "")
        half = max(1, qty // 2) if qty > 1 else qty
        rows = [[{"text": f"All {qty} lots", "callback_data": f"exitqty_{tid}_{qty}"}, {"text": f"Half {half} lots", "callback_data": f"exitqty_{tid}_{half}"}]] if qty > 1 else [[{"text": f"Exit {qty} lot", "callback_data": f"exitqty_{tid}_{qty}"}]]
        rows.append([{"text": "✏ Custom qty", "callback_data": f"exitqty_{tid}_custom"}, {"text": "⬅ Back", "callback_data": f"manage_{tid}"}])
        tg_send(f"📤 <b>Exit {trade.get('instrument')} {trade.get('strike')} {trade.get('option_type')}</b>\n<b>Remaining:</b> {qty} lots\n\nSelect qty:", keyboard={"inline_keyboard": rows})

    elif action.startswith("exitqty_"):
        parts = action.split("_")
        tid, qty_str = parts, parts
        if qty_str == "custom":
            pending_actions[ALGO_CHAT_ID] = {"action": "exit_qty", "tid": tid}
            tg_answer(cid, "")
            tg_send(f"Enter qty to exit:\n<b>Remaining:</b> {open_trades.get(tid, {}).get('qty','—')} lots")
        else:
            qty_exit, trade = int(qty_str), open_trades.get(tid, {})
            cmp = get_option_cmp(trade)
            tg_answer(cid, "")
            pending_actions[ALGO_CHAT_ID] = {"action": "exit_price", "tid": tid, "qty": qty_exit}
            tg_send(f"📤 Exiting <b>{qty_exit} lots</b>\n<b>CMP:</b> ₹{cmp:.1f}\n\nSelect exit price:", keyboard={"inline_keyboard": [[{"text": f"Market (₹{cmp:.0f})", "callback_data": f"exitprice_{tid}_{qty_exit}_{int(cmp)}"}, {"text": "✏ Custom price", "callback_data": f"exitprice_{tid}_{qty_exit}_custom"}], [{"text": "⬅ Back", "callback_data": f"exit_{tid}"}]]})

    elif action.startswith("exitprice_"):
        parts = action.split("_")
        tid, qty_exit, price_str = parts, int(parts), parts
        if price_str == "custom":
            pending_actions[ALGO_CHAT_ID] = {"action": "exit_price", "tid": tid, "qty": qty_exit}
            tg_answer(cid, "")
            tg_send(f"Enter exit price for <b>{qty_exit} lots</b>:")
        else:
            tg_answer(cid, "Placing exit...")
            exit_position(tid, qty_exit, float(price_str))

    elif action == "exit_all":
        tg_answer(cid, "")
        count = len([k for k in open_trades if not k.startswith("pending_")])
        tg_send(f"⚠ <b>EXIT ALL {count} positions at market?</b>", keyboard={"inline_keyboard": [[{"text": "✅ Yes Exit All", "callback_data": "confirm_exit_all"}, {"text": "❌ Cancel", "callback_data": "status_all"}]]})

    elif action == "confirm_exit_all":
        tg_answer(cid, "Exiting all...")
        for tid in [k for k in list(open_trades) if not k.startswith("pending_")]:
            trade = open_trades.get(tid, {})
            cmp = get_option_cmp(trade)
            exit_position(tid, int(trade.get("qty", 0)), cmp if cmp > 0 else float(trade.get("entry", 0)))
        tg_send("✅ All positions closed.")

    elif action.startswith("slconfirm_"):
        parts = action.split("_")
        tg_answer(cid, "Exiting...")
        tg_edit(msg_id, "🛑 <b>SL EXIT PLACED</b>", keyboard={"inline_keyboard": []})
        exit_position(parts[5], int(parts[6]), float(parts[7]))

    elif action.startswith("slchangeprice_"):
        parts = action.split("_")
        pending_actions[ALGO_CHAT_ID] = {"action": "exit_price", "tid": parts[5], "qty": int(parts[6])}
        tg_answer(cid, "")
        tg_send(f"Enter exit price for <b>{parts[6]} lots</b>:")

    elif action.startswith("slorder_"):
        tid, trade = action[8:], open_trades.get(action[8:], {})
        tg_answer(cid, "")
        existing_sl = trade.get("sl_order")
        if existing_sl:
            tg_send(f"🛑 <b>SL Order Already Active</b>\n<b>Trigger:</b> ₹{existing_sl['trigger']} | <b>Limit:</b> ₹{existing_sl['limit']}\n<b>Qty:</b> {existing_sl.get('qty','—')} lots\n━━━━━━━━━━━━━━━━━━", keyboard={"inline_keyboard": [[{"text": "✏ Edit SL Order", "callback_data": f"editsl_{tid}"}, {"text": "❌ Cancel SL Order", "callback_data": f"cancelsl_{tid}"}], [{"text": "⬅ Back", "callback_data": f"manage_{tid}"}]]})
            return
        cmp = get_option_cmp(trade)
        pending_actions[ALGO_CHAT_ID] = {"action": "sl_qty", "tid": tid, "cmp": cmp}
        tg_send(f"🛑 <b>SL Order — {trade.get('instrument')} {trade.get('strike')} {trade.get('option_type')}</b>\n<b>CMP:</b> ₹{cmp:.1f} | <b>Position:</b> {trade.get('qty')} lots\n\nEnter <b>qty to exit</b> when SL triggers:\n<i>Type /cancel to abort</i>")

    elif action.startswith("settgt_"):
        tid, trade = action[7:], open_trades.get(action[7:], {})
        cmp = get_option_cmp(trade)
        pending_actions[ALGO_CHAT_ID] = {"action": "set_target", "tid": tid}
        tg_answer(cid, "")
        tg_send(f"🎯 Enter target price:\n<b>CMP:</b> ₹{cmp:.1f} | <b>Entry:</b> ₹{trade.get('entry','—')}\n\n<i>Type /cancel to abort</i>")

    elif action.startswith("manage_"):
        tid, trade = action[7:], open_trades.get(action[7:], {})
        if not trade: return tg_answer(cid, "Trade not found")
        cmp = get_option_cmp(trade)
        if cmp > 0: open_trades[tid]["opt_cmp"] = str(round(cmp, 1))
        tg_answer(cid, "")
        tg_send(fmt_trade(open_trades[tid], "📊 <b>MANAGING POSITION</b>"), keyboard=trade_keyboard(tid))

    elif action.startswith("editsl_"):
        tid, trade = action[7:], open_trades.get(action[7:], {})
        cmp = get_option_cmp(trade)
        tg_answer(cid, "")
        existing_sl = trade.get("sl_order", {})
        tg_send(f"✏ <b>Edit SL Order</b>\n<b>Current:</b> Trigger ₹{existing_sl.get('trigger','—')} | Limit ₹{existing_sl.get('limit','—')} | Qty {existing_sl.get('qty','—')} lots\n<b>CMP:</b> ₹{cmp:.1f}\n\nEnter new <b>qty to exit</b>:\n<i>Type /cancel to abort</i>")
        pending_actions[ALGO_CHAT_ID] = {"action": "sl_qty", "tid": tid, "cmp": cmp, "editing": True}

    elif action.startswith("cancelsl_"):
        tg_answer(cid, "SL Order cancelled")
        if action[9:] in open_trades:
            open_trades[action[9:]].pop("sl_order", None)
            tg_send("✅ SL Order cancelled successfully.")
            tg_edit(msg_id, "❌ SL Order cancelled.", keyboard={"inline_keyboard": []})

    elif action == "status_all":
        tg_answer(cid, "Refreshing...")
        send_status()

    elif action == "confirm_live":
        PAPER_MODE = False
        tg_answer(cid, "LIVE mode ON")
        tg_send("🔴 <b>LIVE mode active!</b> Real orders will be placed.")
        
    elif action == "stay_paper":
        tg_answer(cid, "Staying in Paper mode")

    elif action.startswith("approve_req_"):
        request_id = action[len("approve_req_"):]
        tg_answer(cid, "Approving...")
        try:
            r = requests.patch(
                f"http://localhost:{SERVER_PORT}/access-requests/{request_id}",
                json={"action": "approve"},
                headers={"x-t2s-secret": "T2SMonitor2026"},
                timeout=10
            )
            data = r.json()
            if data.get("ok"):
                tg_edit(msg_id, f"✅ <b>Approved</b> — {data.get('member_name', 'Member')} now has free premium access.\nA push notification has been sent to them.", keyboard={"inline_keyboard": []})
            else:
                tg_edit(msg_id, f"❌ Approval failed: {data.get('error', 'Unknown error')}", keyboard={"inline_keyboard": []})
        except Exception as e:
            tg_edit(msg_id, f"❌ Server error: {str(e)}", keyboard={"inline_keyboard": []})

    elif action.startswith("reject_req_"):
        request_id = action[len("reject_req_"):]
        tg_answer(cid, "Rejected")
        try:
            r = requests.patch(
                f"http://localhost:{SERVER_PORT}/access-requests/{request_id}",
                json={"action": "reject"},
                headers={"x-t2s-secret": "T2SMonitor2026"},
                timeout=10
            )
            r.json()
            tg_edit(msg_id, "❌ <b>Rejected</b> — Member can re-apply after 24 hours.", keyboard={"inline_keyboard": []})
        except Exception as e:
            tg_edit(msg_id, f"❌ Server error: {str(e)}", keyboard={"inline_keyboard": []})

    elif action.startswith("block_req_"):
        request_id = action[len("block_req_"):]
        tg_answer(cid, "Blocked")
        try:
            r = requests.patch(
                f"http://localhost:{SERVER_PORT}/access-requests/{request_id}",
                json={"action": "block"},
                headers={"x-t2s-secret": "T2SMonitor2026"},
                timeout=10
            )
            data = r.json()
            if data.get("ok"):
                tg_edit(msg_id, f"🚫 <b>Blocked</b> — {data.get('member_name', 'Member')} cannot request free access again.", keyboard={"inline_keyboard": []})
            else:
                tg_edit(msg_id, f"❌ Block failed: {data.get('error', 'Unknown error')}", keyboard={"inline_keyboard": []})
        except Exception as e:
            tg_edit(msg_id, f"❌ Server error: {str(e)}", keyboard={"inline_keyboard": []})

# ============================================================
# 10b. MARKET SCRAPER COMMAND HELPERS (pure — no side effects)
# ============================================================
def _market_on_decision(session_active, is_running, github_token):
    if not session_active:
        return False, "⚠ Login with TOTP first, then send /market_on."
    if is_running:
        return False, "📊 Market scraper is already running."
    if not github_token:
        return False, "❌ GITHUB_TOKEN is not set in the bot config."
    return True, "📊 <b>Market scraper started!</b>\nNIFTY / SENSEX / BANKNIFTY updating every 5 sec.\nAuto-stops at 3:35 PM IST."

def _market_off_decision(is_running):
    if not is_running:
        return False, "📊 Market scraper is not running."
    return True, "📊 Market scraper stopped."

def _market_status_message(session_active, is_running, base_url):
    status = "🟢 Running" if is_running else "🔴 Stopped"
    session_str = "✅ Active" if session_active else "❌ Not logged in"
    return (
        f"📊 <b>Market Scraper Status</b>\n━━━━━━━━━━━━━━━━━━\n"
        f"<b>Scraper:</b> {status}\n"
        f"<b>Session:</b> {session_str}\n"
        f"<b>Base URL:</b> {base_url or 'not set'}"
    )

def handle_message(msg, update_id=None):
    global PAPER_MODE
    text, chat_id = msg.get("text", ""), str(msg.get("chat", {}).get("id", ""))
    print(f"MSG: {text[:80]}")

    if chat_id in pending_actions:
        pa = pending_actions.pop(chat_id)
        if text.strip().lower() == "/cancel": return tg_send("❌ Action cancelled.")

        if pa["action"] == "exit_qty":
            try:
                qty_req = int(text.strip())
                if qty_req <= 0: raise ValueError()
                trade = open_trades.get(pa["tid"], {})
                remaining = int(trade.get("qty", 0))
                if qty_req > remaining:
                    tg_send(f"❌ Only {remaining} lots remaining. Enter valid qty:")
                    pending_actions[chat_id] = pa
                else:
                    cmp = get_option_cmp(trade)
                    pending_actions[chat_id] = {"action": "exit_price", "tid": pa["tid"], "qty": qty_req}
                    tg_send(f"<b>Qty:</b> {qty_req} lots\nSelect exit price:", keyboard={"inline_keyboard": [[{"text": f"Market (₹{cmp:.0f})", "callback_data": f"exitprice_{pa['tid']}_{qty_req}_{int(cmp)}"}, {"text": "✏ Custom price", "callback_data": f"exitprice_{pa['tid']}_{qty_req}_custom"}]]})
            except:
                tg_send("❌ Invalid qty. Enter a positive number:")
                pending_actions[chat_id] = pa

        elif pa["action"] == "exit_price":
            try:
                price = float(text.strip())
                if price <= 0: raise ValueError()
                exit_position(pa["tid"], pa["qty"], price)
            except:
                tg_send("❌ Invalid price. Enter a positive number:")
                pending_actions[chat_id] = pa

        elif pa["action"] == "sl_qty":
            try:
                qty = int(text.strip())
                if qty <= 0: raise ValueError()
                trade, remaining = open_trades.get(pa["tid"], {}), int(open_trades.get(pa["tid"], {}).get("qty", 0))
                if qty > remaining:
                    tg_send(f"❌ Only {remaining} lots available. Enter valid qty:")
                    pending_actions[chat_id] = pa
                else:
                    pending_actions[chat_id] = {"action": "sl_trigger", "tid": pa["tid"], "cmp": pa.get("cmp", 0), "sl_qty": qty, "editing": pa.get("editing", False)}
                    tg_send(f"<b>Qty:</b> {qty} lots\n\nEnter <b>Trigger Price</b>:\n<i>Price at which SL activates</i>\n<i>Type /cancel to abort</i>")
            except:
                tg_send("❌ Invalid qty. Enter a positive number:")
                pending_actions[chat_id] = pa

        elif pa["action"] == "sl_trigger":
            try:
                trigger = float(text.strip())
                if trigger <= 0: raise ValueError()
                pending_actions[chat_id] = {"action": "sl_limit", "tid": pa["tid"], "trigger": trigger, "sl_qty": pa.get("sl_qty", 0), "editing": pa.get("editing", False)}
                tg_send(f"<b>Trigger:</b> ₹{trigger}\nEnter <b>Limit Price</b>:\n<i>Type /cancel to abort</i>")
            except:
                tg_send("❌ Invalid price.")
                pending_actions[chat_id] = pa

        elif pa["action"] == "sl_limit":
            try:
                limit, trigger, sl_qty, tid = float(text.strip()), pa.get("trigger", 0), pa.get("sl_qty", 0), pa["tid"]
                trade = open_trades.get(tid, {})
                open_trades[tid]["sl_order"] = {"trigger": trigger, "limit": limit, "qty": sl_qty}
                tg_send(f"🛑 <b>SL Order {'Updated' if pa.get('editing') else 'Saved'}</b>\n━━━━━━━━━━━━━━━━━━\n<b>{trade.get('instrument')} {trade.get('strike')} {trade.get('option_type')}</b>\n<b>Qty:</b> {sl_qty} lots\n<b>Trigger:</b> ₹{trigger} | <b>Limit:</b> ₹{limit}\n<i>Bot will monitor and execute when trigger is hit</i>", keyboard={"inline_keyboard": [[{"text": "✏ Edit SL", "callback_data": f"editsl_{tid}"}, {"text": "❌ Cancel SL", "callback_data": f"cancelsl_{tid}"}]]})
            except:
                tg_send("❌ Invalid price.")
                pending_actions[chat_id] = pa

        elif pa["action"] == "set_target":
            try:
                tgt = float(text.strip())
                if tgt <= 0: raise ValueError()
                trade = open_trades.get(pa["tid"], {})
                open_trades[pa["tid"]]["target"] = tgt
                entry, qty, lot = float(trade.get("entry", 0)), int(trade.get("qty", 0)), LOT_SIZES.get(trade.get("instrument", "NIFTY"), 65)
                pot = (tgt - entry) * qty * lot
                tg_send(f"🎯 <b>Target set:</b> ₹{tgt}\n<b>Potential P&L:</b> +₹{pot:,.0f}")
            except: tg_send("❌ Invalid price.")

        elif pa["action"] == "mod_entry":
            try: open_trades[pa["tid"]]["entry"] = str(float(text.strip())); tg_send(f"✅ Entry updated to ₹{text.strip()}")
            except: tg_send("❌ Invalid price.")
        elif pa["action"] == "mod_qty":
            try: open_trades[pa["tid"]]["qty"] = int(text.strip()); tg_send(f"✅ Qty updated to {int(text.strip())} lots")
            except: tg_send("❌ Invalid qty.")
        elif pa["action"] == "mod_sl":
            try: open_trades[pa["tid"]]["sl_spot"] = float(text.strip()); tg_send(f"✅ SL level updated to {text.strip()}")
            except: tg_send("❌ Invalid level.")
        return

    if text.strip().isdigit() and len(text.strip()) == 6 and not session_active:
        if login_kotak(text.strip()): tg_send(f"✅ <b>Logged into Kotak Neo!</b>\n<b>Mode:</b> {'📝 Paper' if PAPER_MODE else '🔴 Live'}\nReady to trade! /help for all commands.")
        return

    if "PAYLOAD:" in text: return process_trade(text)

    cmd = text.strip().lower()
    if cmd in ("/start", "/help"): tg_send("🤖 <b>Trade2Spend Algo Bot (Full Version)</b>\n━━━━━━━━━━━━━━━━━━\nSend 6-digit TOTP to login.\n\n<b>Commands:</b>\n/status — Open positions\n/pnl — Today's P&L\n/triggers — Active trigger watchers\n/market_on — Start live market data (login first)\n/market_off — Stop live market data\n/market_status — Scraper state + session info\n/paper — Paper mode\n/live — Live mode\n/skip — Skip login\n/cancel — Cancel pending action\n/debug_spot — Raw Kotak API response for spot price\n/stop — Stop bot")
    elif cmd == "/triggers":
        with _tw_lock:
            watchers = dict(_trigger_watchers)
        if not watchers:
            tg_send("👁 No active trigger watchers.\n<i>Watchers start automatically when trade alerts are posted during market hours.</i>")
        else:
            lines = [f"👁 <b>Active Trigger Watchers ({len(watchers)}):</b>\n━━━━━━━━━━━━━━━━━━"]
            for pid, w in watchers.items():
                p = w.parsed
                lines.append(f"• <b>{p['instrument']} {p['strike']} {p['option_type']}</b> @ ₹{p['entry_price']} ({p['expiry']})")
            tg_send('\n'.join(lines))
    elif cmd == "/status": send_status()
    elif cmd == "/pnl": tg_send(f"💰 <b>Today's Summary</b>\n<b>P&L:</b> {'+'if daily_pnl>=0 else ''}₹{daily_pnl:,.0f}\n<b>Orders:</b> {daily_order_count}\n<b>Open:</b> {len([k for k in open_trades if not k.startswith('pending_')])}")
    elif cmd == "/paper": PAPER_MODE = True; tg_send("📝 Paper mode ON. No real orders.")
    elif cmd == "/live":
        if not session_active: tg_send("⚠ Login with TOTP first.")
        else: tg_send("⚠ <b>Switch to LIVE mode?</b>\nReal orders will be placed!", keyboard={"inline_keyboard": [[{"text": "✅ Go LIVE", "callback_data": "confirm_live"}, {"text": "❌ Stay Paper", "callback_data": "stay_paper"}]]})
    elif cmd == "/skip": PAPER_MODE = True; tg_send("📝 Paper mode. Send trades from PWA!")
    elif cmd == "/cancel":
        if chat_id in pending_actions: pending_actions.pop(chat_id); tg_send("❌ Action cancelled.")
        else: tg_send("Nothing to cancel.")
    elif cmd == "/market_on":
        should_start, msg = _market_on_decision(session_active, market_scraper.is_running(), GITHUB_TOKEN)
        if should_start:
            market_scraper.start_scraper(session_data)
        tg_send(msg)
    elif cmd == "/market_off":
        should_stop, msg = _market_off_decision(market_scraper.is_running())
        if should_stop:
            market_scraper.stop_scraper()
        tg_send(msg)
    elif cmd == "/market_status":
        tg_send(_market_status_message(session_active, market_scraper.is_running(), session_data.get("baseUrl", "")))
    elif cmd == "/debug_spot":
        lines = ["🔬 <b>Debug: Kotak spot API</b>\n━━━━━━━━━━━━━━━━━━"]
        lines.append(f"<b>session_active:</b> {session_active}")
        base = session_data.get("baseUrl", "")
        tok  = session_data.get("token", "")
        sid  = session_data.get("sid", "")
        lines.append(f"<b>baseUrl:</b> {base or 'NOT SET'}")
        lines.append(f"<b>token set:</b> {'yes ('+tok[:8]+'...)' if tok else 'no'}")
        lines.append(f"<b>sid set:</b> {'yes' if sid else 'no'}")
        if not base:
            lines.append("\n⚠ No baseUrl — login with TOTP first.")
            lines.append(f"<b>session_data keys:</b> {list(session_data.keys()) or 'empty'}")
            tg_send('\n'.join(lines))
        else:
            tg_send('\n'.join(lines))
            # Try all combos: two symbols × two auth header styles
            combos = [
                ("nse_cm", "26000",   {"Authorization": KOTAK_CONSUMER_KEY, "Content-Type": "application/json"},        "token 26000 + consumer_key auth"),
                ("nse_cm", "Nifty 50",{"Authorization": KOTAK_CONSUMER_KEY, "Content-Type": "application/json"},        "symbol 'Nifty 50' + consumer_key auth"),
            ]
            if tok:
                combos += [
                    ("nse_cm", "26000",   {"Authorization": f"Bearer {tok}", "Sid": sid, "Auth": tok, "Content-Type": "application/json"}, "token 26000 + session bearer"),
                    ("nse_cm", "Nifty 50",{"Authorization": f"Bearer {tok}", "Sid": sid, "Auth": tok, "Content-Type": "application/json"}, "symbol 'Nifty 50' + session bearer"),
                ]
            for exch, sym, hdrs, label in combos:
                url = f"{base}/script-details/1.0/quotes/neosymbol/{exch}|{sym}/ltp"
                out = [f"\n<b>--- {label} ---</b>", f"URL: <code>{url}</code>"]
                try:
                    r = requests.get(url, headers=hdrs, timeout=5)
                    out.append(f"Status: <b>{r.status_code}</b>")
                    body = r.text[:500] if r.text else "(empty body)"
                    out.append(f"Body: <code>{body}</code>")
                except Exception as e:
                    out.append(f"Exception: <code>{e}</code>")
                tg_send('\n'.join(out))
    elif cmd == "/stop":
        tg_send("🛑 Stopping. Goodbye!")
        if update_id is not None:
            fetch_all_updates(update_id + 1)
        os._exit(0)

# ============================================================
# 11. SUPABASE TRIGGER WATCHER
# ============================================================
_trigger_watchers = {}  # post_id → TriggerWatcher
_tw_lock = threading.Lock()

def _sb_headers():
    return {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    }

def sb_get_pending_alerts():
    """Return today's trade_alert posts with no follow-ups."""
    try:
        today = datetime.now(IST).strftime('%Y-%m-%d')
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/posts",
            params={'is_deleted': 'eq.false', 'post_type': 'eq.trade_alert',
                    'parent_id': 'is.null', 'order': 'sent_at.desc', 'limit': '20'},
            headers=_sb_headers(), timeout=10
        )
        if r.status_code != 200 or not r.text:
            return []
        alerts = [a for a in r.json() if today in (a.get('sent_at') or '')]
        if not alerts:
            return []

        ids = ','.join(f'"{a["id"]}"' for a in alerts)
        fu_r = requests.get(
            f"{SUPABASE_URL}/rest/v1/posts",
            params={'is_deleted': 'eq.false', 'parent_id': f'in.({ids})', 'select': 'parent_id'},
            headers=_sb_headers(), timeout=10
        )
        followed = set()
        if fu_r.status_code == 200 and fu_r.text:
            for fu in fu_r.json():
                followed.add(fu.get('parent_id'))
        return [a for a in alerts if a['id'] not in followed]
    except Exception as e:
        print(f"sb_get_pending_alerts error: {e}")
        return []

def sb_post_followup(parent_id, content):
    """POST a follow-up to Supabase posts table."""
    try:
        payload = {
            'content': content, 'post_type': 'follow_up', 'audience': 'all',
            'allow_sharing': False, 'is_deleted': False, 'parent_id': parent_id,
            'sent_at': datetime.now(IST).isoformat()
        }
        r = requests.post(f"{SUPABASE_URL}/rest/v1/posts", json=payload,
                          headers=_sb_headers(), timeout=10)
        return r.status_code in (200, 201)
    except Exception as e:
        print(f"sb_post_followup error: {e}")
        return False

def parse_trade_alert(content):
    """Parse instrument, strike, option_type, entry_price, expiry from post text."""
    text = content.upper()

    instr_m = re.search(r'\b(BANKNIFTY|FINNIFTY|BANKEX|MIDCAP|SENSEX|NIFTY)\b', text)
    instrument = instr_m.group(1) if instr_m else None

    ot_m = re.search(r'\b(CE|PE)\b', text)
    option_type = ot_m.group(1) if ot_m else None

    strike = None
    for s in re.findall(r'\b(\d{4,6})\b', text):
        val = int(s)
        if instrument == 'BANKNIFTY' and 40000 <= val <= 65000:
            strike = val; break
        elif instrument == 'SENSEX' and 55000 <= val <= 95000:
            strike = val; break
        elif instrument in ('NIFTY', 'FINNIFTY', 'MIDCAP', None) and 15000 <= val <= 35000:
            strike = val; break

    entry_m = re.search(
        r'(?:entry|buying|buy)\s*(?:at|@|near|around|price|:)?\s*[₹]?\s*(\d+(?:\.\d+)?)',
        content, re.IGNORECASE
    )
    if not entry_m:
        entry_m = re.search(r'[₹]\s*(\d{2,4}(?:\.\d+)?)', content)
    entry_price = float(entry_m.group(1)) if entry_m else None

    expiry = 'Weekly'
    if 'MONTHLY' in text:
        expiry = 'Monthly'
    elif re.search(r'NEXT\s*WEEK', text):
        expiry = 'Next Weekly'
    date_m = re.search(r'\b(\d{2}[A-Z]{3}\d{4})\b', text)
    if date_m:
        expiry = date_m.group(1)

    return {'instrument': instrument, 'option_type': option_type,
            'strike': strike, 'entry_price': entry_price, 'expiry': expiry}


class TriggerWatcher(threading.Thread):
    def __init__(self, post_id, parsed):
        super().__init__(daemon=True)
        self.post_id = post_id
        self.parsed = parsed
        self.running = True
        self._option_token = None

    def _find_option_token(self):
        if not session_active or not session_data.get('client'):
            return None
        try:
            p = self.parsed
            result = session_data['client'].search_scrip(
                exchange_segment='nse_fo', symbol=p['instrument'],
                expiry=resolve_expiry(p['expiry'], p['instrument']),
                option_type=p['option_type'], strike_price=str(p['strike'])
            )
            data = result if isinstance(result, list) else (result.get('data') if isinstance(result, dict) else None)
            if not data:
                return None
            items = data if isinstance(data, list) else [data]
            item = pick_expiry(items, p['expiry'])
            return item.get('pSymbol', '') if item else None
        except Exception as e:
            print(f"TriggerWatcher._find_option_token error: {e}")
            return None

    def _has_followup(self):
        try:
            r = requests.get(
                f"{SUPABASE_URL}/rest/v1/posts",
                params={'is_deleted': 'eq.false', 'parent_id': f'eq.{self.post_id}',
                        'select': 'id', 'limit': '1'},
                headers=_sb_headers(), timeout=5
            )
            return r.status_code == 200 and bool(r.text) and len(r.json()) > 0
        except:
            return False

    def run(self):
        p = self.parsed
        entry = p['entry_price']
        tolerance = max(5.0, entry * 0.02)
        label = f"{p['instrument']} {p['strike']} {p['option_type']}"
        print(f"TriggerWatcher started: {label} entry=₹{entry}")
        tg_send(
            f"👁 <b>Watching trigger:</b> {label}\n"
            f"<b>Entry target:</b> ₹{entry} (±{tolerance:.0f} tolerance)\n"
            f"<i>Will auto-post follow-up to PWA when LTP hits entry</i>"
        )
        last_followup_check = 0

        while self.running:
            try:
                now = datetime.now(IST)
                if now.hour > 15 or (now.hour == 15 and now.minute >= 30):
                    tg_send(f"⏰ <b>Trigger expired (3:30 PM)</b>\n{label} @ ₹{entry} — not triggered today")
                    break
                if now.hour < 9:
                    time.sleep(60)
                    continue
                if time.time() - last_followup_check > 60:
                    if self._has_followup():
                        print(f"TriggerWatcher: {label} follow-up found externally, stopping")
                        break
                    last_followup_check = time.time()
                if not session_active:
                    time.sleep(30)
                    continue
                if not self._option_token:
                    self._option_token = self._find_option_token()
                    if not self._option_token:
                        time.sleep(30)
                        continue
                ltp = get_market_quote('nse_fo', self._option_token)
                if ltp and ltp > 0:
                    print(f"Trigger check: {label} LTP=₹{ltp:.1f} entry=₹{entry}")
                    if ltp <= entry + tolerance:
                        follow_msg = f"✅ Buying triggered at ₹{ltp:.0f}"
                        if sb_post_followup(self.post_id, follow_msg):
                            tg_send(
                                f"🎯 <b>TRIGGER FIRED!</b>\n{label}\n"
                                f"<b>LTP:</b> ₹{ltp:.1f} (entry ₹{entry})\n"
                                f"<b>Follow-up posted to PWA ✅</b>"
                            )
                        else:
                            tg_send(
                                f"⚠ <b>Trigger fired but Supabase post failed!</b>\n"
                                f"{label} LTP ₹{ltp:.1f}\n"
                                f"Post manually: {follow_msg}"
                            )
                        break
                time.sleep(10)
            except Exception as e:
                print(f"TriggerWatcher {label} error: {e}")
                time.sleep(30)

        with _tw_lock:
            _trigger_watchers.pop(self.post_id, None)


def _trigger_poll_thread():
    """Every 60s during market hours, pick up new untracked trade alerts."""
    time.sleep(30)  # let bot start up first
    while True:
        try:
            now = datetime.now(IST)
            if 9 <= now.hour < 16:
                for alert in sb_get_pending_alerts():
                    post_id = alert['id']
                    with _tw_lock:
                        if post_id in _trigger_watchers:
                            continue
                    parsed = parse_trade_alert(alert.get('content', ''))
                    if not all([parsed['instrument'], parsed['option_type'],
                                parsed['strike'], parsed['entry_price']]):
                        continue
                    w = TriggerWatcher(post_id, parsed)
                    with _tw_lock:
                        _trigger_watchers[post_id] = w
                    w.start()
        except Exception as e:
            print(f"trigger_poll error: {e}")
        time.sleep(60)


# ============================================================
# 10. MAIN LOOP
# ============================================================
def run():
    global PAPER_MODE
    print(f"🤖 Trade2Spend Trading Bot Full Online (Mode: {'PAPER' if PAPER_MODE else 'LIVE'})")
    threading.Thread(target=_refresh_spot_cache, daemon=True).start()
    threading.Thread(target=_daily_reset_thread, daemon=True).start()
    threading.Thread(target=_trigger_poll_thread, daemon=True).start()
    print("✅ Background threads started")
    
    tg_send("🤖 <b>Trade2Spend Bot Full Online</b>\n" f"<b>Mode:</b> {'📝 Paper' if PAPER_MODE else '🔴 Live'}\n\n" "Send TOTP to login or /skip for Paper mode.\n/help for all commands.")

    old, offset = fetch_all_updates(), None
    if old:
        print(f"Processing {len(old)} pending messages on startup...")
        for update in old:
            offset = update["update_id"] + 1
            try:
                if "message" in update: handle_message(update["message"], update["update_id"])
                fetch_all_updates(offset)   # acknowledge to Telegram after successful processing
            except Exception as e:
                print(f"Startup drain error (update {update['update_id']}): {e}")

    last_summary_day = -1
    while True:
        try:
            now = datetime.now(IST)
            if now.hour == 15 and now.minute >= 35 and last_summary_day != now.day:
                count = len([k for k in open_trades if not k.startswith("pending_")])
                tg_send(f"📊 <b>DAILY SUMMARY</b>\n<b>Orders:</b> {daily_order_count}\n<b>Open:</b> {count}\n<b>P&L:</b> {'+'if daily_pnl>=0 else ''}₹{daily_pnl:,.0f}\n<i>Market closed. See you tomorrow!</i>")
                last_summary_day = now.day

            updates = fetch_all_updates(offset)
            for update in updates:
                offset = update["update_id"] + 1
                if "callback_query" in update: handle_callback(update["callback_query"])
                elif "message" in update: handle_message(update["message"], update["update_id"])
                fetch_all_updates(offset)   # acknowledge to Telegram immediately after processing
            time.sleep(0.3)
        except KeyboardInterrupt:
            print("\n🛑 Stopped."); tg_send("🛑 Bot stopped."); break
        except Exception as e:
            print(f"Loop error: {e}"); time.sleep(3)

if __name__ == "__main__":
    run()
