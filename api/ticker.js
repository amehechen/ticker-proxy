// Aggregador robusto con deadline, snapshot en memoria, fallbacks y mirrors.
// Fuentes:
// - Stocks: Twelve Data (primario) + Finnhub (fallback por símbolo)
// - Índice S&P 500: Stooq con mirrors/símbolos alternativos + fallback a último valor bueno
// - Cripto: CoinGecko (primario) + CoinCap (fallback), %24h
// - FX ARS: CriptoYa (oficial/blue/mep)

const TD_TOKEN = process.env.TWELVE_DATA_TOKEN;
const FH_TOKEN = process.env.FINNHUB_TOKEN;

// ---------- Resiliencia / caché CDN
const PER_SOURCE_TIMEOUT_MS = 3000;
const GLOBAL_DEADLINE_MS = 3500;
const CDN_SMAXAGE_SEC = 5;
const CDN_STALE_SEC = 20;

let lastGoodSnapshot = null;      // snapshot whole payload
let lastGoodAt = 0;
let lastGoodById = {};            // { id: { price, prevClose, source, ts } } item-level memory

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type");
  res.setHeader(
    "cache-control",
    `public, s-maxage=${CDN_SMAXAGE_SEC}, stale-while-revalidate=${CDN_STALE_SEC}, max-age=0`
  );
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

