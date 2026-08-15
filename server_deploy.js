// DEPLOY: T2S-PROD-20260815-002 | server.js: Push notification dedup + tier-aware content. (1) postId-based persistent dedup (_pushSentMap + .push_sent.json) — each postId pushed exactly once, survives VM restarts; body dedup kept as fallback when no postId. (2) Per-member dedup removed — all subscribed devices receive notification (previously only 1 device per member, causing missed notifications). (3) Tier-aware body — paid members see full message, free members see reference only (e.g. "📊 Trade Alert — Open app to view"). (4) Disabled members skipped. (5) Unique tag per post (t2s-post-{postId}) so multiple posts don't collapse each other. Rollback: remove _pushSentMap/PUSH_SENT_FILE/savePushSent block; revert /send-push endpoint to previous version (see T2S-PROD-20260715-009 rollback notes).
// DEPLOY: T2S-PROD-20260805-001 | server.js: GET / response now includes kotakLtpRunning field — Admin PWA dot logic reads this to show green when LTP poll is active, even if session age check reports loggedIn:false. One new field added to GET / JSON response. No other endpoint, logic, or calculation touched. Rollback: remove kotakLtpRunning line from GET / res.end() block.
// DEPLOY: T2S-PROD-20260731-001 | server.js: Phone emergency commands — /pwa and /reset-high. (1) /pwa: clean PWA health snapshot via Telegram — shows scraper status, Kotak session, all tracked contracts with live CMP, session high/low, and LTP age (⚠️ if stale >30s). Zero new data sources — reads _activeContracts, _optionChain, _optionHighs, _optionLows, _optionChainTs, _marketScraperInterval. (2) /reset-high NIFTY 24250 PE: resets _optionHighs[key] and _optionLows[key] for a specific contract from Telegram, preserves postId, calls saveState(). Returns usage hint on bad input. Both commands are purely additive — no existing command modified. Rollback: remove the /pwa block (lines 2809–2838) and /reset-high block (lines 2840–2857) from handleMessage().
// DEPLOY: T2S-PROD-20260730-003 | server.js: Trade identity engine — permanent fix for session high/low bleeding across trades with the same strike. (1) refreshActiveContracts(): postId-change detection — when a new trade is posted for the same instrument-strike-type key, _optionHighs[key] and _optionLows[key] are reset to zero; the null guard means server restarts (where postId is null from state.json restore) do NOT trigger spurious resets. (2) _latestMarketData snapshot: optionHighsPostIds added — member PWA now receives {liveCmpKey → postId} map alongside optionHighs, enabling client-side postId gating. Rollback: remove the RC-1 FIX block in refreshActiveContracts (12 lines); remove optionHighsPostIds line from _latestMarketData snapshot.
// DEPLOY: T2S-PROD-20260729-001 | server.js: [CLOSEPRICE:X] permanent fix — (1) fetchKotakOptionLTPs() now stores last:ltp on _optionHighs[key] alongside high (tracks most-recent option LTP, not just session peak); (2) saveOptionHighsToSupabase() now posts [CLOSEPRICE:last] for every active contract at 3:35 PM — member PWA uses this as exit price for remaining qty when no explicit exit follow-up was posted; safe to post even on fully-exited trades (PWA only uses it for remaining un-exited qty). Rollback: remove last:ltp from _optionHighs assignment; remove the [CLOSEPRICE:X] posting loop in saveOptionHighsToSupabase.
// DEPLOY: T2S-PROD-20260727-001 | server.js: Wrong-contract CMP fix (root cause: unordered Supabase query + stale scrip master on expiry day). Fix 1: refreshActiveContracts() query now adds &order=sent_at.desc so newest post wins the dedup (was undefined order — oldest post, possibly expired, won first). Fix 2: resolved expiry is validated against today's IST date — if in the past, contract is skipped with a warning (prevents tracking expired contracts even if dedup fails). Fix 3: staleness detection now also triggers scrip master re-download (was only refreshing contracts — useless if the token map has yesterday's expired contract tokens). Fix 4: scheduleExpiryDayRefresh() added — fires every Tuesday at 9:10 AM IST to pre-download fresh scrip master before market open (prevents stale token issue when trade posted before TOTP login). Rollback: remove &order=sent_at.desc from query, remove expiry past-check block, remove _scripMasterTs=0 line in staleness handler, remove scheduleExpiryDayRefresh function and its call.
// DEPLOY: T2S-PROD-20260722-001 | server.js: LTP staleness detection + auto-recovery — added _optionChainTs{} var tracking last-good-fetch timestamp per contract key; inside fetchKotakOptionLTPs() if(ltp>0) block now stamps _optionChainTs[key]=Date.now(); post-loop staleness check: if any active contract's timestamp missing or >2min old, resets _activeContractsTs=0 and calls refreshActiveContracts() for self-recovery within one 5s tick; _ltpZeroSince alert now treats stale-but-non-empty as effectively dry (separate reason logged). Rollback: remove _optionChainTs var, remove _optionChainTs[key]=Date.now() stamp, remove staleness detection block (lines 1450-1468), revert _effectivelyDry logic in alert block.
// DEPLOY: T2S-PROD-20260721-001 | server.js: Session LOW tracking for SELL trades — added _optionLows var; refreshActiveContracts() now parses action (BUY/SELL) from post content; fetchKotakOptionLTPs() tracks low alongside high for all contracts; saveOptionHighsToSupabase() now also posts [LOW:X] follow-up for SELL contracts at 3:35 PM; loginKotak() resets _optionLows on new day; saveState()/loadState() persist/restore lows same as highs. Rollback: remove _optionLows var, remove action parse in refreshActiveContracts, remove low tracking block in fetchKotakOptionLTPs, revert saveOptionHighsToSupabase to single highs loop, revert loginKotak reset, revert saveState/loadState.
// DEPLOY: T2S-PROD-20260720-005 | server.js: Scraper 9:15 false alarm fix — _scraperRanTodayIST tracks first start of day. Periodic check now sends calm ✅ message on normal 9:15 start instead of ⚠️ alarm (which was designed for mid-session crashes only). Mid-session unexpected stop still sends ⚠️. Rollback: remove _scraperRanTodayIST var + stamp in startMarketScraper, revert periodic check if/else-if block back to single if(!_scraperStopAlerted) block.
// DEPLOY: T2S-PROD-20260720-004 | server.js: Static index prices fix — Fix 1: fetchKotakIndexLTP() parsing now handles d.data as plain object (gw-napi returns object for spot indices, array for options — old code fell back to d as item, d.ltp=undefined → null → freeze). Fix 2: runMarketScraper() lastUpdated now reflects _lastRealPriceTs (last cycle with ≥1 live price) not Date.now() — makes PWA 5-min ⚠ stale warning accurate when all sources fail. Added STALE log line when falling back to cached values. Rollback: remove _lastRealPriceTs var, revert fetchKotakIndexLTP item line to original Array.isArray ternary, revert lastUpdated to new Date().toISOString(), revert console.log.
// DEPLOY: T2S-PROD-20260720-001 | server.js: CMP wrong value fix — Fix 1: refreshActiveContracts() dedup now ignores expiry (was per-expiry, caused same strike/type with different expiry labels to both enter _activeContracts → loop wrote wrong contract's LTP under correct key). Fix 2: _latestMarketData.optionLTPs snapshot moved to after the for...of loop in fetchKotakOptionLTPs() (was inside loop → partial poisoned snapshots served mid-cycle). Rollback: revert dedup line to include &&c.expiry===expiry, move optionLTPs/optionHighs snapshot back inside if(ltp>0) block.
// DEPLOY: T2S-PROD-20260715-009 | server.js: per-member dedup in /send-push — max 1 notification per member_id (keeps most-recently-used subscription). Both CUG and broadcast queries now fetch member_id+order by last_used.desc. Rollback: remove _seenMembers/_finalSubs block, change _finalSubs.map back to _dedupedSubs.map, revert select queries to not include member_id.
// DEPLOY: T2S-CUG-20260716-001 | server.js: /refresh-contracts endpoint added — bypasses 60s throttle so new trade CMP starts immediately. Rollback: remove the /refresh-contracts block.
// DEPLOY: T2S-PROD-20260715-008 | server.js: CUG push URL changed to uat.html#updates (was index.html#updates — wrong PWA for CUG testing). Rollback: revert url override line.
// DEPLOY: T2S-PROD-20260715-007 | server.js: endpoint dedup in /send-push — before sending, filter subs to unique endpoints only. Prevents multiple pushes when same device has registered multiple subscription rows in DB. Applies to both CUG and broadcast paths. Rollback: remove the _seenEps dedup block and change _dedupedSubs back to subs.
// DEPLOY: T2S-PROD-20260715-006 | server.js: CUG mobile lookup — encode + as %2B in Supabase URL (+ in query string = space, caused 0 CUG members found → no push sent). Rollback: revert .replace(/\+/g,'%2B') to .join(',').
// DEPLOY: T2S-PROD-20260715-003 | server.js: CUG routing — /send-push now routes audience=cug_test posts only to CUG_MOBILES devices. CUG_MOBILES=['+918888888888']. All other audiences unchanged. Rollback: remove CUG_MOBILES constant + cug_test branch in /send-push.
// DEPLOY: T2S-PROD-20260714-007 | server.js: dummy likes made organic — 25% posts get 0 likes, 1–6 likes when fired (skewed towards 1–3 via random×random), first like 1–20 min after post, each subsequent 1–15 min apart. No fixed window, no predictable count.
// DEPLOY: T2S-PROD-20260714-004 | server.js: POST /schedule-dummy-likes?key=T2SMonitor2026 — accepts {postId}, schedules 5-8 staggered setTimeout PATCHes to posts.dummy_likes over 3-45 min. Zero impact on existing routes. Rollback: remove the /schedule-dummy-likes block (lines after /set-high endpoint).
// DEPLOY: T2S-PROD-20260708-003 | server.js: Telegram notification storm fix — removed tgAlert from isSessionValid() (was firing every 5s on expired session), removed self-resetting guard, reset guard on fresh TOTP login
// DEPLOY: T2S-PROD-20260708-004 | server.js: CMP fix — active contracts window 3→7 days (was missing Jul 1-5 trades); LTP HTTP errors now logged (were silent); added /test-cmp (dummy LTP endpoint for UAT testing) and /test-ltp (live Kotak LTP diagnostic per contract)
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
import { redactPostForFreeMember } from '../stability_harness/src/redactor.js';
import { formatOptionPrice } from '../stability_harness/src/pricing/foMath.js';
import { createAtomicWriter } from '../stability_harness/src/state/atomicWriter.js';
import { createMutex }       from '../stability_harness/src/async/mutex.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE   = path.join(__dirname, 'state.json');
const _stateWriter = createAtomicWriter(STATE_FILE);
const HOLIDAY_FILE = path.join(__dirname, '.holiday_state.json');
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
const GH_TOKEN       = process.env.GH_TOKEN || '';
const GH_REPO        = process.env.GH_REPO  || 'Trade2spend/Trade2Spend-Tracker';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY || '';
const GEMINI_KEY     = process.env.GEMINI_KEY     || '';
const GROQ_KEY       = process.env.GROQ_KEY       || '';

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn('WARNING: TELEGRAM_TOKEN or TELEGRAM_CHAT_ID not set — Telegram notifications disabled, server starting anyway');
} else {
  console.log(`Starting with CHAT_ID=${CHAT_ID}, token=${BOT_TOKEN.slice(0,8)}...`);
}

// ── KNOWLEDGE HUB ─────────────────────────────────────────────────────────────
const _khRate = new Map();       // IP → { count, reset }
const _khMemberRate  = new Map(); // memberId → { count, windowStart }
const _khMemberTiers = new Map(); // memberId → { tier, ts } (1-hour cache)

async function khGetMemberTier(memberId) {
  const CACHE_MS = 60 * 60 * 1000;
  const cached = _khMemberTiers.get(memberId);
  if (cached && (Date.now() - cached.ts < CACHE_MS)) return cached.tier;
  try {
    const rows = await sbFetch(`members?id=eq.${memberId}&select=tier,is_admin`, { method: 'GET' });
    const tier = rows?.[0]?.is_admin ? 'admin' : (rows?.[0]?.tier || 'free');
    _khMemberTiers.set(memberId, { tier, ts: Date.now() });
    return tier;
  } catch(e) { return 'free'; }
}

const KH_OUT_OF_SCOPE = '📘 **Answer**\nI only answer questions about the Indian stock market — topics like Nifty, Sensex, CE/PE options, SIP, mutual funds, stop loss, and investing concepts.\n\nTry asking: "What is a Stop Loss?" or "How does SIP work?" 📈';

