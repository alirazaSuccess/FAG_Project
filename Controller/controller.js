const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/user.js");

// Profit levels upto 10 levels
const PROFIT_LEVELS = [10, 5, 3, 3, 2, 2, 1.5, 1.5, 1, 1];

// Generate referral code
const generateRefCode = () => "REF" + Math.floor(100000 + Math.random() * 900000);

// JWT token generator
const generateToken = (user) =>
  jwt.sign({ _id: user._id, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

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

  // Check subtrees recursively
  const levels = [];
  for (let ref of directRefs) {
    const subLevel = await getUserLevel(ref._id);
    levels.push(subLevel);
  }

  // Minimum of direct referral levels + 1
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
        await updateLevelAndRank(parent._id); // update rank recursively
        // console.log(updateLevelAndRank)
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

    // Update parent's referral count & level
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
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ===========================
// ====== PAYMENT ======
exports.payment = async (req, res) => {
  try {
    const userId = req.user._id;
    const { amount } = req.body;

    if (!amount || amount < 50) return res.status(400).json({ message: "Minimum $50 required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.balance = (user.balance || 0) + amount;
    await user.save();

    await distributeProfit(user);

    res.json({ success: true, message: `Payment of $${amount} successful!`, balance: user.balance });
  } catch (err) {
    console.error("Payment error:", err);
    res.status(500).json({ success: false, message: "Payment failed" });
  }
};

// ===========================
// ====== /me ======
exports.me = async (req, res) => {
  try {
    // ✅ Update rank & level before returning user
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
      level: user.level || 0
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