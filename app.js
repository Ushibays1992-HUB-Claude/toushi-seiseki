import { firebaseConfig } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const CONFIGURED = !firebaseConfig.projectId.startsWith("YOUR_");
const TAXABLE = new Set(["特定", "一般"]);
const TAX_RATE = 0.20315;
const ACCOUNTS = ["NISA成長", "旧NISA", "NISAつみたて", "特定", "一般"];
const TYPE_LABEL = { opening: "年初保有", buy: "買付", sell: "売却", split: "株式分割" };
const TYPE_ORDER = { opening: 0, buy: 1, sell: 2, split: 3 };

const state = {
  baseYear: 2026,
  market: { prices: {} },
  yearend: {},
  dividends: {},
  seed: [],
  trades: [],
  overrides: {},
  user: null,
  view: "total",
  fb: null,
};

// ---------- utils ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const todayJST = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const curYear = () => Number(todayJST().slice(0, 4));
const yen = (v) => `${Math.round(v).toLocaleString("ja-JP")}円`;
const signed = (v) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(Math.round(v)).toLocaleString("ja-JP")}`;
const pct = (v) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v * 100).toFixed(2)}%` : "—");
const tone = (v) => (v > 0.5 ? "gain" : v < -0.5 ? "loss" : "");
const money = (v) => `<span class="${tone(v)}">${signed(v)}</span>`;
const unitOf = (kind) => (kind === "fund" ? 10000 : 1);
const fmtDate = (d) => d.replaceAll("-", "/");
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function getJSON(path, fallback) {
  try {
    const res = await fetch(`${path}?t=${Date.now()}`);
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

// ---------- calculation ----------
function sortedTrades() {
  return [...state.trades].sort((a, b) => a.date.localeCompare(b.date) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
}

function securities() {
  const map = {};
  // 銘柄名が空欄の売買は、それまでに登録された銘柄名を引き継ぐ
  for (const t of sortedTrades()) map[t.code] = { name: t.name || map[t.code]?.name || t.code, kind: t.kind || "stock" };
  return map;
}

/** cutoff日（含む）時点の保有数量 { code: { account: qty } } */
function holdingsAt(cutoff) {
  const h = {};
  for (const t of sortedTrades()) {
    if (t.date > cutoff) break;
    const byAcct = (h[t.code] ??= {});
    if (t.type === "split") {
      for (const a in byAcct) byAcct[a] *= Number(t.ratio) || 1;
    } else {
      const sign = t.type === "sell" ? -1 : 1;
      byAcct[t.account] = (byAcct[t.account] ?? 0) + sign * Number(t.qty);
    }
  }
  return h;
}

const sumQty = (byAcct) => Object.values(byAcct ?? {}).reduce((s, q) => s + q, 0);

function lastTradePrice(code) {
  const t = sortedTrades().filter((x) => x.code === code && x.price).pop();
  return t ? Number(t.price) : null;
}

/** 年末（今年は最新）の価格。取れない場合は直近の約定単価で代用 */
function priceAt(code, year) {
  const ye = state.yearend[year]?.[code];
  if (ye) return { price: ye.price, date: ye.date };
  const m = state.market.prices?.[code];
  if (year === curYear() && m) return { price: m.price, date: m.date };
  const p = lastTradePrice(code);
  return p ? { price: p, date: null, fallback: true } : null;
}

function dividendEvents(year, endCut) {
  const list = [];
  const sec = securities();
  for (const [code, events] of Object.entries(state.dividends)) {
    if (!sec[code]) continue;
    for (const ev of events) {
      if (ev.date < `${year}-01-01` || ev.date > endCut) continue;
      // 基準日の2日前までに約定した分が配当の対象
      const hold = holdingsAt(addDays(ev.date, -2))[code] ?? {};
      let gross = 0;
      let net = 0;
      let qty = 0;
      for (const [acct, q] of Object.entries(hold)) {
        if (q <= 0) continue;
        const g = ev.amount * q;
        qty += q;
        gross += g;
        net += TAXABLE.has(acct) ? Math.floor(g * (1 - TAX_RATE)) : g;
      }
      const key = `${code}_${ev.date}`;
      const override = state.overrides[key];
      if (qty <= 0 && !override) continue;
      list.push({
        key, code, name: sec[code].name, date: ev.date, perShare: ev.amount, qty,
        auto: Math.round(net), amount: override ? Number(override.amount) : Math.round(net), overridden: !!override,
      });
    }
  }
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

function yearReport(year) {
  const today = todayJST();
  const isCurrent = year === curYear();
  const endCut = isCurrent ? today : `${year}-12-31`;
  const h0 = holdingsAt(`${year - 1}-12-31`);
  const h1 = holdingsAt(endCut);
  const sec = securities();
  const divs = dividendEvents(year, endCut);
  const trades = sortedTrades().filter((t) => t.date >= `${year}-01-01` && t.date <= endCut && t.type !== "opening");

  const rows = {};
  const row = (code) => (rows[code] ??= {
    code, name: sec[code]?.name ?? code, kind: sec[code]?.kind ?? "stock",
    startQty: 0, endQty: 0, start: 0, end: 0, buy: 0, sell: 0, div: 0, dayChange: 0, flags: [],
  });

  for (const code of new Set([...Object.keys(h0), ...Object.keys(h1)])) {
    const r = row(code);
    const u = unitOf(r.kind);
    r.startQty = sumQty(h0[code]);
    r.endQty = sumQty(h1[code]);
    if (r.startQty > 0) {
      const p = priceAt(code, year - 1);
      if (!p) r.flags.push("年初価格なし");
      r.start = r.startQty * (p?.price ?? 0) / u;
    }
    if (r.endQty > 0) {
      const p = priceAt(code, year);
      if (!p) r.flags.push("価格なし");
      else if (p.fallback) r.flags.push("価格未取得");
      r.end = r.endQty * (p?.price ?? 0) / u;
      r.endPrice = p?.price;
      const m = state.market.prices?.[code];
      if (isCurrent && m) {
        if (m.suspect) r.flags.push("価格要確認");
        if (m.prevClose) r.dayChange = r.endQty * (m.price - m.prevClose) / u;
      }
    }
  }
  for (const t of trades) {
    if (t.type === "buy") row(t.code).buy += Number(t.amount) || 0;
    if (t.type === "sell") row(t.code).sell += Number(t.amount) || 0;
  }
  for (const d of divs) row(d.code).div += d.amount;

  const list = Object.values(rows)
    .map((r) => ({ ...r, perf: r.end - r.start - r.buy + r.sell + r.div }))
    .filter((r) => r.start || r.end || r.buy || r.sell || r.div)
    .sort((a, b) => b.perf - a.perf);

  const total = list.reduce((t, r) => {
    for (const k of ["start", "end", "buy", "sell", "div", "perf", "dayChange"]) t[k] += r[k];
    return t;
  }, { start: 0, end: 0, buy: 0, sell: 0, div: 0, perf: 0, dayChange: 0 });
  total.price = total.perf - total.div;
  total.rate = total.perf / (total.start + total.buy);

  return { year, isCurrent, endCut, rows: list, divs, trades, total };
}

function years() {
  const ys = [];
  for (let y = state.baseYear; y <= curYear(); y++) ys.push(y);
  return ys;
}

// ---------- rendering ----------
function renderTabs() {
  const tabs = [["total", "通算"], ...years().reverse().map((y) => [String(y), `${y}年`])];
  $("#tabs").innerHTML = tabs
    .map(([k, label]) => `<button role="tab" data-view="${k}" aria-selected="${state.view === k}">${label}</button>`)
    .join("");
}

function statTile(k, v, s = "") {
  return `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
}

function heroCard(label, t, extra) {
  return `<section class="card hero">
    <div>
      <p class="hero-label">${label}</p>
      <p class="hero-value ${tone(t.perf)}">${signed(t.perf)}<span style="font-size:.5em">円</span></p>
      <p class="hero-sub muted">利回り <span class="${tone(t.perf)}">${pct(t.rate)}</span>（年初評価額＋買付額に対して）</p>
    </div>
    <div class="stats">
      ${statTile("値動きによる損益", money(t.price), "売買損益を含む")}
      ${statTile("配当金", money(t.div), "基準日ベース")}
      ${extra}
    </div>
  </section>`;
}

function holdingsTable(rows, opts) {
  if (!rows.length) return `<p class="empty">データがありません</p>`;
  const tr = rows.map((r) => `<tr>
      <td class="name">${esc(r.name)}${r.flags.map((f) => `<span class="warn-mark">${esc(f)}</span>`).join("")}
        <span class="sub">${esc(r.code)}${opts.qty ? ` ・ ${r.endQty.toLocaleString("ja-JP")}${r.kind === "fund" ? "口" : "株"}` : ""}</span></td>
      ${opts.values ? `<td class="n opt">${r.start ? yen(r.start) : "—"}</td><td class="n">${r.end ? yen(r.end) : "—"}</td>` : ""}
      <td class="n opt">${r.buy || r.sell ? `${r.buy ? `買 ${yen(r.buy)}` : ""}${r.buy && r.sell ? "<br>" : ""}${r.sell ? `売 ${yen(r.sell)}` : ""}` : "—"}</td>
      <td class="n">${r.div ? yen(r.div) : "—"}</td>
      <td class="n"><strong>${money(r.perf)}</strong></td>
    </tr>`).join("");
  const t = rows.reduce((a, r) => ({ start: a.start + r.start, end: a.end + r.end, div: a.div + r.div, perf: a.perf + r.perf }), { start: 0, end: 0, div: 0, perf: 0 });
  return `<div class="table-wrap"><table>
    <thead><tr><th>銘柄</th>${opts.values ? `<th class="n opt">年初評価額</th><th class="n">${opts.endLabel}</th>` : ""}<th class="n opt">買付・売却</th><th class="n">配当金</th><th class="n">成績</th></tr></thead>
    <tbody>${tr}</tbody>
    <tfoot><tr><td>合計</td>${opts.values ? `<td class="n opt">${yen(t.start)}</td><td class="n">${yen(t.end)}</td>` : ""}<td class="opt"></td><td class="n">${yen(t.div)}</td><td class="n">${money(t.perf)}</td></tr></tfoot>
  </table></div>`;
}

function dividendTable(divs) {
  if (!divs.length) return `<p class="empty">この年の配当金はまだありません</p>`;
  const admin = !!state.user;
  return `<div class="table-wrap"><table>
    <thead><tr><th>基準日</th><th>銘柄</th><th class="n opt">1株配当</th><th class="n opt">株数</th><th class="n">金額</th>${admin ? "<th></th>" : ""}</tr></thead>
    <tbody>${divs.slice().reverse().map((d) => `<tr>
      <td class="num" style="text-align:left">${fmtDate(d.date)}</td>
      <td class="name">${esc(d.name)}<span class="sub">${esc(d.code)}</span></td>
      <td class="n opt">${d.perShare.toLocaleString("ja-JP")}円</td>
      <td class="n opt">${d.qty.toLocaleString("ja-JP")}</td>
      <td class="n">${yen(d.amount)}${d.overridden ? `<span class="sub">修正済み（自動 ${yen(d.auto)}）</span>` : ""}</td>
      ${admin ? `<td class="n"><button class="btn small" data-act="div-edit" data-key="${d.key}" data-amount="${d.amount}">修正</button>${d.overridden ? ` <button class="btn link small" data-act="div-reset" data-key="${d.key}">戻す</button>` : ""}</td>` : ""}
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function tradeTable(trades) {
  const sec = securities();
  const admin = !!state.user;
  const form = admin ? tradeForm() : "";
  if (!trades.length) return `${form}<p class="empty">この年の売買はありません</p>`;
  return `${form}<div class="table-wrap"><table>
    <thead><tr><th>約定日</th><th>種別</th><th>銘柄</th><th class="n">数量</th><th class="n opt">単価</th><th class="n">受渡金額</th>${admin ? "<th></th>" : ""}</tr></thead>
    <tbody>${trades.slice().reverse().map((t) => `<tr>
      <td class="num" style="text-align:left">${fmtDate(t.date)}</td>
      <td>${TYPE_LABEL[t.type]}<span class="tag">${esc(t.account)}</span></td>
      <td class="name">${esc(t.name || sec[t.code]?.name)}<span class="sub">${esc(t.code)}</span></td>
      <td class="n">${t.type === "split" ? `1→${esc(t.ratio)}` : Number(t.qty).toLocaleString("ja-JP")}</td>
      <td class="n opt">${t.price ? Number(t.price).toLocaleString("ja-JP") : "—"}</td>
      <td class="n">${t.amount ? yen(t.amount) : "—"}</td>
      ${admin ? `<td class="n">${t.id ? `<button class="btn link small" data-act="trade-del" data-id="${t.id}">削除</button>` : ""}</td>` : ""}
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function tradeForm() {
  const sec = securities();
  return `<form class="trade" id="trade-form">
    <label>約定日<input type="date" name="date" value="${todayJST()}" required></label>
    <label>種別<select name="type"><option value="buy">買付</option><option value="sell">売却</option><option value="split">株式分割</option></select></label>
    <label>銘柄コード<input name="code" list="codes" required placeholder="例: 2432"></label>
    <datalist id="codes">${Object.entries(sec).map(([c, s]) => `<option value="${esc(c)}">${esc(s.name)}</option>`).join("")}</datalist>
    <label>銘柄名（登録済みの銘柄は空欄可）<input name="name"></label>
    <label>商品<select name="kind"><option value="stock">株式・ETF</option><option value="fund">投資信託</option></select></label>
    <label>口座<select name="account">${ACCOUNTS.map((a) => `<option>${a}</option>`).join("")}</select></label>
    <label data-for="qty">数量<input type="number" name="qty" min="0" step="any"></label>
    <label data-for="price">単価<input type="number" name="price" min="0" step="any"></label>
    <label data-for="amount">受渡金額<input type="number" name="amount" min="0" step="any"></label>
    <label data-for="ratio" hidden>分割比率（1株→）<input type="number" name="ratio" min="0" step="any"></label>
    <label data-for="isin" hidden>ISINコード（新しい投信のみ）<input name="isin" placeholder="例: JP90C000H1T1"></label>
    <div class="actions"><button type="submit" class="btn primary">登録</button></div>
  </form>`;
}

function renderYear(year) {
  const r = yearReport(year);
  const t = r.total;
  const extra = r.isCurrent
    ? statTile("現在の評価額", yen(t.end), `前日比 ${signed(t.dayChange)}円`)
    : statTile("年末評価額", yen(t.end), `年初 ${yen(t.start)}`);
  return `
    ${heroCard(`${year}年の成績${r.isCurrent ? `（${fmtDate(r.endCut)} 時点）` : ""}`, t,
      `${extra}${statTile("今年の買付・売却", `<span style="font-size:.9rem">買 ${yen(t.buy)}</span>`, `売 ${yen(t.sell)}`)}`)}
    <section class="card"><h2>銘柄別の成績 <small>成績＝${r.isCurrent ? "現在" : "年末"}評価額−年初評価額−買付＋売却＋配当</small></h2>
      ${holdingsTable(r.rows, { values: true, qty: true, endLabel: r.isCurrent ? "現在評価額" : "年末評価額" })}</section>
    <section class="card"><h2>配当金 <small>NISA口座は非課税、特定・一般口座は税引後</small></h2>${dividendTable(r.divs)}</section>
    <section class="card"><h2>売買履歴</h2>${tradeTable(r.trades)}</section>`;
}

function renderTotal() {
  const reports = years().map(yearReport);
  const total = { start: reports[0]?.total.start ?? 0, buy: 0, sell: 0, div: 0, perf: 0, price: 0 };
  const byCode = {};
  for (const r of reports) {
    for (const k of ["buy", "sell", "div", "perf", "price"]) total[k] += r.total[k];
    for (const row of r.rows) {
      const b = (byCode[row.code] ??= { ...row, start: 0, end: 0, buy: 0, sell: 0, div: 0, perf: 0, flags: [] });
      for (const k of ["buy", "sell", "div", "perf"]) b[k] += row[k];
      b.endQty = row.endQty;
    }
  }
  total.rate = total.perf / (total.start + total.buy);
  const latest = reports[reports.length - 1]?.total;
  const yearRows = reports.slice().reverse().map((r) => `<tr>
      <td><button class="btn link" data-view="${r.year}">${r.year}年</button>${r.isCurrent ? '<span class="tag">途中</span>' : ""}</td>
      <td class="n opt">${yen(r.total.start)}</td><td class="n">${yen(r.total.end)}</td>
      <td class="n opt">${yen(r.total.div)}</td><td class="n">${pct(r.total.rate)}</td>
      <td class="n"><strong>${money(r.total.perf)}</strong></td></tr>`).join("");
  return `
    ${heroCard(`通算の成績（${state.baseYear}年〜）`, total,
      `${statTile("現在の評価額", yen(latest?.end ?? 0), `前日比 ${signed(latest?.dayChange ?? 0)}円`)}`)}
    <section class="card"><h2>年ごとの成績</h2><div class="table-wrap"><table>
      <thead><tr><th>年</th><th class="n opt">年初評価額</th><th class="n">年末(現在)評価額</th><th class="n opt">配当金</th><th class="n">利回り</th><th class="n">成績</th></tr></thead>
      <tbody>${yearRows}</tbody></table></div></section>
    <section class="card"><h2>銘柄別の通算成績</h2>
      ${holdingsTable(Object.values(byCode).sort((a, b) => b.perf - a.perf), { values: false, qty: true })}</section>`;
}

function renderAuth() {
  const el = $("#auth");
  if (!CONFIGURED) { el.innerHTML = ""; return; }
  el.innerHTML = state.user
    ? `<span>編集モード</span><button class="btn small" data-act="logout">ログアウト</button>`
    : `<button class="btn small" data-act="login">編集ログイン</button>`;
}

function renderNotice() {
  const msgs = [];
  if (!CONFIGURED) msgs.push("プレビュー表示中：Firebase未設定のため初期データ（seed.json）で表示しています。");
  if (CONFIGURED && state.user && state.trades.length === 0)
    msgs.push(`売買データが空です。<button class="btn small primary" data-act="seed">初期データを登録</button>`);
  const suspect = Object.entries(state.market.prices ?? {}).filter(([, p]) => p.suspect).map(([c]) => c);
  if (suspect.length) msgs.push(`株価が急変したため前日の価格で表示している銘柄があります：${suspect.map(esc).join(", ")}（株式分割の場合は売買履歴に「株式分割」を登録してください）`);
  const el = $("#notice");
  el.hidden = !msgs.length;
  el.innerHTML = msgs.map((m) => `<div>${m}</div>`).join("");
}

function render() {
  renderTabs();
  renderAuth();
  renderNotice();
  const upd = state.market.updatedAt ? new Date(state.market.updatedAt) : null;
  $("#updated").textContent = upd ? `価格更新：${upd.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" })}` : "";
  $("#app").innerHTML = state.view === "total" ? renderTotal() : renderYear(Number(state.view));
  bindForm();
}

// ---------- editing ----------
function bindForm() {
  const form = $("#trade-form");
  if (!form) return;
  const sec = securities();
  const show = () => {
    const type = form.type.value;
    const fund = form.kind.value === "fund";
    form.querySelector('[data-for="ratio"]').hidden = type !== "split";
    for (const k of ["qty", "price", "amount"]) form.querySelector(`[data-for="${k}"]`).hidden = type === "split";
    form.querySelector('[data-for="isin"]').hidden = !(fund && !sec[form.code.value]);
    form.querySelector('[data-for="qty"]').firstChild.textContent = fund ? "口数" : "数量";
    form.querySelector('[data-for="price"]').firstChild.textContent = fund ? "基準価額（1万口あたり）" : "単価";
  };
  const autoAmount = () => {
    const q = Number(form.qty.value);
    const p = Number(form.price.value);
    if (q && p) form.amount.value = Math.round(q * p / unitOf(form.kind.value));
  };
  form.code.addEventListener("change", () => {
    const s = sec[form.code.value.trim()];
    form.name.placeholder = s ? `空欄なら「${s.name}」` : "新規銘柄は必須";
    if (s) form.kind.value = s.kind;
    const last = sortedTrades().filter((t) => t.code === form.code.value.trim() && t.account).pop();
    if (last) form.account.value = last.account;
    show();
  });
  form.type.addEventListener("change", show);
  form.kind.addEventListener("change", show);
  form.qty.addEventListener("input", autoAmount);
  form.price.addEventListener("input", autoAmount);
  show();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const t = { date: f.date, type: f.type, code: f.code.trim(), name: f.name.trim(), kind: f.kind, account: f.account };
    if (f.type === "split") {
      t.qty = 0;
      t.ratio = Number(f.ratio);
      if (!t.ratio) return alert("分割比率を入力してください");
    } else {
      t.qty = Number(f.qty);
      t.price = Number(f.price) || null;
      t.amount = Number(f.amount);
      if (!t.qty || !t.amount) return alert("数量と受渡金額を入力してください");
    }
    if (!t.name && !sec[t.code]) return alert("新規の銘柄は銘柄名を入力してください");
    if (f.isin) t.isin = f.isin.trim();
    await write(() => state.fb.addTrade(t));
  });
}

async function write(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    alert(err.code === "permission-denied" ? "編集権限がありません（登録したGoogleアカウントでログインしてください）" : `保存に失敗しました：${err.message}`);
  }
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-view],[data-act]");
  if (!el) return;
  if (el.dataset.view) {
    state.view = el.dataset.view;
    history.replaceState(null, "", `#${state.view}`);
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  const fb = state.fb;
  switch (el.dataset.act) {
    case "login": return write(() => fb.login());
    case "logout": return fb.logout();
    case "seed":
      if (confirm(`初期データ（${state.seed.length}件）を登録しますか？`)) await write(() => fb.importSeed(state.seed));
      return;
    case "trade-del":
      if (confirm("この売買記録を削除しますか？")) await write(() => fb.deleteTrade(el.dataset.id));
      return;
    case "div-edit": {
      const v = prompt("実際に受け取った金額（円）を入力してください", el.dataset.amount);
      if (v !== null && v !== "" && Number.isFinite(Number(v))) await write(() => fb.setOverride(el.dataset.key, Number(v)));
      return;
    }
    case "div-reset": return write(() => fb.deleteOverride(el.dataset.key));
  }
});

// ---------- Firebase ----------
async function initFirebase() {
  const [{ initializeApp }, fs, au] = await Promise.all([
    import(`${FB}firebase-app.js`), import(`${FB}firebase-firestore.js`), import(`${FB}firebase-auth.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const db = fs.getFirestore(app);
  const auth = au.getAuth(app);
  state.fb = {
    login: () => au.signInWithPopup(auth, new au.GoogleAuthProvider()),
    logout: () => au.signOut(auth),
    addTrade: (t) => fs.addDoc(fs.collection(db, "trades"), { ...t, createdAt: fs.serverTimestamp() }),
    deleteTrade: (id) => fs.deleteDoc(fs.doc(db, "trades", id)),
    setOverride: (key, amount) => fs.setDoc(fs.doc(db, "divOverrides", key), { amount }),
    deleteOverride: (key) => fs.deleteDoc(fs.doc(db, "divOverrides", key)),
    importSeed: async (trades) => {
      const batch = fs.writeBatch(db);
      for (const t of trades) batch.set(fs.doc(fs.collection(db, "trades")), { ...t, createdAt: fs.serverTimestamp() });
      await batch.commit();
    },
  };
  au.onAuthStateChanged(auth, (u) => { state.user = u; render(); });
  fs.onSnapshot(fs.collection(db, "trades"), (snap) => {
    state.trades = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  fs.onSnapshot(fs.collection(db, "divOverrides"), (snap) => {
    state.overrides = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    render();
  });
}

// ---------- boot ----------
async function boot() {
  const [seed, market, dividends] = await Promise.all([
    getJSON("data/seed.json", { trades: [] }), getJSON("data/market.json", { prices: {} }), getJSON("data/dividends.json", {}),
  ]);
  state.seed = seed.trades;
  state.baseYear = seed.baseYear ?? state.baseYear;
  state.market = market;
  state.dividends = dividends;
  const ys = [];
  for (let y = state.baseYear - 1; y <= curYear(); y++) ys.push(y);
  const files = await Promise.all(ys.map((y) => getJSON(`data/yearend/${y}.json`, null)));
  ys.forEach((y, i) => { if (files[i]) state.yearend[y] = files[i]; });

  const hash = location.hash.slice(1);
  if (hash === "total" || years().includes(Number(hash))) state.view = hash;

  if (CONFIGURED) {
    render();
    await initFirebase();
  } else {
    state.trades = state.seed;
    render();
  }
}

boot();