function khIsFinanceQuery(q) {
  const s = q.toLowerCase().replace(/['"]/g, '');
  const longTerms = [
    'stock', 'share', 'nifty', 'sensex', 'banknifty', 'bankex', 'equity',
    'demat', 'broker', 'mutual fund', 'portfolio', 'dividend', 'intraday',
    'candlestick', 'volatility', 'technical analysis', 'fundamental',
    'zerodha', 'upstox', 'groww', 'fyers', 'ltcg', 'stcg',
    'midcap', 'smallcap', 'largecap', 'bluechip', 'index fund',
    'open interest', 'stop loss', 'lot size', 'market cap', 'strike price',
    'option chain', 'option premium', 'expiry date', 'expiry',
    'trading', 'investing', 'invest', 'trader', 'investor'
  ];
  if (longTerms.some(t => s.includes(t))) return true;
  const shortTerms = ['pe', 'ce', 'sl', 'nse', 'bse', 'oi', 'atm', 'otm', 'itm',
                      'vix', 'pcr', 'sip', 'ipo', 'etf', 'sebi', 'hedge',
                      'option', 'futures', 'swing', 'index', 'sector'];
  return shortTerms.some(t => new RegExp('\\b' + t + '\\b').test(s));
}

const KNOWLEDGE_PROMPT = `You are the Trade2Spend Knowledge Assistant. You explain Indian stock market concepts to complete beginners.

TARGET READER: A 12-year-old who has never invested before. Assume zero prior knowledge of finance, markets, or trading.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNIVERSAL CLARITY RULES — apply to EVERY question, every topic, every section
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RULE 1 — SHORT SENTENCES
Every sentence = maximum 15 words. If longer, split into two sentences.
One idea per sentence. Never join two ideas with "and then" or "and also".

RULE 2 — EXPLAIN WHAT YOU DO, NOT WHAT IT IS
For any strategy or concept, explain the STEPS the person takes — not a vague definition.
Ask yourself: "What does the trader actually DO? In what order? With what quantity?"
Write THAT — not the textbook definition.

Example (WRONG — incomplete and vague):
  "A Covered Call is selling a Call Option (CE)."
  → WRONG because it misses Step 1. A Covered Call is NOT just selling a CE. It has two parts.

Example (RIGHT — complete and precise):
  • A Covered Call is a way to earn extra money from shares you already own.
  • [[Call Option (CE)]]: when you sell a CE, the buyer pays you the Premium on that same day; they can then buy your shares at the Strike Price anytime before Expiry if they want to.
  • Step 1: Buy shares of an [[F&O segment]] stock — equal to 1 [[Lot Size]] or multiples of it (e.g. 75 Reliance shares at ₹2,800).
  • Step 2: Sell 1 CE of the same stock at ATM or just [[OTM (Out of The Money)]] [[Strike Price]] — e.g. ₹3,000 when Reliance is at ₹2,800.
  • The buyer pays you a [[Premium]] on the day you sell — e.g. ₹50 per share × 75 shares = ₹3,750 total. That fee is yours no matter what happens next.
  • Like earning rent from shares you already own.

CRITICAL for quantities: NEVER say "a certain number of shares". ALWAYS say "1 Lot Size" or "multiples of the Lot Size" with the example quantity.
CRITICAL for Step 2 (CE sell): ALWAYS specify ATM or just OTM — never just say "a Strike Price above current price".
Apply this same structure to every multi-step strategy: define key terms first, then numbered steps with exact quantities and constraints.

RULE 3 — CONCRETE ACTIONS, NOT ABSTRACT WORDS
Never use abstract finance language. Replace with what actually happens.
  ✗ "sell a promise/right/contract" → ✓ "sell a Call Option (CE) at ₹X strike. They pay you ₹Y upfront."
  ✗ "exercise the option" → ✓ "the buyer buys your shares at ₹X"
  ✗ "option expires worthless" → ✓ "the buyer walks away. The deal ends. You keep the fee."
  ✗ "miss out on upside/profit" → ✓ "You sell at ₹X + keep ₹Y fee. Total: ₹Z."
  ✗ "underlying asset" → ✓ "the shares you own"
  ✗ "hedge your position" → ✓ "protect yourself if the price falls"
  ✗ "bullish/bearish" → ✓ "you expect the price to go up / go down"
  ✗ "Out of The Money (OTM)" — first time only: "OTM (a strike price higher than where the stock trades now)"
  ✗ "the agreed price" → ✓ always write the actual ₹ number

RULE 4 — ALWAYS SHOW EXACT ₹ NUMBERS
In every scenario, state the exact rupee amount received, lost, or kept.
Good: "You keep ₹3,750. Your shares are still worth ₹2,10,000."
Bad: "You keep the premium and still own the shares."

RULE 5 — MENTION REQUIREMENTS AND CONSTRAINTS
If a strategy has eligibility rules, mention them clearly.
Examples: "Only for F&O stocks", "Requires margin", "Minimum 1 lot size", "Only in derivatives segment"

RULE 6 — INTRODUCE EVERY TERM WITH ITS PLAIN MEANING — NO EXCEPTIONS
The FIRST time any financial term appears, write it with its plain meaning in brackets immediately after.
Wrap it in [[double brackets]] the FIRST time only — this makes it a clickable link in the app.
After the first introduction, use the short form freely.
NEVER wrap the main topic being explained (e.g. never [[Covered Call]] when explaining Covered Call).

IMPORTANT: If a term's definition is long (more than 8 words), introduce it as its OWN separate bullet BEFORE the step that uses it.
Do NOT put a long definition inside a step sentence — it makes the step unreadable.
Example (WRONG): "Step 2: Sell 1 [[Call Option (CE)]] (when you sell a CE, the buyer pays you the Premium on that same day; they can then buy your shares at the Strike Price anytime before Expiry if they want to) at ₹3,000."
Example (RIGHT):
  "• [[Call Option (CE)]]: when you sell a CE, the buyer pays you the Premium on that same day; they can then buy your shares at the Strike Price anytime before Expiry if they want to.
   • Step 2: Sell 1 CE at ATM or just OTM Strike Price — e.g. ₹3,000."

Use EXACTLY these explanations for common terms:

[[Call Option (CE)]] → (when you sell a CE, the buyer pays you the Premium on that same day; in return, they can buy your shares at the Strike Price anytime before the Expiry date if they want to)
[[Put Option (PE)]] → (when you sell a PE, the buyer pays you the Premium on that same day; in return, they can sell their shares to you at the Strike Price anytime before the Expiry date if they want to)
[[Strike Price]] → (the fixed price at which the shares will be bought or sold — e.g. ₹3,000 when Reliance currently trades at ₹2,800)
[[Premium]] → (the fee the buyer pays you upfront — e.g. ₹50 per share × 75 shares = ₹3,750 received by you on day one)
[[Lot Size]] → (the minimum number of shares required for one trade — e.g. 75 shares for Reliance, 50 for Nifty)
[[ATM (At The Money)]] → (a Strike Price equal to or very close to the current market price)
[[OTM (Out of The Money)]] → (a Strike Price set above the current market price for CE, or below for PE — e.g. ₹3,000 strike when stock is at ₹2,800)
[[Expiry]] → (the date the agreement ends — if the buyer does not act, it simply expires and you keep the fee)
[[Open Interest]] → (total number of active option agreements in the market right now)
[[Stop Loss]] → (a price level where you exit a trade to limit how much you can lose)
[[F&O segment]] → (Futures & Options — a part of the stock market for options trading; only selected stocks qualify)

For any term NOT listed above: create a similar plain-language bracket explanation on first use.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCOPE — STRICTLY STOCK MARKET ONLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You ONLY answer questions about:
- Indian stock market (NSE, BSE, F&O, equity, indices)
- Trading concepts (options, futures, technical analysis, order types)
- Investing concepts (mutual funds, SIP, portfolio, risk)
- Personal finance directly related to investing (tax on trading, demat account)

If the question is about ANYTHING ELSE — food, travel, shopping, general knowledge, technology, relationships, etc. — respond with ONLY this message and nothing else:
"I can only answer questions about the Indian stock market and investing. Please ask something related to stocks, options, trading, or investing. 📈"

Do not attempt to answer off-topic questions even partially.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT NEVER TO DO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Recommend buying or selling anything specific
- Suggest entry price, stop loss level, or target price
- Recommend any broker, bank, or platform
- Predict market direction or promise returns

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXAMPLES (shown under 🌍 Example section)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- For options/F&O strategies: use Indian STOCK examples — "You own 75 Reliance shares (1 lot) at ₹2,800..."
- For general finance concepts: use everyday Indian life — cricket, petrol, rent, salary, grocery
- Numbers must be simple and round (₹50, ₹500, ₹2,800)
- NEVER use gambling, lottery, or crypto

For OPTIONS STRATEGIES specifically — always cover all three outcomes:
• 📈 If price goes UP to ₹X — what happens, with exact ₹ amounts
• 📉 If price goes DOWN to ₹X — what happens, with exact ₹ amounts
• ➡️ If price stays FLAT at ₹X — what happens, with exact ₹ amounts
Each scenario = its own bullet. Never combine two scenarios in one sentence.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — same structure every time
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every section uses bullet points (•). One short sentence per bullet. No paragraphs.

📘 Answer
• What it is — one sentence, simplest possible words
• [If the strategy uses jargon in the steps: define those terms here as separate bullets BEFORE the steps]
• Step 1: [concrete action — exact quantity, e.g. "1 Lot Size (75 Reliance shares)"]
• Step 2: [concrete action — for CE sell: always say ATM or just OTM Strike Price]
• [Step 3 if needed]
• [One analogy — only if genuinely helpful, e.g. "Like earning rent from shares you already own"]
For simple concepts with no steps, just use plain explanation bullets — no "Step 1/2" needed.

🌍 Example
• Setup: who has what, at what price, and what they do — one sentence
• 📈 If price goes UP to ₹X: [exact action + exact ₹ outcome]
• 📉 If price goes DOWN to ₹X: [exact action + exact ₹ outcome]
• ➡️ If price stays FLAT at ₹X: [exact action + exact ₹ outcome]

💡 Why It Matters
• Point 1
• Point 2
• Point 3

⚠ Common Mistake
• The one thing beginners most often get wrong

🎯 Quick Takeaway
• One sentence. The simplest possible summary.

🔗 Related Topics
• [[Topic 1]]
• [[Topic 2]]
• [[Topic 3]]
• [[Topic 4]]`;

const CHART_ANALYSIS_PROMPT = `You are a technical chart analyst for Trade2Spend, an Indian options trading education community. When a user uploads a 15-minute candlestick chart screenshot, analyse it using the strategy rules below and respond in the EXACT Section 8 format at the end. Never skip a section. Never add extra sections. If a signal is not visible in the screenshot, write "Not visible" for that line.

EDUCATIONAL PURPOSE ONLY — This analysis is for educational purposes. Do not use imperative language like "buy" or "sell". Frame as "trade setup" and "educational observation".

── PRIMARY SIGNALS (Both required for trade) ──

EMA Cross (9/21):
- Bullish cross: 9 EMA crosses ABOVE 21 EMA on a closed 15-min candle
- Bearish cross: 9 EMA crosses BELOW 21 EMA on a closed 15-min candle
- Only assess on confirmed candle close — never mid-candle
- If ADX < 20 (ranging market): auto-downgrade any cross to Tier 2

RSI (14 period):
- Bullish confirmation: RSI closes ABOVE 60
- Bearish confirmation: RSI closes BELOW 40
- RSI 40–60 = Neutral: reduces tier automatically
- Note RSI divergence: price lower-low but RSI higher-low = bullish divergence; price higher-high but RSI lower-high = bearish divergence (report even if RSI hasn't crossed 60/40)

── FLEXIBLE SIGNALS (Preferred, not mandatory) ──

Range Breakout:
- First 15-min candle (9:15–9:30) sets the opening range high/low
- Bullish: price closes ABOVE first candle high
- Bearish: price closes BELOW first candle low
- Missing = downgrade one tier

Volume (20-period SMA):
- Entry candle volume must be ABOVE 20-period SMA line
- Volume spike (2× or more above SMA) = upgrade signal strength
- If volume bars not visible in screenshot: write "Not visible" — do not penalise tier

Bollinger Bands (20, 2):
- Squeeze (bands tight/converging): Do not enter Tier 1, wait for expansion
- Expansion (bands widening): confirms breakout is genuine
- Price closing outside upper band with bearish EMA cross = strong bearish signal
- Price closing outside lower band with bullish EMA cross = strong bullish signal
- BB squeeze with EMA cross = reduce to Tier 2 or wait one candle for expansion confirmation
- Not visible: mark "Not visible"

VWAP:
- Buy CALLs only when price is ABOVE VWAP
- Buy PUTs only when price is BELOW VWAP
- Price at VWAP with EMA cross: Wait one candle for confirmation
- Price above VWAP + bullish EMA cross = Tier 1 eligible
- Price below VWAP + bullish EMA cross = Maximum Tier 2
- Price below VWAP + bearish EMA cross = Tier 1 eligible
- Price above VWAP + bearish EMA cross = Maximum Tier 2
- VWAP not visible: mark "Not visible" and assess remaining signals

── TIER SYSTEM ──

Tier 1 — High Conviction: Both primary signals confirmed + minimum 2 flexible signals + VWAP aligned → Mandatory 100-point OTM spread hedge
Tier 2 — Good Conviction: Both primary signals confirmed + minimum 1 flexible signal → Mandatory spread
Tier 3 — Speculative: Only 1 primary signal + other signals present → Mandatory spread + flag speculative
NO TRADE: Neither primary signal present regardless of other signals

── CANDLESTICK PATTERNS (Always check — report all visible, even if NO TRADE) ──

Report entry, SL, and target for each pattern spotted:
Reversal: Bullish Engulfing, Bearish Engulfing, Hammer (long lower wick at support), Inverted Hammer (long upper wick at support), Shooting Star (long upper wick at resistance), Hanging Man (long lower wick at resistance after uptrend), Doji, Dragonfly Doji, Gravestone Doji, Morning Star (3-candle), Evening Star (3-candle), Piercing Line, Dark Cloud Cover, Tweezer Top, Tweezer Bottom, Harami Bullish, Harami Bearish
Continuation: Three White Soldiers, Three Black Crows, Inside Bar, Rising Three Methods, Falling Three Methods

── CHART PATTERNS (Report if visible) ──

Support/Resistance levels (previous day high/low, swing highs/lows, round numbers), Trend analysis (HH+HL = uptrend, LH+LL = downtrend, horizontal = range), RSI divergence, Double top/bottom, Head & Shoulders, Triangles, Flags, Wedges

── ENTRY EXECUTION (for Tier 1/2/3) ──

Step 1: Buy ATM call (bullish) or ATM put (bearish)
Step 2: Wait for 3-point adverse move in the bought option
Step 3: Sell OTM hedge 100 points away (Bull Call Spread or Bear Put Spread)
Target: 15–20 points net on spread | SL: Spot sustains key level for one full 15-min candle close
Time stop: Exit all by 3:00 PM IST. No new entries after 2:30 PM. Expiry day: no entries after 2:00 PM

── AVOID TRADING WHEN ──
BB in squeeze with weak signals, ADX below 20 (ranging), First candle range > 80 points, VIX above 20, Major news event within 30 minutes

── RESPONSE FORMAT ──

Keep total response under 15 lines. No headers. No sections. No jargon. Write so a 12-year-old understands instantly.

LINE 1 — verdict only, start with one of these exact words:
GO — Buy [CE or PE]: [one short reason, under 8 words]
WAIT: [one short reason, under 8 words]
NO TRADE: [one short reason, under 8 words]

LINES 2–4 — exactly 2 or 3 bullet points starting with •, each under 8 words:
• [what the main signal is showing]
• [what confirms or what is missing]
• [third point only if truly important]

IF GO — next 4 lines, trade setup:
Buy: [ATM strike] [CE/PE]
Hedge: [strike 100 points OTM] [CE/PE]
Enter: [plain English entry condition]
SL: [plain English cut-loss condition]

ALWAYS — exactly 1 line for key prices:
Levels: Support [price] · Resistance [price]

IF a candlestick pattern is clearly visible — 1 line only:
Pattern: [name] · [Bullish/Bearish]

Stop. Do not write anything else. No summary. No disclaimer. No extra lines.`;

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
// gw-napi returns 502 — mis.kotaksecurities.com handles scrip-master + LTP correctly
const DATA_URL           = 'https://mis.kotaksecurities.com';
const LOT_SIZES          = { NIFTY: 65, BANKNIFTY: 15, SENSEX: 20 }; // fallback — overridden by Kotak scrip master
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
const VAPID_PUB  = 'BMVcAP6cf_uh6aCRXruTXZsnFdraj6fI7mRjPWLjhVPGkdGYTGYqxpyipQC0kNfZqVRJ79UOybp4whv-QSlQkxA';
const VAPID_PRIV = 'McOnJkFaCJ2hZ76hBzEcuX8kGlvfHEMgN6hUUhW6alU';
const CUG_MOBILES = ['+918888888888']; // T2S-PROD-20260715-003: CUG test numbers — only these devices get audience=cug_test push notifications

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
let _marketHoliday       = false; // manual holiday override — set via /market-holiday endpoint
let _kotakLotSizes       = {};    // lot sizes extracted from Kotak scrip master — keyed by instrument (NIFTY/BANKNIFTY/SENSEX)
let _optionChain         = {}; // key: "NIFTY-23900-PE" → LTP (Kotak primary, NSE fallback)
let _bseDownloadLog      = []; // last BSE scrip master download attempt results
let _scripMaster         = {}; // key: "NIFTY-23900-PE-19JUN2025" → numeric token string
let _scripMasterTs       = 0;  // last successful scrip master download (with current data)
let _scripMasterAttemptTs = 0; // last attempt — rate-limits retries to 10 min when stale
let _expiryDates         = {}; // { NIFTY:{current,next,monthly}, BANKNIFTY:{...}, ... } from scrip master
let _activeContracts     = []; // [{instrument,strike,type,expiry,postId}] parsed from Supabase
let _activeContractsTs   = 0;  // last Supabase refresh timestamp
const _contractsMutex    = createMutex(); // prevents parallel refreshActiveContracts() executions
let _optionHighs         = {}; // key → { high: number, postId: string } — max LTP since session start
let _optionLows          = {}; // key → { low: number, postId: string, action: string } — min LTP since session start (for SELL trades)
let _highPostedToday     = false; // guard: post [HIGH:X] follow-up only once per close
let _kotakLtpInterval    = null; // 5-second Kotak LTP fetch interval
let _sbAlertDate         = null; // date string of last daily reset for SL alerts
let _sbSlAlertedToday    = new Set(); // post IDs where SL auto-follow-up already posted today
let _sbTrigAlertDate     = null;
let _sbTrigAlertedToday  = new Set(); // post IDs where trigger auto-follow-up already posted today
let _resolveAlertSentDate = null; // date string when 3:20 PM resolve alert was sent
let _scraperStopAlerted  = false; // prevents repeat Telegram alerts for scraper-stopped-during-market-hours
let _sessionExpiryWarned = false; // prevents repeat Telegram alerts for session near expiry
let _morningCheckDone    = null; // date string when morning health check was sent today
let _pendingBugFixes     = {};   // uuid → { file, find, replace, summary } awaiting Telegram approval
let _ltpZeroSince        = 0;    // timestamp when optionLTPs first went empty during market hours
let _ltpConsecFailures   = 0;    // consecutive network failures on current LTP URL — triggers failover to backup
let _optionChainTs       = {};   // key → Date.now() of last successful LTP fetch — staleness detection
let _lastPushBody        = '';   // dedup guard: body of last broadcast push sent (fallback when no postId)
let _lastPushTs          = 0;    // dedup guard: timestamp of last broadcast push sent
// postId-based push dedup — persisted to disk so VM restarts don't reset it
const PUSH_SENT_FILE = path.join(__dirname, '.push_sent.json');
const _pushSentMap   = new Map(); // postId → timestamp (ms)
function loadPushSent() {
  try {
    const raw = JSON.parse(fs.readFileSync(PUSH_SENT_FILE, 'utf8'));
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [id, ts] of Object.entries(raw)) {
      if (ts > cutoff) _pushSentMap.set(id, ts);
    }
    console.log(`[push-dedup] Loaded ${_pushSentMap.size} sent postIds from disk`);
  } catch {}
}
function savePushSent() {
  try { fs.writeFileSync(PUSH_SENT_FILE, JSON.stringify(Object.fromEntries(_pushSentMap))); } catch {}
}
let _lastRealPriceTs     = 0;    // timestamp of last cycle where ≥1 index price came from a live source (not cache fallback)
let _scraperRanTodayIST  = null; // IST date string of first scraper start today — distinguishes normal 9:15 start from mid-session crash

function loadHolidayState() {
  try {
    const d = JSON.parse(fs.readFileSync(HOLIDAY_FILE, 'utf8'));
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    if (d.date === ist.toDateString()) { _marketHoliday = !!d.holiday; console.log(`[holiday] Restored: ${_marketHoliday}`); }
  } catch {}
}

function saveHolidayState() {
  try {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    fs.writeFileSync(HOLIDAY_FILE, JSON.stringify({ date: ist.toDateString(), holiday: _marketHoliday }));
  } catch {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.session) session = { ...session, ...data.session };
      session.baseUrl = 'https://gw-napi.kotaksecurities.com'; // gw-napi is the working LTP endpoint (mis.kotaksecurities.com broken)
      if (data.state)   state   = { ...state,   ...data.state };
      // Restore intraday option highs — only if from same IST trading day
      if (data.optionHighs && data.optionHighsDate) {
        const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toDateString();
        if (data.optionHighsDate === todayIST) {
          Object.entries(data.optionHighs).forEach(([k,v]) => {
            // RC-4 FIX: old format = plain number (no postId); new format = { high, last, postId }
            if (typeof v === 'number') {
              _optionHighs[k] = { high: v, last: 0, postId: null };
            } else {
              _optionHighs[k] = { high: v.high || 0, last: v.last || 0, postId: v.postId || null };
            }
          });
          console.log(`Restored ${Object.keys(_optionHighs).length} option highs from state`);
        }
      }
      // Restore intraday option lows — only if from same IST trading day
      if (data.optionLows && data.optionLowsDate) {
        const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toDateString();
        if (data.optionLowsDate === todayIST) {
          Object.entries(data.optionLows).forEach(([k,v]) => {
            _optionLows[k] = { low: v.low, postId: v.postId || null, action: v.action || 'BUY' }; // RC-4 FIX: restore postId
          });
          console.log(`Restored ${Object.keys(_optionLows).length} option lows from state`);
        }
      }
      console.log(`State loaded: ${Object.keys(state.trades).length} trades`);
    }
  } catch (e) { console.error('loadState error:', e.message); }
}

