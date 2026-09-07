const fs = require("fs");
const http = require("http");
const { ethers } = require("ethers");

const BSC_RPC = "https://bsc-dataseed.binance.org/";
const PREDICTION_CONTRACT = "0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA";
const PAIR_ADDRESS = "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const POLL_INTERVAL_MS = 5000;
const DATA_DIR = "/data";
const LOG_FILE = `${DATA_DIR}/log.jsonl`;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PREDICTION_ABI = [
  "function currentEpoch() view returns (uint256)",
  "function rounds(uint256) view returns (uint256 epoch, uint256 startTimestamp, uint256 lockTimestamp, uint256 closeTimestamp, int256 lockPrice, int256 closePrice, uint256 lockOracleId, uint256 closeOracleId, uint256 totalAmount, uint256 bullAmount, uint256 bearAmount, uint256 rewardBaseCalAmount, uint256 rewardAmount, bool oracleCalled)"
];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)"
];

const provider = new ethers.JsonRpcProvider(BSC_RPC);
const contract = new ethers.Contract(PREDICTION_CONTRACT, PREDICTION_ABI, provider);
const pairContract = new ethers.Contract(PAIR_ADDRESS, PAIR_ABI, provider);

let token0IsUsdt = null;
const preLockSnapshot = {};
const settled = {};
const stats = {
  resolved: 0,
  oracleLagCorrect: 0, oracleLagTotal: 0, oracleLagPnl: 0,
  poolMajorityCorrect: 0, poolMajorityTotal: 0, poolMajorityPnl: 0,
};

function evaluateRound(epochStr, lockPriceStr, closePriceStr, snap, finalBull, finalBear, finalTotal) {
  const lockPriceUsd = Number(lockPriceStr) / 1e8;
  const closePriceUsd = Number(closePriceStr) / 1e8;
  const actualUp = closePriceUsd > lockPriceUsd;
  stats.resolved++;
  if (!snap) return;

  const signalUp = snap.price > lockPriceUsd;
  stats.oracleLagTotal++;
  const signalWinPool = signalUp ? finalBull : finalBear;
  if (signalUp === actualUp) {
    stats.oracleLagCorrect++;
    stats.oracleLagPnl += signalWinPool > 0 ? (0.97 * finalTotal / signalWinPool) - 1 : -1;
  } else {
    stats.oracleLagPnl -= 1;
  }

  if (snap.bull !== snap.bear) {
    const majorityIsBull = snap.bull > snap.bear;
    stats.poolMajorityTotal++;
    const majorityWinPool = majorityIsBull ? finalBull : finalBear;
    if (majorityIsBull === actualUp) {
      stats.poolMajorityCorrect++;
      stats.poolMajorityPnl += majorityWinPool > 0 ? (0.97 * finalTotal / majorityWinPool) - 1 : -1;
    } else {
      stats.poolMajorityPnl -= 1;
    }
  }
}

function backfillStats() {
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  } catch (e) {
    console.log("BACKFILL_SKIP no existing log file");
    return;
  }
  const snapshot = {};
  const done = {};
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }
    const epochStr = rec.epoch;
    if (rec.lockPrice === "0" && rec.realtimePrice) {
      snapshot[epochStr] = { price: rec.realtimePrice, bull: parseFloat(rec.bull), bear: parseFloat(rec.bear) };
    }
    if (rec.oracleCalled && rec.lockPrice !== "0" && rec.closePrice !== "0" && !done[epochStr]) {
      done[epochStr] = true;
      evaluateRound(epochStr, rec.lockPrice, rec.closePrice, snapshot[epochStr], parseFloat(rec.bull), parseFloat(rec.bear), parseFloat(rec.total));
    }
  }
  console.log(`BACKFILL_DONE lines=${lines.length} resolved=${stats.resolved} oracleLagPnl=${stats.oracleLagPnl.toFixed(3)} poolMajorityPnl=${stats.poolMajorityPnl.toFixed(3)}`);
}

