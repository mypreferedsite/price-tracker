"""Collect USD prices every 30 minutes and append a row to data/snapshots.json.

Assets (all in USD):
  metals  : XAU gold, XAG silver, XPT platinum      (per troy ounce)
  currency: CHF, EUR, JPY, GBP                      (USD value of ONE unit)
  crypto  : BTC bitcoin, ETH ethereum

Each asset has a list of sources, tried in order. A price that jumps too far from the last saved
price is double-checked with the next source before it is accepted. Which source was used is
written to data/status.json. Uses only the Python standard library.

Optional: set a repository secret TWELVEDATA_KEY (free key from twelvedata.com) to use a proper
forex feed for CHF/EUR/JPY/GBP. Without it, Yahoo Finance is used for them."""
import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path("data/snapshots.json")
STATUS = Path("data/status.json")
MAX_ROWS = 20000
TD_KEY = os.environ.get("TWELVEDATA_KEY", "").strip()

# group, max accepted move since the last saved price, Twelve Data symbol + whether to invert it
ASSETS = {
    "XAU": dict(group="metal",    jump=0.06, yahoo="GC=F", td=("XAU/USD", False)),
    "XAG": dict(group="metal",    jump=0.10, yahoo="SI=F", td=("XAG/USD", False)),
    "XPT": dict(group="metal",    jump=0.10, yahoo="PL=F", td=("XPT/USD", False)),
    "CHF": dict(group="currency", jump=0.05, yahoo="CHFUSD=X", td=("USD/CHF", True),  er="CHF"),
    "EUR": dict(group="currency", jump=0.05, yahoo="EURUSD=X", td=("EUR/USD", False), er="EUR"),
    "JPY": dict(group="currency", jump=0.05, yahoo="JPYUSD=X", td=("USD/JPY", True),  er="JPY"),
    "GBP": dict(group="currency", jump=0.05, yahoo="GBPUSD=X", td=("GBP/USD", False), er="GBP"),
    "BTC": dict(group="crypto",   jump=0.15, yahoo="BTC-USD", coinbase="BTC-USD", kraken="XBTUSD"),
    "ETH": dict(group="crypto",   jump=0.15, yahoo="ETH-USD", coinbase="ETH-USD", kraken="ETHUSD"),
}


def get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def market_closed(group, now):
    """Currencies and metals do not trade from Friday ~22:00 UTC to Sunday ~22:00 UTC. Crypto never closes."""
    if group == "crypto":
        return False
    wd, h = now.weekday(), now.hour           # Monday = 0
    return wd == 5 or (wd == 4 and h >= 22) or (wd == 6 and h < 22)


# ---------------- sources: each returns a float or raises ----------------
def src_goldapi(key, a):
    return float(get_json(f"https://api.gold-api.com/price/{key}")["price"])


def src_yahoo(key, a):
    last = None
    for host in ("query1", "query2"):
        try:
            j = get_json(f"https://{host}.finance.yahoo.com/v8/finance/chart/{a['yahoo']}?interval=1m&range=1d")
            return float(j["chart"]["result"][0]["meta"]["regularMarketPrice"])
        except Exception as e:
            last = e
    raise last


def src_coinbase(key, a):
    return float(get_json(f"https://api.coinbase.com/v2/prices/{a['coinbase']}/spot")["data"]["amount"])


def src_kraken(key, a):
    j = get_json(f"https://api.kraken.com/0/public/Ticker?pair={a['kraken']}")
    if j.get("error"):
        raise RuntimeError(j["error"])
    return float(next(iter(j["result"].values()))["c"][0])


def src_swissquote(key, a):
    """Free public quote feed of Swissquote bank (no key). Mid of bid and ask, USD per troy ounce."""
    j = get_json(f"https://forex-data-feed.swissquote.com/public-quote/feed/{key}/USD")
    prices = j[0]["spreadProfilePrices"]
    p = next((x for x in prices if x.get("spreadProfile") == "standard"), prices[0])
    return (float(p["bid"]) + float(p["ask"])) / 2


_td_cache = {}


def src_twelvedata(key, a):
    if not TD_KEY:
        raise RuntimeError("no TWELVEDATA_KEY")
    if not _td_cache:                          # one request for all four currencies
        syms = ",".join(x["td"][0] for x in ASSETS.values() if "td" in x)
        j = get_json(f"https://api.twelvedata.com/price?symbol={syms}&apikey={TD_KEY}")
        for x in ASSETS.values():
            if "td" in x:
                item = j.get(x["td"][0], j if "price" in j else {})
                if "price" in item:
                    _td_cache[x["td"][0]] = float(item["price"])
        if not _td_cache:
            raise RuntimeError(str(j)[:120])
    sym, inv = a["td"]
    p = _td_cache[sym]
    return 1 / p if inv else p


_er_cache = {}


def src_open_er(key, a):                       # updated about once a day: last resort only
    if not _er_cache:
        _er_cache.update(get_json("https://open.er-api.com/v6/latest/USD")["rates"])
    return 1 / float(_er_cache[a["er"]])


SOURCES = {
    "metal":    [("gold-api", src_goldapi), ("swissquote", src_swissquote), ("twelvedata", src_twelvedata), ("yahoo", src_yahoo)],
    "currency": [("twelvedata", src_twelvedata), ("yahoo", src_yahoo), ("open.er-api (daily)", src_open_er)],
    "crypto":   [("coinbase", src_coinbase), ("kraken", src_kraken), ("yahoo", src_yahoo)],
}


def choose(key, a, last, warnings):
    """Try the sources in order. Accept a price within the allowed move; a bigger move must be confirmed by a second source."""
    suspicious = []
    for name, fn in SOURCES[a["group"]]:
        try:
            v = fn(key, a)
            if not v > 0:
                raise ValueError(f"bad value {v}")
        except Exception as e:
            print(f"  {key}: {name} failed: {e}")
            continue
        if last is None or abs(v / last - 1) <= a["jump"]:
            return v, name
        for n0, v0 in suspicious:              # a big move that two sources agree on is real
            if abs(v / v0 - 1) < 0.01:
                warnings.append(f"{key}: large move confirmed by {n0} and {name}")
                return v0, n0
        suspicious.append((name, v))
        print(f"  {key}: {name} gave {v}, far from last {last}; checking next source")
    if suspicious:
        warnings.append(f"{key}: rejected a suspicious price {suspicious[0][1]} (last was {last})")
    return None, None


def main():
    now = datetime.now(timezone.utc)
    rows = json.loads(OUT.read_text()) if OUT.exists() else []
    last = {}
    for r in reversed(rows[-200:]):            # last saved value of each asset
        for k, v in r["v"].items():
            last.setdefault(k, v)

    values, used, warnings = {}, {}, []
    for key, a in ASSETS.items():
        if market_closed(a["group"], now):
            continue
        v, name = choose(key, a, last.get(key), warnings)
        if v is not None:
            values[key] = round(v, 8 if v < 0.1 else 6)
            used[key] = name
    if not values:
        print("No prices to save (markets closed or all sources failed).")
        STATUS.write_text(json.dumps({"t": int(time.time() * 1000), "source": {}, "warnings": warnings or ["no prices saved"]}))
        return

    OUT.parent.mkdir(exist_ok=True)
    rows.append({"t": int(time.time() * 1000), "v": values})
    OUT.write_text(json.dumps(rows[-MAX_ROWS:]))
    STATUS.write_text(json.dumps({"t": int(time.time() * 1000), "source": used, "warnings": warnings}))
    print("Saved:", values)
    print("Sources:", used, "| warnings:", warnings)


if __name__ == "__main__":
    main()
