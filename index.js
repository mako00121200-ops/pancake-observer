const fs = require("fs");
const { ethers } = require("ethers");

const BSC_RPC = "https://bsc-dataseed.binance.org/";
const PREDICTION_CONTRACT = "0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA";
const POLL_INTERVAL_MS = 5000;
const DATA_DIR = "/data";
const LOG_FILE = `${DATA_DIR}/log.jsonl`;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PREDICTION_ABI = [
  "function currentEpoch() view returns (uint256)",
  "function rounds(uint256) view returns (uint256 epoch, uint256 startTimestamp, uint256 lockTimestamp, uint256 closeTimestamp, int256 lockPrice, int256 closePrice, uint256 lockOracleId, uint256 closeOracleId, uint256 totalAmount, uint256 bullAmount, uint256 bearAmount, uint256 rewardBaseCalAmount, uint256 rewardAmount, bool oracleCalled)"
];

const provider = new ethers.JsonRpcProvider(BSC_RPC);
const contract = new ethers.Contract(PREDICTION_CONTRACT, PREDICTION_ABI, provider);

async function getBinancePrice() {
  const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT");
  const data = await res.json();
  return parseFloat(data.price);
}

function writeLog(record) {
  const line = JSON.stringify(record) + "\n";
  console.log(line.trim());
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error("file write error:", err.message);
  });
}

async function logRound(epoch, binancePrice, now) {
  try {
    const r = await contract.rounds(epoch);
    writeLog({
      t: now,
      epoch: epoch.toString(),
      lockTs: r.lockTimestamp.toString(),
      closeTs: r.closeTimestamp.toString(),
      lockPrice: r.lockPrice.toString(),
      closePrice: r.closePrice.toString(),
      bull: ethers.formatEther(r.bullAmount),
      bear: ethers.formatEther(r.bearAmount),
      total: ethers.formatEther(r.totalAmount),
      oracleCalled: r.oracleCalled,
      binancePrice
    });
  } catch (e) {
    console.error("round fetch error", epoch.toString(), e.message);
  }
}

async function poll() {
  try {
    const epoch = await contract.currentEpoch();
    const binancePrice = await getBinancePrice();
    const now = Math.floor(Date.now() / 1000);

    await logRound(epoch, binancePrice, now);
    await logRound(epoch - 1n, binancePrice, now);
    await logRound(epoch - 2n, binancePrice, now);
  } catch (err) {
    console.error("poll error:", err.message);
  }
}

setInterval(poll, POLL_INTERVAL_MS);
poll();