function deepAnalysis() {
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  } catch (e) { return; }

  const snapshot = {};
  const done = {};
  const resolvedList = [];

  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }
    const epochStr = rec.epoch;
    if (rec.lockPrice === "0" && rec.realtimePrice) {
      snapshot[epochStr] = { price: rec.realtimePrice, bull: parseFloat(rec.bull), bear: parseFloat(rec.bear) };
    }
    if (rec.oracleCalled && rec.lockPrice !== "0" && rec.closePrice !== "0" && !done[epochStr]) {
      done[epochStr] = true;
      const lockPriceUsd = Number(rec.lockPrice) / 1e8;
      const closePriceUsd = Number(rec.closePrice) / 1e8;
      resolvedList.push({
        epoch: epochStr,
        actualUp: closePriceUsd > lockPriceUsd,
        snap: snapshot[epochStr],
        finalBull: parseFloat(rec.bull),
        finalBear: parseFloat(rec.bear),
        finalTotal: parseFloat(rec.total),
      });
    }
  }

  const buckets = [
    { label: "0-5pct", min: 0, max: 0.05 },
    { label: "5-10pct", min: 0.05, max: 0.10 },
    { label: "10-20pct", min: 0.10, max: 0.20 },
    { label: "20-35pct", min: 0.20, max: 0.35 },
    { label: "35pct+", min: 0.35, max: 1.01 },
  ].map(b => ({ ...b, majorityWin: 0, majorityTotal: 0, majorityPnl: 0, contrarianPnl: 0 }));

  for (const r of resolvedList) {
    if (!r.snap || r.snap.bull === r.snap.bear) continue;
    const totalSnap = r.snap.bull + r.snap.bear;
    const balance = Math.abs(r.snap.bull / totalSnap - 0.5);
    const bucket = buckets.find(b => balance >= b.min && balance < b.max);
    if (!bucket) continue;

    const majorityIsBull = r.snap.bull > r.snap.bear;
    const majorityWinPool = majorityIsBull ? r.finalBull : r.finalBear;
    bucket.majorityTotal++;
    if (majorityIsBull === r.actualUp) {
      bucket.majorityWin++;
      bucket.majorityPnl += majorityWinPool > 0 ? (0.97 * r.finalTotal / majorityWinPool) - 1 : -1;
    } else {
      bucket.majorityPnl -= 1;
    }
    const minorityWinPool = majorityIsBull ? r.finalBear : r.finalBull;
    if (majorityIsBull !== r.actualUp) {
      bucket.contrarianPnl += minorityWinPool > 0 ? (0.97 * r.finalTotal / minorityWinPool) - 1 : -1;
    } else {
      bucket.contrarianPnl -= 1;
    }
  }

  console.log("DEEPANALYSIS_BALANCE_START");
  for (const b of buckets) {
    const majWr = b.majorityTotal > 0 ? (b.majorityWin / b.majorityTotal * 100).toFixed(1) : "N/A";
    const majRoi = b.majorityTotal > 0 ? (b.majorityPnl / b.majorityTotal * 100).toFixed(2) : "N/A";
    const conRoi = b.majorityTotal > 0 ? (b.contrarianPnl / b.majorityTotal * 100).toFixed(2) : "N/A";
    console.log(`BALANCE bucket=${b.label} n=${b.majorityTotal} majority_wr=${majWr}% majority_roi=${majRoi}% contrarian_roi=${conRoi}%`);
  }
  console.log("DEEPANALYSIS_BALANCE_END");

  const streakStats = {};
  let currentStreakDir = null;
  let currentStreakLen = 0;

  for (const r of resolvedList) {
    const streakLenBefore = currentStreakLen;
    const streakDirBefore = currentStreakDir;

    if (streakLenBefore >= 2 && r.snap) {
      const key = Math.min(streakLenBefore, 5);
      if (!streakStats[key]) streakStats[key] = { reversal: 0, total: 0, reversalPnl: 0 };
      const reversed = r.actualUp !== streakDirBefore;
      const betWinPool = (!streakDirBefore) ? r.finalBull : r.finalBear;
      streakStats[key].total++;
      if (reversed) {
        streakStats[key].reversal++;
        streakStats[key].reversalPnl += betWinPool > 0 ? (0.97 * r.finalTotal / betWinPool) - 1 : -1;
      } else {
        streakStats[key].reversalPnl -= 1;
      }
    }

    if (r.actualUp === currentStreakDir) {
      currentStreakLen++;
    } else {
      currentStreakDir = r.actualUp;
      currentStreakLen = 1;
    }
  }

  console.log("DEEPANALYSIS_STREAK_START");
  for (const key of Object.keys(streakStats).sort()) {
    const s = streakStats[key];
    const reversalRate = (s.reversal / s.total * 100).toFixed(1);
    const roi = (s.reversalPnl / s.total * 100).toFixed(2);
    console.log(`STREAK len=${key}${key == 5 ? "plus" : ""} n=${s.total} reversal_rate=${reversalRate}% reversal_bet_roi=${roi}%`);
  }
  console.log("DEEPANALYSIS_STREAK_END");
}

