// Aggregador robusto (Node handler) con deadline, snapshot y fallback Finnhub para stocks.
// Fuentes: Twelve Data (stocks primario), Finnhub (stocks fallback), Stooq (^SPX), CoinGecko (BTC/ETH), CriptoYa (USDARS).

const TD_TOKEN = process.env.TWELVE_DATA_TOKEN;
const FH_TOKEN = process.env.FINNHUB_TOKEN;

// ---- Parámetros de resiliencia (amplios)
const PER_SOURCE_TIMEOUT_MS = 3000;
const GLOBAL_DEADLINE_MS     = 3500;
const CDN_SMAXAGE_SEC        = 5;
const CDN_STALE_SEC          = 20;

let lastGoodSnapshot = null;
let lastGoodAt = 0;

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type");
  res.setHeader("cache-control", `public, s-maxage=${CDN_SMAXAGE_SEC}, stale-while-revalidate=${CDN_STALE_SEC}, max-age=0`);
  res.end(JSON.stringify(data));
}

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

async function fetchWithTimeout(url, init = {}, ms = PER_SOURCE_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// ---------- Fetchers

// Twelve Data (batch)
async function fetchTwelveData(symbols) {
  if (!TD_TOKEN || !symbols.length) return { data: {}, error: "twelve-no-token-or-empty" };
  const url = `https://api.twelvedata.com/quote?symbol=${symbols.join(",")}&apikey=${TD_TOKEN}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { data: {}, error: `twelve-http-${res.status}` };
    const raw = await res.json();
    const out = {};
    if (raw && typeof raw === "object" && !raw.symbol) {
      for (const sym of symbols) {
        const q = raw[sym];
        if (q?.status === "ok") {
          out[sym] = {
            price: num(q.price ?? q.c),
            prevClose: num(q.previous_close ?? q.pc),
            source: "twelvedata",
          };
        } else if (q?.status) {
          // guardamos el error por símbolo
          out[sym] = out[sym] || {};
          out[sym].__error = `twelve-${sym}-${q.status}`;
        }
      }
    } else if (raw?.symbol) {
      out[raw.symbol] = {
        price: num(raw.price ?? raw.c),
        prevClose: num(raw.previous_close ?? raw.pc),
        source: "twelvedata",
      };
    }
    return { data: out, error: null };
  } catch (e) {
    return { data: {}, error: `twelve-ex-${(e && e.name) || "err"}` };
  }
}

// Finnhub (fallback por símbolo: quote)
async function fetchFinnhub(symbols) {
  if (!FH_TOKEN || !symbols.length) return { data: {}, error: "finnhub-no-token-or-empty" };
  const out = {};
  const errs = [];
  // hacemos requests en paralelo pero con timeout por cada una
  await Promise.all(symbols.map(async (sym) => {
    const url = `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FH_TOKEN}`;
    try {
      const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
      if (!res.ok) { errs.push(`fh-http-${sym}-${res.status}`); return; }
      const j = await res.json();
      const price = num(j.c);
      const prev  = num(j.pc);
      if (price != null) {
        out[sym] = { price, prevClose: prev, source: "finnhub" };
      } else {
        errs.push(`fh-empty-${sym}`);
      }
    } catch (e) {
      errs.push(`fh-ex-${sym}-${(e && e.name) || "err"}`);
    }
  }));
  return { data: out, error: errs.length ? errs.join(",") : null };
}

// Stooq (^SPX en puntos)
async function fetchStooqSPX() {
  const url = "https://stooq.com/q/l/?s=%5Espx&i=d";
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "text/plain" } });
    if (!res.ok) return { data: {}, error: `stooq-http-${res.status}` };
    const txt = await res.text();
    const parts = (txt.trim().split("\n")[0] || "").split(",");
    const close = num(parts[6]);
    if (!Number.isFinite(close)) return { data: {}, error: "stooq-parse" };
    return { data: { "^GSPC": { price: close, prevClose: null, source: "stooq" } }, error: null };
  } catch (e) {
    return { data: {}, error: `stooq-ex-${(e && e.name) || "err"}` };
  }
}

// CoinGecko (BTC/ETH %24h)
async function fetchCoinGecko(ids) {
  const need = [];
  if (ids.includes("BTC")) need.push("bitcoin");
  if (ids.includes("ETH")) need.push("ethereum");
  if (!need.length) return { data: {}, error: null };
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${need.join(",")}&vs_currencies=usd&include_24hr_change=true`;
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { data: {}, error: `cg-http-${res.status}` };
    const j = await res.json();
    const out = {};
    if (j.bitcoin)  out["BTC"] =  { price: num(j.bitcoin.usd),   changePct24h: num(j.bitcoin.usd_24h_change),   source: "coingecko" };
    if (j.ethereum) out["ETH"] =  { price: num(j.ethereum.usd),  changePct24h: num(j.ethereum.usd_24h_change),  source: "coingecko" };
    return { data: out, error: null };
  } catch (e) {
    return { data: {}, error: `cg-ex-${(e && e.name) || "err"}` };
  }
}