async function saveState() {
  try {
    const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toDateString();
    const highsSnap = Object.fromEntries(Object.entries(_optionHighs).map(([k,v]) => [k, { high: v.high, last: v.last || 0, postId: v.postId || null }])); // RC-4 FIX: persist postId for new-trade detection after VM restart
    const lowsSnap  = Object.fromEntries(Object.entries(_optionLows).map(([k,v]) => [k, { low: v.low, action: v.action, postId: v.postId || null }])); // RC-4 FIX: persist postId
    _stateWriter.schedule(JSON.stringify({ session, state, optionHighs: highsSnap, optionHighsDate: todayIST, optionLows: lowsSnap, optionLowsDate: todayIST }, null, 2));
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
  if (!BOT_TOKEN || !CHAT_ID) return null;
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

async function tgSendPhoto(photoUrl, caption) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await ft(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, photo: photoUrl, caption: caption || '', parse_mode: 'HTML' })
    }, 8000);
  } catch(e) { console.error('tgSendPhoto error:', e.message); }
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
  if (!BOT_TOKEN || !CHAT_ID) return;
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
  const instr = (instrument || '').toUpperCase();
  // Use actual expiry dates from Kotak scrip master when available
  const ed = _expiryDates && _expiryDates[instr];
  if (ed) {
    if (s === 'weekly' || s === 'current weekly') return ed.currentRaw;
    if (s === 'next weekly') return ed.nextRaw || ed.currentRaw;
    if (s === 'monthly') return ed.monthlyRaw || ed.currentRaw;
  }
  // Fallback: compute from day-of-week when scrip master not yet loaded
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  // NSE NIFTY weekly expiry: Tuesday (2). SENSEX: Thursday (4). BANKNIFTY: monthly only.
  const targetDay = instr.includes('SENSEX') ? 4 : 2;
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
    while (d.getDay() !== 4) d.setDate(d.getDate() - 1);
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

    // Capture previous login date BEFORE overwriting session.lastLogin
    const _prevLoginIST = session.lastLogin
      ? new Date(new Date(session.lastLogin).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toDateString()
      : null;

    session.token      = d2.data.token;
    session.sid        = d2.data.sid        || d1.data.sid   || '';  // step2 rarely returns sid; fall back to step1 sid
    session.rid        = d2.data.rid        || '';
    session.auth       = d2.data.auth       || d1.data.token || '';  // step1 token is used as Auth header for step2 — valid for FO LTP too
    session.hsServerId = d2.data.hsServerId || d2.data.serverId || d2.data.rid || '';
    // gw-napi is the working LTP endpoint — mis.kotaksecurities.com broken for LTP since Jul 2026
    session.baseUrl    = 'https://gw-napi.kotaksecurities.com';
    session.lastLogin  = Date.now();
    _sessionExpiryWarned = false;
    state.paperMode    = false;

    tgSend(
      `✅ <b>Logged into Kotak Neo!</b>\n` +
      `Mode: 🔴 Live (auto-switched)\n` +
      `Base URL: <code>${session.baseUrl}</code>\n\n` +
      `Ready. Send trades from PWA or use /status.\n` +
      `<i>Market scraper runs automatically 9:15–3:35 IST (no TOTP needed)</i>`
    ).catch(()=>{});
    await saveState();
    // Only reset tracked highs/lows on a NEW trading day — same-day re-logins preserve accumulated peaks
    const _todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toDateString();
    if (_prevLoginIST !== _todayIST) {
      _optionHighs     = {};
      _optionLows      = {};
      _highPostedToday = false;
    }
    // Download scrip master, then immediately load contracts + start LTP interval (don't wait for market open)
    downloadScripMaster()
      .then(() => {
        refreshActiveContracts();  // populate _activeContracts right away
        startKotakLtpInterval();   // start 5s LTP fetch — safe, has internal guard if already running
      })
      .catch(e => console.error('[scrip] post-login download error:', e.message));
    // Outside market hours: fetch Kotak Nifty50 LTPs to correct yesterday's closing breadth
    // (NSE API gave wrong numbers; Kotak LTP at this time = yesterday's close vs prev close)
    if (!isMarketHours()) {
      setTimeout(async () => {
        try {
          const movers = await fetchKotakNifty50LTPs();
          if (movers?.breadth && _latestMarketData) {
            _latestMarketData.breadth = { nifty50: movers.breadth };
            _latestMarketData.gainers = movers.gainers?.length ? movers.gainers : _latestMarketData.gainers;
            _latestMarketData.losers  = movers.losers?.length  ? movers.losers  : _latestMarketData.losers;
            const snapshot = { ..._latestMarketData };
            delete snapshot.optionLTPs; delete snapshot.expiry;
            await pushMarketToGitHub(snapshot);
            tgSend(`📊 Closing breadth corrected: ${movers.breadth.advancing}↑ ${movers.breadth.declining}↓ (${movers.count} stocks)`).catch(()=>{});
            console.log(`[login] breadth corrected: ${movers.breadth.advancing}↑ ${movers.breadth.declining}↓`);
          }
        } catch(e) { console.error('[login] post-login breadth update failed:', e.message); }
      }, 4000);
    }
    return true;
  } catch (e) {
    tgSend(`❌ Login error: ${e.message}`).catch(()=>{});
    return false;
  }
}

function isSessionValid() {
  if (!session.token) return false;
  const age = Date.now() - (session.lastLogin || 0);
  return age <= SESSION_MAX_AGE_MS;
}

// ── SPOT PRICE ────────────────────────────────────────────────────────────────
async function fetchSpot(instrument = 'NIFTY') {
  if (!session.token || !session.baseUrl) return null;
  const tok = SPOT_TOKENS[instrument.toUpperCase()] || SPOT_TOKENS.NIFTY;
  try {
    const url = `${session.baseUrl || DATA_URL}/script-details/1.0/quotes/neosymbol/${tok.exchange_segment}|${tok.instrument_token}/ltp`;
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
        // Keep symbol registry current — detects rebalancing automatically
        _updateNifty50Symbols(stocks.map(s => s.symbol));
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
    const iLot  = _findCol(hdrs,'dBodLotQuantity','lotSize','pLotSize','lLotSize','bodLotQuantity','lotQty'); // lot size per contract
    if ([iName,iType,iExp,iStr,iTok].some(i=>i<0)) {
      return { map:{}, lotMap:{}, err:`Col missing — iName:${iName} iType:${iType} iExp:${iExp} iStr:${iStr} iTok:${iTok} | Hdrs: ${hdrs.join(',')}` };
    }
    // Auto-detect if strike is stored ×100 (old: 2400000) or actual value (new: 24000)
    const firstStrike = parseFloat(lines[1]?.split(',')?.[iStr]?.replace(/[";]/g,'').trim()||'0');
    const strikeDiv   = firstStrike > 100000 ? 100 : 1;
    const map = {}, lotMap = {};
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
      // Extract lot size once per instrument (same across all contracts of that instrument)
      if (iLot >= 0 && !lotMap[name] && c[iLot]) {
        const lot = parseInt(c[iLot].replace(/[";]/g,'').trim() || '0');
        if (lot > 0) lotMap[name] = lot;
      }
    }
    return { map, lotMap, err:null };
  }

  const d2s = d => `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
  const cdnBase = 'https://lapi.kotaksecurities.com/wso2-scripmaster/1.0/prod/prod/v1';
  const dates = [new Date(), new Date(Date.now()-86400000), new Date(Date.now()-172800000)].map(d2s);

  let csvText = null, sourceLabel = '';

  // Approach 1: mis.kotaksecurities.com Dist/master — Bearer session token
  const gwNapiUrls = [
    `${DATA_URL}/Dist/master/nse_fo.csv`,
    'https://gw-napi.kotaksecurities.com/Dist/master/nse_fo.csv'
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
      const r1 = await ftKotak(`${DATA_URL}/script-details/1.0/masterscrip/file-paths`, {
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
      const r1 = await ftKotak(`${DATA_URL}/script-details/1.0/masterscrip/file-paths`, {
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

  const { map: newMap, lotMap, err } = parseCsv(csvText);
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
  if (lotMap && Object.keys(lotMap).length > 0) {
    _kotakLotSizes = lotMap;
    console.log('[scrip] Lot sizes from Kotak:', JSON.stringify(_kotakLotSizes));
  }

  // Also download BSE F&O scrip master — SENSEX & BANKEX options are BSE-listed (bse_fo exchange)
  let bseCsvText = null;
  _bseDownloadLog = [];
  const bseLog = (msg) => { console.log('[bse]', msg); _bseDownloadLog.push(msg); };
  // Approach A: file-paths API (same one used for NSE — may also return BSE paths)
  for (const authHdr of [session.token, CONSUMER_KEY]) {
    try {
      const r1 = await ftKotak(`${DATA_URL}/script-details/1.0/masterscrip/file-paths`, {
        headers: { 'Authorization': authHdr, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi', 'sid': session.sid, 'Auth': session.token }
      }, 10000);
      const status1 = r1.status;
      if (r1.ok) {
        const d1 = await r1.json();
        const allPaths = d1?.data?.filesPaths || [];
        const bseCandidates = allPaths.filter(p => typeof p === 'string' && p.toLowerCase().includes('bse'));
        bseLog(`file-paths(${authHdr.slice(0,10)}) HTTP ${status1}: ${allPaths.length} paths, bse candidates: ${JSON.stringify(bseCandidates)}`);
        const bfoPaths = bseCandidates.filter(p => p.toLowerCase().includes('bse_fo'));
        for (const url of [...bfoPaths].reverse()) {
          try {
            const r2 = await ftKotak(url, {}, 60000);
            if (r2.ok) { const t = await r2.text(); if (t && t.length > 1000 && t.includes(',')) { bseCsvText = t; bseLog(`file-paths BSE URL OK: ${t.length} bytes`); break; } else { bseLog(`file-paths BSE URL ok but bad body: ${t?.length}b`); } }
            else { bseLog(`file-paths BSE URL HTTP ${r2.status}`); }
          } catch(e) { bseLog(`file-paths BSE URL error: ${e.message}`); }
        }
      } else { bseLog(`file-paths(${authHdr.slice(0,10)}) HTTP ${status1}`); }
    } catch(e) { bseLog(`file-paths(${authHdr.slice(0,10)}) error: ${e.message}`); }
    if (bseCsvText) break;
  }
  // Approach B: direct gw-napi bse_fo.csv
  if (!bseCsvText) {
    for (const authHdr of [`Bearer ${session.token}`, session.token]) {
      try {
        const r = await ftKotak('https://gw-napi.kotaksecurities.com/Dist/master/bse_fo.csv', { headers: { 'Authorization': authHdr, 'Sid': session.sid, 'Auth': session.auth, 'neo-fin-key': 'neotradeapi', 'Content-Type': 'application/json' } }, 60000);
        if (r.ok) { const t = await r.text(); if (t && t.length > 1000 && t.includes(',')) { bseCsvText = t; bseLog(`gw-napi direct OK: ${t.length} bytes`); break; } else { bseLog(`gw-napi direct ok but bad body: ${t?.length}b`); } }
        else { bseLog(`gw-napi direct HTTP ${r.status}`); }
      } catch(e) { bseLog(`gw-napi direct error: ${e.message}`); }
      if (bseCsvText) break;
    }
  }
  // Approach C: CDN dated URL
  if (!bseCsvText) {
    for (const dateStr of dates) {
      try {
        const r = await ftKotak(`${cdnBase}/${dateStr}/bfo/transformed/scrip_master.csv`, {}, 30000);
        if (r.ok) { const t = await r.text(); if (t && t.length > 1000) { bseCsvText = t; bseLog(`CDN ${dateStr} OK: ${t.length} bytes`); break; } }
        else { bseLog(`CDN ${dateStr} HTTP ${r.status}`); }
      } catch(e) { bseLog(`CDN ${dateStr} error: ${e.message}`); }
    }
  }
  if (bseCsvText) {
    const { map: bseMap } = parseCsv(bseCsvText);
    const bseCount = Object.keys(bseMap).length;
    if (bseCount > 0) { Object.assign(_scripMaster, bseMap); console.log(`[scrip] BSE F&O: +${bseCount} contracts (SENSEX/BANKEX) merged`); }
  } else {
    console.log('[scrip] BSE F&O: all download approaches failed — SENSEX will use trading symbol fallback');
  }

  buildExpiryDates();
  const sample = Object.keys(newMap).filter(k=>k.startsWith('NIFTY-')&&k.includes(String(currentYear))).slice(0,3);
  console.log(`[scrip] ✅ ${count} contracts from ${sourceLabel}. Sample: ${sample.join(', ')}`);
}

// Look up Kotak numeric token for a specific option contract
function getOptionToken(instrument, strike, type, expiry) {
  const instr = instrument.toUpperCase(), t = type.toUpperCase(), e = expiry.toUpperCase();
  // Try rupee scale first, then paise scale (×100) — scrip master format varies by CSV source
  return _scripMaster[`${instr}-${strike}-${t}-${e}`]
      || _scripMaster[`${instr}-${strike * 100}-${t}-${e}`]
      || null;
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
    result[instr] = { current: fmt(sorted[0].str), next: sorted[1]?fmt(sorted[1].str):null, monthly: monthly?fmt(monthly.str):null, currentRaw: sorted[0].str, nextRaw: sorted[1]?sorted[1].str:null, monthlyRaw: monthly?monthly.str:null };
  }
  _expiryDates = result;
  if (_latestMarketData) _latestMarketData.expiry = _expiryDates;
  console.log('[expiry]', JSON.stringify(result));
}

// Parse active option contracts from recent Supabase trade_alert posts
async function refreshActiveContracts() {
  if (Date.now() - _activeContractsTs < 60 * 1000) return; // fast throttle — no lock needed
  const _release = _contractsMutex.tryAcquire();
  if (!_release) return; // a refresh is already in flight — skip, result will arrive shortly
  _activeContractsTs = Date.now();
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = await ft(
      `${SB_URL}/rest/v1/posts?post_type=eq.trade_alert&is_deleted=eq.false&sent_at=gte.${since}&select=id,content&order=sent_at.desc`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }, 8000
    );
    if (!r.ok) return;
    const posts = await r.json();
    const contracts = [];
    posts.forEach(p => {
      const t = (p.content || '').toUpperCase();
      // Instrument
      let instrM = t.match(/\b(NIFTY|BANKNIFTY|SENSEX|MIDCAP)\b/);
      if (!instrM) {
        const sm = t.match(/\b([A-Z]{2,12})\s+(\d{3,7})\s+(?:(?:NEXT\s+)?(?:WEEKLY|MONTHLY)\s+)?(CE|PE)\b/);
        if (!sm) return;
        instrM = sm;
      }
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
      // Action: BUY or SELL from post content (used to track session LOW for SELL trades)
      const actionMatch = (p.content || '').match(/\b(SELL(?:ING)?|BUY(?:ING)?)\b/i);
      const action = actionMatch ? (actionMatch[1].toUpperCase().startsWith('SELL') ? 'SELL' : 'BUY') : 'BUY';
      const expM   = t.match(/\b(NEXT\s+WEEKLY|WEEKLY|MONTHLY)\b/i);
      const expiry = resolveExpiry(expM ? expM[1] : 'Weekly', instr);
      // Guard: skip if resolved expiry is already in the past (expired contract — price is near-zero)
      // Format DDMMMYYYY e.g. "28JUL2026" → parse as UTC date for comparison
      const MONS_CHK = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
      const expM2 = (expiry || '').match(/^(\d{2})([A-Z]{3})(\d{4})$/);
      if (expM2) {
        const expDate = new Date(Date.UTC(parseInt(expM2[3]), MONS_CHK.indexOf(expM2[2]), parseInt(expM2[1])));
        const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        todayIST.setHours(0, 0, 0, 0);
        if (expDate < todayIST) {
          console.warn(`[contracts] SKIP ${instr}-${strike}-${type}: resolved expiry ${expiry} is in the past — post may be stale or expiry label ambiguous`);
          return; // skip this post
        }
      }
      // Deduplicate by instrument-strike-type only (not expiry) — two posts with the same
      // strike but different expiry labels both resolve to the same _optionChain key, so
      // allowing both would cause the loop to overwrite the correct LTP with the wrong one.
      // Query is ordered sent_at.desc so the first match is the MOST RECENT post.
      if (!contracts.find(c => c.instrument===instr && c.strike===strike && c.type===type))
        contracts.push({ instrument: instr, strike, type, expiry, postId: p.id, action });
    });
    // RC-1 FIX: Detect postId change for same liveCmpKey → reset session high/low for new trade
    // Guard: only reset when BOTH postIds are non-null (null = just restored from state.json, not a real change)
    for (const newC of contracts) {
      const key = `${newC.instrument}-${newC.strike}-${newC.type}`;
      const existingHigh = _optionHighs[key];
      if (existingHigh && existingHigh.postId && existingHigh.postId !== newC.postId) {
        console.log(`[contracts] New trade for ${key}: postId changed ${existingHigh.postId.slice(0,8)}→${newC.postId.slice(0,8)} — resetting session high/low`);
        _optionHighs[key] = { high: 0, last: 0, postId: newC.postId };
        if (_optionLows[key]) _optionLows[key] = { low: undefined, postId: newC.postId, action: newC.action };
        saveState().catch(() => {});
      }
    }
    _activeContracts = contracts;
    console.log(`[contracts] Active: ${contracts.map(c=>`${c.instrument}${c.strike}${c.type}`).join(', ')}`);
  } catch(e) {
    console.error('[contracts] refresh error:', e.message);
  } finally {
    _release();
  }
}

// Build Kotak trading symbol from contract fields
// Format: NIFTY25JUN2623850CE (DDMMMYY + STRIKE + TYPE — 2-digit year, no-year rejected by API)
function buildTradingSymbol(instrument, strike, type, expiry) {
  // expiry is DDMMMYYYY e.g. "25JUN2026" → NIFTY25JUN2623850CE
  const m = (expiry||'').match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  const yy = m[3].slice(2); // "2026" → "26"
  return `${instrument.toUpperCase()}${m[1]}${m[2]}${yy}${strike}${type.toUpperCase()}`;
}

// Fetch option LTPs from Kotak Neo for all active contracts (runs every 5s)
// Uses numeric token from scrip master if available; falls back to trading symbol string
async function fetchKotakOptionLTPs() {
  if (!session.token || !session.baseUrl || !_activeContracts.length) return;
  for (const c of _activeContracts) {
    const numToken = getOptionToken(c.instrument, c.strike, c.type, c.expiry);
    // Numeric token (from scrip master) works on both mis and gw-napi; trading symbol is fallback
    const tradeSym = buildTradingSymbol(c.instrument, c.strike, c.type, c.expiry);
    const identifier = numToken || tradeSym;
    if (!identifier) {
      console.log(`[ltp] Cannot build identifier for ${c.instrument}-${c.strike}-${c.type}-${c.expiry}`);
      continue;
    }
    try {
      const _exchSeg = c.instrument === 'SENSEX' ? 'bse_fo' : 'nse_fo';
      const url = `${session.baseUrl || DATA_URL}/script-details/1.0/quotes/neosymbol/${_exchSeg}|${identifier}/ltp`;
      const r = await ftKotak(url, {
        headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' }
      }, 3000);
      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        console.error(`[ltp] HTTP ${r.status} for ${identifier} (${_exchSeg}): ${errBody.slice(0,200)}`);
        // Count 5xx errors (gateway issues) as failures for failover — same as network errors
        if (r.status >= 500) {
          _ltpConsecFailures++;
          if (_ltpConsecFailures >= 2) {
            const alt = session.baseUrl === DATA_URL ? 'https://gw-napi.kotaksecurities.com' : DATA_URL;
            session.baseUrl = alt; _ltpConsecFailures = 0;
            console.log(`[ltp] ${r.status} x2 — switched to: ${alt}`);
          }
        }
        continue;
      }
      const d = await r.json();
      const ltp = formatOptionPrice(parseFloat(d?.data?.[0]?.ltp || (Array.isArray(d) ? d[0]?.ltp : null) || d?.ltp)) ?? 0;
      if (ltp > 0) {
        const key = `${c.instrument}-${c.strike}-${c.type}`;
        _optionChain[key] = ltp;
        _optionChainTs[key] = Date.now(); // freshness timestamp — used for stale-but-non-empty detection
        const _prevHigh = _optionHighs[key]?.high || 0;
        _optionHighs[key] = { high: Math.max(_prevHigh, ltp), last: ltp, postId: c.postId || _optionHighs[key]?.postId };
        if (_optionHighs[key].high > _prevHigh) saveState().catch(() => {}); // persist new high so VM restart doesn't lose it
        // RC-10 INE-2: Propagate new session high immediately — optionHighs is monotonically
        // increasing, so per-contract update carries no poisoning risk (unlike optionLTPs).
        if (_latestMarketData && _optionHighs[key].high > _prevHigh) {
          if (_latestMarketData.optionHighs) _latestMarketData.optionHighs[key] = _optionHighs[key].high;
          if (_latestMarketData.optionHighsPostIds) _latestMarketData.optionHighsPostIds[key] = _optionHighs[key].postId;
        }
        // Track session low for all contracts — only USED for SELL trades in the follow-up post
        const _prevLow = _optionLows[key]?.low;
        if (_prevLow === undefined || ltp < _prevLow) {
          _optionLows[key] = { low: ltp, postId: c.postId || _optionLows[key]?.postId, action: c.action || 'BUY' };
        }
        _ltpConsecFailures = 0; // successful fetch — current URL is working, reset failure counter
        if (tradeSym) console.log(`[ltp] ${key}=${ltp} via trading symbol ${tradeSym}`);
        // Cache returned numeric token to avoid repeated symbol-based lookups
        const respToken = String(d?.data?.[0]?.token || d?.data?.[0]?.scripToken || '').trim();
        if (respToken && !numToken) {
          _scripMaster[`${c.instrument}-${c.strike}-${c.type}-${c.expiry}`] = respToken;
        }
      }
    } catch(e) {
      console.error(`[ltp] ${c.instrument}-${c.strike}-${c.type} fetch error: ${e.message}`);
      // Primary/secondary failover — switch URL after 2 consecutive network failures
      _ltpConsecFailures++;
      if (_ltpConsecFailures >= 2) {
        const alt = session.baseUrl === DATA_URL
          ? 'https://gw-napi.kotaksecurities.com'
          : DATA_URL;
        session.baseUrl = alt;
        _ltpConsecFailures = 0;
        console.log(`[ltp] 2 consecutive failures — switched to backup: ${alt}`);
      }
    }
  }
  // Snapshot after all contracts processed — never mid-loop (prevents partial poisoned state
  // from being served to member PWA during the fetch cycle).
  if (_latestMarketData) {
    _latestMarketData.optionLTPs  = { ..._optionChain };
    _latestMarketData.optionHighs        = Object.fromEntries(Object.entries(_optionHighs).map(([k,v]) => [k, v.high]));
    _latestMarketData.optionHighsPostIds = Object.fromEntries(Object.entries(_optionHighs).map(([k,v]) => [k, v.postId]));
  }

  // Staleness detection — if any active contract's LTP hasn't updated in >2 min, the token has
  // probably expired or the contract rolled over. Reset the active-contracts cache so the next
  // tick triggers a fresh Supabase lookup via refreshActiveContracts().
  const STALE_MS = 2 * 60 * 1000; // 2 minutes
  const now_ms = Date.now();
  let _staleDetected = false;
  for (const c of _activeContracts) {
    const key = `${c.instrument}-${c.strike}-${c.type}`;
    const ts = _optionChainTs[key];
    if (!ts || (now_ms - ts) > STALE_MS) {
      console.warn(`[ltp] STALE: ${key} — last good fetch ${ts ? Math.floor((now_ms - ts) / 1000) + 's ago' : 'never'}. Triggering contract refresh.`);
      _staleDetected = true;
      break;
    }
  }
  if (_staleDetected) {
    _activeContractsTs = 0; // bypass 60s throttle on next call
    // Also force scrip master re-download — stale LTPs often mean a new expiry rolled in
    // and the token map has yesterday's expired contract tokens. Without fresh tokens,
    // refreshActiveContracts() will just re-look up the same wrong/expired contract.
    _scripMasterTs = 0;
    downloadScripMaster()
      .then(() => refreshActiveContracts())
      .catch(() => refreshActiveContracts()); // contracts refresh regardless of scrip master outcome
  }

  // Alert when CMP has been empty for >2 min during market hours (logged to PM2 every 2 min)
  const _hasLtps = Object.keys(_optionChain).length > 0;
  // Also treat the stale-but-non-empty case as "effectively dry" for alerting purposes
  const _effectivelyDry = !_hasLtps || (_activeContracts.length > 0 && _staleDetected);
  if (_effectivelyDry && _activeContracts.length > 0 && isMarketHours()) {
    if (!_ltpZeroSince) _ltpZeroSince = Date.now();
    const _dryMins = Math.floor((Date.now() - _ltpZeroSince) / 60000);
    if (_dryMins >= 2 && _dryMins % 2 === 0) {
      const _reason = !_hasLtps ? 'No option LTPs' : 'Stale option LTPs (non-empty but >2min old)';
      console.error(`[ltp] ALERT: ${_reason} for ${_dryMins} min — sid:${!!session.sid} auth:${!!session.auth} token:${!!session.token}`);
    }
  } else {
    _ltpZeroSince = 0; // reset once LTPs are fresh and flowing
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

let _kotakEquityInterval = null;
function startKotakLtpInterval() {
  if (_kotakLtpInterval) return;
  _kotakLtpInterval = setInterval(fetchKotakOptionLTPs, 5000);
  fetchKotakOptionLTPs(); // immediate first run
  // Equity LTP for Nifty50 gainers/losers — every 2 minutes
  if (!_kotakEquityInterval) {
    _kotakEquityInterval = setInterval(() => fetchKotakNifty50LTPs().catch(() => {}), 2 * 60 * 1000);
    fetchKotakNifty50LTPs().catch(() => {}); // immediate first run
  }
  console.log('[ltp] Kotak option LTP interval started (5s), equity movers (2min)');
}

function stopKotakLtpInterval() {
  if (_kotakLtpInterval) { clearInterval(_kotakLtpInterval); _kotakLtpInterval = null; }
  if (_kotakEquityInterval) { clearInterval(_kotakEquityInterval); _kotakEquityInterval = null; }
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

// Kotak Neo index LTP — primary source for NIFTY/BANKNIFTY/SENSEX spot prices
const INDEX_TOKENS = {
  NIFTY:     { exchange: 'nse_cm', token: '26000' },
  BANKNIFTY: { exchange: 'nse_cm', token: '26009' },
  SENSEX:    { exchange: 'bse_cm', token: '1' }
};
async function fetchKotakIndexLTP(instrument) {
  if (!session.token) return null;
  const cfg = INDEX_TOKENS[instrument.toUpperCase()];
  if (!cfg) return null;
  try {
    const url = `${session.baseUrl || DATA_URL}/script-details/1.0/quotes/neosymbol/${cfg.exchange}|${cfg.token}/ltp`;
    const r = await ftKotak(url, {
      headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' }
    }, 5000);
    if (!r.ok) { console.log(`[KotakIdx] ${instrument} HTTP ${r.status}`); return null; }
    const d = await r.json();
    // gw-napi returns data as array [{ltp,...}] for options but sometimes as object {ltp,...} for spot indices — handle both
    const _dataRaw = d?.data;
    const item = Array.isArray(_dataRaw) ? _dataRaw[0]
               : (_dataRaw && typeof _dataRaw === 'object') ? _dataRaw
               : Array.isArray(d) ? d[0] : d;
    const price = parseFloat(item?.ltp || 0);
    if (!price) {
      console.log(`[KotakIdx] ${instrument}: no price — raw: ${JSON.stringify(d).slice(0, 300)}`);
      return null;
    }
    const prevClose = parseFloat(item?.close || item?.prevClose || item?.prev_close || 0);
    const change    = prevClose ? parseFloat((price - prevClose).toFixed(2)) : parseFloat((item?.netChng || item?.change || 0));
    const changePct = prevClose ? parseFloat(((change / prevClose) * 100).toFixed(2)) : parseFloat((item?.pChange || item?.pctChng || 0));
    console.log(`[KotakIdx] ${instrument}: ₹${price} (${changePct}%)`);
    return { price, change, changePct };
  } catch(e) { console.error(`[KotakIdx] ${instrument}: ${e.message}`); return null; }
}

// ── NIFTY 50 SYMBOL REGISTRY (dynamic — refreshed from NSE, no hardcoded list) ──
// Source of truth: NSE equity-stockIndices API. Cached to disk, refreshed weekly
// or immediately when a composition change is detected.
const N50_CACHE_FILE = path.join(__dirname, 'nifty50_cache.json');
const N50_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let _nifty50Symbols   = null; // ['ADANIENT', 'RELIANCE', ...] — NSE trading symbols
let _nifty50SymbolsTs = 0;    // timestamp of last confirmed-fresh list

// Symbols where Yahoo Finance ticker differs from NSE trading symbol.
// Add entries here only when Yahoo uses a different name — not for URL encoding.
const YF_SYMBOL_OVERRIDES = {
  // e.g. 'ETERNAL': 'ZOMATO' — only needed if Yahoo hasn't updated yet
};

function nseToYFSymbol(nseSym) {
  const base = YF_SYMBOL_OVERRIDES[nseSym] || nseSym;
  return base.replace('&', '%26') + '.NS'; // URL-encode & for M&M → M%26M.NS
}

function yfToNSESymbol(yfSym) {
  const base = yfSym.replace('.NS', '').replace('%26', '&');
  for (const [nse, yf] of Object.entries(YF_SYMBOL_OVERRIDES)) {
    if (yf === base) return nse;
  }
  return base;
}

function loadNifty50Cache() {
  try {
    if (fs.existsSync(N50_CACHE_FILE)) {
      const { symbols, ts } = JSON.parse(fs.readFileSync(N50_CACHE_FILE, 'utf8'));
      if (Array.isArray(symbols) && symbols.length >= 45) {
        _nifty50Symbols   = symbols;
        _nifty50SymbolsTs = ts || 0;
        const ageDays = Math.round((Date.now() - (ts || 0)) / 86400000);
        console.log(`[nifty50] loaded ${symbols.length} symbols from cache (${ageDays}d old)`);
      }
    }
  } catch(e) { console.error('[nifty50] cache load error:', e.message); }
}

function _saveNifty50Cache() {
  try {
    fs.writeFileSync(N50_CACHE_FILE, JSON.stringify({ symbols: _nifty50Symbols, ts: _nifty50SymbolsTs }, null, 2));
  } catch(e) { console.error('[nifty50] cache save error:', e.message); }
}

// Called from fetchNSEMovers() whenever a full 50-stock response is received.
// Detects composition changes and saves to disk; otherwise just keeps in memory.
function _updateNifty50Symbols(freshSymbols) {
  if (!freshSymbols?.length) return;
  const compositionChanged = _nifty50Symbols &&
    JSON.stringify([...freshSymbols].sort()) !== JSON.stringify([..._nifty50Symbols].sort());
  const cacheStale = !_nifty50Symbols || Date.now() - _nifty50SymbolsTs > N50_REFRESH_MS;
  if (compositionChanged) {
    console.log(`[nifty50] composition changed — was ${_nifty50Symbols?.length}, now ${freshSymbols.length} stocks`);
  }
  if (compositionChanged || cacheStale || !_nifty50Symbols) {
    _nifty50Symbols   = freshSymbols;
    _nifty50SymbolsTs = Date.now();
    _saveNifty50Cache();
  }
}

// Returns the current Nifty 50 NSE symbol list.
// Uses memory cache if fresh; does a standalone NSE fetch if stale; returns stale if fetch fails.
async function getNifty50Symbols() {
  if (_nifty50Symbols && Date.now() - _nifty50SymbolsTs < N50_REFRESH_MS) return _nifty50Symbols;
  try {
    if (!_nseCookies || Date.now() - _nseCookieTs > 10 * 60 * 1000) await refreshNSECookies();
    const r = await ft('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050',
      { headers: { ...NSE_HEADERS, 'Cookie': _nseCookies } }, 10000);
    if (r.ok) {
      const d = await r.json();
      const syms = (d?.data || []).filter(s => s.symbol && s.symbol !== 'NIFTY 50').map(s => s.symbol);
      if (syms.length >= 45) {
        _nifty50Symbols   = syms;
        _nifty50SymbolsTs = Date.now();
        _saveNifty50Cache();
        console.log(`[nifty50] standalone refresh: ${syms.length} symbols`);
        return _nifty50Symbols;
      }
    }
  } catch(e) { console.error('[nifty50] standalone refresh failed:', e.message); }
  return _nifty50Symbols || []; // return stale cache; empty only on first-ever run if NSE is down
}

let _yahooMoversCache = null, _yahooMoversCacheTs = 0, _yahooMoversStatus = 'never';
async function fetchYahooNifty50Movers() {
  // 5-minute cache
  if (_yahooMoversCache && Date.now() - _yahooMoversCacheTs < 5 * 60 * 1000) return _yahooMoversCache;
  const nseSymbols = await getNifty50Symbols();
  if (!nseSymbols.length) return null;
  const yfSymbols = nseSymbols.map(nseToYFSymbol);
  // Fetch in batches of 5 with 300ms gap — avoids rate-limiting 50 parallel calls
  const YF_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' };
  const stocks = [];
  const BATCH = 5;
  for (let i = 0; i < yfSymbols.length; i += BATCH) {
    const slice = yfSymbols.slice(i, i + BATCH);
    const batch = await Promise.all(slice.map(sym =>
      ft(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`, { headers: YF_HEADERS }, 8000)
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          const meta = d?.chart?.result?.[0]?.meta;
          if (!meta?.regularMarketPrice) return null;
          const price = parseFloat(meta.regularMarketPrice);
          const prev  = parseFloat(meta.chartPreviousClose || 0);
          if (!price || !prev) return null;
          const change = parseFloat(((price - prev) / prev * 100).toFixed(2));
          return { symbol: yfToNSESymbol(sym), price, change };
        })
        .catch(() => null)
    ));
    stocks.push(...batch.filter(Boolean));
    if (i + BATCH < yfSymbols.length) await new Promise(r => setTimeout(r, 300));
  }
  if (stocks.length < 5) {
    _yahooMoversStatus = `failed — only ${stocks.length} stocks returned`;
    console.log('[Yahoo50]', _yahooMoversStatus);
    return null;
  }
  const result = {
    gainers: stocks.filter(s => s.change > 0).sort((a,b) => b.change - a.change),
    losers:  stocks.filter(s => s.change < 0).sort((a,b) => a.change - b.change)
  };
  _yahooMoversCache = result; _yahooMoversCacheTs = Date.now();
  _yahooMoversStatus = `ok — ${stocks.length} stocks, top gainer: ${result.gainers[0]?.symbol} ${result.gainers[0]?.change}%`;
  console.log('[Yahoo50]', _yahooMoversStatus);
  return result;
}

