"""株価・基準価額・配当を取得して data/ 以下のJSONを更新する（GitHub Actionsから1日1回実行）。

- data/market.json      : 最新の価格（異常値チェック付き）
- data/navs/CODE.json   : 投資信託の基準価額の履歴（積立の自動計上で約定日の価格に使う）
- data/holidays_jp.json : 日本の祝日・休日（積立の約定日の計算に使う）
- data/yearend/YYYY.json: その年の最新価格。年が変わると自動的に「年末値」として固定される
- data/dividends.json   : 1株あたり配当の履歴（追記のみ。一度記録した値は上書きしない）
"""
import csv
import datetime as dt
import io
import json
import pathlib
import re
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
JST = dt.timezone(dt.timedelta(hours=9))

# 運用会社APIのファンドコード（協会コード → 三菱UFJアセットマネジメントのfund_cd）
MUFG_FUNDS = {"0331418A": "253425"}
# 協会コード → ISINコード（基準価額の履歴を投資信託協会から取るのに使う）
FUND_ISIN = {"0331418A": "JP90C000H1T1"}
NAV_HISTORY_FROM = "2025-12-01"

# 前回価格からこの比率を超えて動いたら異常値候補として保留する
JUMP_LIMIT = 0.3
# 異常値候補が何日続いたら正しい値として採用するか（株式分割など）
CONFIRM_DAYS = 3


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read()


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def firestore_value(v):
    if "stringValue" in v:
        return v["stringValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return v["doubleValue"]
    return None


def load_collection(name):
    """Firestoreのコレクションを読む。未設定・失敗時は None。"""
    config = (ROOT / "firebase-config.js").read_text(encoding="utf-8")
    m = re.search(r'projectId:\s*"([^"]+)"', config)
    if not m or m.group(1).startswith("YOUR_"):
        return None
    base = f"https://firestore.googleapis.com/v1/projects/{m.group(1)}/databases/(default)/documents/{name}?pageSize=300"
    docs, token = [], ""
    try:
        while True:
            res = json.loads(http_get(base + (f"&pageToken={token}" if token else "")))
            for doc in res.get("documents", []):
                docs.append({k: firestore_value(v) for k, v in doc.get("fields", {}).items()})
            token = res.get("nextPageToken")
            if not token:
                return docs
    except Exception as e:  # noqa: BLE001
        print(f"Firestore read failed ({name}):", e)
        return None


def load_trades():
    """売買記録と積立設定。売買記録が取れないときは seed.json を使う。"""
    trades = load_collection("trades") or load_json(DATA / "seed.json", {"trades": []})["trades"]
    return trades + (load_collection("plans") or [])


def fetch_nav_history(code, isin):
    raw = http_get(f"https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download?isinCd={isin}&associFundCd={code}")
    navs = {}
    for r in csv.reader(io.StringIO(raw.decode("cp932"))):
        if r and r[0][:1].isdigit():
            d = dt.datetime.strptime(r[0], "%Y年%m月%d日").date().isoformat()
            if d >= NAV_HISTORY_FROM:
                navs[d] = int(r[1])
    return navs


def fetch_jp_holidays():
    raw = http_get("https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv").decode("cp932")
    days = []
    for r in csv.reader(io.StringIO(raw)):
        if r and r[0][:1].isdigit():
            y, m, d = map(int, r[0].split("/"))
            if y >= 2025:
                days.append(dt.date(y, m, d).isoformat())
    return sorted(days)


def jst_date(ts):
    return dt.datetime.fromtimestamp(ts, JST).date().isoformat()


def fetch_stock(code):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}.T?range=1mo&interval=1d&events=div"
    r = json.loads(http_get(url))["chart"]["result"][0]
    closes = [(jst_date(t), c) for t, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]) if c is not None]
    date, price = closes[-1]
    prev = closes[-2][1] if len(closes) >= 2 else None
    divs = [{"date": jst_date(v["date"]), "amount": v["amount"]} for v in r.get("events", {}).get("dividends", {}).values()]
    return {"price": round(price, 2), "date": date, "prevClose": round(prev, 2) if prev else None}, divs


