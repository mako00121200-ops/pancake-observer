const fs = require("fs");
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
  console.log(line.trim());
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error("file write error:", err.message);
  });
}

async function logRound(epoch, realtimePrice, now) {
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
      realtimePrice
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

setInterval(poll, POLL_INTERVAL_MS);
poll();
