/* core.js - shared code for the analysis pages (currencies, metals, crypto, ratio).
   Keep this file in the same folder as the pages. */
const HOUR = 3600 * 1000;
// currencies and metals do not trade from Friday ~22:00 UTC to Sunday ~22:00 UTC
const isClosed = t => { const d = new Date(t), wd = d.getUTCDay(), h = d.getUTCHours(); return wd === 6 || (wd === 5 && h >= 22) || (wd === 0 && h < 22); };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const pad = n => String(n).padStart(2, '0');
const stamp = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
let fmt = v => v == null ? '–' : (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6));
const sig = v => v == null ? '–' : Number(v).toPrecision(4);

// ---------------- indicators ----------------
function sma(v, n) {
  const out = []; let sum = 0;
  for (let i = 0; i < v.length; i++) { sum += v[i]; if (i >= n) sum -= v[i - n]; out.push(i >= n - 1 ? sum / n : null); }
  return out;
}
function ema(v, n) {
  const k = 2 / (n + 1), out = []; let e = null;
  for (let i = 0; i < v.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    e = e === null ? v.slice(0, n).reduce((a, b) => a + b, 0) / n : v[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
const avg = (v, type, n) => type === 'EMA' ? ema(v, n) : sma(v, n);

function rsiCalc(v, n) {                       // Wilder's RSI
  const out = Array(v.length).fill(null);
  if (v.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i-1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i-1];
    ag = (ag * (n - 1) + (d > 0 ? d : 0)) / n;
    al = (al * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function macdCalc(v) {
  const e12 = ema(v, 12), e26 = ema(v, 26);
  const macd = v.map((_, i) => e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
  const first = macd.findIndex(x => x != null);
  const sg = Array(v.length).fill(null);
  if (first >= 0) ema(macd.slice(first), 9).forEach((x, k) => { sg[first + k] = x; });
  const hist = macd.map((m, i) => m != null && sg[i] != null ? m - sg[i] : null);
  return { macd, sig:sg, hist };
}
function bollCalc(v, n, k) {
  const mid = sma(v, n), up = [], lo = [];
  for (let i = 0; i < v.length; i++) {
    if (mid[i] == null) { up.push(null); lo.push(null); continue; }
    let s = 0; for (let j = i - n + 1; j <= i; j++) { const d = v[j] - mid[i]; s += d * d; }
    const sd = Math.sqrt(s / n);
    up.push(mid[i] + k * sd); lo.push(mid[i] - k * sd);
  }
  return { mid, up, lo };
}

// ---------------- shared indicator set ----------------
function computeInd(p, o) {
  const m = macdCalc(p);
  return { p, fast:avg(p, o.maType, o.maFast), slow:avg(p, o.maType, o.maSlow), rsi:rsiCalc(p, o.rsiN), macd:m.macd, msig:m.sig, hist:m.hist, bb:bollCalc(p, o.bbN, o.bbK) };
}
function lastOf(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; }

// ---------------- saving a file (CSV) ----------------
async function saveBlob(blob, name) {
  try {
    if (window.showSaveFilePicker) {
      const fh = await showSaveFilePicker({ suggestedName:name, types:[{ description:'CSV file', accept:{ 'text/csv':['.csv'] } }] });
      const w = await fh.createWritable(); await w.write(blob); await w.close(); return;
    }
  } catch (e) { if (e.name === 'AbortError') return; }
  try {
    const f = new File([blob], name, { type:'text/csv' });
    if (navigator.canShare && navigator.canShare({ files:[f] })) { await navigator.share({ files:[f], title:name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

// ---------------- warning when saved prices are old ----------------
const PT_GROUP = { XAU:'metal', XAG:'metal', XPT:'metal', CHF:'currency', EUR:'currency', JPY:'currency', GBP:'currency', BTC:'crypto', ETH:'crypto' };
function showStale(rows, keys) {
  const box = document.getElementById('stale'); if (!box) return;
  const now = Date.now(), msg = [];
  let worst = 0;
  keys.forEach(k => {
    let t = null;
    for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].v && rows[i].v[k] != null) { t = rows[i].t; break; } }
    const grp = PT_GROUP[k] || 'crypto', closed = grp !== 'crypto' && isClosed(now);
    const age = t == null ? Infinity : (now - t) / 3600000;
    const limitOrange = closed ? 72 : 2, limitRed = closed ? 96 : 6;
    if (age > limitOrange) { worst = Math.max(worst, age > limitRed ? 2 : 1); msg.push(k + (t == null ? ': no saved price yet' : ': last price ' + (age < 48 ? age.toFixed(1) + ' hours' : Math.round(age / 24) + ' days') + ' old')); }
  });
  if (!msg.length) { box.innerHTML = ''; return; }
  const col = worst === 2 ? '#7a1f1a' : '#7a4a0e', bd = worst === 2 ? '#f85149' : '#f0883e';
  box.innerHTML = `<div style="background:${col};border:1px solid ${bd};border-radius:8px;padding:9px 11px;margin-bottom:10px;font-size:.85rem">` +
    `<b>⚠ Saved prices are old.</b> ${msg.join(' · ')}. The collector may have stopped: on GitHub open Actions, then “Collect prices”, and look for a red cross. <a href="health.html" style="color:#fff">Data health page</a></div>`;
}

// ---------------- daily view (the bigger trend) ----------------
function dailyTrend(h) {                       // h = hourly points [{t, p}]; uses the last price of each UTC day
  const days = []; let day = null;
  for (const x of h) { const d = Math.floor(x.t / 86400000); if (d !== day) { days.push(x.p); day = d; } else days[days.length - 1] = x.p; }
  if (days.length < 55) return null;
  const n = days.length - 1, f = sma(days, 20)[n], s = sma(days, 50)[n], p = days[n], r = rsiCalc(days, 14)[n];
  const vote = 0.5 * Math.sign(f - s) + 0.5 * Math.sign(p - s);
  return { dir: vote > TH ? 1 : vote < -TH ? -1 : 0, f, s, p, rsi:r, days:days.length };
}
function dailyNote(dt, T) {
  const word = dt.dir > 0 ? '<b class="up">UP</b>' : dt.dir < 0 ? '<b class="down">DOWN</b>' : '<b>MIXED</b>';
  let t = `<b>Daily view (the bigger trend):</b> ${word}. The price is ${dt.p >= dt.s ? 'above' : 'below'} its 50-day average and the 20-day average is ${dt.f >= dt.s ? 'above' : 'below'} the 50-day one` + (dt.rsi != null ? `; daily RSI ${dt.rsi.toFixed(0)}.` : '.');
  if (Math.abs(T) > TH && dt.dir !== 0) t += dt.dir === Math.sign(T) ? ' The hourly view agrees with the daily trend, which makes it more reliable.'
    : ' <span class="warn">The hourly view goes AGAINST the daily trend: treat it as a short-term move only and keep positions small.</span>';
  return t;
}

// ---------------- dollar basket (EUR, JPY, GBP, CHF with dollar-index weights) ----------------
const DXY_W = { EUR:0.6644, JPY:0.1569, GBP:0.1373, CHF:0.0415 }, DXY_REF = { EUR:1.10, JPY:0.0070, GBP:1.30, CHF:1.12 };
function dollarIndexAt(v) {
  let lg = 0; for (const k in DXY_W) { if (!(v[k] > 0)) return null; lg -= DXY_W[k] * Math.log(v[k] / DXY_REF[k]); }
  return 100 * Math.exp(lg);
}
function dollarSeries() {
  const out = [];
  for (const r of rows) { if (isClosed(r.t)) continue; const x = r.v && dollarIndexAt(r.v); if (x != null) out.push({ t:r.t, x }); }
  return out;
}
function dollarContext(t0) {
  if (t0 == null) return null;
  const s = dollarSeries(); if (s.length < 3) return null;
  const a = s.find(x => x.t >= t0) || s[0], b = s[s.length - 1], pct = (b.x / a.x - 1) * 100;
  return `<b>Dollar check (this period):</b> a dollar basket (euro, yen, pound, franc, weighted like the dollar index) moved ${(pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(2)}% to about ${b.x.toFixed(1)}, so the dollar is ${pct > 0.15 ? 'STRONGER' : pct < -0.15 ? 'WEAKER' : 'about unchanged'}. A stronger dollar tends to weigh on gold and crypto, a weaker one to support them, but this link is often broken by other news.`;
}

// ---------------- risk calculator ----------------
let riskInfo = null, riskEntryTouched = false;
function initRisk(id) {
  const box = document.getElementById(id); if (!box) return;
  const sv = store.get('pt_risk', { cap:1000, pct:1 });
  box.innerHTML = `<div class="card"><h2>Risk calculator</h2>
    <div class="status">How much can you buy or sell so that, if your exit level is hit, you lose only the amount you accept? Just arithmetic: it does not say whether to trade.</div>
    <div class="row">
      <label>Capital (USD)<br><input type="number" id="rk_cap" min="0" step="any" value="${sv.cap}"></label>
      <label>Risk per trade (%)<br><input type="number" id="rk_pct" min="0" step="0.1" value="${sv.pct}"></label>
      <label>Direction<br><select id="rk_dir"><option value="1">Buy</option><option value="-1">Sell short</option></select></label>
    </div>
    <div class="row">
      <label>Entry price<br><input type="number" id="rk_ent" step="any"></label>
      <label>Exit (stop) price<br><input type="number" id="rk_stop" step="any"></label>
    </div>
    <div class="row" id="rk_sug"></div>
    <div class="stats" id="rk_out"></div></div>`;
  const $ = x => document.getElementById(x);
  ['rk_cap', 'rk_pct', 'rk_dir', 'rk_ent', 'rk_stop'].forEach(x => $(x).addEventListener('input', () => { if (x === 'rk_ent') riskEntryTouched = true; if (x === 'rk_cap' || x === 'rk_pct') store.set('pt_risk', { cap:Number($('rk_cap').value) || 0, pct:Number($('rk_pct').value) || 0 }); riskCalc(); }));
  $('rk_dir').addEventListener('change', riskCalc);
  $('rk_sug').addEventListener('click', e => { const v = e.target.dataset.v; if (v) { $('rk_stop').value = v; riskCalc(); } });
}
function riskUpdate(info) {
  const $ = x => document.getElementById(x); if (!$('rk_ent')) return;
  const changed = !riskInfo || riskInfo.key !== info.key;
  riskInfo = info;
  if (changed) { riskEntryTouched = false; $('rk_stop').value = ''; if (info.dir) $('rk_dir').value = String(info.dir); }
  if (!riskEntryTouched && info.price != null) $('rk_ent').value = Number(info.price.toPrecision(6));
  const sell = $('rk_dir').value === '-1', sug = [];
  const rnd = v => Number(v.toPrecision(6));
  const okSide = v => v != null && (sell ? v > Number($('rk_ent').value) : v < Number($('rk_ent').value));
  if (okSide(info.slow)) sug.push(`<button class="alt" data-v="${rnd(info.slow)}">Slow average ${fmt(info.slow)}</button>`);
  const band = sell ? info.up : info.lo;
  if (okSide(band)) sug.push(`<button class="alt" data-v="${rnd(band)}">${sell ? 'Upper' : 'Lower'} band ${fmt(band)}</button>`);
  $('rk_sug').innerHTML = sug.length ? '<span class="status" style="margin:0">Suggested exit levels:</span> ' + sug.join(' ') : '<span class="status" style="margin:0">The usual exit levels (slow average, band) are on the wrong side of your entry price: choose your own exit level.</span>';
  riskCalc();
}
function riskCalc() {
  const $ = x => document.getElementById(x), out = $('rk_out'); if (!out) return;
  const cap = Number($('rk_cap').value), pct = Number($('rk_pct').value), ent = Number($('rk_ent').value), stop = Number($('rk_stop').value), sell = $('rk_dir').value === '-1';
  if (!(cap > 0) || !(pct > 0) || !(ent > 0)) { out.textContent = 'Enter your capital, the risk per trade and the entry price.'; return; }
  if (!(stop > 0)) { out.textContent = 'Enter an exit (stop) price, or tap a suggested level.'; return; }
  if (sell ? stop <= ent : stop >= ent) { out.innerHTML = `<span class="warn">For a ${sell ? 'short sale' : 'purchase'} the exit price must be ${sell ? 'above' : 'below'} the entry price.</span>`; return; }
  const risk = cap * pct / 100, dist = Math.abs(ent - stop), units = risk / dist, value = units * ent, distPct = dist / ent * 100;
  const f = v => v >= 100 ? v.toLocaleString(undefined, { maximumFractionDigits:2 }) : Number(v.toPrecision(5)).toString();
  const t1 = sell ? ent - dist : ent + dist, t2 = sell ? ent - 2 * dist : ent + 2 * dist;
  out.innerHTML = `Maximum loss if the exit is hit: <b>${f(risk)} USD</b> (${pct}% of your capital).<br>` +
    `Distance to the exit: <b>${distPct.toFixed(2)}%</b> of the price.<br>` +
    `Position size: <b>${f(units)} ${riskInfo ? riskInfo.name : 'units'}</b>, worth about <b>${f(value)} USD</b> (${(value / cap * 100).toFixed(0)}% of your capital).<br>` +
    `Gain of the same size as the risk (1:1) at ${f(t1)}, twice the risk (2:1) at ${f(t2)}.` +
    (value > cap ? `<br><span class="warn">This position is larger than your capital, so it needs borrowing (leverage ×${(value / cap).toFixed(1)}). Leverage multiplies losses too and the exit may not be filled at your price.</span>` : '') +
    (distPct < 0.15 ? '<br><span class="warn">The exit is very close to the entry: normal price noise could trigger it.</span>' : '');
}

// ---------------- linear regression ----------------
function regress(h, idx) {
  const n = idx.length; if (n < 3) return null;
  const t0 = h[idx[0]].t, xs = idx.map(i => (h[i].t - t0) / HOUR), ys = idx.map(i => h[i].p);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let k = 0; k < n; k++) { const dx = xs[k] - mx, dy = ys[k] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (sxx === 0) return null;
  const b = sxy / sxx, a = my - b * mx;
  let ssr = 0; for (let k = 0; k < n; k++) { const e = ys[k] - (a + b * xs[k]); ssr += e * e; }
  return { n, a, b, mean:my, r2: syy === 0 ? 0 : 1 - ssr / syy, sd: Math.sqrt(ssr / (n - 2)),
           fit: i => a + b * ((h[i].t - t0) / HOUR), lastIdx: idx[n - 1], lastP: ys[n - 1] };
}

// ---------------- backtest ----------------
function backtest(ind, startIdx, cost) {
  const p = ind.p, n = p.length, d = Array(n).fill(0); let st = 0;
  for (let i = 0; i < n; i++) {
    if (rule === 'ma')        st = ind.fast[i] != null && ind.slow[i] != null ? (ind.fast[i] > ind.slow[i] ? 1 : 0) : 0;
    else if (rule === 'macd') st = ind.macd[i] != null && ind.msig[i] != null ? (ind.macd[i] > ind.msig[i] ? 1 : 0) : 0;
    else if (rule === 'rsi')  { if (ind.rsi[i] != null) { if (ind.rsi[i] < 30) st = 1; else if (ind.rsi[i] > 70) st = 0; } }
    else if (rule === 'bb')   { if (ind.bb.lo[i] != null) { if (p[i] < ind.bb.lo[i]) st = 1; else if (p[i] > ind.bb.mid[i]) st = 0; } }
    d[i] = st;
  }
  const eq = Array(n).fill(null), bh = Array(n).fill(null);
  let e = 100, prev = 0, closed = 0, wins = 0, entryEq = null, peak = 100, mdd = 0;
  for (let i = startIdx; i < n; i++) {
    if (i > startIdx) e *= 1 + prev * (p[i] / p[i-1] - 1);
    if (d[i] !== prev) {
      if (d[i] === 1) { entryEq = e; e *= 1 - cost; }
      else { e *= 1 - cost; closed++; if (e > entryEq) wins++; entryEq = null; }
      prev = d[i];
    }
    eq[i] = e; bh[i] = 100 * p[i] / p[startIdx];
    if (e > peak) peak = e; mdd = Math.max(mdd, (peak - e) / peak);
  }
  return { eq, bh, closed, wins, ret:e / 100 - 1, hold:n > startIdx ? p[n-1] / p[startIdx] - 1 : 0, mdd, open:prev === 1 };
}

// ---------------- trader synthesis ----------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const TH = 0.3;                                   // |vote| above this = a clear signal
function synthesize(h, ind, idx, rg) {
  const L = ind.p.length - 1;
  if (L < 0) return null;
  const p = ind.p[L], R = [];                     // R = one row per indicator
  const sg = v => v == null ? 0 : v > 0 ? 1 : -1;

  // 1 · moving averages (trend)
  const f = ind.fast[L], s = ind.slow[L];
  if (f != null && s != null)
    R.push({ name:'Two moving averages', kind:'trend', vote:0.5 * sg(f - s) + 0.5 * sg(p - s),
      text:`Fast average ${fmt(f)} is ${f > s ? 'above' : 'below'} the slow average ${fmt(s)}; the price is ${p > s ? 'above' : 'below'} the slow average.` });
  else R.push({ name:'Two moving averages', kind:'trend', vote:null, text:'Not enough history for the slow average yet.' });

  // 2 · MACD (trend / momentum)
  const m = ind.macd[L], g = ind.msig[L];
  if (m != null && g != null) {
    const h0 = ind.hist[L], h3 = ind.hist[L - 3];
    const fade = h0 != null && h3 != null && Math.sign(h0) === Math.sign(h3) && Math.abs(h0) < Math.abs(h3);
    R.push({ name:'MACD', kind:'trend', vote:0.5 * sg(m - g) + 0.5 * sg(m),
      text:`MACD is ${m > g ? 'above' : 'below'} its signal line and ${m > 0 ? 'above' : 'below'} zero.` + (fade ? ' The push is fading (bars shrinking).' : '') });
  } else R.push({ name:'MACD', kind:'trend', vote:null, text:'Not enough history yet (needs about 35 hourly points).' });

  // 3 · linear regression (trend now, position in the channel feeds the stretch score)
  let zVote = null;
  if (rg) {
    const fl = rg.fit(rg.lastIdx), z = rg.sd > 0 ? (rg.lastP - fl) / rg.sd : 0, pctDay = rg.mean ? rg.b * 24 / rg.mean * 100 : 0;
    zVote = clamp(-z / 2, -1, 1);
    R.push({ name:'Linear regression', kind:'trend', vote:sg(rg.b) * clamp(rg.r2 / 0.5, 0, 1),
      text:`Over the selected period the trend is ${rg.b >= 0 ? 'rising' : 'falling'} ${Math.abs(pctDay).toFixed(2)}% per day (R² ${rg.r2.toFixed(2)}). Price is ${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}σ from the line.` +
        (rg.r2 < 0.3 ? ' R² is low, so this trend counts for little.' : '') });
  } else R.push({ name:'Linear regression', kind:'trend', vote:null, text:'Not enough data in this period.' });

  // 4 · RSI (stretch)
  const r = ind.rsi[L];
  if (r != null) R.push({ name:'RSI', kind:'stretch', vote:Math.sign(50 - r) * clamp((Math.abs(r - 50) - 10) / G.rsiSpan, 0, 1),
    text:`RSI is ${r.toFixed(0)}: ` + (r < G.rsiLo ? 'oversold (fell fast, a bounce is possible).' : r > G.rsiHi ? 'overbought (rose fast, a pullback is possible).' : r < 45 ? 'on the weak side, not yet oversold.' : r > 55 ? 'on the strong side, not yet overbought.' : 'balanced.') });
  else R.push({ name:'RSI', kind:'stretch', vote:null, text:'Not enough history yet.' });

  // 5 · Bollinger Bands (stretch + volatility)
  const up = ind.bb.up[L], lo = ind.bb.lo[L], mid = ind.bb.mid[L];
  let vol = null;
  if (up != null && lo != null && up > lo) {
    const pb = (p - lo) / (up - lo), bws = [];
    for (let i = 0; i < ind.p.length; i++) if (ind.bb.up[i] != null && ind.bb.mid[i]) bws.push((ind.bb.up[i] - ind.bb.lo[i]) / ind.bb.mid[i]);
    bws.sort((x, y) => x - y);
    vol = bws.length >= 10 ? (up - lo) / mid / bws[Math.floor(bws.length / 2)] : null;
    R.push({ name:'Bollinger Bands', kind:'stretch', vote:Math.sign(0.5 - pb) * clamp((Math.abs(pb - 0.5) - 0.15) / 0.35, 0, 1),
      text:`Price sits at ${(pb * 100).toFixed(0)}% of the band (0% = lower band, 100% = upper band)` + (p > up ? ', outside the upper band.' : p < lo ? ', outside the lower band.' : '.') });
  } else R.push({ name:'Bollinger Bands', kind:'stretch', vote:null, text:'Not enough history yet.' });

  const avgOf = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const T = avgOf(R.filter(x => x.kind === 'trend' && x.vote != null).map(x => x.vote));
  const sv = R.filter(x => x.kind === 'stretch' && x.vote != null).map(x => x.vote);
  if (zVote != null) sv.push(zVote);
  const S = avgOf(sv);
  const avail = R.filter(x => x.vote != null).length;
  const bull = R.filter(x => x.vote != null && x.vote > TH).length, bear = R.filter(x => x.vote != null && x.vote < -TH).length;
  return { R, T, S, p, L, f, s, up, lo, vol, avail, bull, bear, score:T == null ? null : Math.round(100 * ((1 - G.stretchW) * T + G.stretchW * (S ?? 0))) };
}

// ---------------- group context (how this asset compares with its neighbours) ----------------
function periodMove(key, idx0t) {
  const h = hourly[key] || []; let a = null;
  for (const x of h) if (x.t >= idx0t) { a = x; break; }
  const b = h.length ? h[h.length - 1] : null;
  return a && b && a.p ? { a:a.p, b:b.p, pct:(b.p / a.p - 1) * 100 } : null;
}
function groupContext(a, idx) {
  const h = hourly[current] || [];
  if (!idx.length) return null;
  const t0 = h[idx[0]].t, pc = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';
  if (GROUP === 'currencies') {
    const mv = ASSETS.map(x => [x.name, periodMove(x.key, t0)]).filter(x => x[1]);
    if (mv.length < 2) return null;
    const avgP = mv.reduce((s, x) => s + x[1].pct, 0) / mv.length, me = mv.find(x => x[0] === a.name);
    return '<b>Dollar check (this period):</b> ' + mv.map(x => x[0] + ' ' + pc(x[1].pct)).join(' · ') + '. On average these currencies moved ' + pc(avgP) +
      ' against the dollar, so the dollar is ' + (avgP < -0.05 ? 'STRONGER' : avgP > 0.05 ? 'WEAKER' : 'about unchanged') + '.' +
      (me ? ' ' + a.name + ' did ' + (me[1].pct - avgP >= 0 ? 'better' : 'worse') + ' than the group by ' + Math.abs(me[1].pct - avgP).toFixed(2) + ' points. When all move together it is a dollar story, not a story about one country.' : '');
  }
  if (GROUP === 'metals') {
    const au = periodMove('XAU', t0), ag = periodMove('XAG', t0), pt = periodMove('XPT', t0), out = [];
    if (au && ag) { const r0 = au.a / ag.a, r1 = au.b / ag.b; out.push('gold/silver ratio ' + r1.toFixed(1) + ' (it was ' + r0.toFixed(1) + ' at the start of the period; a rising ratio means silver is lagging gold, often in fearful markets)'); }
    if (au && pt) { const r0 = pt.a / au.a, r1 = pt.b / au.b; out.push('platinum/gold ratio ' + r1.toFixed(2) + ' (was ' + r0.toFixed(2) + ')'); }
    return out.length ? '<b>Metals context:</b> ' + out.join('; ') + '.' : null;
  }
  const btc = periodMove('BTC', t0), eth = periodMove('ETH', t0);
  if (btc && eth) {
    const r0 = eth.a / btc.a, r1 = eth.b / btc.b;
    return '<b>Crypto context:</b> Bitcoin ' + pc(btc.pct) + ', Ethereum ' + pc(eth.pct) + ' this period. ETH/BTC ratio ' + r1.toFixed(4) + ' (was ' + r0.toFixed(4) + '): ' +
      (r1 > r0 * 1.01 ? 'Ethereum is outperforming Bitcoin, which usually goes with a stronger appetite for risk.' : r1 < r0 * 0.99 ? 'Bitcoin is outperforming Ethereum, which often goes with caution.' : 'no clear difference between them.');
  }
  return null;
}

function renderSynth(a, h, ind, idx, rg) {
  const box = document.getElementById('synbody'), y = synthesize(h, ind, idx, rg);
  if (!y || y.T == null) { box.innerHTML = '<span class="warn">Not enough saved history for this asset yet to judge the trend. Load more past prices (backfill) or choose a longer period.</span>'; return; }
  const { T, S, R } = y, s0 = S ?? 0;
  let title, sub, col;
  if (T > TH) {
    if (s0 >= -TH) { title = 'BUY bias'; col = '#3fb950'; sub = 'The trend is up and the price is not stretched. In an uptrend, buying on a small pullback is the classic entry. If you already hold, keep holding.'; }
    else { title = 'HOLD · do not chase'; col = '#f0883e'; sub = 'The trend is up, but the price is already stretched. Buying here means paying a high price. Better to wait for a pullback toward the slow average or the middle band. If you hold, keep it and consider tightening your exit.'; }
  } else if (T < -TH) {
    if (s0 <= TH) { title = 'SELL / stay out'; col = '#f85149'; sub = 'The trend is down and the price is not yet oversold. Avoid buying. If you hold, this is the kind of picture where traders reduce or exit.'; }
    else { title = 'WAIT · bounce possible'; col = '#f0883e'; sub = 'The trend is down, but the price is on the cheap side of its range, so a short bounce is possible. Buying against the trend is risky (“catching a falling knife”). Wait for the fast average or MACD to turn up first.'; }
  } else {
    if (s0 > 0.5) { title = 'NEUTRAL · watch to buy low'; col = '#8b98a5'; sub = 'No clear trend, but the price is on the cheap side of its range. A small, careful entry could be considered with a tight exit.'; }
    else if (s0 < -0.5) { title = 'NEUTRAL · watch to sell high'; col = '#8b98a5'; sub = 'No clear trend, and the price is on the expensive side of its range. A good area to sell or take profit if you hold.'; }
    else { title = 'NEUTRAL · no edge'; col = '#8b98a5'; sub = 'The indicators do not agree and nothing is stretched. Patience is a position: waiting costs nothing.'; }
  }
  const dom = Math.max(y.bull, y.bear);
  let conf = dom >= 4 ? 2 : dom === 3 ? 1 : 0;
  if (y.avail < 5) conf--;
  if (rg && (rg.r2 < 0.3 || rg.n < 24)) conf--;
  const dt = dailyTrend(h);
  if (dt && dt.dir !== 0 && Math.abs(T) > TH && dt.dir !== Math.sign(T)) conf--;
  const confTxt = ['LOW', 'MEDIUM', 'HIGH'][clamp(conf, 0, 2)];

  const badge = x => {
    if (x.vote == null) return '<span class="badge b-mid">No data</span>';
    const st = x.kind === 'stretch';
    if (x.vote > TH) return `<span class="badge b-up">${st ? 'Cheap side' : 'Bullish'}</span>`;
    if (x.vote < -TH) return `<span class="badge b-down">${st ? 'Stretched up' : 'Bearish'}</span>`;
    return '<span class="badge b-mid">Neutral</span>';
  };
  const rows = R.map(x => `<tr><td><b>${x.name}</b><br><span class="status" style="margin:0">${x.kind === 'trend' ? 'trend' : 'stretch'}</span></td><td>${badge(x)}</td><td>${x.text}</td></tr>`).join('');

  const notes = [];
  if (dt) notes.push(dailyNote(dt, T));
  if (y.vol != null) notes.push(y.vol > 1.3 ? `<b>Risk:</b> the Bollinger Bands are wide (${y.vol.toFixed(1)}× their usual width). Swings are big, so use a smaller position and a wider exit.`
    : y.vol < 0.7 ? `<b>Risk:</b> the Bollinger Bands are squeezed (${y.vol.toFixed(1)}× their usual width). The market is quiet and a bigger move often follows, but the direction is unknown. Do not size up.`
    : `<b>Risk:</b> volatility is normal (${y.vol.toFixed(1)}× its usual band width).`);
  if (T > TH && y.s != null) notes.push(`<b>The bullish view weakens</b> if the price falls below the slow average (${fmt(y.s)})${y.lo != null ? ' or the lower Bollinger band (' + fmt(y.lo) + ')' : ''}. A trader would place the exit just beyond one of these levels.`);
  if (T < -TH && y.s != null) notes.push(`<b>The bearish view weakens</b> if the price rises above the slow average (${fmt(y.s)})${y.up != null ? ' or the upper Bollinger band (' + fmt(y.up) + ')' : ''}.`);
  if (idx.length > 2) {
    const bt = backtest(ind, idx[0], costPct / 100), rn = { ma:'fast/slow average', rsi:'RSI', macd:'MACD', bb:'Bollinger' }[rule];
    const pc = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
    notes.push(`<b>Reality check (chart 6):</b> on this period the “${rn}” rule gave ${pc(bt.ret)} versus ${pc(bt.hold)} for just holding, with ${bt.closed} closed trade${bt.closed === 1 ? '' : 's'}.` +
      (bt.closed < 10 ? ' <span class="warn">Too few trades to prove anything.</span>' : bt.ret < bt.hold ? ' <span class="warn">The rule did not beat holding.</span>' : ''));
  }
  if (GROUP !== 'currencies') { const dx = dollarContext(idx.length ? h[idx[0]].t : null); if (dx) notes.push(dx); }
  const cx = groupContext(a, idx); if (cx) notes.push(cx);
  notes.push(G.before + ' No indicator sees such events coming.');

  const sc = y.score, pos = clamp((sc + 100) / 2, 2, 98);
  box.innerHTML =
    `<div class="verdict" style="border-left-color:${col}"><div class="vt" style="color:${col}">${a.name}: ${title}</div><div class="vs">${sub}</div></div>` +
    `<div class="gauge"><i style="left:${pos}%"></i></div><div class="gscale"><span>Strong sell −100</span><span>Score <b>${sc > 0 ? '+' : ''}${sc}</b></span><span>+100 Strong buy</span></div>` +
    `<div class="stats">Indicators agreeing: <b class="up">${y.bull} bullish</b> · <b>${y.avail - y.bull - y.bear} neutral</b> · <b class="down">${y.bear} bearish</b> · Confidence: <b>${confTxt}</b></div>` +
    `<table class="syn"><tr><th>Indicator</th><th>Signal</th><th>What it says now</th></tr>${rows}</table>` +
    `<ul class="synlist">${notes.map(n => '<li>' + n + '</li>').join('')}</ul>`;
  riskUpdate({ key:a.key, name:a.name, price:y.p, slow:y.s, lo:y.lo, up:y.up, dir:T > TH ? 1 : T < -TH ? -1 : 0 });
}


// ---------------- charts ----------------
const charts = [];
let viewH = [], viewShow = [];
const crosshair = { id:'crosshair', afterDraw(c) {
  if (c.$hi == null || !c.scales.x) return;
  const x = c.scales.x.getPixelForValue(c.$hi), a = c.chartArea;
  if (x == null || isNaN(x)) return;
  const g = c.ctx; g.save(); g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.setLineDash([4, 3]);
  g.beginPath(); g.moveTo(x, a.top); g.lineTo(x, a.bottom); g.stroke(); g.restore();
} };
function hoverSync(active, src) {
  const i = active && active.length ? active[0].index : null;
  charts.forEach(c => { if (c.$hi !== i) { c.$hi = i; if (c !== src) c.draw(); } });
}
function makeChart(id, yFmt, extraY) {
  const ch = new Chart(document.getElementById(id).getContext('2d'), {
    type:'line', data:{ labels:[], datasets:[] },
    plugins:[crosshair],
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      interaction:{ mode:'index', intersect:false },
      onHover:(e, a, c) => hoverSync(a, c),
      scales:{
        x:{ ticks:{ color:'#8b98a5', maxTicksLimit:6, font:{ size:9 } }, grid:{ color:'#2b3540' } },
        y:Object.assign({ ticks:{ color:'#8b98a5', font:{ size:10 }, callback:v => yFmt(Number(v)) }, grid:{ color:'#2b3540' },
                          afterFit(s) { s.width = 66; } }, extraY || {})
      },
      plugins:{
        legend:{ labels:{ color:'#e6edf3', boxWidth:12, font:{ size:10 } } },
        tooltip:{ backgroundColor:'rgba(15,20,25,0.55)', borderColor:'rgba(255,255,255,0.15)', borderWidth:1,
                  titleFont:{ size:10 }, bodyFont:{ size:10 }, padding:5, boxWidth:8, boxHeight:8, caretSize:4,
                  filter:it => it.parsed.y != null,
                  callbacks:{ title:it => it.length && viewH[viewShow[it[0].dataIndex]] ? stamp(viewH[viewShow[it[0].dataIndex]].t) : '',
                              label:c => ' ' + c.dataset.label + ': ' + yFmt(c.parsed.y) } }
      }
    }
  });
  charts.push(ch); return ch;
}
const line = (label, data, color, extra) => Object.assign({ type:'line', label, data, borderColor:color, backgroundColor:color, borderWidth:1.8, pointRadius:0, tension:.1, spanGaps:true }, extra || {});

let zoom = null, zKey = '', selMode = false, zoomSkipY = [];           // zoom = {a, b}: first/last point shown
const ZHELP = 'To zoom every chart at once: drag across any chart with the mouse, or switch “Select area” on and drag with your finger. Then use ◀ ▶ to move.';
function applyZoom() {
  const n = viewShow.length;
  charts.forEach(c => {
    const x = c.options.scales.x, y = c.options.scales.y;
    if (!zoom) { x.min = x.max = undefined; if (!zoomSkipY.includes(c)) y.min = y.max = undefined; return; }
    x.min = zoom.a; x.max = zoom.b;
    if (zoomSkipY.includes(c)) return;                                // RSI keeps its fixed 0-100 scale
    let lo = Infinity, hi = -Infinity;
    c.data.datasets.forEach(d => { for (let i = zoom.a; i <= zoom.b; i++) { const v = d.data[i]; if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } } });
    if (lo === Infinity) { y.min = y.max = undefined; return; }
    const m = (hi - lo) * 0.08 || Math.abs(hi) * 0.001 || 0.5; y.min = lo - m; y.max = hi + m;
  });
  const info = document.getElementById('zinfo');
  if (zoom && viewH[viewShow[zoom.a]]) info.textContent = 'Zoomed: ' + stamp(viewH[viewShow[zoom.a]].t) + '  →  ' + stamp(viewH[viewShow[zoom.b]].t) + '  (' + (zoom.b - zoom.a + 1) + ' points). All 6 charts show the same period.';
  else info.textContent = ZHELP;
}
function setZoom(a, b) {
  const n = viewShow.length; if (n < 2) return;
  if (b - a < 4) { const c = (a + b) / 2; a = Math.round(c - 2); b = a + 4; }
  if (a < 0) { b -= a; a = 0; } if (b > n - 1) { a -= b - (n - 1); b = n - 1; } a = Math.max(0, a);
  zoom = (a <= 0 && b >= n - 1) ? null : { a, b };
  renderAll();
}
function initZoom(skip) {
  zoomSkipY = skip || [];
  let drag = null;                                       // {ch, box, x0, xs}
  charts.forEach(ch => {
    const cv = ch.canvas, wrap = cv.parentElement, box = document.createElement('div');
    box.style.cssText = 'display:none;position:absolute;top:0;bottom:0;background:rgba(77,208,225,.18);border:1px solid #4dd0e1;pointer-events:none';
    wrap.appendChild(box); cv.style.touchAction = 'pan-y';
    const px = e => e.clientX - cv.getBoundingClientRect().left;
    cv.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' && !selMode) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drag = { ch, box, x0:px(e), xs:px(e) }; try { cv.setPointerCapture(e.pointerId); } catch {}
    });
    cv.addEventListener('pointermove', e => {
      if (!drag || drag.ch !== ch) return; drag.xs = px(e);
      box.style.display = 'block'; box.style.left = Math.min(drag.x0, drag.xs) + 'px'; box.style.width = Math.abs(drag.xs - drag.x0) + 'px';
    });
    cv.addEventListener('pointerup', () => {
      if (!drag || drag.ch !== ch) return;
      const a = drag.x0, b = drag.xs; drag = null; box.style.display = 'none';
      if (Math.abs(b - a) < 12) return;
      const sc = ch.scales.x, i0 = Math.round(sc.getValueForPixel(Math.min(a, b))), i1 = Math.round(sc.getValueForPixel(Math.max(a, b)));
      setZoom(Math.max(0, i0), Math.min(viewShow.length - 1, i1));
    });
    cv.addEventListener('pointercancel', () => { drag = null; box.style.display = 'none'; });
  });
  const cur = () => zoom || { a:0, b:viewShow.length - 1 };
  document.getElementById('zsel').onclick = e => {
    selMode = !selMode; charts.forEach(c => { c.canvas.style.touchAction = selMode ? 'none' : 'pan-y'; });
    e.target.textContent = '🔍 Select area: ' + (selMode ? 'ON – drag on a chart' : 'off'); e.target.classList.toggle('sel', selMode);
  };
  document.getElementById('zin').onclick = () => { const z = cur(), c = (z.a + z.b) / 2, w = (z.b - z.a) / 4; setZoom(Math.round(c - w), Math.round(c + w)); };
  document.getElementById('zout').onclick = () => { const z = cur(), c = (z.a + z.b) / 2, w = z.b - z.a; setZoom(Math.round(c - w), Math.round(c + w)); };
  document.getElementById('zleft').onclick = () => { if (!zoom) return; const d = Math.max(1, Math.round((zoom.b - zoom.a) / 4)); setZoom(zoom.a - d, zoom.b - d); };
  document.getElementById('zright').onclick = () => { if (!zoom) return; const d = Math.max(1, Math.round((zoom.b - zoom.a) / 4)); setZoom(zoom.a + d, zoom.b + d); };
  document.getElementById('zreset').onclick = () => { zoom = null; renderAll(); };
}