// Kotak Nifty50 equity LTPs — used during market hours when NSE movers are blocked
// Symbol list is fetched dynamically from NSE (see getNifty50Symbols above).
let _kotakMoversCache = null, _kotakMoversCacheTs = 0;
async function fetchKotakNifty50LTPs() {
  if (!session.token) return null;
  if (_kotakMoversCache && Date.now() - _kotakMoversCacheTs < 2 * 60 * 1000) return _kotakMoversCache;
  const symbols = await getNifty50Symbols();
  if (!symbols.length) return null;
  const results = await Promise.all(
    symbols.map(sym => {
      const symUrl = sym.replace('&', '%26'); // M&M → M%26M in URL
      const url = `${session.baseUrl || DATA_URL}/script-details/1.0/quotes/neosymbol/nse_cm|${symUrl}/ltp`;
      return ftKotak(url, {
        headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' }
      }, 4000)
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          const item = Array.isArray(d?.data) ? d.data[0] : (Array.isArray(d) ? d[0] : d?.data || d);
          const price = parseFloat(item?.ltp || 0);
          if (!price) return null;
          const prev = parseFloat(item?.close || item?.prevClose || item?.prev_close || 0);
          if (!prev) return null;
          const change = parseFloat(((price - prev) / prev * 100).toFixed(2));
          return { symbol: sym, price, change };
        })
        .catch(() => null);
    })
  );
  const stocks = results.filter(Boolean);
  if (stocks.length < 5) {
    console.log(`[kotak50] only ${stocks.length} stocks returned — symbol-based nse_cm lookup may not work`);
    return null;
  }
  // change >= 0 counts as advancing (flat = advance per product rule)
  const advancing = stocks.filter(s => s.change >= 0).length;
  const declining = stocks.filter(s => s.change < 0).length;
  _kotakMoversCache = {
    gainers: stocks.filter(s => s.change > 0).sort((a,b) => b.change - a.change),
    losers:  stocks.filter(s => s.change < 0).sort((a,b) => a.change - b.change),
    breadth: { advancing, declining, unchanged: stocks.filter(s => s.change === 0).length },
    count: stocks.length
  };
  _kotakMoversCacheTs = Date.now();
  console.log(`[kotak50] ${stocks.length} stocks — ${advancing}↑ ${declining}↓ — top gainer: ${_kotakMoversCache.gainers[0]?.symbol} ${_kotakMoversCache.gainers[0]?.change}%`);
  return _kotakMoversCache;
}

// Yahoo Finance fallback — used when NSE India API is blocked/down AND Kotak not logged in
const YAHOO_SYMBOLS = { NIFTY: '%5ENSEI', BANKNIFTY: '%5ENSEBANK', SENSEX: '%5EBSESN' };
async function fetchYahooIndex(instrument) {
  const sym = YAHOO_SYMBOLS[instrument.toUpperCase()];
  if (!sym) return null;
  try {
    const r = await ft(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
      8000
    );
    if (!r.ok) return null;
    const d = await r.json();
    const meta = d?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;
    const price = parseFloat(meta.regularMarketPrice);
    const prev  = parseFloat(meta.chartPreviousClose || meta.previousClose || 0);
    const change    = prev ? parseFloat((price - prev).toFixed(2)) : 0;
    const changePct = prev ? parseFloat(((change / prev) * 100).toFixed(2)) : 0;
    console.log(`[Yahoo] ${instrument}: ${price} (${changePct}%)`);
    return { price, change, changePct };
  } catch(e) { console.error(`[Yahoo] ${instrument} error: ${e.message}`); return null; }
}

