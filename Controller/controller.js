// backend/Controller/controller.js

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { ethers } = require("ethers");
const User = require("../models/user");

// ===========================
// Config / Constants
// ===========================
const MIN_DEPOSIT_USD = 50;

const BSC_USDT_CONTRACT =
  (process.env.BSC_USDT_CONTRACT ||
    "0x55d398326f99059fF775485246999027B3197955").toLowerCase();
const BSC_USDT_DECIMALS = Number(process.env.BSC_USDT_DECIMALS || 18);

// ERC-20 Transfer event signature
const TRANSFER_TOPIC = ethers.utils.id(
  "Transfer(address,address,uint256)"
);

// ===========================
// Referral / Rank Configuration
// ===========================

// Profit levels up to 10 levels (per successful deposit)
const PROFIT_LEVELS = [10, 5, 3, 3, 2, 2, 1.5, 1.5, 1, 1];

// Rank rules (based on a “3-wide” structure + active downlines)
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
// Utils
// ===========================
const generateRefCode = () =>
  "REF" + Math.floor(100000 + Math.random() * 900000);

const generateToken = (user) =>
  jwt.sign(
    { _id: user._id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

// ===========================
// Level / Rank Calculation
// ===========================
async function countActiveReferrals(userId) {
  const directRefs = await User.find({
    parentId: userId,
    balance: { $gte: MIN_DEPOSIT_USD },
  });
  if (!directRefs.length) return 0;

  let total = directRefs.length;
  for (const ref of directRefs) {
    total += await countActiveReferrals(ref._id);
  }
  return total;
}

async function getUserLevel(userId) {
  const user = await User.findById(userId);
  if (!user || (user.balance || 0) < MIN_DEPOSIT_USD) return 0;

  const directRefs = await User.find({
    parentId: userId,
    balance: { $gte: MIN_DEPOSIT_USD },
  });
  // Need 3 active directs to start levelling
  if (directRefs.length < 3) return 0;

  const subLevels = [];
  for (const ref of directRefs) {
    subLevels.push(await getUserLevel(ref._id));
  }
  const minSub = subLevels.length ? Math.min(...subLevels) : 0;
  return Math.min(minSub + 1, 10);
}

function levelToRank(level) {
  const rule = RANK_RULES.find((r) => r.level === level);
  return rule ? rule.rank : "Starter";
}

async function updateLevelAndRank(userId) {
  const user = await User.findById(userId);
  if (!user || (user.balance || 0) < MIN_DEPOSIT_USD) return;
  const newLevel = await getUserLevel(userId);
  const newRank = levelToRank(newLevel);
  if (user.level !== newLevel || user.rank !== newRank) {
    user.level = newLevel;
    user.rank = newRank;
    await user.save();
  }
}

// ===========================
// Referral Profit Distribution
// ===========================
async function distributeProfit(paidUser) {
  try {
    let parentId = paidUser.parentId;
    let level = 0;

    while (parentId && level < PROFIT_LEVELS.length) {
      const parent = await User.findById(parentId);
      if (!parent) break;

      const profit = PROFIT_LEVELS[level];

      if ((parent.balance || 0) >= MIN_DEPOSIT_USD) {
        parent.bonusEarned = (parent.bonusEarned || 0) + profit;
        parent.referralHistory = parent.referralHistory || [];
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
        parent.referralHistory = parent.referralHistory || [];
        parent.referralHistory.push({
          name: paidUser.username,
          email: paidUser.email,
          profit,
          date: new Date(),
          status: "pending",
        });
        await parent.save();
      }

      parentId = parent.parentId;
      level++;
    }
  } catch (err) {
    console.error("Profit Distribution Error:", err);
  }
}

// ===========================
// BSC (BEP-20) Provider & CHUNKED Log Scanner
// ===========================
function makeBscProvider() {
  const urls = [
    process.env.BSC_RPC_PRIMARY,       // e.g. https://rpc.ankr.com/bsc/...
    process.env.BSC_RPC_FALLBACK_1,    // e.g. https://bsc-dataseed.binance.org
    process.env.BSC_RPC_FALLBACK_2,
  ].filter(Boolean);

  if (!urls.length) throw new Error("No BSC RPC provided (set BSC_RPC_PRIMARY)");

  let i = 0;
  let provider = new ethers.providers.JsonRpcProvider(urls[i], {
    name: "binance",
    chainId: 56,
  });

  provider.on("error", () => {
    i = Math.min(i + 1, urls.length - 1);
    provider = new ethers.providers.JsonRpcProvider(urls[i], {
      name: "binance",
      chainId: 56,
    });
  });

  return provider;
}

// singleton
const bsc = makeBscProvider();

const ERC20_IFACE = new ethers.utils.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

// Chunking knobs
const MAX_LOG_SPAN = Math.max(500, Number(process.env.BSC_LOG_MAX_SPAN || 3000));
const SLEEP_MS_PER_CHUNK = Number(process.env.BSC_LOG_SLEEP_MS || 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scan BSC logs for a USDT (BEP-20) Transfer to ADMIN_WALLET >= amount.
 * Walks backward from latest block in CHUNKS to avoid "Block range is too large".
 *
 * @param {Object} p
 * @param {string} p.adminWallet - checksum 0x...
 * @param {number} p.amount - required amount in USDT
 * @param {number} [p.lookbackBlocks=40000] - total history window (~2 days)
 * @returns {Promise<null | { txId, from, amount }>}
 */
async function findIncomingUsdtBep20({ adminWallet, amount, lookbackBlocks = 40000 }) {
  if (!adminWallet || !/^0x[a-fA-F0-9]{40}$/.test(adminWallet)) {
    throw new Error("Invalid ADMIN_WALLET");
  }

  const usdtAddr = BSC_USDT_CONTRACT;
  const decimals = BSC_USDT_DECIMALS;
  const need = ethers.utils.parseUnits(String(amount), decimals);
  const toTopic = "0x" + "00".repeat(12) + adminWallet.toLowerCase().slice(2);

  const latest = await bsc.getBlockNumber();
  const oldest = Math.max(latest - lookbackBlocks, 1);

  let toBlock = latest;

  while (toBlock >= oldest) {
    let span = Math.min(MAX_LOG_SPAN, toBlock - oldest + 1);
    let fromBlock = Math.max(toBlock - span + 1, oldest);

    // try this window; if provider complains, shrink span until it works
    let logs = [];
    while (true) {
      try {
        logs = await bsc.getLogs({
          address: usdtAddr,
          fromBlock,
          toBlock,
          topics: [TRANSFER_TOPIC, null, toTopic],
        });
        break; // success
      } catch (e) {
        const code = e?.code || e?.error?.code || e?.response?.data?.error?.code;
        // -32062 or -32005 => block range too large / limit
        if ((code === -32062 || code === -32005) && span > 500) {
          span = Math.max(Math.floor(span / 2), 500);
          fromBlock = Math.max(toBlock - span + 1, oldest);
          continue; // retry with smaller span
        }
        // transient: small sleep & one last retry smaller
        span = Math.max(Math.floor(span / 2), 500);
        fromBlock = Math.max(toBlock - span + 1, oldest);
        await sleep(150);
        try {
          logs = await bsc.getLogs({
            address: usdtAddr,
            fromBlock,
            toBlock,
            topics: [TRANSFER_TOPIC, null, toTopic],
          });
          break;
        } catch {
          logs = []; // skip this chunk
          break;
        }
      }
    }

    // process logs (any match returns immediately)
    for (const lg of logs) {
      try {
        const parsed = ERC20_IFACE.parseLog(lg);
        const to = String(parsed.args.to || "").toLowerCase();
        if (to !== adminWallet.toLowerCase()) continue;
        const value = parsed.args.value; // BigNumber
        if (value.gte(need)) {
          return {
            txId: lg.transactionHash,
            from: String(parsed.args.from || "").toLowerCase(),
            amount: Number(ethers.utils.formatUnits(value, decimals)),
          };
        }
      } catch {
        // ignore unparsable
      }
    }

    // move to previous window
    toBlock = fromBlock - 1;
    if (SLEEP_MS_PER_CHUNK > 0) await sleep(SLEEP_MS_PER_CHUNK);
  }

  return null;
}

// ===========================
// Auth: Signup / Login / Me
// ===========================
exports.signup = async (req, res) => {
  try {
    const {
      username,
      email,
      password,
      number,
      address,
      city,
      country,
      refCode: parentRefCode,
    } = req.body;

    const existing = await User.findOne({ email });
    if (existing)
      return res.status(400).json({ message: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);

    const user = new User({
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
      if (!parent)
        return res.status(400).json({ message: "Invalid referral code" });
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
    console.error("LOGIN error:", err);
    res.status(500).json({ message: err.message });
  }
};

exports.me = async (req, res) => {
  try {
    await updateLevelAndRank(req.user._id);

    const user = await User.findById(req.user._id).lean();
    if (!user) return res.status(401).json({ message: "Invalid user" });

    const referrals = await User.find({ parentId: user._id }).lean();
    const referralHistory = user.referralHistory || [];
    let totalProfit = 0;
    const cleanedHistory = referralHistory.map((r) => {
      const p = Number(r.profit || 0);
      totalProfit += p;
      return { ...r, profit: p };
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
// Network / Referrals
// ===========================
exports.subusers = async (req, res) => {
  try {
    const subs = await User.find({ parentId: req.user._id }).lean();
    res.json({ subusers: subs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

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

exports.tree = async (req, res) => {
  try {
    const level1 = await User.find({ parentId: req.user._id }).lean();
    const ids = level1.map((u) => u._id);
    const level2 = await User.find({ parentId: { $in: ids } }).lean();
    res.json({ level1, level2 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ===========================
// Daily Profit (manual trigger every 24h)
// ===========================
exports.dailyProfit = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.dailyProfitEligible || (user.balance || 0) <= MIN_DEPOSIT_USD) {
      return res
        .status(400)
        .json({ message: "User not eligible for daily profit" });
    }

    const now = new Date();
    const base = user.lastDailyBonusAt || user.eligibleSince;

    if (!base) {
      user.eligibleSince = now;
      await user.save();
      return res
        .status(400)
        .json({ message: "Eligibility started. Try again after 24 hours." });
    }

    const HOURS_24 = 24 * 60 * 60 * 1000;
    if (now - new Date(base) < HOURS_24) {
      const remainingMs = HOURS_24 - (now - new Date(base));
      return res.status(400).json({
        message: "Daily profit not available yet",
        remainingHours: Math.ceil(remainingMs / (1000 * 60 * 60)),
      });
    }

    user.dailyProfit = (user.dailyProfit || 0) + 1;
    user.lastDailyBonusAt = now;
    user.referralHistory = user.referralHistory || [];
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
      lastDailyBonusAt: user.lastDailyBonusAt,
    });
  } catch (err) {
    console.error("Daily Profit Error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ===========================
// Payment Verification (BSC / BEP-20 USDT)
// ===========================
exports.verifyPayment = async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user?._id;

    const amt = parseFloat(amount);
    if (!amt || amt < MIN_DEPOSIT_USD) {
      return res.status(400).json({ message: `Minimum $${MIN_DEPOSIT_USD} required` });
    }

    const adminWallet = (process.env.ADMIN_WALLET || "").trim();
    if (!adminWallet) {
      return res
        .status(500)
        .json({ message: "Server wallet not configured (ADMIN_WALLET missing)" });
    }

    // Scan recent logs for a matching inbound transfer (chunked)
    const matched = await findIncomingUsdtBep20({
      adminWallet,
      amount: amt,
      lookbackBlocks: 60000, // ~2 days worth of blocks on BSC
    });

    if (!matched) {
      return res.status(400).json({
        message:
          "Payment not found yet. If you already sent USDT, wait a minute and try again.",
      });
    }

    // Credit user
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.balance = (user.balance || 0) + amt;

    // Activate daily profit on first $50+ threshold
    if (!user.dailyProfit) user.dailyProfit = 0;
    if (!user.dailyProfitEligible && (user.balance || 0) >= MIN_DEPOSIT_USD) {
      const now = new Date();
      user.dailyProfitEligible = true;
      user.eligibleSince = now;
      user.lastDailyBonusAt = now;
      user.dailyProfit += 1; // instant first $1 bonus
    }

    // Prevent double-credit (store txId history)
    user.payments = user.payments || [];
    if (!user.payments.find((p) => p.txId === matched.txId)) {
      user.payments.push({
        txId: matched.txId,
        amount: matched.amount,
        at: new Date(),
        chain: "BSC",
      });
    }

    await user.save();

    // Referral distribution
    await distributeProfit(user);

    res.json({
      success: true,
      message: `✅ Verified: $${amt} USDT received.`,
      network: "BSC",
      balance: user.balance,
      txHash: matched.txId,
      from: matched.from,
    });
  } catch (err) {
    console.error("Verify Payment Error:", err?.response?.data || err?.message || err);
    const msg = err?.message || "Error verifying payment";
    res.status(500).json({ message: msg });
  }
};
