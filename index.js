const fs = require("fs");
const http = require("http");

const API_BASE = "https://api.limitless.exchange";
const POLL_INTERVAL_MS = 15000;
const DATA_DIR = "/data";
const LOG_FILE = `${DATA_DIR}/limitless-log.jsonl`;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const tracked = new Map();

function writeLog(record) {
  const line = JSON.stringify(record) + "\n";
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error("file write error:", err.message);
  });
}

function isTargetMarket(m) {
  const s = ((m.slug || "") + " " + (m.title || "")).toLowerCase();
  return (s.includes("btc") || s.includes("eth")) &&
         (s.includes("5-min") || s.includes("15-min"));
}

async function fetchOrderbook(slug) {
  try {
    const res = await fetch(`${API_BASE}/markets/${slug}/orderbook`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fetchDetail(slug) {
  try {
    const res = await fetch(`${API_BASE}/markets/${slug}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function bestBidAsk(ob) {
  if (!ob || !Array.isArray(ob.bids) || !Array.isArray(ob.asks)) return { bid: null, ask: null };
  const bid = ob.bids.length ? Math.max(...ob.bids.map(b => b.price)) : null;
  const ask = ob.asks.length ? Math.min(...ob.asks.map(a => a.price)) : null;
  return { bid, ask };
}

async function poll() {
  const now = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(`${API_BASE}/markets/active`);
    const data = await res.json();
    let markets = [];
    if (Array.isArray(data)) markets = data;
    else if (Array.isArray(data.markets)) markets = data.markets;
    else if (Array.isArray(data.data)) markets = data.data;

    const activeSlugs = new Set();
    const targets = markets.filter(isTargetMarket);

    for (const m of targets) {
      activeSlugs.add(m.slug);
      if (!tracked.has(m.slug)) {
        tracked.set(m.slug, { firstSeen: now, title: m.title });
        console.log(`NEW_MARKET slug=${m.slug} title="${m.title}"`);
      }

      const ob = await fetchOrderbook(m.slug);
      const { bid, ask } = bestBidAsk(ob);
      writeLog({
        type: "snapshot", t: now, slug: m.slug,
        bid, ask, spread: (bid !== null && ask !== null) ? (ask - bid) : null,
      });
    }

    for (const slug of Array.from(tracked.keys())) {
      if (!activeSlugs.has(slug)) {
        const detail = await fetchDetail(slug);
        console.log(`RESOLVED_CHECK slug=${slug} detail=${JSON.stringify(detail).slice(0, 500)}`);
        writeLog({ type: "resolved_raw", t: now, slug, detail });
        tracked.delete(slug);
      }
    }

    console.log(`POLL total=${markets.length} tracked=${tracked.size}`);
  } catch (e) {
    console.error("poll error:", e.message);
  }
}

setInterval(poll, POLL_INTERVAL_MS);
poll();

http.createServer((req, res) => {
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean).slice(-100);
  } catch (e) {}
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`tracked=${tracked.size}\n\n` + lines.join("\n"));
}).listen(process.env.PORT || 3000);