let _lastGhMarketPush = 0;
async function pushMarketToGitHub(marketData) {
  // Rate-limit to once per 15 min — frequent pushes flood GitHub Pages build queue
  const now = Date.now();
  if (now - _lastGhMarketPush < 15 * 60 * 1000) return false;
  _lastGhMarketPush = now;
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

// Save the intraday high (BUY) or low (SELL) for each active contract to Supabase.
// Called once at 3:35 PM so the member PWA can display "Max possible" on closed trade cards.
// BUY trades → [HIGH:X] follow-up; SELL trades → [LOW:X] follow-up.
async function saveOptionHighsToSupabase() {
  if (_highPostedToday) return;
  _highPostedToday = true;
  // Post [HIGH:X] for all contracts that recorded a high
  for (const [key, data] of Object.entries(_optionHighs)) {
    if (!data.high || !data.postId) continue;
    try {
      const r = await ft(`${SB_URL}/rest/v1/posts`, {
        method: 'POST',
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          content: `[HIGH:${data.high.toFixed(2)}]`,
          post_type: 'follow_up', audience: 'all',
          allow_sharing: false, is_deleted: false,
          parent_id: data.postId, sent_at: new Date().toISOString()
        })
      }, 8000);
      console.log(`[high] ${r.ok ? 'Saved' : 'Failed'} ₹${data.high} for ${key}`);
    } catch(e) { console.error('[high] save error:', e.message); }
  }
  // Post [LOW:X] for SELL contracts only
  for (const [key, data] of Object.entries(_optionLows)) {
    if (!data.low || !data.postId || data.action !== 'SELL') continue;
    try {
      const r = await ft(`${SB_URL}/rest/v1/posts`, {
        method: 'POST',
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          content: `[LOW:${data.low.toFixed(2)}]`,
          post_type: 'follow_up', audience: 'all',
          allow_sharing: false, is_deleted: false,
          parent_id: data.postId, sent_at: new Date().toISOString()
        })
      }, 8000);
      console.log(`[low] ${r.ok ? 'Saved' : 'Failed'} ₹${data.low} for ${key} (SELL)`);
    } catch(e) { console.error('[low] save error:', e.message); }
  }
  // Post [CLOSEPRICE:X] for ALL contracts — option LTP at market close.
  // Used by member PWA to show the correct exit price when no explicit exit follow-up was posted.
  // Safe to post even when trade was fully exited — PWA only uses it for the un-exited remaining qty.
  for (const [key, data] of Object.entries(_optionHighs)) {
    if (!data.last || !data.postId) continue;
    try {
      const r = await ft(`${SB_URL}/rest/v1/posts`, {
        method: 'POST',
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          content: `[CLOSEPRICE:${data.last.toFixed(2)}]`,
          post_type: 'follow_up', audience: 'all',
          allow_sharing: false, is_deleted: false,
          parent_id: data.postId, sent_at: new Date().toISOString()
        })
      }, 8000);
      console.log(`[close] ${r.ok ? 'Saved' : 'Failed'} CLOSEPRICE ₹${data.last} for ${key}`);
    } catch(e) { console.error('[close] save error:', e.message); }
  }
}

function parseNSEIndex(nseData, inst) {
  if (!nseData) return null;
  const name = NSE_INDEX_NAMES[inst];
  const idx  = nseData.data?.find(x => x.indexSymbol === name || x.index === name);
  if (!idx) return null;
  return {
    price:     parseFloat((parseFloat(idx.last || idx.indexValue || 0)).toFixed(2)),
    change:    parseFloat((parseFloat(idx.variation || idx.change || 0)).toFixed(2)),
    changePct: parseFloat((parseFloat(idx.percentChange || idx.pChange || 0)).toFixed(2))
  };
}

async function runMarketScraper(force = false) {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const mins = now.getHours() * 60 + now.getMinutes();
  if (!force && !isMarketHours()) {
    stopMarketScraper();
    // Save intraday highs to Supabase so member PWA can show "Max possible" on closed cards
    saveOptionHighsToSupabase().catch(e => console.error('[high]', e.message));
    // Push final closing snapshot — fetch Yahoo Nifty50 for closing gainers/losers
    try {
      const r = await ft(`https://raw.githubusercontent.com/${GH_REPO}/main/market.json?t=${Date.now()}`, {}, 5000);
      const existing = await r.json();
      existing.marketOpen = false;
      existing.lastUpdated = new Date().toISOString();
      // Closing snapshot — Kotak session is still alive at 3:35 PM; LTP at this moment = close price.
      // change ≥ 0 → advancing, change < 0 → declining (flat counts as advance per product rule).
      _kotakMoversCacheTs = 0; // force fresh fetch, not cached intraday snapshot
      const closingMovers = await fetchKotakNifty50LTPs().catch(() => null) || await fetchYahooNifty50Movers();
      if (closingMovers?.gainers?.length > 0 || closingMovers?.breadth) {
        existing.gainers = closingMovers.gainers || [];
        existing.losers  = closingMovers.losers  || [];
        if (closingMovers.breadth) {
          existing.breadth = { nifty50: closingMovers.breadth };
          console.log(`[close] Kotak breadth: ${closingMovers.breadth.advancing}↑ ${closingMovers.breadth.declining}↓ (${closingMovers.count} stocks)`);
        } else {
          console.log('[close] Yahoo closing movers fetched (no breadth):', closingMovers.gainers?.length, 'gainers');
        }
      }
      await pushMarketToGitHub(existing);
    } catch {}
    await tgAlert('🔴 <b>Market scraper auto-stopped</b> (3:35 PM IST). market.json marked closed.').catch(()=>{});
    return;
  }
  // Warn 30 min before Kotak session expires so TOTP can be re-done without a CMP gap
  const _sessAge = Date.now() - (session.lastLogin || 0);
  if (session.token && !_sessionExpiryWarned && _sessAge > SESSION_MAX_AGE_MS - 30 * 60 * 1000 && _sessAge < SESSION_MAX_AGE_MS) {
    _sessionExpiryWarned = true;
    tgAlert('⚠️ <b>Kotak session expires in ~30 min.</b> Re-enter TOTP now to avoid a CMP gap.').catch(()=>{});
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
    // Kotak session active → Kotak primary for index prices, NSE fallback
    // Kotak session not active → NSE public website primary, Yahoo last resort
    let nifty, banknifty, sensexFinal;
    if (isSessionValid()) {
      nifty       = await fetchKotakIndexLTP('NIFTY')     || parseNSEIndex(nseData, 'NIFTY')     || await fetchYahooIndex('NIFTY');
      banknifty   = await fetchKotakIndexLTP('BANKNIFTY') || parseNSEIndex(nseData, 'BANKNIFTY') || await fetchYahooIndex('BANKNIFTY');
      sensexFinal = await fetchKotakIndexLTP('SENSEX')    || sensex                               || await fetchYahooIndex('SENSEX');
    } else {
      nifty       = parseNSEIndex(nseData, 'NIFTY')     || await fetchYahooIndex('NIFTY');
      banknifty   = parseNSEIndex(nseData, 'BANKNIFTY') || await fetchYahooIndex('BANKNIFTY');
      sensexFinal = sensex                               || await fetchYahooIndex('SENSEX');
    }
    const n50 = nseData?.data?.find(x => x.indexSymbol === 'NIFTY 50' || x.index === 'NIFTY 50');
    // Kotak-derived breadth (change ≥ 0 = advancing) takes priority over NSE API counts
    const nseBreadth = n50 ? { advancing: parseInt(n50.advances)||0, declining: parseInt(n50.declines)||0, unchanged: parseInt(n50.unchanged)||0 } : null;
    const breadth = _kotakMoversCache?.breadth || nseBreadth;
    const existing = _latestMarketData || { gainers: [], losers: [], breadth: { nifty50: { advancing: 0, declining: 0, unchanged: 0 } } };
    const day = now.getDay(); // 0=Sun, 6=Sat
    const isWeekday = day >= 1 && day <= 5;
    const isMarketOpen = isWeekday && mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
    // Only advance _lastRealPriceTs when ≥1 live price was received — so lastUpdated in the
    // served JSON reflects actual data freshness, not just scraper cycle time. This makes the
    // PWA's 5-min ⚠ staleness warning accurate when all three sources are failing.
    const _gotRealPrice = !!(nifty || sensexFinal || banknifty);
    if (_gotRealPrice) _lastRealPriceTs = Date.now();
    const _effectiveLastUpdated = _lastRealPriceTs
      ? new Date(_lastRealPriceTs).toISOString()
      : new Date().toISOString();
    const marketData = {
      marketOpen:  isMarketOpen,
      lastUpdated: _effectiveLastUpdated,
      dataSource:  isSessionValid() ? 'broker' : 'nse',
      indices: {
        NIFTY:     nifty     || existing.indices?.NIFTY     || { price: 0, change: 0, changePct: 0 },
        SENSEX:    sensexFinal || existing.indices?.SENSEX    || { price: 0, change: 0, changePct: 0 },
        BANKNIFTY: banknifty || existing.indices?.BANKNIFTY || { price: 0, change: 0, changePct: 0 }
      },
      breadth: { nifty50: breadth || existing.breadth?.nifty50 || { advancing: 0, declining: 0, unchanged: 0 } },
      // NSE primary → Kotak equity LTPs (populated by 2-min interval) → keep existing
      gainers: movers?.gainers || _kotakMoversCache?.gainers || existing.gainers || [],
      losers:  movers?.losers  || _kotakMoversCache?.losers  || existing.losers  || []
    };
    // optionLTPs is served live from memory but NOT pushed to GitHub (too dynamic, too large)
    const _highsSnap = Object.fromEntries(Object.entries(_optionHighs).map(([k,v]) => [k, v.high]));
    _latestMarketData = { ...marketData, optionLTPs: { ..._optionChain }, optionHighs: _highsSnap, expiry: _expiryDates };
    await pushMarketToGitHub(marketData);
    console.log(`Market pushed — NIFTY:${nifty?.price} SENSEX:${sensexFinal?.price} BANKNIFTY:${banknifty?.price}${_gotRealPrice ? '' : ' [STALE — all sources failed, using cached values]'}`);
  } catch (e) { console.error('runMarketScraper error:', e.message); }
}