// CriptoYa (USDARS)
async function fetchCriptoYa() {
  const url = "https://criptoya.com/api/dolar";
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { data: {}, error: `cy-http-${res.status}` };
    const d = await res.json();
    const pick = (n) => num(n?.price ?? n?.ask ?? n?.bid);
    const out = {};
    if (d.oficial) out["OFICIAL"] = { price: pick(d.oficial), changePct: num(d.oficial.variation), source: "criptoya" };
    if (d.blue)   out["BLUE"]   = { price: pick(d.blue),    changePct: num(d.blue.variation),    source: "criptoya" };
    const mep = d?.mep?.gd30?.ci;
    if (mep)      out["MEP"]    = { price: num(mep.price),  changePct: num(mep.variation),       source: "criptoya" };
    return { data: out, error: null };
  } catch (e) {
    return { data: {}, error: `cy-ex-${(e && e.name) || "err"}` };
  }
}

// ---------- Ensamblado
function mapItem(id, raw) {
  const meta = {
    BTC:    { label: "Bitcoin",      kind: "crypto", currency: "USD" },
    ETH:    { label: "Ethereum",     kind: "crypto", currency: "USD" },
    OFICIAL:{ label: "Dólar Oficial",kind: "fx_ars", currency: "ARS" },
    BLUE:   { label: "Dólar Blue",   kind: "fx_ars", currency: "ARS" },
    MEP:    { label: "Dólar MEP",    kind: "fx_ars", currency: "ARS" },
    "^GSPC":{ label: "S&P 500",      kind: "index",  currency: "USD" },
    NVDA:   { label: "Nvidia",       kind: "stock",  currency: "USD" },
    PLTR:   { label: "Palantir",     kind: "stock",  currency: "USD" },
  }[id] || { label: id, kind: "stock", currency: "USD" };

  let changeAbs = null, changePct = null, direction = "flat";
  if (raw?.changePct24h != null) {
    changePct = raw.changePct24h;
  } else if (raw?.changePct != null) {
    changePct = raw.changePct;
  } else if (raw?.price != null && raw?.prevClose != null && raw.prevClose > 0) {
    changeAbs = raw.price - raw.prevClose;
    changePct = (changeAbs / raw.prevClose) * 100;
  }
  if (changePct != null) {
    direction = changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";
    if (changeAbs == null && raw?.prevClose != null) {
      changeAbs = raw.price != null ? raw.price - raw.prevClose : null;
    }
  }
  return {
    id,
    label: meta.label,
    kind: meta.kind,
    currency: meta.currency,
    price: raw?.price ?? null,
    prevClose: raw?.prevClose ?? null,
    source: raw?.source || "unknown",
    changeAbs: round(changeAbs, 4),
    changePct: round(changePct, 2),
    direction
  };
}

