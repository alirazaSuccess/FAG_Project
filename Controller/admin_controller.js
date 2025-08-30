const crypto = require("crypto");
const Withdrawal = require("../models/withdrawal");
const user = require("../models/user");

// Get User WithDrawable Amount

async function getWithdrawableAmount(userId) {
  const user = await user.findById(userId).lean();
  if (!user) return 0;

  const earnings = Number(user.dailyProfit || 0) + Number(user.bonusEarned || 0);

  const pendingAgg = await Withdrawal.aggregate([
    { $match: { user: user._id, status: { $in: ["pending", "approved"] } } },
    { $group: { _id: null, sum: { $sum: "$amount" } } },
  ]);

  const onHold = pendingAgg[0]?.sum || 0;
  return Math.max(earnings - onHold, 0);
}


// Request WithDrawel

exports.requestWithdrawal = async (req, res) => {
  try {
    const { address, amount } = req.body;
    const min = Number(process.env.WITHDRAW_MIN || 10);
    const currency = process.env.WITHDRAW_CURRENCY || "USDT";
    const chain = process.env.WITHDRAW_CHAIN || "TRC20";

    const amt = Number(amount);
    if (!address || !amt || amt < min) {
      return res.status(400).json({ message: `Minimum withdrawal is ${min} ${currency}` });
    }

    // simple TRON address check (starts with 'T')
    if (!/^T[a-zA-Z0-9]{25,34}$/.test(address)) {
      return res.status(400).json({ message: "Enter a valid TRON (TRC20) address starting with 'T'" });
    }

    const available = await getWithdrawableAmount(req.user._id);
    if (amt > available) {
      return res.status(400).json({ message: "Insufficient withdrawable balance" });
    }

    const wd = await Withdrawal.create({
      user: req.user._id,
      address,
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


// My WithDrawel

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

// Admin Asserts

function assertAdmin(req, res) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }
  return true;
}

// Admin List WithDrawel

exports.adminListWithdrawals = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { status } = req.query;   // e.g. ?status=pending
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


// Api Calling Ku Signing

const KUCOIN_BASE = process.env.KUCOIN_BASE || "https://api.kucoin.com";
const KUCOIN_API_KEY = process.env.KUCOIN_API_KEY;
const KUCOIN_API_SECRET = process.env.KUCOIN_API_SECRET;
const KUCOIN_API_PASSPHRASE = process.env.KUCOIN_API_PASSPHRASE;

function kucoinHeaders(method, endpoint, bodyStr = "") {
  if (!KUCOIN_API_KEY || !KUCOIN_API_SECRET || !KUCOIN_API_PASSPHRASE) {
    throw new Error("KuCoin API not configured");
  }
  const ts = Date.now().toString();
  const preSign = ts + method.toUpperCase() + endpoint + bodyStr;
  const sign = crypto.createHmac("sha256", KUCOIN_API_SECRET).update(preSign).digest("base64");
  const passphrase = crypto.createHmac("sha256", KUCOIN_API_SECRET)
    .update(KUCOIN_API_PASSPHRASE).digest("base64");

  return {
    "KC-API-KEY": KUCOIN_API_KEY,
    "KC-API-SIGN": sign,
    "KC-API-TIMESTAMP": ts,
    "KC-API-PASSPHRASE": passphrase,
    "KC-API-KEY-VERSION": "2",
    "Content-Type": "application/json",
  };
}

async function kucoinCreateWithdrawal({ currency, address, amount, chain, remark }) {
  const endpoint = "/api/v1/withdrawals";
  const bodyObj = { currency, address, amount: String(amount), chain, remark };
  const bodyStr = JSON.stringify(bodyObj);
  const headers = kucoinHeaders("POST", endpoint, bodyStr);

  const { data } = await axios.post(`${KUCOIN_BASE}${endpoint}`, bodyObj, { headers });
  if (data?.code !== "200000") {
    throw new Error(data?.msg || "KuCoin withdrawal failed");
  }
  return data?.data; // KuCoin withdrawalId
}



// Approve Routes

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

    // Execute payout via KuCoin
    const withdrawalId = await kucoinCreateWithdrawal({
      currency: wd.currency,
      address: wd.address,
      amount: wd.amount,
      chain: wd.chain,
      remark: `WD ${wd.user.email} ${wd._id}`,
    });

    // Mark paid & deduct earnings (bonusEarned first, then dailyProfit)
    wd.status = "paid";
    wd.txId = withdrawalId;
    wd.approvedBy = req.user._id;
    wd.approvedAt = new Date();
    await wd.save();

    const user = await User.findById(wd.user._id);
    let remaining = wd.amount;

    const fromBonus = Math.min(Number(user.bonusEarned || 0), remaining);
    user.bonusEarned = Number(user.bonusEarned || 0) - fromBonus;
    remaining -= fromBonus;

    if (remaining > 0) {
      user.dailyProfit = Math.max(Number(user.dailyProfit || 0) - remaining, 0);
      remaining = 0;
    }

    user.withdrawnTotal = Number(user.withdrawnTotal || 0) + wd.amount; // harmless if you didn’t add the field
    await user.save();

    res.json({ success: true, message: "Withdrawal executed", withdrawal: wd });
  } catch (err) {
    console.error("adminApproveWithdrawal error:", err?.response?.data || err?.message || err);
    const wd = await Withdrawal.findById(req.params.id);
    if (wd && wd.status === "pending") {
      wd.status = "failed";
      wd.note = err?.response?.data?.msg || err?.message || "KuCoin payout failed";
      await wd.save();
    }
    res.status(500).json({ message: "KuCoin payout failed" });
  }
};

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