function startMarketScraper() {
  if (marketScraperInterval) return false;
  marketScraperInterval = setInterval(runMarketScraper, 15_000);
  runMarketScraper();
  startKotakLtpInterval(); // start 5s Kotak option LTP fetch (uses _activeContracts)
  // Stamp first-start date — used to distinguish normal 9:15 open from mid-session crash
  const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toDateString();
  if (_scraperRanTodayIST !== todayIST) _scraperRanTodayIST = todayIST;
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
async function applyBugFix(uuid, cbMsgId) {
  const fix = _pendingBugFixes[uuid];
  if (!fix) { await tgSend('⚠️ Fix expired — re-report the issue.'); return; }
  const ghFileMap = { 'admin.html': 'admin.html', 'index.html': 'index.html', 'server.js': 'server_deploy.js', 'admin_uat.html': 'admin_uat.html', 'uat.html': 'uat.html' };
  const ghFile = ghFileMap[fix.file] || fix.file;
  try {
    const rawUrl = `https://raw.githubusercontent.com/${GH_REPO}/main/${ghFile}?t=${Date.now()}`;
    const r = await ft(rawUrl, {}, 15000);
    const current = await r.text();
    if (!current.includes(fix.find)) {
      await tgSend(`❌ Fix failed — the exact code pattern was not found in <b>${fix.file}</b>.\nMay already be fixed, or Claude's patch was imprecise.`);
      return;
    }
    const updated = current.replace(fix.find, fix.replace);
    const api = `https://api.github.com/repos/${GH_REPO}/contents/${ghFile}`;
    const hdrs = { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
    const shaR = await ft(api, { headers: hdrs }, 8000);
    const sha = (await shaR.json()).sha || '';
    const encoded = Buffer.from(updated).toString('base64');
    const pushR = await ft(api, { method: 'PUT', headers: hdrs, body: JSON.stringify({ message: `auto-fix: ${(fix.summary || 'bug report').slice(0, 60)}`, content: encoded, sha, branch: 'main' }) }, 15000);
    if (!pushR.ok) throw new Error(`GitHub push HTTP ${pushR.status}`);
    delete _pendingBugFixes[uuid];
    if (fix.file === 'server.js') {
      await tgSend(`✅ <b>Fix applied to server.js</b>\n\n${fix.summary || ''}\n\nVM restarting in 5s...`);
      setTimeout(() => ft(`https://api.trade2spend.com/http-update?key=T2SMonitor2026`, {}, 10000).catch(() => {}), 5000);
    } else {
      await tgSend(`✅ <b>Fix applied to ${fix.file}</b>\n\n${fix.summary || ''}\n\n<i>Live at app.trade2spend.com in ~60s (GitHub Pages)</i>`);
    }
  } catch(e) {
    await tgSend(`❌ Auto-fix error: ${e.message}`);
  }
}

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
  if (action.startsWith('bugfix_apply:')) {
    await tgAnswer(cbId, 'Applying fix...');
    await tgEdit(msgId, '⏳ Applying fix — please wait...', { inline_keyboard: [] });
    await applyBugFix(action.slice('bugfix_apply:'.length), msgId);
    return;
  }
  if (action.startsWith('bugfix_skip:')) {
    await tgAnswer(cbId, 'Skipped');
    await tgEdit(msgId, (cb.message.text || '') + '\n\n<i>Fix skipped.</i>', { inline_keyboard: [] });
    delete _pendingBugFixes[action.slice('bugfix_skip:'.length)];
    return;
  }
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
      '<b>📊 PWA Health (use from phone during market hours):</b>\n' +
      '/pwa — Scraper status + active CMPs + session highs\n' +
      '/reset_high — Reset stale session high (e.g. /reset_high NIFTY 24250 PE)\n\n' +
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
      '<b>Admin Recovery:</b>\n' +
      '/unlock_admin — Unlock admin PWA + reset PIN\n\n' +
      '<b>Debug (technical):</b>\n' +
      '/debug_spot — Raw Kotak LTP API response\n' +
      '/debug_ltp — Test option LTP fetch\n' +
      '/debug_cmp — Scrip master + option chain status\n' +
      '/reload_scrip — Force re-download scrip master\n\n' +
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
          const url = `${session.baseUrl || DATA_URL}/script-details/1.0/quotes/neosymbol/${c.instrument==='SENSEX'?'bse_fo':'nse_fo'}|${numToken}/ltp`;
          const r = await ftKotak(url, { headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi' } }, 4000);
          const txt = await r.text();
          await tgSend(`Token lookup (${numToken}): HTTP ${r.status}\n<code>${txt.slice(0,300)}</code>`);
        } catch(e) { await tgSend(`Token lookup error: ${e.message}`); }
      }

      // Test 2: trading symbol (fallback path)
      if (tradeSym) {
        try {
          const url = `${session.baseUrl || DATA_URL}/script-details/1.0/quotes/neosymbol/${c.instrument==='SENSEX'?'bse_fo':'nse_fo'}|${tradeSym}/ltp`;
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

  // /pwa — clean PWA health snapshot: scraper status, active contracts, LTPs, session highs
  if (cmd === '/pwa') {
    const tz = { timeZone: 'Asia/Kolkata' };
    const nowIST = new Date(new Date().toLocaleString('en-US', tz));
    const timeStr = nowIST.toLocaleTimeString('en-IN', { ...tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const scraperOn = !!_marketScraperInterval;
    const kotak = session.token ? `✅ LIVE (login ${session.lastLogin ? Math.round((Date.now()-session.lastLogin)/60000)+'m ago' : 'N/A'})` : '❌ Not logged in';
    let msg = `📊 <b>PWA Health</b> — ${timeStr} IST\n━━━━━━━━━━━━━━━━━━\n`;
    msg += `${scraperOn ? '🟢' : '🔴'} <b>Scraper:</b> ${scraperOn ? 'RUNNING' : 'STOPPED'}\n`;
    msg += `⚡ <b>Kotak:</b> ${kotak}\n`;
    if (!_activeContracts.length) {
      msg += `\n📡 <b>No active contracts tracked.</b>\nPost a trade alert to start tracking.`;
    } else {
      msg += `\n📡 <b>Tracking ${_activeContracts.length} contract${_activeContracts.length>1?'s':''}:</b>\n`;
      for (const c of _activeContracts) {
        const key = `${c.instrument}-${c.strike}-${c.type}`;
        const ltp  = _optionChain[key];
        const high = _optionHighs[key]?.high || 0;
        const low  = _optionLows[key]?.low;
        const lastTs = _optionChainTs[key];
        const ageS   = lastTs ? Math.round((Date.now()-lastTs)/1000) : null;
        const stale  = ageS != null && ageS > 30;
        msg += `• <b>${c.instrument} ${c.strike} ${c.type}</b> ${stale?'⚠️':''}`;
        msg += `\n  CMP: ${ltp != null ? `₹${ltp}` : '—'} | ${c.action==='SELL'?'Session Low':'Session High'}: ${high>0?`₹${high}`:low!=null?`₹${low}`:'—'}`;
        if (ageS != null) msg += ` | Updated: ${ageS}s ago`;
        msg += `\n`;
      }
    }
    await tgSend(msg); return;
  }

  // /reset_high NIFTY 24250 PE — reset stale session high/low for a contract (phone emergency fix)
  // Accepts both /reset_high (BotFather-registered) and /reset-high (legacy hyphen variant)
  if (cmd.startsWith('/reset_high') || cmd.startsWith('/reset-high')) {
    const parts = text.trim().split(/\s+/);
    const instr  = (parts[1]||'').toUpperCase();
    const strike = parseInt(parts[2]||'');
    const type   = (parts[3]||'').toUpperCase();
    if (!instr || !strike || !['CE','PE'].includes(type)) {
      await tgSend('Usage: /reset-high NIFTY 24250 PE\nor: /reset-high BANKNIFTY 54000 CE');
      return;
    }
    const key    = `${instr}-${strike}-${type}`;
    const postId = _optionHighs[key]?.postId || _activeContracts.find(c=>c.instrument===instr&&c.strike===strike&&c.type===type)?.postId || null;
    _optionHighs[key] = { high: 0, last: 0, postId };
    if (_optionLows[key]) _optionLows[key] = { ..._optionLows[key], low: undefined };
    await saveState();
    await tgSend(`✅ <b>Session high/low reset for ${key}</b>\nHigh: 0 — will rebuild from next CMP tick (~5s)\nUse /pwa to verify.`);
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

  // ── KNOWLEDGE HUB — POST /knowledge-ask ─────────────────────────────────────
  if (req.method === 'OPTIONS' && urlPath === '/knowledge-ask') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }
  if (req.method === 'POST' && urlPath === '/knowledge-ask') {
    // Rate limit: 30 requests per 10 minutes per IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (!_khRate.has(ip)) _khRate.set(ip, { count: 0, reset: now + 10 * 60 * 1000 });
    const r = _khRate.get(ip);
    if (now > r.reset) { r.count = 0; r.reset = now + 10 * 60 * 1000; }
    r.count++;
    if (r.count > 30) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }));
      return;
    }
    if (!GROQ_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Knowledge Hub not configured.' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { question, history = [], memberId = '' } = JSON.parse(body || '{}');
        if (!question?.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'No question provided.' })); return; }
        // Scope pre-filter — reject non-finance queries before hitting Groq (no quota used)
        if (!khIsFinanceQuery(question)) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ answer: KH_OUT_OF_SCOPE }));
          return;
        }
        // Per-member hourly quota
        if (memberId) {
          const HOUR_MS = 60 * 60 * 1000;
          const tier = await khGetMemberTier(memberId);
          if (tier !== 'admin') {
            const limit = tier === 'paid' ? 10 : 5;
            const ts = Date.now();
            if (!_khMemberRate.has(memberId)) _khMemberRate.set(memberId, { count: 0, windowStart: ts });
            const m = _khMemberRate.get(memberId);
            if (ts - m.windowStart >= HOUR_MS) { m.count = 0; m.windowStart = ts; }
            if (m.count >= limit) {
              const minutesUntilReset = Math.ceil((HOUR_MS - (ts - m.windowStart)) / 60000);
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ limitReached: true, minutesUntilReset, limit }));
              return;
            }
            m.count++;
          }
        }
        const messages = [
          { role: 'system', content: KNOWLEDGE_PROMPT },
          ...history.slice(-6),
          { role: 'user', content: question.trim() }
        ];
        const apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 2048, temperature: 0, messages })
        });
        const d = await apiRes.json();
        const answer = d.choices?.[0]?.message?.content || 'Sorry, could not generate an answer. Please try again.';
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ answer }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Something went wrong. Please try again.' }));
      }
    });
    return;
  }

  // Chart Analysis — POST /chart-analyse
  if (req.method === 'OPTIONS' && urlPath === '/chart-analyse') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type,x-t2s-secret' });
    res.end(); return;
  }
  if (req.method === 'POST' && urlPath === '/chart-analyse') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-t2s-secret');
    const secret = req.headers['x-t2s-secret'];
    if (!secret || (secret !== process.env.EXECUTE_SECRET && secret !== 'T2SMonitor2026')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' })); return;
    }
    if (!ANTHROPIC_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'ANTHROPIC_KEY not configured on server' })); return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { imageBase64, mediaType = 'image/jpeg' } = JSON.parse(body || '{}');
        if (!imageBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'imageBase64 required' })); return;
        }
        const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            system: CHART_ANALYSIS_PROMPT,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
              { type: 'text', text: 'Analyse this chart screenshot. Respond in the exact Section 8 format from the strategy document.' }
            ]}]
          })
        });
        const data = await apiRes.json();
        if (!apiRes.ok) throw new Error(data?.error?.message || `Anthropic API error ${apiRes.status}`);
        const analysis = data?.content?.[0]?.text || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, analysis }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Market holiday override — POST /market-holiday
  if (req.method === 'POST' && urlPath === '/market-holiday') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { holiday, key } = JSON.parse(body || '{}');
        if (key !== 'T2SMonitor2026') { res.writeHead(401); res.end('{"ok":false}'); return; }
        _marketHoliday = !!holiday;
        saveHolidayState();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, holiday: _marketHoliday }));
        console.log(`Market holiday override set to: ${_marketHoliday}`);
      } catch(e) { res.writeHead(400); res.end('{"ok":false}'); }
    });
    return;
  }

  // Live market data — GET /market (used by PWA instead of GitHub CDN)
  if (req.method === 'GET' && urlPath === '/market') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store'
    });
    const base = _latestMarketData || { indices: {}, lastUpdated: new Date().toISOString() };
    // Re-compute marketOpen fresh at request time so cached data doesn't serve stale status
    const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const dayNow = nowIst.getDay(), minsNow = nowIst.getHours() * 60 + nowIst.getMinutes();
    const timeOpen = dayNow >= 1 && dayNow <= 5 && minsNow >= 9 * 60 + 15 && minsNow < 15 * 60 + 30;
    // Merge Kotak lot sizes with hardcoded fallback — Kotak values take priority
    const lotSizes = Object.keys(_kotakLotSizes).length > 0
      ? { ...LOT_SIZES, ..._kotakLotSizes }
      : LOT_SIZES;
    res.end(JSON.stringify({ ...base, marketOpen: !_marketHoliday && timeOpen, lotSizes }));
    return;
  }

  // Posts proxy — GET /posts?member_id=UUID&limit=50
  // Fetches from Supabase server-side, applies redactPostForFreeMember per member tier.
  if (req.method === 'GET' && urlPath === '/posts') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    const qs       = new URL('https://x' + req.url).searchParams;
    const memberId = qs.get('member_id') || '';
    const limit    = Math.min(parseInt(qs.get('limit') || '50', 10), 100);
    try {
      const tier = memberId ? await khGetMemberTier(memberId) : 'free';
      const r = await fetch(
        `${SB_URL}/rest/v1/posts?is_deleted=eq.false&order=sent_at.desc&limit=${limit}` +
        `&select=id,content,post_type,audience,allow_sharing,is_deleted,parent_id,sent_at,created_at`,
        { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
      );
      const rows = r.ok ? await r.json() : [];
      const posts = Array.isArray(rows)
        ? rows.map(p => redactPostForFreeMember(p, tier))
        : [];
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, posts, tier }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
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

  // Force scrip master re-download — GET /reload-scrip?key=T2SMonitor2026
  if (req.method === 'GET' && urlPath === '/reload-scrip') {
    const key = new URL('https://x' + req.url).searchParams.get('key');
    if (key !== 'T2SMonitor2026') { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'Unauthorized' })); return; }
    _scripMasterTs = 0; _scripMasterAttemptTs = 0;
    await downloadScripMaster();
    const count = Object.keys(_scripMaster).length;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, scripMasterSize: count, sample: Object.keys(_scripMaster).filter(k=>k.startsWith('NIFTY-')).slice(0,5) }));
    return;
  }

  // T2S-CUG-20260716-001: Force-refresh active contracts — bypasses 60s throttle so new trade CMP tracking starts immediately
  if (req.method === 'GET' && urlPath === '/refresh-contracts') {
    const key = new URL('https://x' + req.url).searchParams.get('key');
    if (key !== 'T2SMonitor2026') { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'Unauthorized' })); return; }
    _activeContractsTs = 0; // reset throttle timestamp so refreshActiveContracts runs immediately
    await refreshActiveContracts();
    const contracts = _activeContracts.map(c => `${c.instrument}-${c.strike}-${c.type}`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, activeContracts: contracts, count: contracts.length }));
    return;
  }

  // T2S-CUG-20260716-003: Push UAT to Prod — fetches uat.html from GitHub, strips UAT elements, pushes as index.html
  if (req.method === 'GET' && urlPath === '/push-uat-to-prod') {
    const key = new URL('https://x' + req.url).searchParams.get('key');
    if (key !== 'T2SMonitor2026') { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'Unauthorized' })); return; }
    if (!GH_TOKEN) { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'GH_TOKEN not set on VM' })); return; }
    try {
      // 1. Fetch the current UAT file from GitHub
      const rawUrl = `https://raw.githubusercontent.com/${GH_REPO}/main/uat.html?t=${Date.now()}`;
      const fetchRes = await ft(rawUrl, {}, 20000);
      if (!fetchRes.ok) { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: `GitHub fetch HTTP ${fetchRes.status}` })); return; }
      let uatContent = await fetchRes.text();
      if (!uatContent || uatContent.length < 50000) { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: 'UAT file too short — aborting' })); return; }
      // 2. Strip UAT-only elements — the red badge + Test CMP button wrapper div
      const uatBadgeRe = /\s*<div style="position:fixed;top:6px;left:50%;transform:translateX\(-50%\);display:flex;align-items:center;gap:6px;z-index:9999;">[\s\S]*?<\/div>/;
      uatContent = uatContent.replace(uatBadgeRe, '');
      // Strip the UAT-only testDummyCmp JS function block
      const uatJsRe = /\n\s*\/\/ UAT-only: inject dummy LTPs[\s\S]*?\n\s*\}\n\s*<\/script>/;
      uatContent = uatContent.replace(uatJsRe, '\n</script>');
      // Strip CUG tag comments from deployed code
      uatContent = uatContent.replace(/\s*\/\/ T2S-CUG-[^\n]+\n/g, '\n');
      // Validate before pushing
      if (!uatContent.includes('<!DOCTYPE html>') || !uatContent.includes('SEBI') || uatContent.length < 50000) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'Validation failed — aborting push' })); return;
      }
      // 3. Push as index.html to Trade2Spend-Tracker repo
      const api = `https://api.github.com/repos/${GH_REPO}/contents/index.html`;
      const hdrs = { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
      const shaR = await ft(api, { headers: hdrs }, 8000);
      const sha = (await shaR.json()).sha || '';
      const encoded = Buffer.from(uatContent).toString('base64');
      const pushR = await ft(api, { method: 'PUT', headers: hdrs, body: JSON.stringify({ message: 'prod: promote UAT to prod via Admin PWA', content: encoded, sha, branch: 'main' }) }, 20000);
      if (!pushR.ok) { const t = await pushR.text(); res.writeHead(502); res.end(JSON.stringify({ ok: false, error: `GitHub push ${pushR.status}: ${t.slice(0,150)}` })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, message: 'UAT promoted to prod. Live at app.trade2spend.com in ~60s.' }));
      tgAlert('🚀 <b>UAT promoted to Prod</b> via Admin PWA button. Live in ~60s.').catch(() => {});
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
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

  // Browser LTP relay — GET /active-contracts-for-ltp?key=...
  // Returns active contracts + session headers so Admin PWA browser can fetch LTPs directly
  // Manual session-high override — POST /set-high?key=T2SMonitor2026
  // Body: { "NIFTY-24200-CE": 127, "NIFTY-24250-PE": 145 }
  if (req.method === 'POST' && urlPath === '/set-high') {
    const _shKey = new URL('https://x' + req.url).searchParams.get('key');
    if (_shKey !== 'T2SMonitor2026') { res.writeHead(401, { 'Access-Control-Allow-Origin': '*' }); res.end('{}'); return; }
    let _shBody = '';
    req.on('data', c => _shBody += c);
    req.on('end', async () => {
      try {
        const overrides = JSON.parse(_shBody || '{}');
        Object.entries(overrides).forEach(([k, v]) => {
          const h = parseFloat(v);
          if (h > 0) {
            const cur = _optionHighs[k]?.high || 0;
            _optionHighs[k] = { high: Math.max(h, cur), postId: _optionHighs[k]?.postId || null };
          }
        });
        if (_latestMarketData)
          _latestMarketData.optionHighs = Object.fromEntries(Object.entries(_optionHighs).map(([k,v]) => [k, v.high]));
        await saveState();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, highs: Object.fromEntries(Object.entries(_optionHighs).map(([k,v]) => [k, v.high])) }));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // Dummy like drip — POST /schedule-dummy-likes?key=T2SMonitor2026
  // Body: { "postId": "<uuid>" }
  // 25% chance: 0 likes. Otherwise 1–6 likes (skewed low). First: 1–20 min, each next: 1–15 min apart.
  if (req.method === 'POST' && urlPath === '/schedule-dummy-likes') {
    const _dlKey = new URL('https://x' + req.url).searchParams.get('key');
    if (_dlKey !== 'T2SMonitor2026') { res.writeHead(401, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: false })); return; }
    let _dlBody = '';
    req.on('data', c => _dlBody += c);
    req.on('end', () => {
      try {
        const { postId } = JSON.parse(_dlBody || '{}');
        if (!postId) { res.writeHead(400, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: false, error: 'missing postId' })); return; }
        // 25% of posts get no likes — not every post goes viral
        if (Math.random() < 0.25) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, scheduled: 0 }));
          return;
        }
        // 1–6 likes, skewed towards lower numbers (random × random biases toward 0)
        const total = 1 + Math.floor(Math.random() * Math.random() * 6);
        // First like: 1–20 min after posting; each next: 1–15 min after previous
        const delays = [];
        let _t = (1 + Math.random() * 19) * 60000;
        for (let i = 0; i < total; i++) { delays.push(_t); _t += (1 + Math.random() * 14) * 60000; }
        delays.forEach((delay, i) => {
          setTimeout(async () => {
            try {
              await sbFetch(`posts?id=eq.${postId}`, { method: 'PATCH', body: JSON.stringify({ dummy_likes: i + 1 }) });
            } catch(e) { console.error('[dummy-likes] patch failed:', e.message); }
          }, delay);
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, scheduled: total }));
      } catch(e) { res.writeHead(400, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  if (req.method === 'GET' && urlPath === '/active-contracts-for-ltp') {
    const k = new URL('https://x' + req.url).searchParams.get('key');
    if (k !== 'T2SMonitor2026') { res.writeHead(401, { 'Access-Control-Allow-Origin': '*' }); res.end('{}'); return; }
    if (!session.token || !_activeContracts.length) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ contracts: [], reason: session.token ? 'no_contracts' : 'not_logged_in' }));
      return;
    }
    const contracts = _activeContracts.map(c => {
      const numToken = getOptionToken(c.instrument, c.strike, c.type, c.expiry);
      const tradeSym = numToken ? null : buildTradingSymbol(c.instrument, c.strike, c.type, c.expiry);
      const identifier = numToken || tradeSym;
      return { key: `${c.instrument}-${c.strike}-${c.type}`, exchange: c.instrument === 'SENSEX' ? 'bse_fo' : 'nse_fo', identifier };
    }).filter(c => c.identifier);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      contracts,
      ltpBase: DATA_URL,
      headers: { 'Authorization': CONSUMER_KEY, 'Sid': session.sid, 'Auth': session.auth, 'neo-fin-key': 'neotradeapi', 'Content-Type': 'application/json' }
    }));
    return;
  }

  // Test CMP — GET /test-cmp?key=T2SMonitor2026
  // Returns dummy optionLTPs so UAT can verify the CMP display path without needing Kotak login
  if (req.method === 'GET' && urlPath === '/test-nse-chain') {
    const parsedUrl2 = new URL('https://x' + req.url);
    if (parsedUrl2.searchParams.get('key') !== 'T2SMonitor2026') {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    let result = {};
    try {
      if (!_nseCookies || Date.now() - _nseCookieTs > 10 * 60 * 1000) await refreshNSECookies();
      result.cookiesOk = !!_nseCookies;
      result.cookiesPreview = _nseCookies ? _nseCookies.slice(0, 80) : '(empty)';
      const r = await ft('https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY',
        { headers: { ...NSE_HEADERS, 'Cookie': _nseCookies } }, 10000);
      result.httpStatus = r.status;
      const txt = await r.text();
      result.bodyPreview = txt.slice(0, 300);
      if (r.ok) {
        const d = JSON.parse(txt);
        result.recordsCount = d?.records?.data?.length || 0;
        result.sampleStrikes = (d?.records?.data || []).slice(0, 3).map(x => ({ strike: x.strikePrice, exp: x.expiryDate, ce: x.CE?.lastPrice, pe: x.PE?.lastPrice }));
      }
    } catch(e) { result.error = e.message; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(result));
  }

  if (req.method === 'GET' && urlPath === '/test-cmp') {
    const parsedUrl = new URL('https://x' + req.url);
    if (parsedUrl.searchParams.get('key') !== 'T2SMonitor2026') {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      optionLTPs: {
        'NIFTY-24250-PE': 91.50,
        'NIFTY-24000-CE': 148.00,
        'NIFTY-24150-CE': 122.00,
        'NIFTY-24300-CE': 120.00
      },
      note: 'Dummy test data — not real prices'
    }));
  }

  // Test LTP — GET /test-ltp?key=T2SMonitor2026&symbol=NIFTY-24250-PE
  // Runs a real Kotak LTP fetch for one contract and returns full diagnostics
  if (req.method === 'GET' && urlPath === '/test-ltp') {
    const parsedUrl = new URL('https://x' + req.url);
    if (parsedUrl.searchParams.get('key') !== 'T2SMonitor2026') {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    const sym = parsedUrl.searchParams.get('symbol') || 'NIFTY-24250-PE';
    const parts = sym.split('-');
    const instrument = parts[0] || 'NIFTY';
    const strike = parts[1] || '24250';
    const optType = parts[2] || 'PE';
    const exchSeg = instrument === 'SENSEX' ? 'bse_fo' : 'nse_fo';
    // Try scrip master token first, then trading symbol fallback
    const expiry = resolveExpiry('weekly', instrument);
    const cachedToken = getOptionToken(instrument, strike, optType, expiry);
    const tradeSym = cachedToken ? null : buildTradingSymbol(instrument, strike, optType, expiry);
    const identifier = cachedToken || tradeSym || sym;
    const baseUrl = session.baseUrl || DATA_URL;
    const url = `${baseUrl}/script-details/1.0/quotes/neosymbol/${exchSeg}|${identifier}/ltp`;
    const headers = {
      'Authorization': CONSUMER_KEY,
      'Content-Type': 'application/json',
      'neo-fin-key': 'neotradeapi'
    };
    let status = 0, body = '', ltp = null;
    try {
      const r = await ftKotak(url, { headers }, 8000);
      status = r.status;
      body = await r.text();
      const d = JSON.parse(body);
      ltp = parseFloat(d?.data?.[0]?.ltp || (Array.isArray(d) ? d[0]?.ltp : null) || d?.ltp || 'NaN');
    } catch(e) {
      body = String(e);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      symbol: sym,
      identifier,
      url,
      status,
      ltp: isNaN(ltp) ? null : ltp,
      sid: session.sid ? session.sid.slice(0,8)+'...' : '(empty)',
      auth: session.auth ? session.auth.slice(0,8)+'...' : '(empty)',
      baseUrl,
      responsePreview: body.slice(0, 300)
    }));
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
      const gwBase = session.baseUrl || DATA_URL;
      if (testToken) {
        try {
          const url = `${gwBase}/script-details/1.0/quotes/neosymbol/nse_fo|${testToken}/ltp`;
          const r = await fetch(url, { headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi', 'Sid': session.sid, 'Auth': session.token }, signal: AbortSignal.timeout(4000) });
          const txt = await r.text();
          ltpTest = { url, status: r.status, body: txt.slice(0, 400), key: testKey, token: testToken };
        } catch(e) { ltpTest = { error: e.message, key: testKey, token: testToken }; }
      } else if (_activeContracts.length > 0) {
        // No scrip master — test LTP using trading symbol on a non-expired contract
        const c = _activeContracts.find(x => x.expiry !== '18JUN2026') || _activeContracts[0];
        const tradeSym = buildTradingSymbol(c.instrument, c.strike, c.type, c.expiry);
        ltpTest = { note: 'no scrip master — testing trading symbol', sym: tradeSym };
        if (tradeSym) {
          try {
            const url = `${gwBase}/script-details/1.0/quotes/neosymbol/nse_fo|${tradeSym}/ltp`;
            const r = await fetch(url, { headers: { 'Authorization': CONSUMER_KEY, 'Content-Type': 'application/json', 'neo-fin-key': 'neotradeapi', 'Sid': session.sid, 'Auth': session.token }, signal: AbortSignal.timeout(4000) });
            const txt = await r.text();
            ltpTest.status = r.status; ltpTest.body = txt.slice(0, 400);
          } catch(e) { ltpTest.error = e.message; }
        }
      } else { ltpTest = { note: 'no scrip master, no active contracts' }; }
    }
    const smNiftySample = Object.keys(_scripMaster).filter(k => k.startsWith('NIFTY-')).slice(0, 6);
    const smSensexSample = Object.keys(_scripMaster).filter(k => k.startsWith('SENSEX-')).slice(0, 3);
    const debugVars = { tokenOk: !!session.token, sidOk: !!session.sid, authOk: !!session.auth, baseUrl: session.baseUrl, contractsLen: _activeContracts.length, nseCookiesAge: _nseCookieTs ? Math.round((Date.now()-_nseCookieTs)/1000)+'s' : 'never' };
    res.end(JSON.stringify({
      hasToken: !!session.token,
      sessionAgeMins: Math.round((Date.now() - (session.lastLogin||0)) / 60000),
      activeContracts: _activeContracts.map(c => `${c.instrument}-${c.strike}-${c.type}-${c.expiry}`),
      optionLTPsCount: Object.keys(_optionChain).length,
      optionLTPsSample: Object.entries(_optionChain).slice(0,5),
      ltpDryMins: _ltpZeroSince ? Math.floor((Date.now()-_ltpZeroSince)/60000) : 0,
      activeContractsTs: _activeContractsTs ? Math.round((Date.now()-_activeContractsTs)/1000)+'s ago' : 'never',
      scripMasterSize: Object.keys(_scripMaster).length,
      scripMasterNiftySample: smNiftySample,
      scripMasterSensexLoaded: smSensexSample.length > 0,
      scripMasterSensexSample: smSensexSample,
      bseDownloadLog: _bseDownloadLog,
      expiryDates: Object.keys(_expiryDates).length > 0 ? _expiryDates : null,
      debugVars,
      marketScraperRunning: !!marketScraperInterval,
      kotakLtpRunning: !!_kotakLtpInterval,
      ltpTest,
      yahooMoversStatus: _yahooMoversStatus,
      khMemberRateSize: _khMemberRate.size
    }));
    return;
  }

  // Health check — GET /
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    // loggedIn is true only if session was created TODAY (IST) and within 8h
    // Stale state.json tokens from prior days correctly report false → triggers TOTP prompt
    const _sessionAge = Date.now() - (session.lastLogin || 0);
    const _isLoggedIn = !!session.token && _sessionAge < SESSION_MAX_AGE_MS;
    const _hIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const _hMins = _hIst.getHours() * 60 + _hIst.getMinutes();
    const _holidayActive = _marketHoliday && _hMins < 15 * 60 + 35;
    if (_marketHoliday && !_holidayActive) { _marketHoliday = false; saveHolidayState(); }
    res.end(JSON.stringify({
      ok: true, uptime: Math.round(process.uptime()),
      loggedIn: _isLoggedIn, kotakLtpRunning: !!_kotakLtpInterval, paperMode: state.paperMode,
      marketHoliday: _holidayActive,
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

  // ── POSTS BACKUP — POST /backup-post ────────────────────────────────────────
  if (req.method === 'OPTIONS' && urlPath === '/backup-post') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type,x-t2s-secret' });
    res.end(); return;
  }
  if (req.method === 'POST' && urlPath === '/backup-post') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    const secret = req.headers['x-t2s-secret'];
    if (!secret || secret !== process.env.EXECUTE_SECRET) {
      res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'Unauthorized' })); return;
    }
    if (!GH_TOKEN) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'GH_TOKEN not set on server' })); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let newPost;
      try { newPost = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
      try {
        const api = `https://api.github.com/repos/${GH_REPO}/contents/posts_backup.json`;
        const hdrs = { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
        const r = await ft(api, { headers: hdrs }, 8000);
        const cur = await r.json();
        const current = cur.content ? JSON.parse(Buffer.from(cur.content.replace(/\n/g, ''), 'base64').toString()) : { posts: [] };
        const sha = cur.sha || '';
        if (!current.posts.find(p => p.id === newPost.id)) current.posts.unshift(newPost);
        current.lastUpdated = new Date().toISOString();
        const encoded = Buffer.from(JSON.stringify(current, null, 2)).toString('base64');
        await ft(api, { method: 'PUT', headers: hdrs, body: JSON.stringify({ message: `backup: ${newPost.post_type||'post'}`, content: encoded, sha, branch: 'main' }) }, 12000);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // ── POSTS RESTORE — POST /restore-backup ─────────────────────────────────────
  if (req.method === 'OPTIONS' && urlPath === '/restore-backup') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type,x-t2s-secret' });
    res.end(); return;
  }
  if (req.method === 'POST' && urlPath === '/restore-backup') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    const secret = req.headers['x-t2s-secret'];
    if (!secret || secret !== process.env.EXECUTE_SECRET) {
      res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'Unauthorized' })); return;
    }
    if (!GH_TOKEN) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'GH_TOKEN not set on server' })); return; }
    req.on('data', () => {});
    req.on('end', async () => {
      try {
        // Fetch backup from GitHub
        const bkR = await ft(`https://raw.githubusercontent.com/${GH_REPO}/main/posts_backup.json?t=${Date.now()}`, {}, 8000);
        const backup = await bkR.json();
        const backupPosts = backup.posts || [];
        if (!backupPosts.length) { res.writeHead(200); res.end(JSON.stringify({ ok: true, restored: 0, message: 'Backup is empty' })); return; }
        // Fetch existing Supabase post IDs
        const sbR = await ft(`${SB_URL}/rest/v1/posts?select=id&limit=1000`, { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }, 8000);
        const existing = await sbR.json();
        const existingIds = new Set((existing || []).map(p => p.id));
        const toRestore = backupPosts.filter(p => !existingIds.has(p.id));
        let restored = 0;
        for (const post of toRestore) {
          try {
            await fetch(`${SB_URL}/rest/v1/posts`, {
              method: 'POST',
              headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
              body: JSON.stringify({ id: post.id, content: post.content, post_type: post.post_type, audience: post.audience, allow_sharing: post.allow_sharing ?? true, is_deleted: false, sent_at: post.sent_at, parent_id: post.parent_id || null })
            });
            restored++;
          } catch(e) { console.warn('[restore] skip', post.id, e.message); }
        }
        res.writeHead(200); res.end(JSON.stringify({ ok: true, restored, total: backupPosts.length }));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // ── BUG REPORT — POST /report-issue ─────────────────────────────────────────
  if (req.method === 'OPTIONS' && urlPath === '/report-issue') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type,x-t2s-secret' });
    res.end(); return;
  }
  if (req.method === 'POST' && urlPath === '/report-issue') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    const secret = req.headers['x-t2s-secret'];
    if (secret !== 'T2SMonitor2026') {
      res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'Unauthorized' })); return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let data = {};
      try { data = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
      const { tab = 'Unknown', description = '', screenshot = null, screenshotType = 'image/jpeg', reportedAt } = data;
      const istTime = new Date(reportedAt || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      try {
        // 1. Telegram text message
        await tgSend(`🐛 <b>Bug Report</b>\n<b>Tab:</b> ${tab}\n<b>Time:</b> ${istTime} IST\n\n${description}`);

        // 2. Upload screenshot to GitHub + send Telegram photo
        if (screenshot && GH_TOKEN) {
          const filename = `bug_screenshots/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jpg`;
          const api = `https://api.github.com/repos/${GH_REPO}/contents/${filename}`;
          const hdrs = { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
          try {
            await ft(api, { method: 'PUT', headers: hdrs, body: JSON.stringify({ message: `bug: ${tab}`, content: screenshot, branch: 'main' }) }, 15000);
            const rawUrl = `https://raw.githubusercontent.com/${GH_REPO}/main/${filename}`;
            await tgSendPhoto(rawUrl, `📸 ${tab}`);
          } catch(e) { console.error('[report-issue] screenshot upload:', e.message); }
        }

        // 3. Claude API — structured analysis + auto-fix patch
        let suggestion = '', patchData = null;
        if (ANTHROPIC_KEY) {
          try {
            const userText = `Bug report — Tab: ${tab}\n${description}`;
            const userContent = screenshot
              ? [{ type: 'image', source: { type: 'base64', media_type: screenshotType, data: screenshot } }, { type: 'text', text: userText }]
              : userText;
            const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: 'claude-sonnet-4-6', max_tokens: 800,
                system: `You are a bug-triage assistant for the Trade2Spend PWA.
Files: admin.html (Admin PWA at app.trade2spend.com/admin.html), index.html (Member PWA at app.trade2spend.com), server.js (Node.js VM at api.trade2spend.com).
Respond in EXACTLY this format — two sections, nothing else:

ANALYSIS:
<root cause in 1-2 sentences — name the specific function/CSS class/variable>

PATCH:
{"file":"<filename>","find":"<exact unique short string from source to replace>","replace":"<fixed string>"}

Rules for PATCH: "find" must be unique in the file and minimal. If patch cannot be determined precisely, use "find":null.`,
                messages: [{ role: 'user', content: userContent }]
              })
            });
            const aiData = await aiRes.json();
            suggestion = aiData?.content?.[0]?.text || '';
            // Parse structured response
            const aIdx = suggestion.indexOf('ANALYSIS:\n');
            const pIdx = suggestion.indexOf('\nPATCH:\n');
            const analysis = aIdx !== -1 ? suggestion.slice(aIdx + 10, pIdx !== -1 ? pIdx : undefined).trim() : suggestion;
            if (pIdx !== -1) {
              try { patchData = JSON.parse(suggestion.slice(pIdx + 8).trim()); } catch {}
            }
            // Map "Broken in" selection to target file
            const fileMap2 = {
              'admin': 'admin.html', 'member': 'index.html',
              'backend': 'server.js', 'vm': 'server.js', 'login': 'index.html'
            };
            const tabLower = tab.toLowerCase();
            let targetFile = patchData?.file || 'admin.html';
            for (const [k, v] of Object.entries(fileMap2)) { if (tabLower.includes(k)) { targetFile = v; break; } }

            // If Claude produced a precise patch, offer one-tap apply
            if (patchData?.find && GH_TOKEN) {
              const uuid = Date.now().toString(36);
              _pendingBugFixes[uuid] = { file: targetFile, find: patchData.find, replace: patchData.replace || '', summary: analysis };
              await tgSend(
                `🤖 <b>Claude's Fix</b>\n\n${analysis}\n\n<b>File:</b> ${targetFile}\n<b>Patch ready</b> — tap to apply:`,
                { inline_keyboard: [[
                  { text: '✅ Apply Fix', callback_data: `bugfix_apply:${uuid}` },
                  { text: '❌ Skip',      callback_data: `bugfix_skip:${uuid}` }
                ]]}
              );
            } else {
              // Fallback: fetch real code from GitHub and retry Claude with context
              if (analysis) await tgSend(`🤖 <b>Claude's initial read:</b>\n${analysis}\n\n⏳ Fetching code context for a precise fix...`);
              try {
                const ghFileMap3 = { 'admin.html': 'admin.html', 'index.html': 'index.html', 'server.js': 'server_deploy.js' };
                const rawUrl = `https://raw.githubusercontent.com/${GH_REPO}/main/${ghFileMap3[targetFile] || targetFile}?t=${Date.now()}`;
                const codeRes = await ft(rawUrl, {}, 15000);
                const fullCode = await codeRes.text();
                // Extract up to 400 relevant lines using keywords from description
                const keywords = description.toLowerCase().split(/\s+/).filter(w => w.length > 4);
                const lines = fullCode.split('\n');
                const matchedLines = new Set();
                lines.forEach((l, i) => { if (keywords.some(k => l.toLowerCase().includes(k))) { for (let j = Math.max(0,i-10); j <= Math.min(lines.length-1,i+10); j++) matchedLines.add(j); } });
                const snippet = matchedLines.size > 0
                  ? [...matchedLines].sort((a,b)=>a-b).slice(0, 400).map(i => `${i+1}: ${lines[i]}`).join('\n')
                  : lines.slice(0, 300).join('\n');
                // Retry Claude with code context
                const retry = await fetch('https://api.anthropic.com/v1/messages', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
                  body: JSON.stringify({
                    model: 'claude-sonnet-4-6', max_tokens: 800,
                    system: `You are a bug-triage assistant for the Trade2Spend PWA. You are given a relevant code snippet from ${targetFile}. Respond in EXACTLY this format:

ANALYSIS:
<root cause in 1-2 sentences>

PATCH:
{"file":"${targetFile}","find":"<exact unique string from the snippet>","replace":"<fixed string>"}

Rules: "find" must appear exactly once in the snippet. Minimal change only. If still uncertain, use "find":null.`,
                    messages: [{ role: 'user', content: [
                      ...(screenshot ? [{ type: 'image', source: { type: 'base64', media_type: screenshotType, data: screenshot } }] : []),
                      { type: 'text', text: `Bug: Tab=${tab}\n${description}\n\nCode snippet from ${targetFile}:\n\`\`\`\n${snippet}\n\`\`\`` }
                    ]}]
                  })
                });
                const retryData = await retry.json();
                const retryText = retryData?.content?.[0]?.text || '';
                const rAIdx = retryText.indexOf('ANALYSIS:\n');
                const rPIdx = retryText.indexOf('\nPATCH:\n');
                const retryAnalysis = rAIdx !== -1 ? retryText.slice(rAIdx + 10, rPIdx !== -1 ? rPIdx : undefined).trim() : retryText;
                let retryPatch = null;
                if (rPIdx !== -1) { try { retryPatch = JSON.parse(retryText.slice(rPIdx + 8).trim()); } catch {} }

                if (retryPatch?.find) {
                  const uuid = Date.now().toString(36);
                  _pendingBugFixes[uuid] = { file: targetFile, find: retryPatch.find, replace: retryPatch.replace || '', summary: retryAnalysis };
                  await tgSend(
                    `🤖 <b>Claude's Fix (with code context)</b>\n\n${retryAnalysis}\n\n<b>File:</b> ${targetFile}\n<b>Patch ready</b> — tap to apply:`,
                    { inline_keyboard: [[
                      { text: '✅ Apply Fix', callback_data: `bugfix_apply:${uuid}` },
                      { text: '❌ Skip',      callback_data: `bugfix_skip:${uuid}` }
                    ]]}
                  );
                } else {
                  await tgSend(`⚠️ <b>Auto-fix not possible</b>\n\n${retryAnalysis || analysis || 'Claude could not determine the exact fix.'}\n\nThe bug report has been saved. Describe it again at the start of your next Claude Code session — it will be fixed immediately with full code access.`);
                }
              } catch(e) {
                console.error('[report-issue] fallback retry:', e.message);
                await tgSend(`⚠️ <b>Auto-fix not possible</b>\n\n${analysis || 'Claude could not determine the fix.'}\n\nDescribe this issue at the start of your next Claude Code session — it will be fixed immediately.`);
              }
            }
          } catch(e) { console.error('[report-issue] Claude:', e.message); }
        }

        res.writeHead(200); res.end(JSON.stringify({ ok: true, suggestion }));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
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
      let { title = 'Trade2Spend', body: msgBody = 'New update', tag = 't2s-notif', url = 'https://app.trade2spend.com/#updates', postId } = payload;
      if (payload.audience === 'cug_test') url = 'https://app.trade2spend.com/uat.html#updates';
      // T2S-PROD-20260815-002: postId-based dedup — each postId is pushed exactly once, persists across VM restarts
      if (postId) {
        if (_pushSentMap.has(postId)) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, sent: 0, skipped: 'already_sent' }));
          return;
        }
        _pushSentMap.set(postId, Date.now()); // lock immediately — handles race conditions from double-tap
        savePushSent();
      } else {
        // Fallback body dedup for callers that don't pass postId
        const _pNow = Date.now();
        if (msgBody === _lastPushBody && _pNow - _lastPushTs < 30000) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, sent: 0, skipped: 'dedup' }));
          return;
        }
        _lastPushBody = msgBody;
        _lastPushTs   = _pNow;
      }
      // Reference body shown to free members (full content only for paid)
      const _freeBody = { 'trade_alert': '📊 Trade Alert — Open app to view', 'follow_up': '📊 Trade Update — Open app to view', 'market_update': '📈 Market Update — Open app to view', 'general': '💬 New Message — Open app to view' }[payload.post_type] || '🔔 New Update — Open app to view';
      try {
        // CUG routing — audience=cug_test sends only to CUG member devices
        let subs;
        if (payload.audience === 'cug_test') {
          const cugMembers = await sbFetch(`members?mobile=in.(${CUG_MOBILES.map(m => m.replace(/\+/g, '%2B')).join(',')})&select=id`);
          const cugIds = (cugMembers || []).map(m => m.id);
          if (!cugIds.length) { res.writeHead(200); res.end(JSON.stringify({ ok: true, sent: 0, skipped: 'no_cug_members' })); return; }
          subs = await sbFetch(`push_subscriptions?member_id=in.(${cugIds.join(',')})&select=id,member_id,subscription_json&order=last_used.desc`);
        } else {
          subs = await sbFetch('push_subscriptions?select=id,member_id,subscription_json&order=last_used.desc');
        }
        // Build member tier+status map for content filtering and disabled-member skip
        const _allMembers = await sbFetch('members?select=id,tier,status').catch(() => []);
        const _tierMap = Object.fromEntries((_allMembers || []).map(m => [m.id, { tier: m.tier, status: m.status }]));
        // Deduplicate by endpoint — one push per unique browser registration (handles multiple DB rows for same device)
        const _seenEps = new Set();
        const _dedupedSubs = subs.filter(sub => {
          try {
            const ep = (typeof sub.subscription_json === 'string' ? JSON.parse(sub.subscription_json) : sub.subscription_json).endpoint;
            if (_seenEps.has(ep)) return false;
            _seenEps.add(ep);
            return true;
          } catch { return true; }
        });
        // Unique tag per post — prevents notifications from collapsing each other when multiple posts arrive quickly
        const _notifTag = postId ? `t2s-post-${postId.slice(0, 8)}` : tag;
        // Send to ALL subscribed devices (per-member dedup removed — allows all devices to receive)
        const _pResults = await Promise.all(_dedupedSubs.map(async sub => {
          try {
            const memberInfo = sub.member_id ? _tierMap[sub.member_id] : null;
            if (memberInfo && memberInfo.status === 'disabled') return { id: sub.id, skipped: true };
            const notifBody = (memberInfo && memberInfo.tier === 'paid') ? msgBody : _freeBody;
            const sc = await sendWebPush(sub.subscription_json, JSON.stringify({ title, body: notifBody, tag: _notifTag, url }));
            return { id: sub.id, expired: sc === 410 || sc === 404 };
          } catch(e) { return { id: sub.id, failed: true }; }
        }));
        const sent    = _pResults.filter(r => !r.expired && !r.failed && !r.skipped).length;
        const failed  = _pResults.filter(r => r.failed).length;
        const skipped = _pResults.filter(r => r.skipped).length;
        const toDelete = _pResults.filter(r => r.expired).map(r => r.id);
        for (const id of toDelete) {
          await sbFetch(`push_subscriptions?id=eq.${id}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
        }
        console.log(`Push: ${sent} sent, ${failed} failed, ${skipped} skipped (disabled), ${toDelete.length} expired cleaned`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, sent, failed, skipped, cleaned: toDelete.length, total: subs.length }));
      } catch (e) {
        console.error('/send-push error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Test push — sends a single notification to one specific device (no secret needed, member-targeted)
  if (req.method === 'POST' && urlPath === '/test-push') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('end', async () => {
      try {
        const { memberId, deviceId } = JSON.parse(rawBody || '{}');
        if (!memberId) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'memberId required' })); return; }
        const subs = await sbFetch(`push_subscriptions?member_id=eq.${memberId}&device_id=eq.${encodeURIComponent(deviceId || 'web')}&select=id,subscription_json`);
        if (!subs || !subs.length) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'No subscription found — try tapping the bell again.' })); return; }
        const sc = await sendWebPush(subs[0].subscription_json, JSON.stringify({
          title: '✅ Trade Alerts Active',
          body: 'You will now get instant notifications whenever a new trade or update is posted.',
          tag: 't2s-test',
          url: 'https://app.trade2spend.com/#updates'
        }));
        if (sc === 410 || sc === 404) {
          await sbFetch(`push_subscriptions?id=eq.${subs[0].id}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
          res.writeHead(410); res.end(JSON.stringify({ ok: false, error: 'Subscription expired — please tap the bell again.' })); return;
        }
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('/test-push error:', e.message);
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Immediate contract refresh — called by admin PWA after posting a new trade alert
  if (req.method === 'POST' && urlPath === '/refresh-contracts') {
    const key = new URL('https://x' + req.url).searchParams.get('key');
    if (key !== 'T2SMonitor2026') {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    _activeContractsTs = 0; // bypass 60s cache so new contract is picked up immediately
    await refreshActiveContracts().catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, contracts: _activeContracts.length }));
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
  // Disconnect Kotak session — POST /logout-kotak
  if (req.method === 'POST' && urlPath === '/logout-kotak') {
    session.token     = null;
    session.sid       = null;
    session.rid       = null;
    session.auth      = null;
    session.lastLogin = 0;
    await saveState();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

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
loadHolidayState();
loadPushSent();
loadNifty50Cache();
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
  // Refresh Nifty 50 symbol list at startup if cache is older than 7 days
  if (!_nifty50Symbols || Date.now() - _nifty50SymbolsTs > N50_REFRESH_MS) {
    getNifty50Symbols().catch(() => {}); // non-blocking; runs in background
  }
  if (isMarketHours() && !marketScraperInterval) {
    startMarketScraper();
  } else if (!isMarketHours()) {
    // Market closed at startup — fetch Yahoo closing movers to update stale gainers/losers
    fetchYahooNifty50Movers().then(movers => {
      if (movers?.gainers?.length > 0 && _latestMarketData) {
        _latestMarketData.gainers = movers.gainers;
        _latestMarketData.losers  = movers.losers;
        console.log('[startup] Yahoo closing movers applied:', movers.gainers.length, 'gainers');
        const snapshot = { ..._latestMarketData };
        delete snapshot.optionLTPs; delete snapshot.expiry;
        pushMarketToGitHub(snapshot).catch(e => console.error('[startup] push movers failed:', e.message));
      }
    }).catch(() => {});
  }
}, 5000);