def fetch_fund(code, isin):
    if code in MUFG_FUNDS:
        res = json.loads(http_get(f"https://developer.am.mufg.jp/fund_information_latest/fund_cd/{MUFG_FUNDS[code]}"))
        f = res["datasets"][0]
        d = f["base_date"]
        return {"price": f["nav"], "date": f"{d[:4]}-{d[4:6]}-{d[6:]}", "prevClose": f["nav"] - int(f["cmp_prev_day"])}
    if isin:  # 投資信託協会のCSV（全ファンド共通）
        raw = http_get(f"https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download?isinCd={isin}&associFundCd={code}")
        rows = [r for r in csv.reader(io.StringIO(raw.decode("cp932"))) if r and r[0][:1].isdigit()]
        to_iso = lambda s: dt.datetime.strptime(s, "%Y年%m月%d日").date().isoformat()  # noqa: E731
        return {"price": int(rows[-1][1]), "date": to_iso(rows[-1][0]), "prevClose": int(rows[-2][1])}
    raise ValueError(f"no price source for fund {code}")


def accept_price(code, new, old_market, split_dates=()):
    """前回の採用価格から大きく動いた値はすぐには採用しない（Yahooの一時的な異常値対策）。
    ただし、その間に株式分割が登録されていれば分割による値動きなので、すぐに採用する。"""
    old = old_market.get("prices", {}).get(code)
    if not old or old.get("date") == new["date"] and not old.get("pending"):
        return {**new, "suspect": False}
    if any(old["date"] < d <= new["date"] for d in split_dates):
        return {**new, "suspect": False}
    ratio = new["price"] / old["price"] - 1
    if abs(ratio) <= JUMP_LIMIT:
        return {**new, "suspect": False}
    pending = old.get("pending")
    if pending and abs(new["price"] / pending["price"] - 1) <= 0.05:
        count = pending["count"] + (1 if new["date"] != pending["date"] else 0)
    else:
        count = 1
    if count >= CONFIRM_DAYS:
        return {**new, "suspect": False}
    held = {k: old[k] for k in ("price", "date", "prevClose") if k in old}
    return {**held, "suspect": True, "pending": {"price": new["price"], "date": new["date"], "count": count}}


def merge_dividends(store, code, events):
    """新しい配当だけ追記する。日付が±5日以内の既存記録は同じ配当とみなす（Yahooの重複登録対策）。"""
    known = store.setdefault(code, [])
    for ev in sorted(events, key=lambda e: e["date"]):
        if ev["date"] < "2025-01-01":
            continue
        d = dt.date.fromisoformat(ev["date"])
        if any(abs((dt.date.fromisoformat(k["date"]) - d).days) <= 5 for k in known):
            continue
        known.append({"date": ev["date"], "amount": ev["amount"]})
        print(f"  new dividend {code} {ev['date']} {ev['amount']}")
    known.sort(key=lambda e: e["date"])
    if not known:
        del store[code]


def main():
    trades = load_trades()
    securities, splits = {}, {}
    for t in trades:
        if t.get("type") == "split":
            splits.setdefault(t["code"], []).append(t["date"])
        sec = securities.setdefault(t["code"], {"kind": t.get("kind", "stock"), "isin": None})
        sec["isin"] = sec["isin"] or t.get("isin") or FUND_ISIN.get(t["code"])

    old_market = load_json(DATA / "market.json", {})
    dividends = load_json(DATA / "dividends.json", {})
    prices, yearend_updates = {}, {}

    for code, sec in securities.items():
        try:
            if sec["kind"] == "fund":
                new, divs = fetch_fund(code, sec.get("isin")), []
            else:
                new, divs = fetch_stock(code)
        except Exception as e:  # noqa: BLE001
            print(f"{code}: fetch failed ({e})")
            if code in old_market.get("prices", {}):
                prices[code] = old_market["prices"][code]
            continue
        p = accept_price(code, new, old_market, splits.get(code, ()))
        prices[code] = p
        print(f"{code}: {p['price']} ({p['date']}){' SUSPECT' if p['suspect'] else ''}")
        if not p["suspect"]:
            yearend_updates.setdefault(p["date"][:4], {})[code] = {"price": p["price"], "date": p["date"]}
        if divs:
            merge_dividends(dividends, code, divs)
        if sec["kind"] == "fund" and sec.get("isin"):
            try:
                save_json(DATA / "navs" / f"{code}.json", fetch_nav_history(code, sec["isin"]))
            except Exception as e:  # noqa: BLE001
                print(f"{code}: nav history failed ({e})")

    try:
        save_json(DATA / "holidays_jp.json", fetch_jp_holidays())
    except Exception as e:  # noqa: BLE001
        print("holidays failed:", e)

    save_json(DATA / "market.json", {"updatedAt": dt.datetime.now(JST).isoformat(timespec="minutes"), "prices": prices})
    for year, entries in yearend_updates.items():
        path = DATA / "yearend" / f"{year}.json"
        save_json(path, {**load_json(path, {}), **entries})
    save_json(DATA / "dividends.json", dividends)


if __name__ == "__main__":
    main()