async function getRealtimePrice() {
  try {
    if (token0IsUsdt === null) {
      const t0 = await pairContract.token0();
      token0IsUsdt = t0.toLowerCase() === USDT_ADDRESS.toLowerCase();
    }
    const [r0, r1] = await pairContract.getReserves();
    const usdtReserve = token0IsUsdt ? r0 : r1;
    const wbnbReserve = token0IsUsdt ? r1 : r0;
    const usdtNum = parseFloat(ethers.formatUnits(usdtReserve, 18));
    const wbnbNum = parseFloat(ethers.formatUnits(wbnbReserve, 18));
    return usdtNum / wbnbNum;
  } catch (e) {
    console.error("price fetch error:", e.message);
    return null;
  }
}

function writeLog(record) {
  const line = JSON.stringify(record) + "\n";
  console.log(`CHECK epoch=${record.epoch} price=${record.realtimePrice} bull=${record.bull} bear=${record.bear} lockPrice=${record.lockPrice}`);
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error("file write error:", err.message);
  });
}

async function logRound(epoch, realtimePrice, now) {
  try {
    const r = await contract.rounds(epoch);
    const epochStr = epoch.toString();
    const lockPriceStr = r.lockPrice.toString();
    const closePriceStr = r.closePrice.toString();

    if (lockPriceStr === "0" && realtimePrice !== null) {
      preLockSnapshot[epochStr] = {
        price: realtimePrice,
        bull: parseFloat(ethers.formatEther(r.bullAmount)),
        bear: parseFloat(ethers.formatEther(r.bearAmount)),
      };
    }

    if (r.oracleCalled && lockPriceStr !== "0" && closePriceStr !== "0" && !settled[epochStr]) {
      settled[epochStr] = true;
      const snap = preLockSnapshot[epochStr];
      evaluateRound(
        epochStr, lockPriceStr, closePriceStr, snap,
        parseFloat(ethers.formatEther(r.bullAmount)),
        parseFloat(ethers.formatEther(r.bearAmount)),
        parseFloat(ethers.formatEther(r.totalAmount))
      );
      delete preLockSnapshot[epochStr];
      console.log(`RESULT epoch=${epochStr} lock=${(Number(lockPriceStr)/1e8).toFixed(2)} close=${(Number(closePriceStr)/1e8).toFixed(2)}`);
    }

    writeLog({
      t: now, epoch: epochStr,
      lockTs: r.lockTimestamp.toString(), closeTs: r.closeTimestamp.toString(),
      lockPrice: lockPriceStr, closePrice: closePriceStr,
      bull: ethers.formatEther(r.bullAmount), bear: ethers.formatEther(r.bearAmount),
      total: ethers.formatEther(r.totalAmount), oracleCalled: r.oracleCalled, realtimePrice
    });
  } catch (e) {
    console.error("round fetch error", epoch.toString(), e.message);
  }
}