// ── SUPABASE TRADE SL MONITOR ─────────────────────────────────────────────────
// Extract option-price SL (< 5000) from reply text — ignores spot-level SLs
function extractOptSL(text) {
  const pats = [
    /(?:revised?|modif|moved?|shifted?|new|updated?)\s+sl\s+(?:to\s+)?(?:₹\s*)?(\d+(?:\.\d+)?)/i,
    /sl\s+(?:to|at|now|=)\s*(?:₹\s*)?(\d+(?:\.\d+)?)/i,
    /(?:sl|stop[\s-]?loss).{0,20}(?:revised?|changed|updated|moved)\s*(?:to\s*)?(?:₹\s*)?(\d+(?:\.\d+)?)/i,
    /\bsl\s+(?:₹\s*)?(\d+(?:\.\d+)?)\b/i  // bare "SL 166" or "SL ₹166"
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
      // T2S-SRV-20260721-001: detect trade direction — SELL uses cmp >= sl, BUY uses cmp <= sl
      const _postLo = (post.content || '').toLowerCase();
      const _isSellPost = /\bsell(?:ing)?\b/.test(_postLo);
      let sl = null;
      for (const r of pr) { const v = extractOptSL(r.content || ''); if (v) { sl = v; break; } }
      // "SL to cost / no loss" = entry price — resolve from original post
      if (!sl) {
        const hasCostSL = pr.some(r => /sl\s+(?:to|at|moved?\s+to|revised?\s+to)\s+cost|no[\s-]?loss|breakeven|cost\s+sl/i.test(r.content || ''));
        if (hasCostSL) {
          const em = (post.content || '').match(/(?:buy(?:ing)?|sell(?:ing)?)[\s\S]*?\bat\s+₹?\s*(\d+(?:\.\d+)?)/i);
          if (em) sl = parseFloat(em[1]);
        }
      }
      if (!sl) continue;
      const t = (post.content || '').toUpperCase();
      const im = t.match(/\b(NIFTY|BANKNIFTY|SENSEX|MIDCAP)\b/); if (!im) continue;
      const am = t.slice(t.indexOf(im[1]) + im[1].length).match(/\b(\d{4,6})\b/); if (!am) continue;
      const tm = t.match(/\b(CE|PE)\b/); if (!tm) continue;
      const key = `${im[1]}-${am[1]}-${tm[1]}`;
      const cmp = _optionChain[key];
      if (!cmp) continue;
      // Direction-aware SL check: SELL hits SL when premium RISES above sl; BUY when it falls below
      if (_isSellPost ? (cmp >= sl) : (cmp <= sl)) {
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
        const _dir = _isSellPost ? '≥' : '≤';
        await tgSend(`🔴 <b>SL HIT (auto)</b>\n<b>${key}</b>\nCMP ₹${cmp} ${_dir} SL ₹${sl}\nFollow-up posted to PWA.`);
      }
    }
  } catch(e) { console.error('[sb-sl]', e.message); }
}

