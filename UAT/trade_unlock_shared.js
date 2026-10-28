// T2S-UAT shared trade-unlock engine (checkpoint stage1_posts_gatekeeper, 2026-10-25)
// Single source of truth for the paid_only trade-alert progressive-unlock rules.
// Loaded by UAT/uat.html as a browser <script> AND by Trading_Bot/server.js via
// require() on the VM — byte-identical logic in both places by construction, so the
// server's redaction decision can never drift from what the client would compute.
// parseFollowUpContent/extractTradeAlertFields/getFreeUnlockedFields/getMainContent are
// ported verbatim from UAT/uat.html — do not hand-edit one copy without the other; this
// IS the only copy. redactPostContent/redactReplyContent are new, server-side-only code:
// they mask ONLY the exact source character span of a locked value, found via each
// regex's own `d` (hasIndices) flag — never a re-search by parsed value — so a masked
// number can never collide with an unrelated unlocked number that happens to share the
// same value, and formatting quirks (trailing zeros etc.) can't leave a value unmasked
// (checkpoint stage1_posts_gatekeeper, Codex review round: the original re-search-by-value
// approach was rejected for exactly this reason).
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.T2SUnlock = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Every function below records WHERE (character span in the original `text`/`content`
  // argument) each sensitive value came from, alongside the parsed value itself — the
  // span is what redaction actually uses; the parsed value is what getFreeUnlockedFields
  // and the rest of the app logic use, exactly as before. Spans come from `match.indices`
  // (the `d` flag), so they always point at the EXACT matched group, not a guess.

  function parseFollowUpContent(text) {
    const lo = (text||'').toLowerCase().trim();
    const r = { type:'status', price:null, exitPct:null, slRevised:null, cmp:null,
                isHolding:false, isFullExit:false, noLossPossible:false, isAdminUnlock:false,
                t1Hit:false, t2Hit:false, t3Hit:false,
                _priceSpan:null, _slSpan:null, _cmpSpan:null };
    if (!text) return r;
    if (text.includes('[T2S_UNLOCK]')) { r.isAdminUnlock = true; return r; }
    const _negHoldRe = /\b(?:not|won'?t|will\s+not|wont|don'?t|dont|never)\b.{0,25}\bhold(?:ing)?\b.{0,20}\b(?:overnight|next\s+day|tomorrow)\b/i;
    if (!_negHoldRe.test(text) && /hold(?:ing)?\s+(?:for\s+)?(?:next\s+day|tomorrow|overnight|long(?:\s+term)?|positional|swing|marathon|long\s+hold)|(?:positional|swing)\s+trade|overnight\s+position/i.test(text))
        r.isHolding = true;
    const loNoFuture = lo.replace(/(?:till|until|if|when)\s+(?:the\s+)?(?:sl|stop\s*loss)\s+(?:is\s+)?(?:hit|triggered)/gi,'');
    if (/\bsl\b.{0,20}(?:hit|triggered|gone|breached)|stop[\s-]?loss.{0,15}(?:hit|triggered)/.test(loNoFuture)) { r.isFullExit=true; r.type='exit'; }
    if (/fully\s+exit|full\s+exit|position\s+clos|clos.*position|booked?\s+full|100\s*%\s*exit|exiting\s+full|exit\s+all/.test(lo)) { r.isFullExit=true; r.type='exit'; }
    if (/\bfully\s+out\b|trade\s+(?:is\s+)?(?:done|over|closed?)\b|exit(?:ed|ing)\s+(?:all|full(?:y)?|everything)|position\s+(?:done|over|exited?)|\ball\s+(?:closed?|out|done|exited?)/.test(lo)) { r.isFullExit=true; r.type='exit'; }
    if (/exit(?:ed|ing)\s+remaining|remaining\s+(?:exited?|booked?|clos(?:ed|ing)?)/.test(lo)) {
        const _hasSLSuffix = /\d+\s+as\s+(?:(?:my|the|a|an)\s+)?(?:sl|stop[\s-]?loss)\b/.test(lo);
        if (!_hasSLSuffix) { r.isFullExit=true; r.type='exit'; }
    }
    // `lo` is text.toLowerCase().trim() — case changes never shift character offsets, but
    // trim() does when there's leading whitespace. loOffset projects a `lo`-relative index
    // back onto the original `text` for span-based redaction.
    const loOffset = text.length - text.replace(/^\s+/, '').length;
    const em = lo.match(/(?:exit(?:ing|ed)?|book(?:ed|ing)?|clos(?:ed|ing)?)\s+(?:another\s+)?(\d+)\s*%/);
    if (em) { r.type='exit'; r.exitPct=parseInt(em[1]); }
    if (!r.isFullExit && !r.exitPct) {
        const exPriceM = lo.match(/\bexiting?\s+(?:with|at|@)\s*(?:₹\s*)?(\d{2,4}(?:\.\d+)?)/d);
        if (exPriceM) {
            const exitVal = parseFloat(exPriceM[1]);
            const [gs, ge] = exPriceM.indices[1];
            const afterStr = lo.slice(exPriceM.index + exPriceM[0].length, exPriceM.index + exPriceM[0].length + 25);
            const isSLPhrasing = /\bas\s+(?:(?:my|the|a|an)\s+)?(?:sl|stop[\s-]?loss|stoploss)\b/.test(afterStr);
            const cmpM = lo.match(/\bcmp\s*[=:]?\s*(?:₹\s*)?(\d{2,6}(?:\.\d+)?)/);
            const cmpDiffers = cmpM && Math.abs(parseFloat(cmpM[1]) - exitVal) > 0.5;
            if (isSLPhrasing || cmpDiffers) {
                r.slRevised = exitVal;
                r._slSpan = [loOffset + gs, loOffset + ge];
                if (!r.exitPct) r.type = 'sl_update';
            } else {
                r.isFullExit = true; r.type = 'exit'; r.price = exitVal;
                r._priceSpan = [loOffset + gs, loOffset + ge];
            }
        }
    }
    if (r.isFullExit && !r.price && !r.exitPct) {
        const slHitExitM = lo.match(/\bexit(?:ed|ing)?\b(?:\s+\S+){0,3}?\s+(?:with|at|@)\s*(?:₹\s*)?(\d{2,4}(?:\.\d+)?)/d);
        if (slHitExitM) {
            r.price = parseFloat(slHitExitM[1]);
            const [gs, ge] = slHitExitM.indices[1];
            r._priceSpan = [loOffset + gs, loOffset + ge];
        }
    }
    if (!r.price) {
        const wm = text.match(/(?:went|goes?|now at?|currently|trading at)\s+(?:to\s+)?(\d{2,4}(?:\.\d+)?)/id);
        if (wm) {
            const n=parseFloat(wm[1]);
            if(n>5&&n<9999){ r.price=n; r._priceSpan=wm.indices[1].slice(); }
        }
    }
    const lmSrc = text.replace(/^\s+/, '');
    const lm = lmSrc.match(/^(\d{2,4}(?:\.\d+)?)\+?\s*(?:[,\n\r\s]|$)/d);
    if (lm) {
        const n=parseFloat(lm[1]);
        if(n>5&&n<9999){
            r.price=n; if(r.type==='status') r.type=r.exitPct?'exit':'cmp_update';
            const [gs, ge] = lm.indices[1];
            r._priceSpan=[loOffset+gs, loOffset+ge];
        }
    }
    if (!r.price) {
        const pm = text.match(/(?:(?:at|@)\s*₹?\s*|₹\s*)(\d{2,4}(?:\.\d+)?)\b/id);
        if (pm) {
            const n=parseFloat(pm[1]);
            if(n>5&&n<9999){ r.price=n; r._priceSpan=pm.indices[1].slice(); }
        }
    }
    if (/sl\s+(?:to|at|moved?\s+to|revised?\s+to|of\s+remaining\s+to)\s+cost|modif[a-z]*\s+sl[^0-9]*to\s+cost|sl\s+at\s+entry|at\s+breakeven/i.test(text)) {
        r.slRevised='cost'; r.noLossPossible=true; if(!r.exitPct) r.type='sl_update';
    }
    if (!r.slRevised) {
        const slPats = [
            /(?:revised?|modif(?:y|ied|ying)|moved?|shifted?|new|updated?)\s+sl\s+(?:(?:of|for)\s+(?:\w+\s+){0,3})?(?:to\s+)?(\d+(?:\.\d+)?)/id,
            /\bsl\s+(?:revised?|modif(?:y|ied|ying)|moved?|shifted?|updated?)\s+(?:to\s+)?(\d+(?:\.\d+)?)/id,
            /sl\s+(?:to|of|at|now|=)\s*(\d+(?:\.\d+)?)/id,
            /stop[\s-]?loss\s+(?:to|at|now|revised?)\s*(\d+(?:\.\d+)?)/id,
            /moving\s+sl\s+to\s+(\d+(?:\.\d+)?)/id,
            /trail(?:ing)?\s+sl\b[:\s]*(\d+(?:\.\d+)?)/id,
            /sl\s+updated?\b[:\s]*(\d+(?:\.\d+)?)/id,
            /revised?\s+sl\b[:\s]*(\d+(?:\.\d+)?)/id,
            /(\d+(?:\.\d+)?)\s+as\s+(?:(?:my|the|a|an)\s+)?(?:sl|stop[\s-]?loss|stoploss)\b/id,
            /\bsl\s+(?:₹\s*)?(\d+(?:\.\d+)?)\b/id
        ];
        for (const p of slPats) {
            const m=text.match(p);
            if(m&&m[1]){
                r.slRevised=parseFloat(m[1]); if(!r.exitPct) r.type='sl_update';
                r._slSpan = m.indices[1].slice();
                break;
            }
        }
    }
    if (/no\s+loss\s+(?:possible|now)|can.t\s+lose/i.test(text)) r.noLossPossible=true;
    const cm = text.match(/cmp\s*[=:]?\s*(?:₹\s*)?(\d{2,6}(?:\.\d+)?)/id);
    if (cm) {
        const n=parseFloat(cm[1]);
        if(n>5){ r.cmp=n; r._cmpSpan=cm.indices[1].slice(); }
    }
    if (/\bt1\s*(?:hit|achieved|done|booked?|reached?)|\btarget[\s-]?1\s*(?:hit|done|achieved|reached?)/i.test(text)) r.t1Hit = true;
    if (/\bt2\s*(?:hit|achieved|done|booked?|reached?)|\btarget[\s-]?2\s*(?:hit|done|achieved|reached?)/i.test(text)) r.t2Hit = true;
    if (/\bt3\s*(?:hit|achieved|done|booked?|reached?)|\btarget[\s-]?3\s*(?:hit|done|achieved|reached?)/i.test(text)) r.t3Hit = true;
    return r;
  }

  function extractTradeAlertFields(content) {
    const f={instrument:null,strike:null,optType:null,expiry:null,entry:null,sl:null,action:null,
             _optTypeSpan:null,_entrySpan:null,_slSpan:null,_expirySpan:null};
    if (!content) return f;
    const lo = content.toLowerCase();
    if (/\bbuying\b|\bbuy\b/.test(lo)) f.action='BUY'; else if (/\bselling\b|\bsell\b/.test(lo)) f.action='SELL';
    if (/bank\s*nifty/i.test(content)) f.instrument='BANKNIFTY';
    else if (/\bnifty\b/i.test(content)) f.instrument='NIFTY';
    else if (/\bsensex\b/i.test(content)) f.instrument='SENSEX';
    else if (/\bfinnifty\b/i.test(content)) f.instrument='FINNIFTY';
    else if (/\bbankex\b/i.test(content)) f.instrument='BANKEX';
    const sm = content.match(/(?:nifty|banknifty|bank\s*nifty|sensex|finnifty)\s+(\d{4,6})/i);
    if (sm) f.strike = sm[1];
    if (!f.instrument) {
        const stockM = content.match(/\b([A-Z]{2,12})\s+(\d{3,7})\s+(?:Monthly|Weekly|Next\s+Weekly)?\s*(CE|PE)\b/id);
        if (stockM) {
            f.instrument = stockM[1].toUpperCase();
            if (!f.strike) f.strike = stockM[2];
            if (!f.optType) { f.optType = stockM[3].toUpperCase(); f._optTypeSpan = stockM.indices[3].slice(); }
        }
    }
    // Original is unconditional here (not gated by `if (!f.optType)`) — this generic check
    // always runs and its result wins over stockM's, since content containing a stockM-style
    // "RELIANCE 1280 CE" also always matches this plain /\bce\b/ check. Preserved verbatim:
    // whichever of these two runs last decides f.optType/f._optTypeSpan.
    const ceM = content.match(/\bce\b|\bcall\b/id);
    if (ceM) { f.optType='CE'; f._optTypeSpan = ceM.indices[0].slice(); }
    else {
        const peM = content.match(/\bpe\b|\bput\b/id);
        if (peM) { f.optType='PE'; f._optTypeSpan = peM.indices[0].slice(); }
    }
    let expiryM = null;
    if (/next\s+weekly/i.test(lo)) { f.expiry='Next Weekly'; expiryM = content.match(/next\s+weekly/id); }
    else if (/monthly/i.test(lo)) { f.expiry='Monthly'; expiryM = content.match(/monthly/id); }
    else if (/weekly/i.test(lo)) { f.expiry='Weekly'; expiryM = content.match(/weekly/id); }
    else if (/today.s?\s+expiry|expiry\s+today/i.test(lo)) { f.expiry="Today's Expiry"; expiryM = content.match(/today.s?\s+expiry|expiry\s+today/id); }
    if (!f.expiry) {
        const dm=content.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/id);
        if(dm) { f.expiry=`${dm[1]} ${dm[2].charAt(0).toUpperCase()+dm[2].slice(1).toLowerCase()} ${dm[3]}`; expiryM = dm; }
    }
    if (expiryM) f._expirySpan = expiryM.indices[0].slice();
    const em = content.match(/\bat\s+(\d+(?:\.\d+)?)/id);
    if (em) {
        const n=parseFloat(em[1]);
        if(n>1&&n<9999){ f.entry=n; f._entrySpan=em.indices[1].slice(); }
    }
    const slm = content.match(/(below|above)\s+(\d{2,6}(?:\.\d+)?)/id);
    if (slm) {
        f.sl = parseFloat(slm[2]); f.slDirection = slm[1].toLowerCase();
        f._slSpan = slm.indices[2].slice();
    }
    if (!f.slDirection && f.action && f.optType) {
        const _bullish = (f.action==='BUY'&&f.optType==='CE')||(f.action==='SELL'&&f.optType==='PE');
        f.slDirection = _bullish ? 'below' : 'above';
    }
    const sustM = content.match(/for\s+(\d+)\s+min/i);
    if (sustM) f.slSustainMinutes = parseInt(sustM[1]);
    return f;
  }

  function getMainContent(c) { return (c||'').replace(/\[WHY\][\s\S]*?\[\/WHY\]/gi,'').trim(); }

  function getFreeUnlockedFields(replies, postSentAt) {
    const u = { callPut:false, entry:false, expiry:false, cmp:false, sl:false, all:false };
    let cumExit = 0;
    for (const r of (replies||[])) {
        const c = r.content||'';
        if (c.includes('[T2S_UNLOCK]')) { u.all=true; return u; }
        const p = parseFollowUpContent(c);
        if (p.isFullExit) { u.callPut=true; u.entry=true; u.expiry=true; u.cmp=true; u.sl=true; }
        if (p.exitPct) {
            cumExit = Math.min(100, cumExit + p.exitPct);
            if (cumExit >= 50) { u.callPut=true; u.entry=true; u.expiry=true; u.cmp=true; }
        }
        if (p.slRevised) u.sl=true;
    }
    if (u.sl) { u.callPut=true; u.entry=true; u.expiry=true; u.cmp=true; }
    if (postSentAt && !u.all) {
        const tz = { timeZone: 'Asia/Kolkata' };
        const nowIST = new Date(new Date().toLocaleString('en-US', tz));
        const nowMins = nowIST.getHours()*60 + nowIST.getMinutes();
        const postIST = new Date(new Date(postSentAt).toLocaleString('en-US', tz));
        const isSameDay = postIST.toDateString() === nowIST.toDateString();
        const postMins = postIST.getHours()*60 + postIST.getMinutes();
        if (isSameDay && postMins < 14*60+45 && nowMins >= 14*60+45) u.all = true;
    }
    return u;
  }

  // Splices out a list of [start,end] spans from `text`, replacing each with a fixed
  // placeholder. Applies from the END backward so earlier spans' indices stay valid as
  // later ones are replaced (replacing a span changes the string length).
  function _maskSpans(text, spans) {
    const valid = spans.filter(s => s && s[0] != null && s[1] > s[0]).sort((a,b) => b[0]-a[0]);
    let out = text;
    for (const [start, end] of valid) out = out.slice(0, start) + '•••' + out.slice(end);
    return out;
  }

  // ── PARENT POST REDACTION (new, server-side use only) ──
  // callPut/entry/sl/expiry are the fields buildTradeAlertCard() actually gates on the
  // PARENT post for a locked free viewer (instrument, strike, action are always shown —
  // confirmed unconditional in the card template). Masks only the exact character span
  // extractTradeAlertFields() matched for each locked field — never a value re-search.
  function redactPostContent(content, unlocked) {
    if (!content) return content;
    const f = extractTradeAlertFields(content);
    const spans = [];
    if (!unlocked.callPut) spans.push(f._optTypeSpan);
    if (!unlocked.entry) spans.push(f._entrySpan);
    if (!unlocked.sl) spans.push(f._slSpan);
    if (!unlocked.expiry) spans.push(f._expirySpan);
    return _maskSpans(content, spans);
  }

  // NOTE: reply content is intentionally NOT surgically redacted (an earlier draft of this
  // file did this and was removed). Confirmed by reading the actual render path
  // (uat.html:4060-4064, 4112-4122): the client already shows a reply's raw content VERBATIM
  // to a free viewer once it passes two existing filters — not a [T2S_UNLOCK] marker, and
  // not itself individually marked audience='paid_only'. That per-reply audience flag is an
  // existing ADMIN-CONTROLLED choice (the admin decides whether a given update is safe to
  // reveal immediately or should stay paid-only), not a client-side display gate tied to
  // getFreeUnlockedFields. So there is no gap between what the UI shows and what the network
  // already sends for replies today — the only thing the gatekeeper needs to enforce for
  // replies is the SAME binary audience==='paid_only' drop already used for Part A (general/
  // market_update posts), not a numeric mask. See redactPostContent for the one real gap
  // (the PARENT trade_alert post's own extracted summary fields, which DO have a getFreeUnlockedFields-driven
  // display gate the network response doesn't currently respect).

  return {
    parseFollowUpContent,
    extractTradeAlertFields,
    getFreeUnlockedFields,
    getMainContent,
    redactPostContent
  };
});
