// backend/Controller/admin_controller.js
const crypto = require("crypto");
const axios = require("axios");
const Withdrawal = require("../models/withdrawal");
const User = require("../models/user"); // ✅ fix: correct model name

// ==============================
// Helpers
// ==============================
async function getWithdrawableAmount(userId) {
  // ✅ fix: use User model
  const u = await User.findById(userId).lean();
  if (!u) return 0;

  const earnings = Number(u.dailyProfit || 0) + Number(u.bonusEarned || 0);

  // pending or approved withdrawals on hold
  const pendingAgg = await Withdrawal.aggregate([
    { $match: { user: u._id, status: { $in: ["pending", "approved"] } } },
    { $group: { _id: null, sum: { $sum: "$amount" } } },
  ]);

  const onHold = pendingAgg[0]?.sum || 0;
  return Math.max(earnings - onHold, 0);
}

function assertAdmin(req, res) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }
  return true;
}

// ==============================
// User: create withdrawal request
// ==============================
exports.requestWithdrawal = async (req, res) => {
  try {
    const { address, amount } = req.body;
    const min = Number(process.env.WITHDRAW_MIN || 10);
    const currency = process.env.WITHDRAW_CURRENCY || "USDT";
    const chain = process.env.WITHDRAW_CHAIN || "BEP20";

    const amt = Number(amount);
    if (!address || !amt || amt < min) {
      return res
        .status(400)
        .json({ message: `Minimum withdrawal is ${min} ${currency}` });
    }

    // simple TRON address check
  // EVM address check (BEP-20): 0x + 40 hex
  if (!/^0x[a-fA-F0-9]{40}$/.test(address.trim())) {
   return res
      .status(400)
      .json({ message: "Enter a valid BEP20 (BSC) address starting with 0x" });
  }

    const available = await getWithdrawableAmount(req.user._id);
    if (amt > available) {
      return res.status(400).json({ message: "Insufficient withdrawable balance" });
    }

    const wd = await Withdrawal.create({
      user: req.user._id,
      address: address.trim(),
      amount: amt,
      netAmount: amt, // adjust if you charge fees
      currency,
      chain,
    });

    return res.json({ success: true, withdrawal: wd });
  } catch (err) {
    console.error("requestWithdrawal error:", err);
    return res.status(500).json({ message: "Unable to create withdrawal request" });
  }
};

// ==============================
// User: my withdrawals
// ==============================
exports.myWithdrawals = async (req, res) => {
  try {
    const list = await Withdrawal.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ withdrawals: list });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ==============================
// Admin: list withdrawals
// ==============================
exports.adminListWithdrawals = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { status } = req.query; // ?status=pending
    const q = status ? { status } : {};
    const list = await Withdrawal.find(q)
      .populate("user", "username email")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ withdrawals: list });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ==============================
// BINANCE (SAPI) WITHDRAW
// ==============================
// Docs: POST /sapi/v1/capital/withdraw/apply
// Notes:
// - API key must have "Enable Withdrawals" + IP whitelist on binance.com
// - network for TRON is "TRX" (not "TRC20")

const BINANCE_BASE = process.env.BINANCE_BASE || "https://api.binance.com";
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
// OPTIONAL: TRON network name at Binance
const BINANCE_NETWORK = process.env.BINANCE_NETWORK || "BSC";

function signQuery(paramsObj) {
  const usp = new URLSearchParams(paramsObj);
  const qs = usp.toString();
  const signature = crypto
    .createHmac("sha256", BINANCE_API_SECRET)
    .update(qs)
    .digest("hex");
  return `${qs}&signature=${signature}`;
}

async function binanceWithdraw({ coin, address, amount, network, remark }) {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    throw new Error("Binance API not configured");
  }

  const endpoint = "/sapi/v1/capital/withdraw/apply";
  const ts = Date.now();

  const params = {
    coin,                               // e.g. "USDT"
    address,                            // user's TRON address
    amount: String(amount),             // decimal string
    network: network || BINANCE_NETWORK, // e.g. "TRX"
    timestamp: ts,
    recvWindow: 5000,
    // addressTag: "", // not used for TRON
    // name: "optionalLabel"
  };

  if (remark) params.remark = remark;

  const signed = signQuery(params);
  const url = `${BINANCE_BASE}${endpoint}?${signed}`;

  const headers = { "X-MBX-APIKEY": BINANCE_API_KEY };

  const { data } = await axios.post(url, null, { headers });
  // Success returns: { id: string }
  if (!data || !data.id) {
    throw new Error("Binance withdraw response missing id");
  }
  return data.id; // Use as payout/withdrawal id
}