async function poll() {
  try {
    const epoch = await contract.currentEpoch();
    const realtimePrice = await getRealtimePrice();
    const now = Math.floor(Date.now() / 1000);
    await logRound(epoch, realtimePrice, now);
    await logRound(epoch - 1n, realtimePrice, now);
    await logRound(epoch - 2n, realtimePrice, now);
  } catch (err) {
    console.error("poll error:", err.message);
  }
}

backfillStats();
deepAnalysis();
setInterval(poll, POLL_INTERVAL_MS);
poll();

setInterval(() => {
  const oracleLagWinRate = stats.oracleLagTotal > 0 ? (stats.oracleLagCorrect / stats.oracleLagTotal * 100).toFixed(1) : "N/A";
  const poolMajorityWinRate = stats.poolMajorityTotal > 0 ? (stats.poolMajorityCorrect / stats.poolMajorityTotal * 100).toFixed(1) : "N/A";
  const oracleLagRoi = stats.oracleLagTotal > 0 ? (stats.oracleLagPnl / stats.oracleLagTotal * 100).toFixed(2) : "N/A";
  const poolMajorityRoi = stats.poolMajorityTotal > 0 ? (stats.poolMajorityPnl / stats.poolMajorityTotal * 100).toFixed(2) : "N/A";
  console.log(`SUMMARY resolved=${stats.resolved} oracleLag_winrate=${oracleLagWinRate}% oracleLag_roi=${oracleLagRoi}% poolMajority_winrate=${poolMajorityWinRate}% poolMajority_roi=${poolMajorityRoi}%`);
}, 60000);

function renderDashboard() {
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  } catch (e) {
    return `<p>まだデータがありません</p>`;
  }
  const byEpoch = {};
  for (const line of lines) {
    try { const rec = JSON.parse(line); byEpoch[rec.epoch] = rec; } catch (e) {}
  }
  const epochs = Object.keys(byEpoch).map(Number).sort((a, b) => b - a).slice(0, 50);
  const rows = epochs.map(ep => {
    const r = byEpoch[ep];
    const lockPrice = r.lockPrice && r.lockPrice !== "0" ? (Number(r.lockPrice) / 1e8).toFixed(2) : "-";
    const closePrice = r.closePrice && r.closePrice !== "0" ? (Number(r.closePrice) / 1e8).toFixed(2) : "-";
    const result = r.oracleCalled ? (Number(r.closePrice) > Number(r.lockPrice) ? "UP" : "DOWN") : "-";
    return `<tr><td>${r.epoch}</td><td>${lockPrice}</td><td>${closePrice}</td><td>${result}</td><td>${Number(r.bull).toFixed(3)}</td><td>${Number(r.bear).toFixed(3)}</td><td>${r.realtimePrice ? r.realtimePrice.toFixed(2) : "-"}</td><td>${r.oracleCalled ? "確定済" : "進行中"}</td></tr>`;
  }).join("");
  return `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body{font-family:-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;padding:10px;}table{border-collapse:collapse;width:100%;font-size:12px;}th,td{border:1px solid #30363d;padding:4px 6px;text-align:right;}th{background:#161b22;}h1{font-size:18px;}</style></head><body>
  <h1>PancakeSwap Prediction 観測データ</h1>
  <p>確定ラウンド数: ${stats.resolved}</p>
  <table><tr><th>Epoch</th><th>Lock</th><th>Close</th><th>結果</th><th>Bull</th><th>Bear</th><th>実勢価格</th><th>状態</th></tr>${rows}</table>
  </body></html>`;
}

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderDashboard());
}).listen(process.env.PORT || 3000);
