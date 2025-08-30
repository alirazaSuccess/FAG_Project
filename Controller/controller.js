const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/user");
const axios = require("axios");
const TronWeb = require("tronweb");


// Profit levels upto 10 levels
const PROFIT_LEVELS = [10, 5, 3, 3, 2, 2, 1.5, 1.5, 1, 1];

// Generate referral code
const generateRefCode = () => "REF" + Math.floor(100000 + Math.random() * 900000);

// JWT token generator
const generateToken = (user) =>
  jwt.sign(
    { _id: user._id, email: user.email, role: user.role },  // ✅ role included
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

// Rank Rules (exponential referrals)
const RANK_RULES = [
  { level: 1, requiredUsers: 3, rank: "Bronze" },
  { level: 2, requiredUsers: 9, rank: "Silver" },
  { level: 3, requiredUsers: 27, rank: "Gold" },
  { level: 4, requiredUsers: 81, rank: "Platinum" },
  { level: 5, requiredUsers: 243, rank: "Sapphire" },
  { level: 6, requiredUsers: 729, rank: "Ruby" },
  { level: 7, requiredUsers: 2187, rank: "Emerald" },
  { level: 8, requiredUsers: 6561, rank: "Diamond" },
  { level: 9, requiredUsers: 19683, rank: "Crown" },
  { level: 10, requiredUsers: 59049, rank: "Legender" },
];

// ===========================
// Count ONLY active referrals recursively
async function countActiveReferrals(userId) {
  const directRefs = await User.find({ parentId: userId, balance: { $gte: 50 } });
  if (!directRefs.length) return 0;

  let total = directRefs.length;
  for (let ref of directRefs) {
    total += await countActiveReferrals(ref._id);
  }
  return total;
}

// ===========================
// Calculate level based on active referrals recursively
async function getUserLevel(userId) {
  const user = await User.findById(userId);
  if (!user || user.balance < 50) return 0;

  const directRefs = await User.find({ parentId: userId, balance: { $gte: 50 } });
  if (directRefs.length < 3) return 0; // Minimum 3 active referrals to level up

  const levels = [];
  for (let ref of directRefs) {
    const subLevel = await getUserLevel(ref._id);
    levels.push(subLevel);
  }

  const minSubLevel = levels.length ? Math.min(...levels) : 0;
  const userLevel = Math.min(minSubLevel + 1, 10); // Max level 10
  return userLevel;
}

// ===========================
// Convert level to rank
function levelToRank(level) {
  const rule = RANK_RULES.find(r => r.level === level);
  return rule ? rule.rank : "Starter";
}

// ===========================
// Update rank & level based on active referrals
async function updateLevelAndRank(userId) {
  const user = await User.findById(userId);
  if (!user || user.balance < 50) return;

  const newLevel = await getUserLevel(userId);
  const newRank = levelToRank(newLevel);

  if (user.level !== newLevel || user.rank !== newRank) {
    user.level = newLevel;
    user.rank = newRank;
    await user.save();
  }
}

// ===========================
// Profit distribution
async function distributeProfit(paidUser) {
  try {
    let currentParentId = paidUser.parentId;
    let level = 0;

    while (currentParentId && level < PROFIT_LEVELS.length) {
      const parent = await User.findById(currentParentId);
      if (!parent) break;

      const profit = PROFIT_LEVELS[level];

      if (parent.balance >= 50) {
        parent.bonusEarned = (parent.bonusEarned || 0) + profit;
        parent.referralHistory.push({
          name: paidUser.username,
          email: paidUser.email,
          profit,
          date: new Date(),
          status: "paid",
        });

        await parent.save();
        await updateLevelAndRank(parent._id);
      } else {
        parent.referralHistory.push({
          name: paidUser.username,
          email: paidUser.email,
          profit,
          date: new Date(),
          status: "pending",
        });
        await parent.save();
      }

      currentParentId = parent.parentId;
      level++;
    }
  } catch (err) {
    console.error("Profit Distribution Error:", err);
  }
}

// ===========================
// ====== SIGNUP ======
exports.signup = async (req, res) => {
  try {
    const { username, email, password, number, address, city, country, refCode: parentRefCode } = req.body;

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);

    let user = new User({
      username,
      email,
      password: hash,
      number,
      address,
      city,
      country,
      refCode: generateRefCode(),
      parentId: null,
    });

    if (parentRefCode) {
      const parent = await User.findOne({ refCode: parentRefCode });
      if (!parent) return res.status(400).json({ message: "Invalid referral code" });
      user.parentId = parent._id;
    }

    await user.save();

    if (user.parentId) {
      const parent = await User.findById(user.parentId);
      parent.referralsCount = (parent.referralsCount || 0) + 1;
      await parent.save();
      await updateLevelAndRank(parent._id);
    }

    const token = generateToken(user);
    res.json({ user, token });
  } catch (err) {
    console.error("SIGNUP error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ===========================
// ====== LOGIN ======
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ message: "Invalid credentials" });

    const token = generateToken(user);
    res.json({ token, role: user.role, user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ===========================
// ====== PAYMENT ======
// exports.payment = async (req, res) => {
//   try {
//     const userId = req.user._id;
//     const { amount } = req.body;

//     if (!amount || amount < 50) return res.status(400).json({ message: "Minimum $50 required" });

//     const user = await User.findById(userId);
//     if (!user) return res.status(404).json({ message: "User not found" });

//     // add deposit
//     user.balance = (user.balance || 0) + amount;

//     if (!user.dailyProfit) user.dailyProfit = 0;

//     // ✅ First time eligibility check
//     if (!user.dailyProfitEligible && user.balance >= 50) {
//       const now = new Date();

//       user.dailyProfitEligible = true;
//       user.eligibleSince = now;
//       user.lastDailyBonusAt = now;

//       // ✅ Immediately give first daily profit
//       user.dailyProfit += 1;
//       // user.referralHistory.push({
//       //   name: "dailyProfit",
//       //   email: user.email,
//       //   profit: 1,
//       //   date: now,
//       //   status: "paid",
//       // });
//     }

//     await user.save();
//     await distributeProfit(user);

//     res.json({
//       success: true,
//       message: `Payment of $${amount} successful!`,
//       balance: user.balance,
//       dailyProfit: user.dailyProfit
//     });
//   } catch (err) {
//     console.error("Payment error:", err);
//     res.status(500).json({ success: false, message: "Payment failed" });
//   }
// };

// ===========================
// ====== /me ======
exports.me = async (req, res) => {
  try {
    await updateLevelAndRank(req.user._id);

    const user = await User.findById(req.user._id).lean();
    if (!user) return res.status(401).json({ message: "Invalid user" });

    const referrals = await User.find({ parentId: user._id }).lean();
    const referralHistory = user.referralHistory || [];
    let totalProfit = 0;
    const cleanedHistory = referralHistory.map((r) => {
      totalProfit += Number(r.profit || 0);
      return { ...r, profit: Number(r.profit || 0) };
    });

    res.json({
      ...user,
      referrals,
      referralHistory: cleanedHistory,
      totalProfit,
      rank: user.rank || "Starter",
      level: user.level || 0,
    });
  } catch (err) {
    console.error("ME error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ===========================
// ====== Subusers ======
exports.subusers = async (req, res) => {
  try {
    const subs = await User.find({ parentId: req.user._id }).lean();
    res.json({ subusers: subs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ===========================
// ====== Referral Link ======
exports.referral = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean();
    if (!user) return res.status(401).json({ message: "Invalid user" });

    const link = `${process.env.CLIENT_ORIGIN || "http://localhost:3000"}/register?ref=${user.refCode}`;
    res.json({ refCode: user.refCode, link });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ===========================
// ====== Referral Tree ======
exports.tree = async (req, res) => {
  try {
    const level1 = await User.find({ parentId: req.user._id }).lean();
    const ids = level1.map(u => u._id);
    const level2 = await User.find({ parentId: { $in: ids } }).lean();
    res.json({ level1, level2 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ====== DAILY PROFIT (manual trigger; every 24h) ======
exports.dailyProfit = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // check eligibility
    if (!user.dailyProfitEligible || user.balance <= 50) {
      return res.status(400).json({ message: "User not eligible for daily profit" });
    }

    const now = new Date();
    const base = user.lastDailyBonusAt || user.eligibleSince;

    if (!base) {
      user.eligibleSince = now; // first eligibility time
      await user.save();
      return res.status(400).json({ message: "Eligibility started. Try again after 24 hours." });
    }

    // must wait 24h
    const HOURS_24 = 24 * 60 * 60 * 1000;
    if (now - new Date(base) < HOURS_24) {
      const remainingMs = HOURS_24 - (now - new Date(base));
      return res.status(400).json({
        message: "Daily profit not available yet",
        remainingHours: Math.ceil(remainingMs / (1000 * 60 * 60))
      });
    }

    // ✅ Only update dailyProfit (NOT balance)
    user.dailyProfit = (user.dailyProfit || 0) + 1;
    user.lastDailyBonusAt = now;

    user.referralHistory.push({
      name: "Daily Bonus",
      email: user.email,
      profit: 1,
      date: now,
      status: "paid",
    });

    await user.save();

    res.json({
      message: "Daily profit credited ($1)",
      dailyProfit: user.dailyProfit,
      lastDailyBonusAt: user.lastDailyBonusAt
    });
  } catch (err) {
    console.error("Daily Profit Error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ===========================
// PAYMENT (TronGrid v1 only; no TronWeb)
// ===========================

// Axios instance for TronGrid v1 (base URL only — we’ll inject the API key per request)
const tronGrid = axios.create({
  baseURL: process.env.TRONGRID_URL || "https://api.trongrid.io",
});

// Safe value converter (handles raw integers or decimal strings)
function toDecimal(valueStr, decimals = 6) {
  const s = String(valueStr ?? "0").trim();
  if (s.includes(".")) return Number(s);
  // treat as big integer with `decimals`
  try {
    const n = BigInt(s || "0");
    const d = BigInt(10) ** BigInt(decimals);
    const intPart = n / d;
    const fracPart = n % d;
    const frac = fracPart.toString().padStart(decimals, "0").replace(/0+$/, "");
    return Number(frac ? `${intPart}.${frac}` : intPart.toString());
  } catch {
    return Number(s) || 0;
  }
}

/**
 * Find an incoming USDT (TRC20) transfer to the admin wallet within a lookback window
 * TronGrid v1 endpoint: /v1/accounts/{address}/transactions/trc20
 */
async function findIncomingUsdt({
  adminWallet,
  amount,
  lookbackMs = 48 * 60 * 60 * 1000,
}) {
  const USDT = process.env.USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // TRC20 USDT mainnet

  // attach API key per-request so it always uses fresh env
  const headers = {};
  if (process.env.TRONGRID_API_KEY) {
    headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
  }

  const { data } = await tronGrid.get(
    `/v1/accounts/${adminWallet}/transactions/trc20`,
    {
      params: {
        limit: 200,
        contract_address: USDT,
        only_confirmed: true,
        order_by: "block_timestamp,desc",
      },
      headers,
      timeout: 15000,
    }
  );

  const rows = data?.data || [];
  const now = Date.now();
  const need = Number(amount);

  for (const row of rows) {
    // Typical TronGrid fields:
    // from, to, token_info.decimals, value (may be int-like string or decimal string), block_timestamp, transaction_id
    const to = (row.to || "").trim();
    const ts = Number(row.block_timestamp || 0);
    const dec = Number(row.token_info?.decimals ?? 6);

    const valueNum = toDecimal(row.value, dec);

    if (
      to &&
      to.toLowerCase() === adminWallet.toLowerCase() &&
      ts &&
      now - ts <= lookbackMs &&
      valueNum >= need
    ) {
      return {
        txId: row.transaction_id || row.txID,
        from: row.from,
        amount: valueNum,
        timestamp: ts,
        decimals: dec,
      };
    }
  }

  return null;
}

// ===========================
// ====== VERIFY PAYMENT =====
exports.verifyPayment = async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user?._id;

    // Basic validation
    if (!amount || parseFloat(amount) < 50) {
      return res.status(400).json({ message: "Minimum $50 required" });
    }

    const adminWallet = (process.env.ADMIN_WALLET || "").trim();
    if (!adminWallet) {
      return res.status(500).json({ message: "Server wallet not configured" });
    }

    // 1) Look for a confirmed TRC20 USDT transfer to admin wallet (recent window)
    const matched = await findIncomingUsdt({
      adminWallet,
      amount: parseFloat(amount),
      lookbackMs: 48 * 60 * 60 * 1000, // last 48h
    });

    if (!matched) {
      return res.status(400).json({
        message:
          "Payment not found yet. If you already sent USDT, wait a minute and try again.",
      });
    }

    // 2) Update user balance & daily-profit eligibility
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const credited = parseFloat(amount);
    user.balance = (user.balance || 0) + credited;

    if (!user.dailyProfit) user.dailyProfit = 0;
    if (!user.dailyProfitEligible && user.balance >= 50) {
      const now = new Date();
      user.dailyProfitEligible = true;
      user.eligibleSince = now;
      user.lastDailyBonusAt = now;
      user.dailyProfit += 1; // first $1 instantly
    }

    await user.save();

    // 3) Distribute referral profits up the chain
    await distributeProfit(user);

    return res.json({
      success: true,
      message: `✅ Verified: $${credited} USDT received.`,
      balance: user.balance,
      txHash: matched.txId,
      from: matched.from,
    });
  } catch (err) {
    // This catches missing/invalid API key too (TronGrid error body arrives in err.response.data)
    console.error(
      "Verify Payment Error:",
      err?.response?.data || err?.message || err
    );
    return res.status(500).json({ message: "Error verifying payment" });
  }
};