// ==============================
// Admin: approve -> trigger Binance payout
// ==============================
exports.adminApproveWithdrawal = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const wd = await Withdrawal.findById(req.params.id).populate("user");
    if (!wd) return res.status(404).json({ message: "Request not found" });
    if (wd.status !== "pending") {
      return res.status(400).json({ message: `Request is ${wd.status}, not pending` });
    }

    // Re-check available (protect against race)
    const available = await getWithdrawableAmount(wd.user._id);
    if (wd.amount > available) {
      return res.status(400).json({ message: "User no longer has withdrawable balance" });
    }

    // Execute payout via Binance
    const binanceWithdrawId = await binanceWithdraw({
      coin: wd.currency || "USDT",
      address: wd.address,
      amount: wd.amount,
      network: (wd.chain || "").toUpperCase().includes("BEP") ? "BSC" : BINANCE_NETWORK,
      remark: `WD ${wd.user?.email || ""} ${wd._id}`,
    });

    // Mark paid & deduct earnings (bonusEarned first, then dailyProfit)
    wd.status = "paid";
    wd.txId = binanceWithdrawId; // Binance withdraw id (tx hash arrives later)
    wd.approvedBy = req.user._id;
    wd.approvedAt = new Date();
    await wd.save();

    const u = await User.findById(wd.user._id);
    let remaining = wd.amount;

    const fromBonus = Math.min(Number(u.bonusEarned || 0), remaining);
    u.bonusEarned = Number(u.bonusEarned || 0) - fromBonus;
    remaining -= fromBonus;

    if (remaining > 0) {
      u.dailyProfit = Math.max(Number(u.dailyProfit || 0) - remaining, 0);
      remaining = 0;
    }

    u.withdrawnTotal = Number(u.withdrawnTotal || 0) + wd.amount; // ok if not in schema
    await u.save();

    res.json({
      success: true,
      message: "Withdrawal executed via Binance",
      withdrawal: wd,
    });
  } catch (err) {
    console.error("adminApproveWithdrawal error:", err?.response?.data || err?.message || err);
    const wd = await Withdrawal.findById(req.params.id);
    if (wd && wd.status === "pending") {
      wd.status = "failed";
      wd.note =
        err?.response?.data?.msg ||
        err?.response?.data?.message ||
        err?.message ||
        "Binance payout failed";
      await wd.save();
    }
    res.status(500).json({ message: "Binance payout failed" });
  }
};

// ==============================
// Admin: reject
// ==============================
exports.adminRejectWithdrawal = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { reason } = req.body;
    const wd = await Withdrawal.findById(req.params.id);
    if (!wd) return res.status(404).json({ message: "Request not found" });
    if (wd.status !== "pending") {
      return res.status(400).json({ message: `Request is ${wd.status}, not pending` });
    }
    wd.status = "rejected";
    wd.note = reason || "Rejected by admin";
    wd.approvedBy = req.user._id;
    wd.approvedAt = new Date();
    await wd.save();
    res.json({ success: true, withdrawal: wd });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};



exports.adminStats = async (req, res) => {
  if (!assertAdmin(req, res)) return;

  try {
    // 1) Totals from User
    const [uAgg] = await User.aggregate([
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          sumDailyProfit: { $sum: { $ifNull: ["$dailyProfit", 0] } },
          sumBonusEarned: { $sum: { $ifNull: ["$bonusEarned", 0] } },
        },
      },
    ]);

    // 2) Commission = sum of referralHistory.profit where name != "Daily Bonus"
    const [cAgg] = await User.aggregate([
      { $unwind: { path: "$referralHistory", preserveNullAndEmptyArrays: true } },
      { $match: { "referralHistory.name": { $ne: "Daily Bonus" } } },
      {
        $group: {
          _id: null,
          totalCommission: { $sum: { $ifNull: ["$referralHistory.profit", 0] } },
        },
      },
    ]);

    // 3) Withdraw total = sum of all withdrawals (any status)
    const [wAgg] = await Withdrawal.aggregate([
      { $group: { _id: null, total: { $sum: { $ifNull: ["$amount", 0] } } } },
    ]);

    const totalUsers = uAgg?.totalUsers || 0;
    const sumDailyProfit = uAgg?.sumDailyProfit || 0;
    const sumBonusEarned = uAgg?.sumBonusEarned || 0;
    const totalCommission = cAgg?.totalCommission || 0;
    const totalWithdraw = wAgg?.total || 0;

    // Total earnings = daily profit + commission (historical)
    const totalEarnings = sumDailyProfit + totalCommission;

    res.json({
      totalUsers,
      sumDailyProfit,
      sumBonusEarned,
      totalCommission,
      totalWithdraw,
      totalEarnings,
    });
  } catch (err) {
    console.error("adminStats error:", err);
    res.status(500).json({ message: "Failed to compute admin stats" });
  }
};