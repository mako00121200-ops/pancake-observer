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
      console.log("RAW_SAMPLE " + JSON.stringify(data).slice(0, 500));
      return;
    }

    console.log(`POLL total=${markets.length}`);

    const shortDuration = markets.filter(m => {
      const s = ((m.slug || "") + " " + (m.title || "")).toLowerCase();
      return (s.includes("btc") || s.includes("eth")) &&
             (s.includes("5min") || s.includes("5-min") || s.includes("hourly") || s.includes("up-or-down") || s.includes("updown"));
    });

    for (const m of shortDuration) {
      console.log(`FOUND slug=${m.slug} title="${m.title}" deadline=${m.deadline || m.endDate || m.expirationDate || "?"}`);
    }

    if (shortDuration.length === 0 && markets.length > 0) {
      console.log("SAMPLE_TITLES " + markets.slice(0, 5).map(m => m.slug || m.title).join(" | "));
    }
  } catch (e) {
    console.error("poll error:", e.message);
  }
}

setInterval(poll, POLL_INTERVAL_MS);
poll();

http.createServer((req, res) => { res.end("ok"); }).listen(process.env.PORT || 3000);