// ---------- Handler
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  const start = Date.now();
  const debug = (req.url || "").includes("debug=1");
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const raw = (url.searchParams.get("items") || "").trim();
    if (!raw) return sendJson(res, 400, { ok: false, error: "missing items" });

    const ids = raw.split(",").map(s => decodeURIComponent(s.trim())).filter(Boolean);

    // Qué quiere cada fuente
    const wantTD  = ids.filter((s) => /^[A-Z.]+$/.test(s) && !["BTC","ETH","OFICIAL","BLUE","MEP","^GSPC"].includes(s));
    const wantCG  = ids.filter((s) => s === "BTC" || s === "ETH");
    const wantCY  = ids.some((s) => s === "OFICIAL" || s === "BLUE" || s === "MEP");
    const wantSPX = ids.includes("^GSPC");

    const jobs = [];
    const errors = [];
    const sources = [];

    // Primero Twelve Data para stocks
    if (wantTD.length) { jobs.push(fetchTwelveData(wantTD)); sources.push({ name:"twelvedata", wants: wantTD }); }
    if (wantCG.length) { jobs.push(fetchCoinGecko(wantCG));  sources.push({ name:"coingecko", wants: wantCG }); }
    if (wantCY)        { jobs.push(fetchCriptoYa());         sources.push({ name:"criptoya", wants: ["OFICIAL","BLUE","MEP"] }); }
    if (wantSPX)       { jobs.push(fetchStooqSPX());         sources.push({ name:"stooq", wants: ["^GSPC"] }); }

    const globalTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error("global-deadline")), GLOBAL_DEADLINE_MS));

    let merged = {};
    try {
      const settled = await Promise.race([ Promise.allSettled(jobs), globalTimeout ]);
      if (Array.isArray(settled)) {
        for (const s of settled) {
          if (s.status === "fulfilled") {
            const { data, error } = s.value || {};
            if (error) errors.push(error);
            if (data && typeof data === "object") merged = Object.assign(merged, data);
          } else {
            errors.push(String(s.reason?.message || s.reason || "unknown"));
          }
        }
      } else {
        errors.push("deadline-race");
      }
    } catch (e) {
      errors.push(String(e?.message || e));
    }

    // Fallback Finnhub para símbolos que sigan sin precio
    const missingStockIds = wantTD.filter((sym) => !merged[sym]?.price);
    if (missingStockIds.length && FH_TOKEN) {
      const fh = await fetchFinnhub(missingStockIds);
      if (fh.error) errors.push(fh.error);
      merged = Object.assign(merged, fh.data);
      sources.push({ name: "finnhub-fallback", wants: missingStockIds });
    }

    const items = ids.map((id) => mapItem(id, merged[id] || {}));
    const hasAnyPrice = items.some((it) => it.price != null);

    if (!hasAnyPrice && lastGoodSnapshot) {
      const snap = { ...lastGoodSnapshot };
      snap.meta = { ...(snap.meta || {}), servedFrom: "snapshot", snapshotAt: lastGoodAt };
      if (debug) snap.meta.sources = sources;
      return sendJson(res, 200, snap);
    }

    const partial = items.some((it) => it.price == null);
    const payload = {
      ok: true,
      ts: Date.now(),
      items,
      meta: { partial, stale: false, tookMs: Date.now() - start, errors }
    };
    if (debug) payload.meta.sources = sources;

    if (hasAnyPrice) {
      lastGoodSnapshot = payload;
      lastGoodAt = Date.now();
    }

    return sendJson(res, 200, payload);
  } catch (e) {
    if (lastGoodSnapshot) {
      const snap = { ...lastGoodSnapshot };
      snap.meta = { ...(snap.meta || {}), servedFrom: "snapshot-on-error", error: String(e?.message || e) };
      return sendJson(res, 200, snap);
    }
    return sendJson(res, 200, { ok: true, ts: Date.now(), items: [], meta: { partial: true, stale: true, errors: [String(e?.message || e)] } });
  }
}
