"""Track record of the hourly verdicts (BUY / HOLD / SELL / WAIT / NEUTRAL).

Reads data/snapshots.json, rebuilds the verdict the group pages (currencies / metals / crypto) would have shown
at EVERY past hour, using only the prices known at that hour (no look-ahead), then measures what the price did
afterwards (24 h, 72 h, 168 h). Writes data/track.json, which track.html displays.

The rules are the same as the pages' "Trader's synthesis" with the pages' default settings. They were reasoned
before this test, not fitted to the data. Uses only the Python standard library and never stops the job:
on any problem it prints a message and leaves the old track.json untouched."""
import bisect
import json
import math
import sys
import time
from pathlib import Path

IN = Path("data/snapshots.json")
OUT = Path("data/track.json")
HOUR = 3600 * 1000
TH = 0.3                                     # |vote| above this = a clear signal (same as the pages)
MIN_POINTS = 60                              # an asset needs at least this many hourly points
HORIZONS = (24, 72, 168)
MAX_LATE_H = 72                              # a forward price may be at most 72 h later than t+H (weekends)
CLASSES = ("BUY", "HOLD", "SELL", "WAIT", "NEUTRAL")

GROUPS = {
    "XAU": "metal", "XAG": "metal", "XPT": "metal",
    "CHF": "currency", "EUR": "currency", "JPY": "currency", "GBP": "currency",
    "BTC": "crypto", "ETH": "crypto",
}
# defaults of the three pages: moving-average type, fast, slow, weight of the "stretch" side, RSI span
CFG = {
    "currency": dict(ma="SMA", fast=20, slow=50, stretchW=0.40, rsiSpan=20, weekends=True),
    "metal":    dict(ma="SMA", fast=20, slow=50, stretchW=0.35, rsiSpan=20, weekends=True),
    "crypto":   dict(ma="EMA", fast=12, slow=48, stretchW=0.25, rsiSpan=15, weekends=False),
}
RSI_N, BB_N, BB_K = 14, 20, 2.0


def is_closed(t_ms):
    """Same as isClosed() in the pages: Friday 22:00 UTC to Sunday 22:00 UTC."""
    days = t_ms // 86400000
    wd = (days + 4) % 7                      # 1970-01-01 was a Thursday; 0 = Sunday like JavaScript getUTCDay()
    h = (t_ms // HOUR) % 24
    return wd == 6 or (wd == 5 and h >= 22) or (wd == 0 and h < 22)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def sg(v):
    """Same as sg() in the pages: 0 for missing, +1 above zero, otherwise -1."""
    return 0 if v is None else (1 if v > 0 else -1)


def sign(v):
    return (v > 0) - (v < 0)


# ---------------- indicators (same maths as the pages) ----------------
def sma(v, n):
    out, s = [], 0.0
    for i, x in enumerate(v):
        s += x
        if i >= n:
            s -= v[i - n]
        out.append(s / n if i >= n - 1 else None)
    return out


def ema(v, n):
    k, out, e = 2 / (n + 1), [], None
    for i, x in enumerate(v):
        if i < n - 1:
            out.append(None)
            continue
        e = sum(v[:n]) / n if e is None else x * k + e * (1 - k)
        out.append(e)
    return out


def rsi_calc(v, n):
    out = [None] * len(v)
    if len(v) <= n:
        return out
    g = l = 0.0
    for i in range(1, n + 1):
        d = v[i] - v[i - 1]
        if d >= 0:
            g += d
        else:
            l -= d
    ag, al = g / n, l / n
    out[n] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(v)):
        d = v[i] - v[i - 1]
        ag = (ag * (n - 1) + (d if d > 0 else 0)) / n
        al = (al * (n - 1) + (-d if d < 0 else 0)) / n
        out[i] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def macd_calc(v):
    e12, e26 = ema(v, 12), ema(v, 26)
    macd = [a - b if a is not None and b is not None else None for a, b in zip(e12, e26)]
    first = next((i for i, x in enumerate(macd) if x is not None), -1)
    sig = [None] * len(v)
    if first >= 0:
        for k, x in enumerate(ema(macd[first:], 9)):
            sig[first + k] = x
    return macd, sig


