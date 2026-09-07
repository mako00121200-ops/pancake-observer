const http = require("http");

const API_BASE = "https://api.limitless.exchange";
const POLL_INTERVAL_MS = 30000;

async function poll() {
  try {
    const res = await fetch(`${API_BASE}/markets/active`);
    const data = await res.json();

    let markets = [];
    if (Array.isArray(data)) markets = data;
    else if (Array.isArray(data.markets)) markets = data.markets;
    else if (Array.isArray(data.data)) markets = data.data;
    else {
      console.log("UNKNOWN_SHAPE keys=" + Object.keys(data).join(","));
      return;
    }

    const shortDuration = markets.filter(m => {
      const s = ((m.slug || "") + " " + (m.title || "")).toLowerCase();
      return (s.includes("btc") || s.includes("eth")) &&
             (s.includes("5-min") || s.includes("15-min") || s.includes("hourly"));
    });

    console.log(`POLL total=${markets.length} shortDuration=${shortDuration.length}`);

    // サンプルとして BTC 5分市場を1つだけ選び、板情報と市場詳細を確認する
    const sample = shortDuration.find(m => (m.slug || "").includes("btc-up-or-down-5-min"));
    if (sample) {
      console.log(`SAMPLE_MARKET slug=${sample.slug}`);
      console.log(`SAMPLE_MARKET_RAW ${JSON.stringify(sample).slice(0, 800)}`);

      const detailRes = await fetch(`${API_BASE}/markets/${sample.slug}`);
      const detail = await detailRes.json();
      console.log(`SAMPLE_DETAIL ${JSON.stringify(detail).slice(0, 800)}`);

      const obRes = await fetch(`${API_BASE}/markets/${sample.slug}/orderbook`);
      const ob = await obRes.json();
      console.log(`SAMPLE_ORDERBOOK ${JSON.stringify(ob).slice(0, 800)}`);
    } else {
      console.log("NO_BTC_5MIN_SAMPLE_FOUND");
    }
  } catch (e) {
    console.error("poll error:", e.message);
  }
}

setInterval(poll, POLL_INTERVAL_MS);
poll();

http.createServer((req, res) => { res.end("ok"); }).listen(process.env.PORT || 3000);
