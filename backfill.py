"""Load past prices into data/snapshots.json (run it once by hand from the Actions tab; safe to run again).
 
What it does
  1. Fetches history for every asset: last ~58 days every 30-60 minutes, older (up to 1 year) once a day.
     Each asset has several sources, tried in order, so one service blocking us does not stop everything:
       Bitcoin, Ethereum : Coinbase, then Kraken, then Yahoo
       Gold, silver, platinum : Yahoo, then Stooq (daily only)
       Currencies : Yahoo, then Frankfurter (European Central Bank, daily only)
  2. Adds rows for the time BEFORE your first saved row (if any).
  3. Fills in assets that are missing in rows you already have (for example platinum, bitcoin and ethereum
     the first time you run this after upgrading). A missing price is only filled when a real price exists
     close in time, so weekends are left empty rather than invented.
Rows you already have are never changed, only completed. Uses only the Python standard library."""
import bisect
import csv
import io
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
 
OUT = Path("data/snapshots.json")
MAX_ROWS = 20000
STEP = 1800                      # seconds: row spacing for intraday history
INTRADAY_DAYS = 58
 
YAHOO = {"XAU": "GC=F", "XAG": "SI=F", "XPT": "PL=F", "CHF": "CHFUSD=X", "EUR": "EURUSD=X",
         "JPY": "JPYUSD=X", "GBP": "GBPUSD=X", "BTC": "BTC-USD", "ETH": "ETH-USD"}
COINBASE = {"BTC": "BTC-USD", "ETH": "ETH-USD"}
TOL_INTRADAY = 100 * 60 * 1000   # a filled price must come from at most 100 minutes before the row
TOL_DAILY = 36 * 3600 * 1000     # ... or 36 hours for daily points
 
 
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
 
 
def get_text(url, timeout=30, tries=3):
    """Download a page; wait and retry when the service says 'too many requests' or has a hiccup."""
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json,text/csv,*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504) and k < tries - 1:
                time.sleep(3 * (k + 1))
                continue
            raise
        except Exception as e:
            last = e
            if k < tries - 1:
                time.sleep(2)
    raise last
 
 
def get_json(url, timeout=30):
    return json.loads(get_text(url, timeout))
 
 
def yahoo_bars(symbol, interval, rng):
    last = None
    for host in ("query1", "query2"):
        try:
            res = get_json(f"https://{host}.finance.yahoo.com/v8/finance/chart/{symbol}?interval={interval}&range={rng}")["chart"]["result"][0]
            break
        except Exception as e:
            last = e
    else:
        raise last
    ts = res.get("timestamp") or []
    closes = res["indicators"]["quote"][0]["close"]
    return [(t, c) for t, c in zip(ts, closes) if c is not None]
 
 
def coinbase_hourly(product, days=365):
    """Hourly candles, 300 per request. Each point is (end of the hour, close price)."""
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(days=days)
    out, cur = {}, start
    while cur < end:
        nxt = min(cur + timedelta(hours=280), end)      # stay safely below the 300-candle limit
        url = (f"https://api.exchange.coinbase.com/products/{product}/candles?granularity=3600"
               f"&start={cur.strftime('%Y-%m-%dT%H:%M:%SZ')}&end={nxt.strftime('%Y-%m-%dT%H:%M:%SZ')}")
        for c in get_json(url):                       # [time, low, high, open, close, volume]
            out[int(c[0]) + 3600] = float(c[4])
        cur = nxt
        time.sleep(0.4)                               # be gentle with the free service
    return sorted(out.items())
 
 
KRAKEN = {"BTC": "XBTUSD", "ETH": "ETHUSD"}
STOOQ = {"XAU": "xauusd", "XAG": "xagusd", "XPT": "xptusd"}
ECB = {"CHF": "CHF", "EUR": "EUR", "JPY": "JPY", "GBP": "GBP"}
 
 
def kraken_points(pair, interval):
    j = get_json(f"https://api.kraken.com/0/public/OHLC?pair={pair}&interval={interval}")
    if j.get("error"):
        raise RuntimeError(j["error"])
    rows = next(v for k, v in j["result"].items() if k != "last")
    step = interval * 60
    return [(int(c[0]) + step, float(c[4])) for c in rows]       # [time, open, high, low, close, ...]
 
 
def stooq_daily(symbol):
    text = get_text(f"https://stooq.com/q/d/l/?s={symbol}&i=d")
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        try:
            t = int(datetime.strptime(r["Date"], "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()) + 21 * 3600
            out.append((t, float(r["Close"])))
        except Exception:
            pass
    if not out:
        raise RuntimeError("no rows: " + text[:80].replace("\n", " "))
    return out[-400:]
 
 
_ecb = {}
 
 
def ecb_daily(key):
    if not _ecb:
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=370)
        j = get_json(f"https://api.frankfurter.app/{start}..{end}?from=USD&to={','.join(ECB.values())}")
        for day, rates in j["rates"].items():
            t = int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()) + 12 * 3600
            for k, c in ECB.items():
                if rates.get(c):
                    _ecb.setdefault(k, []).append((t, 1 / float(rates[c])))      # USD per one unit
    if key not in _ecb:
        raise RuntimeError("no rates")
    return _ecb[key]
 
 