def boll_calc(v, n, k):
    mid = sma(v, n)
    up, lo = [None] * len(v), [None] * len(v)
    for i in range(len(v)):
        if mid[i] is None:
            continue
        s = 0.0
        for j in range(i - n + 1, i + 1):
            d = v[j] - mid[i]
            s += d * d
        sd = math.sqrt(s / n)
        up[i], lo[i] = mid[i] + k * sd, mid[i] - k * sd
    return up, lo


# ---------------- the verdict at every hour ----------------
def analyze(times, prices, cfg):
    """times (ms) and prices of one asset's hourly series. Returns a list with, for every hour where all five
    indicators exist, (class, score, T, S); otherwise None. Uses only data up to each hour."""
    n = len(prices)
    avg = ema if cfg["ma"] == "EMA" else sma
    fast, slow = avg(prices, cfg["fast"]), avg(prices, cfg["slow"])
    rsi = rsi_calc(prices, RSI_N)
    macd, msig = macd_calc(prices)
    bup, blo = boll_calc(prices, BB_N, BB_K)

    # prefix sums for the 7-day regression (prices scaled by the first price: z, R2 and the sign do not change)
    y0 = prices[0] if prices[0] else 1.0
    X = [(t - times[0]) / HOUR for t in times]
    Y = [p / y0 for p in prices]
    sx, sy, sxx_, sxy_, syy_ = [0.0], [0.0], [0.0], [0.0], [0.0]
    for x, y in zip(X, Y):
        sx.append(sx[-1] + x)
        sy.append(sy[-1] + y)
        sxx_.append(sxx_[-1] + x * x)
        sxy_.append(sxy_[-1] + x * y)
        syy_.append(syy_[-1] + y * y)

    res = [None] * n
    w = cfg["stretchW"]
    span = cfg["rsiSpan"]
    start = 0
    for i in range(n):
        p = prices[i]
        f, s, m, g, r = fast[i], slow[i], macd[i], msig[i], rsi[i]
        up, lo = bup[i], blo[i]
        if f is None or s is None or m is None or g is None or r is None or up is None or lo is None or not up > lo:
            continue
        # 1 moving averages, 2 MACD (trend votes)
        trend = [0.5 * sg(f - s) + 0.5 * sg(p - s), 0.5 * sg(m - g) + 0.5 * sg(m)]
        # 3 linear regression over the last 7 days of points up to this hour
        t_from = times[i] - 7 * 86400000
        while times[start] < t_from:
            start += 1
        cnt = i - start + 1
        if cnt < 3:
            continue
        a, b = start, i + 1
        Sx, Sy = sx[b] - sx[a], sy[b] - sy[a]
        sxx = sxx_[b] - sxx_[a] - Sx * Sx / cnt
        sxy = sxy_[b] - sxy_[a] - Sx * Sy / cnt
        syy = syy_[b] - syy_[a] - Sy * Sy / cnt
        if sxx <= 0:
            continue
        if syy < 1e-14:
            syy = 0.0
        bsl = sxy / sxx
        ssr = max(0.0, syy - bsl * sxy)
        r2 = 0.0 if syy == 0 else 1 - ssr / syy
        sd = math.sqrt(ssr / (cnt - 2))
        mx, my = Sx / cnt, Sy / cnt
        fit = my + bsl * (X[i] - mx)
        z = (Y[i] - fit) / sd if sd > 1e-12 else 0.0
        zvote = clamp(-z / 2, -1, 1)
        trend.append(sg(bsl) * clamp(r2 / 0.5, 0, 1))
        # 4 RSI and 5 Bollinger (stretch votes)
        pb = (p - lo) / (up - lo)
        stretch = [sign(50 - r) * clamp((abs(r - 50) - 10) / span, 0, 1),
                   sign(0.5 - pb) * clamp((abs(pb - 0.5) - 0.15) / 0.35, 0, 1),
                   zvote]
        T = sum(trend) / len(trend)
        S = sum(stretch) / len(stretch)
        score = round_js(100 * ((1 - w) * T + w * S))
        if T > TH:
            cls = "BUY" if S >= -TH else "HOLD"
        elif T < -TH:
            cls = "SELL" if S <= TH else "WAIT"
        else:
            cls = "NEUTRAL"
        res[i] = (cls, score, T, S)
    return res


def round_js(x):
    """Math.round in JavaScript rounds halves up."""
    return int(math.floor(x + 0.5))


