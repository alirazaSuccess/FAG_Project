// controllers/binance_controller.js
const axios = require("axios");
const crypto = require("crypto");

const BINANCE_API_BASE = process.env.BINANCE_API_BASE || "https://api.binance.com";
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

function signQuery(paramsObj) {
  const qs = new URLSearchParams(paramsObj).toString();
  const sig = crypto.createHmac("sha256", BINANCE_API_SECRET).update(qs).digest("hex");
  return `${qs}&signature=${sig}`;
}

async function binanceCall(method, path, params = {}, isSapi = false) {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    throw new Error("Binance API is not configured");
  }
  const timestamp = Date.now();
  const recvWindow = 5000;
  const signed = signQuery({ ...params, timestamp, recvWindow });

  const url = `${BINANCE_API_BASE}${path}?${signed}`;
  const headers = { "X-MBX-APIKEY": BINANCE_API_KEY };

  return axios({ method, url, headers });
}

/**
 * Try to read USDT balance from:
 *  1) Spot:   GET /api/v3/account   -> balances[{asset, free, locked}]
 *  2) Funding:POST /sapi/v1/asset/get-funding-asset  -> [{asset, free}]
 */
exports.getUsdtBalancePublic = async (req, res) => {
  try {
    let spotFree = 0, spotLocked = 0, fundingFree = 0;

    // --- 1) SPOT ---
    try {
      const { data } = await binanceCall("GET", "/api/v3/account");
      const usdt = (data?.balances || []).find((b) => b.asset === "USDT");
      if (usdt) {
        spotFree = Number(usdt.free || 0);
        spotLocked = Number(usdt.locked || 0);
      }
    } catch (e) {
      // ignore & try funding
    }

    // --- 2) FUNDING (Binance expects POST on SAPI for funding asset) ---
    try {
      // Funding endpoint is SAPI; some bins require POST form – we keep query sign same way
      const { data } = await binanceCall("POST", "/sapi/v1/asset/get-funding-asset", { asset: "USDT" });
      // data may be an array of assets
      const item = Array.isArray(data) ? data.find((x) => x.asset === "USDT") : null;
      if (item) {
        fundingFree = Number(item.free || 0);
      }
    } catch (e) {
      // ignore if funding not enabled
    }

    const total = Number((spotFree + fundingFree).toFixed(6));

    return res.json({
      asset: "USDT",
      spot: { free: spotFree, locked: spotLocked },
      funding: { free: fundingFree },
      total,
    });
  } catch (err) {
    console.error("getUsdtBalancePublic error:", err?.response?.data || err.message);
    return res.status(500).json({ message: "Failed to query Binance balance" });
  }
};