// Finnhub (fallback por símbolo)
async function fetchFinnhub(symbols) {
  if (!FH_TOKEN || !symbols.length) return { data: {}, error: "finnhub-no-token-or-empty" };
  const out = {};
  const errs = [];
  await Promise.all(symbols.map(async (sym) => {
    const url = `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FH_TOKEN}`;
    try {
      const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
      if (!res.ok) { errs.push(`fh-http-${sym}-${res.status}`); return; }
      const j = await res.json();
      const price = num(j.c);
      const prev = num(j.pc);
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

// Stooq robusto para ^GSPC: probar mirrors + símbolos alternativos
async function fetchStooqSPXRobust() {
  const hosts = ["https://stooq.com", "https://stooq.pl"];
  const syms = ["%5Espx", "%5Egspc", "spx"]; // ^spx, ^gspc o spx
  const headers = { accept: "text/plain" };

  for (const h of hosts) {
    for (const s of syms) {
      const url = `${h}/q/l/?s=${s}&i=d`;
      try {
        const res = await fetchWithTimeout(url, { headers });
        if (!res.ok) continue;
        const txt = await res.text();
        const line = (txt.trim().split("\n")[0] || "");
        const parts = line.split(",");
        // Stooq CSV: [symbol, date, time, open, high, low, close, volume, ...]
        const close = num(parts[6]);
        if (Number.isFinite(close)) {
          return { data: { "^GSPC": { price: close, prevClose: null, source: "stooq" } }, error: null };
        }
      } catch (_) { /* try next */ }
    }
  }
  return { data: {}, error: "stooq-all-attempts-failed" };
}

// CoinGecko (primario) → CoinCap (fallback) para BTC/ETH
async function fetchCryptoWithFallback(ids) {
  const out = {};
  const errs = [];

  // 1) CoinGecko
  const cgNeed = [];
  if (ids.includes("BTC")) cgNeed.push("bitcoin");
  if (ids.includes("ETH")) cgNeed.push("ethereum");

  let triedCG = false;
  if (cgNeed.length) {
    const cgUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${cgNeed.join(",")}&vs_currencies=usd&include_24hr_change=true`;
    triedCG = true;
    try {
      const res = await fetchWithTimeout(cgUrl, { headers: { accept: "application/json" } });
      if (res.ok) {
        const j = await res.json();
        if (j.bitcoin)  out["BTC"] = { price: num(j.bitcoin.usd),  changePct24h: num(j.bitcoin.usd_24h_change),  source: "coingecko" };
        if (j.ethereum) out["ETH"] = { price: num(j.ethereum.usd), changePct24h: num(j.ethereum.usd_24h_change), source: "coingecko" };
      } else {
        errs.push(`cg-http-${res.status}`);
      }
    } catch (e) {
      errs.push(`cg-ex-${(e && e.name) || "err"}`);
    }
  }

  // 2) Si faltó algo o CG dio 429/err → CoinCap
  const needFallback = ids.filter((id) => !out[id]);
  if (needFallback.length) {
    try {
      const ccUrl = `https://api.coincap.io/v2/assets?ids=${needFallback.map(x => x === "BTC" ? "bitcoin" : x === "ETH" ? "ethereum" : "").filter(Boolean).join(",")}`;
      const res = await fetchWithTimeout(ccUrl, { headers: { accept: "application/json" } });
      if (res.ok) {
        const j = await res.json();
        const arr = Array.isArray(j?.data) ? j.data : [];
        for (const a of arr) {
          if (a.id === "bitcoin") {
            const price = num(a.priceUsd);
            const pct = num(a.changePercent24Hr);
            if (price != null) out["BTC"] = { price, changePct24h: pct, source: "coincap" };
          }
          if (a.id === "ethereum") {
            const price = num(a.priceUsd);
            const pct = num(a.changePercent24Hr);
            if (price != null) out["ETH"] = { price, changePct24h: pct, source: "coincap" };
          }
        }
        if (!arr.length) errs.push("coincap-empty");
      } else {
        errs.push(`coincap-http-${res.status}`);
      }
    } catch (e) {
      errs.push(`coincap-ex-${(e && e.name) || "err"}`);
    }
  }

  return { data: out, error: errs.length ? errs.join(",") : null };
}

// CriptoYa (dólar ARS)
async function fetchCriptoYa() {
  const url = "https://criptoya.com/api/dolar";
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { data: {}, error: `cy-http-${res.status}` };
    const d = await res.json();
    const pick = (n) => num(n?.price ?? n?.ask ?? n?.bid);
    const out = {};
    if (d.oficial) out["OFICIAL"] = { price: pick(d.oficial), changePct: num(d.oficial.variation), source: "criptoya" };
    if (d.blue)   out["BLUE"]   = { price: pick(d.blue),      changePct: num(d.blue.variation),   source: "criptoya" };
    const mep = d?.mep?.gd30?.ci;
    if (mep)      out["MEP"]    = { price: num(mep.price),    changePct: num(mep.variation),      source: "criptoya" };
    return { data: out, error: null };
  } catch (e) {
    return { data: {}, error: `cy-ex-${(e && e.name) || "err"}` };
  }
}

// ---------- Ensamblado / mapping

function mapItem(id, raw) {
  const meta = {
    BTC:    { label: "Bitcoin",       kind: "crypto", currency: "USD" },
    ETH:    { label: "Ethereum",      kind: "crypto", currency: "USD" },
    OFICIAL:{ label: "Dólar Oficial", kind: "fx_ars", currency: "ARS" },
    BLUE:   { label: "Dólar Blue",    kind: "fx_ars", currency: "ARS" },
    MEP:    { label: "Dólar MEP",     kind: "fx_ars", currency: "ARS" },
    "^GSPC":{ label: "S&P 500",       kind: "index",  currency: "USD" },
    NVDA:   { label: "Nvidia",        kind: "stock",  currency: "USD" },
    PLTR:   { label: "Palantir",      kind: "stock",  currency: "USD" },
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
    const wantStocks = ids.filter((s) => /^[A-Z.]+$/.test(s) && !["BTC","ETH","OFICIAL","BLUE","MEP","^GSPC"].includes(s));
    const wantCrypto = ids.filter((s) => s === "BTC" || s === "ETH");
    const wantFX    = ids.some((s) => s === "OFICIAL" || s === "BLUE" || s === "MEP");
    const wantSPX   = ids.includes("^GSPC");

    const jobs = [];
    const errors = [];
    const sources = [];

    // Stocks: TwelveData primero
    if (wantStocks.length) { jobs.push(fetchTwelveData(wantStocks)); sources.push({ name:"twelvedata", wants: wantStocks }); }
    // Crypto
    if (wantCrypto.length) { jobs.push(fetchCryptoWithFallback(wantCrypto)); sources.push({ name:"coingecko/coinCap", wants: wantCrypto }); }
    // FX
    if (wantFX) { jobs.push(fetchCriptoYa()); sources.push({ name:"criptoya", wants: ["OFICIAL","BLUE","MEP"] }); }
    // S&P 500
    if (wantSPX) { jobs.push(fetchStooqSPXRobust()); sources.push({ name:"stooq-robust", wants: ["^GSPC"] }); }

    const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error("global-deadline")), GLOBAL_DEADLINE_MS));

    let merged = {};
    try {
      const settled = await Promise.race([ Promise.allSettled(jobs), deadline ]);
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

    // Fallback Finnhub para stocks que sigan sin precio
    const missingStockIds = wantStocks.filter((sym) => !merged[sym]?.price);
    if (missingStockIds.length && FH_TOKEN) {
      const fh = await fetchFinnhub(missingStockIds);
      if (fh.error) errors.push(fh.error);
      merged = Object.assign(merged, fh.data);
      sources.push({ name: "finnhub-fallback", wants: missingStockIds });
    }

    // Si ^GSPC sigue sin precio, usar último bueno para ese ID
    if (wantSPX && !merged["^GSPC"]?.price && lastGoodById["^GSPC"]?.price != null) {
      merged["^GSPC"] = { ...lastGoodById["^GSPC"], source: merged["^GSPC"]?.source || "snapshot-id" };
      errors.push("spx-used-last-good");
    }

    const items = ids.map((id) => mapItem(id, merged[id] || {}));
    const hasAnyPrice = items.some((it) => it.price != null);

    // Guardar item-level memory
    for (const it of items) {
      if (it.price != null) {
        lastGoodById[it.id] = { price: it.price, prevClose: it.prevClose ?? null, source: it.source, ts: Date.now() };
      }
    }

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
    return sendJson(res, 200, {
      ok: true,
      ts: Date.now(),
      items: [],
      meta: { partial: true, stale: true, errors: [String(e?.message || e)] }
    });
  }
}