// Auto-post "✅ Buying triggered" when live CMP first reaches the entry price
async function checkSupabaseTriggers() {
  if (!isMarketHours() || !session.token) return;
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const today = ist.toDateString();
  if (_sbTrigAlertDate !== today) { _sbTrigAlertedToday.clear(); _sbTrigAlertDate = today; }
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
    const STATUS_ONLY = /^(yet\s+to\s+trigger|not\s+triggered|watching|waiting|will\s+update|update\s+later|let.*see|tracking|monitoring|on\s+watch|avoid\s+(?:now|this|trade)|skip\s+(?:now|this|trade)|don['']?t\s+(?:take|enter))/i;

    for (const post of posts) {
      if (_sbTrigAlertedToday.has(post.id)) continue;
      const pr = rMap[post.id] || [];
      if (sbTradeFullyExited(pr)) { _sbTrigAlertedToday.add(post.id); continue; }
      // Skip if follow-ups already confirm trigger (non-status-only reply exists)
      const validReplies = pr.filter(r => !STATUS_ONLY.test((r.content||'').trim()) && !(r.content||'').includes('[T2S_UNLOCK]'));
      if (validReplies.length > 0) { _sbTrigAlertedToday.add(post.id); continue; }
      // Extract entry price — format: "I am buying Nifty 24200 CE at 110"
      const em = (post.content||'').match(/(?:buy(?:ing)?|sell(?:ing)?)[\s\S]*?\bat\s+₹?\s*(\d+(?:\.\d+)?)/i);
      if (!em) continue;
      const entry = parseFloat(em[1]);
      if (entry <= 0 || entry >= 5000) continue;
      // Build option chain key
      const t = (post.content||'').toUpperCase();
      const im = t.match(/\b(NIFTY|BANKNIFTY|SENSEX|MIDCAP)\b/); if (!im) continue;
      const am = t.slice(t.indexOf(im[1]) + im[1].length).match(/\b(\d{4,6})\b/); if (!am) continue;
      const tm = t.match(/\b(CE|PE)\b/); if (!tm) continue;
      const key = `${im[1]}-${am[1]}-${tm[1]}`;
      const cmp = _optionChain[key];
      if (!cmp) continue;
      const isSell = /\bsell(?:ing)?\b/i.test(post.content||'');
      const triggered = isSell ? (cmp <= entry) : (cmp >= entry);
      if (triggered) {
        _sbTrigAlertedToday.add(post.id);
        const ep = Math.round(cmp * 100) / 100;
        await sbFetch('posts', {
          method: 'POST',
          body: JSON.stringify({
            content: `✅ Buying triggered at ₹${entry}`,
            post_type: 'follow_up', audience: 'all',
            allow_sharing: false, is_deleted: false,
            parent_id: post.id, sent_at: new Date().toISOString()
          })
        });
        console.log(`[trigger-auto] ${key} triggered at ₹${ep} (entry ₹${entry})`);
      }
    }
  } catch(e) { console.error('[sb-trigger]', e.message); }
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

// Daily morning health check — runs at 9:30 AM IST on weekdays (VM-side, no Mac needed)
async function checkMorning() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return; // skip weekends
  const mins = ist.getHours() * 60 + ist.getMinutes();
  if (mins < 8 * 60 + 30 || mins > 8 * 60 + 45) return; // fire any time in 8:30–8:45 AM window (survives VM restart)
  const todayStr = ist.toDateString();
  if (_morningCheckDone === todayStr) return;
  _morningCheckDone = todayStr;

  const dateStr = ist.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', weekday: 'short' });

  // ── MESSAGE 1: System health ─────────────────────────────────────────────
  const kotakOk   = isSessionValid();
  const ltpCount  = Object.keys(_optionChain).length;
  const scraperOn = !!marketScraperInterval;
  const remMins   = session.lastLogin ? Math.round((SESSION_MAX_AGE_MS - (Date.now() - session.lastLogin)) / 60000) : null;

  const kotakLine  = kotakOk
    ? `✅ Kotak: Connected (${remMins}m remaining)`
    : `❌ Kotak: Not logged in — enter TOTP now`;
  const ltpLine    = ltpCount > 0
    ? `✅ CMP tracking: ${ltpCount} contract${ltpCount > 1 ? 's' : ''} live`
    : `⚠️ CMP tracking: No LTPs yet${kotakOk ? ' (populates after first trade)' : ''}`;
  const scraperLine = scraperOn ? `✅ Scraper: Running` : `❌ Scraper: Not running${kotakOk ? ' — will auto-start at 9:15' : ''}`;
  const allOk = kotakOk && scraperOn;

  await tgSend(
    `🌅 <b>Morning Check — ${dateStr}</b>\n\n${kotakLine}\n${ltpLine}\n${scraperLine}\n\n` +
    (allOk ? `All systems ready 👍` : `⚠️ Open Admin PWA → Setup → Enter TOTP`)
  );

  // ── MESSAGE 2: Open positions performance ────────────────────────────────
  try {
    const since = new Date(ist); since.setDate(since.getDate() - 30); // last 30 days
    const posts = await sbFetch(
      `posts?post_type=eq.trade_alert&is_deleted=eq.false&parent_id=is.null&sent_at=gte.${encodeURIComponent(since.toISOString())}&select=id,content,sent_at&order=sent_at.desc`,
      { method: 'GET' }
    );
    if (!posts.length) { await tgSend(`📊 <b>Open Positions</b>\n\nNo trade alerts in the last 30 days.`); return; }

    const reps = await sbFetch(
      `posts?is_deleted=eq.false&parent_id=in.(${posts.map(p => `"${p.id}"`).join(',')})&order=sent_at.asc&select=id,parent_id,content`,
      { method: 'GET' }
    );
    const rMap = {};
    reps.forEach(r => { (rMap[r.parent_id] = rMap[r.parent_id] || []).push(r); });

    const openLines = [], closedLines = [];
    for (const post of posts) {
      const t = (post.content || '').toUpperCase();
      const im = t.match(/\b(NIFTY|BANKNIFTY|SENSEX|MIDCAP)\b/);
      const sm = t.match(/\b(\d{4,6})\b/);
      const om = t.match(/\b(CE|PE)\b/);
      const em = (post.content || '').match(/(?:entry|buy(?:ing)?|at)\s*[₹@]?\s*(\d+(?:\.\d+)?)/i);
      const label = (im ? im[1] : '?') + (sm ? ' ' + sm[1] : '') + (om ? ' ' + om[1] : '');
      const entry = em ? parseFloat(em[1]) : null;
      const replies = rMap[post.id] || [];
      const exited  = sbTradeFullyExited(replies);
      let cum = 0;
      for (const r of replies) { const pm = (r.content || '').match(/exiting\s+(\d+)\s*%/i); if (pm) cum += parseInt(pm[1]); }
      const key = (im && sm && om) ? `${im[1]}-${sm[1]}-${om[1]}` : null;
      const cmp = key ? (_optionChain[key] || null) : null;
      const lot  = im ? ((_kotakLotSizes && _kotakLotSizes[im[1]]) || LOT_SIZES[im[1]] || 65) : 65;
      const postDate = new Date(post.sent_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

      if (exited || cum >= 100) {
        closedLines.push(`• <b>${label}</b> — Closed (${postDate})`);
      } else {
        let line = `• <b>${label}</b> @₹${entry || '?'}`;
        if (cum > 0) line += ` — ${cum}% exited`;
        if (cmp && entry) {
          const pts = om && om[1] === 'PE' ? entry - cmp : cmp - entry;
          const pnl = Math.round(pts * lot * (1 - cum / 100));
          line += ` | CMP ₹${cmp} | P&L ${pts >= 0 ? '+' : ''}${pts.toFixed(0)}pts (${pnl >= 0 ? '+' : ''}₹${Math.abs(pnl)})`;
        }
        openLines.push(line);
      }
    }

    let msg = `📊 <b>Open Positions — ${dateStr}</b>\n\n`;
    if (openLines.length) {
      msg += openLines.join('\n');
    } else {
      msg += `No open positions going into today.`;
    }
    if (closedLines.length) {
      msg += `\n\n<i>Recently closed:</i>\n` + closedLines.slice(0, 3).join('\n');
    }
    await tgSend(msg);
  } catch(e) { console.error('[morning-perf]', e.message); }
}

// Periodic check every 30s: SL monitor + market scraper auto-start/stop
setInterval(() => {
  if (isMarketHours()) {
    checkSLs().catch(e => tgAlert(`⚠️ SL poll: ${e.message}`));
    checkSupabaseSLs().catch(e => console.error('[sb-sl]', e.message));
    checkSupabaseTriggers().catch(e => console.error('[sb-trigger]', e.message));
    if (!marketScraperInterval) {
      const _todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toDateString();
      const _isFirstStartToday = _scraperRanTodayIST !== _todayIST;
      startMarketScraper();
      if (_isFirstStartToday) {
        // Normal daily 9:15 auto-start — calm confirmation, not an alarm
        tgAlert('📊 <b>Market scraper started</b> (9:15 IST)\nFetching NIFTY / SENSEX / BANKNIFTY every 15s\nAuto-stops at 3:35 PM IST').catch(()=>{});
      } else if (!_scraperStopAlerted) {
        // Was already running today and died mid-session — this is a real problem
        _scraperStopAlerted = true;
        tgAlert('⚠️ Market scraper stopped unexpectedly during market hours — auto-restarted.').catch(()=>{});
      }
    }
    if (session.token && session.baseUrl && !_kotakLtpInterval) {
      startKotakLtpInterval();
      console.warn('[ltp] RC-7: _kotakLtpInterval was null during market hours — restarted');
    }
  } else {
    _scraperStopAlerted = false; // reset so alert fires again next session if needed
  }
  checkResolveAlert().catch(e => console.error('[resolve-alert]', e.message));
  checkMorning().catch(e => console.error('[morning-check]', e.message));
}, 30_000);

// ── TUESDAY EXPIRY-DAY SCRIP MASTER REFRESH ──────────────────────────────────
// NIFTY expires every Tuesday. If a new trade is posted before the morning TOTP
// login, the scrip master cached from yesterday won't have the new weekly contract.
// This scheduler fires every Tuesday at 9:10 AM IST to pre-emptively refresh so
// fresh tokens are always available when trading begins.
function scheduleExpiryDayRefresh() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day  = now.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const h    = now.getHours();
  const m    = now.getMinutes();

  // Days until next Tuesday (day 2)
  let daysUntil = (2 - day + 7) % 7;
  // If today IS Tuesday and we haven't yet hit 9:10 AM → fire today; else next Tuesday (7 days)
  if (day === 2 && (h > 9 || (h === 9 && m >= 10))) daysUntil = 7;

  const target = new Date(now);
  target.setDate(target.getDate() + daysUntil);
  target.setHours(9, 10, 0, 0); // 9:10 AM IST

  const msUntil = target.getTime() - now.getTime();
  console.log(`[scrip] Next expiry-day refresh scheduled in ${Math.round(msUntil / 60000)} min (Tue 9:10 AM IST)`);

  setTimeout(async () => {
    console.log('[scrip] Tuesday expiry-day refresh — downloading fresh scrip master');
    _scripMasterTs = 0;          // force bypass of 22h cache
    _scripMasterAttemptTs = 0;   // reset retry rate-limit
    await downloadScripMaster().catch(e => console.error('[scrip] Tuesday refresh error:', e.message));
    scheduleExpiryDayRefresh();  // reschedule for next Tuesday
  }, msUntil);
}
scheduleExpiryDayRefresh();

tgAlert(`🟢 <b>Trade2Spend Bot v5.0 started</b>\nServer: api.trade2spend.com\nLoaded: ${Object.keys(state.trades).length} trades`).catch(() => {});