def history(key):
    """Returns points [(t_ms, price, tolerance_ms)] sorted by time. Tries the sources in order."""
    now = time.time()
    cut = now - INTRADAY_DAYS * 86400
 
    def pack(intra, daily):
        return sorted([(t * 1000, c, TOL_INTRADAY) for t, c in intra] + [(t * 1000, c, TOL_DAILY) for t, c in daily])
 
    if key in COINBASE:
        try:
            pts = coinbase_hourly(COINBASE[key])
            if pts:
                return pack([(t, c) for t, c in pts if t >= cut], [(t, c) for t, c in pts if t < cut and t % 86400 == 43200])
        except Exception as e:
            print(f"{key}: Coinbase failed: {e}")
        try:
            hourly = kraken_points(KRAKEN[key], 60)
            daily = kraken_points(KRAKEN[key], 1440)
            first = hourly[0][0] if hourly else now
            return pack(hourly, [(t, c) for t, c in daily if t < first])
        except Exception as e:
            print(f"{key}: Kraken failed: {e}")
    out = []
    try:
        m30 = yahoo_bars(YAHOO[key], "30m", "58d")
        out += [(t * 1000, c, TOL_INTRADAY) for t, c in m30]
        first30 = m30[0][0] if m30 else now
    except Exception as e:
        print(f"{key}: Yahoo 30m failed: {e}")
        first30 = now
    try:
        out += [(t * 1000, c, TOL_DAILY) for t, c in yahoo_bars(YAHOO[key], "1d", "1y") if t < first30]
    except Exception as e:
        print(f"{key}: Yahoo 1d failed: {e}")
    if out:
        return sorted(out)
    try:                                              # last resort: daily prices only
        daily = stooq_daily(STOOQ[key]) if key in STOOQ else ecb_daily(key) if key in ECB else []
        return pack([], daily)
    except Exception as e:
        print(f"{key}: backup source failed: {e}")
    return []
 
 
def lookup(points, times, t_ms):
    i = bisect.bisect_right(times, t_ms) - 1
    if i < 0:
        return None
    t, c, tol = points[i]
    return c if t_ms - t <= tol else None
 
 
def build_old_rows(series, first_live_ms):
    """New rows older than first_live_ms: intraday points on 30-minute slots, daily points at noon UTC."""
    rows, intra_days = {}, set()
    for key, pts in series.items():
        for t, c, tol in pts:
            if tol == TOL_INTRADAY:
                slot = (t // 1000 // STEP) * STEP * 1000
                rows.setdefault(slot, {})[key] = round(c, 8)
                intra_days.add(slot // 86400000)
    for key, pts in series.items():
        for t, c, tol in pts:
            if tol == TOL_DAILY:
                day = t // 86400000
                if day not in intra_days:
                    rows.setdefault(day * 86400000 + 43200000, {})[key] = round(c, 8)
    return [{"t": t, "v": v} for t, v in sorted(rows.items()) if t < first_live_ms]
 
 
def complete_rows(rows, series):
    """Fill missing assets in existing rows from real nearby prices. Returns the number of values added."""
    added = 0
    idx = {k: [p[0] for p in pts] for k, pts in series.items()}
    for r in rows:
        for key, pts in series.items():
            if key in r["v"] and r["v"][key] is not None:
                continue
            c = lookup(pts, idx[key], r["t"])
            if c is not None:
                r["v"][key] = round(c, 8)
                added += 1
    return added
 
 
def main():
    rows = json.loads(OUT.read_text()) if OUT.exists() else []
    first_live = rows[0]["t"] if rows else 10**15
    series = {}
    for key in YAHOO:
        pts = history(key)
        print(f"{key}: {len(pts)} points")
        if pts:
            series[key] = pts
    missing = [k for k in YAHOO if k not in series]
    if missing:
        print("No history found for:", ", ".join(missing), "(see the lines above for the reason)")
    if not series:
        raise SystemExit("Nothing fetched from any source; data left unchanged. See the lines above for the reasons.")
 
    old = build_old_rows(series, first_live)
    added = complete_rows(rows, series)
    out = (old + rows)[-MAX_ROWS:]
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out))
    print(f"Added {len(old)} older rows and {added} missing prices; total rows {len(out)}.")
 
 
if __name__ == "__main__":
    main()