# ---------------- hourly series from the saved rows ----------------
def hourly_series(rows, key, weekends):
    times, prices, slot = [], [], None
    for r in rows:
        v = (r.get("v") or {}).get(key)
        if v is None:
            continue
        t = r["t"]
        if weekends and is_closed(t):
            continue
        s = t // HOUR
        if s != slot:
            times.append(t)
            prices.append(float(v))
            slot = s
    return times, prices


def empty_stat():
    return {"n": 0, "sum": 0.0, "pos": 0, "neg": 0}


def add(stat, r):
    stat["n"] += 1
    stat["sum"] += r
    if r > 0:
        stat["pos"] += 1
    elif r < 0:
        stat["neg"] += 1


def forward_returns(times, prices, i):
    """{24: r, 72: r, 168: r}: price at the first point at or after t+H, within MAX_LATE_H hours of it."""
    out = {}
    for h in HORIZONS:
        target = times[i] + h * HOUR
        j = bisect.bisect_left(times, target)
        if j < len(times) and times[j] - target <= MAX_LATE_H * HOUR and prices[i] > 0:
            out[h] = prices[j] / prices[i] - 1
    return out


def summarize(key, rows):
    group = GROUPS[key]
    cfg = CFG[group]
    times, prices = hourly_series(rows, key, cfg["weekends"])
    if len(times) < MIN_POINTS:
        return None
    res = analyze(times, prices, cfg)
    baseline = {f"h{h}": empty_stat() for h in HORIZONS}
    classes = {c: {"hours": 0, "episodes": 0, **{f"h{h}": empty_stat() for h in HORIZONS}} for c in CLASSES}
    prev_cls, prev_i, classified = None, None, 0
    for i, x in enumerate(res):
        if x is None:
            prev_cls = None
            continue
        cls = x[0]
        classified += 1
        c = classes[cls]
        c["hours"] += 1
        if cls != prev_cls or prev_i is None or times[i] - times[prev_i] > 3 * HOUR:
            c["episodes"] += 1
        prev_cls, prev_i = cls, i
        for h, r in forward_returns(times, prices, i).items():
            add(c[f"h{h}"], r)
            add(baseline[f"h{h}"], r)
    last = next((i for i in range(len(res) - 1, -1, -1) if res[i] is not None), None)
    now = None
    if last is not None:
        now = {"class": res[last][0], "score": res[last][1], "t": times[last], "price": prices[last]}
    return {"group": group, "hours": classified, "points": len(times), "first": times[0], "last": times[-1],
            "settings": {"ma": cfg["ma"], "fast": cfg["fast"], "slow": cfg["slow"], "stretchW": cfg["stretchW"]},
            "now": now, "baseline": baseline, "classes": classes}


def main(src=IN, dst=OUT):
    t0 = time.time()
    try:
        rows = json.loads(Path(src).read_text())
        if not isinstance(rows, list) or not rows:
            raise ValueError("no rows")
    except Exception as e:
        print(f"track.py: cannot read {src} ({e}); nothing written.")
        return 0
    assets = {}
    for key in GROUPS:
        try:
            s = summarize(key, rows)
        except Exception as e:                       # one asset must never stop the others
            print(f"track.py: {key} skipped ({e})")
            continue
        if s:
            assets[key] = s
    if not assets:
        print("track.py: not enough hourly prices yet for any asset; nothing written.")
        return 0
    out = {"t": int(time.time() * 1000),
           "note": ("Verdicts rebuilt hour by hour from the saved prices with the default settings of the pages, "
                    "using only data known at that hour. Only hours where all five indicators exist are counted. "
                    "Returns are measured to the first price at or after 24 h / 72 h / 168 h later. "
                    "Currencies and metals skip weekend hours."),
           "assets": assets}
    Path(dst).parent.mkdir(exist_ok=True)
    Path(dst).write_text(json.dumps(out, separators=(",", ":")))
    print(f"track.py: wrote {dst} for {len(assets)} assets in {time.time() - t0:.1f} s.")
    return 0


if __name__ == "__main__":
    try:
        main(*(sys.argv[1:3]))
    except Exception as e:                           # never fail the GitHub job
        print(f"track.py: stopped ({e}); nothing written.")
    sys.exit(0)
