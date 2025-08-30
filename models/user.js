const mongoose = require("mongoose");

const referralHistorySchema = new mongoose.Schema({
  name: String,
  email: String,
  profit: { type: Number, default: 0 },
  date: { type: Date, default: Date.now },
  status: { type: String, enum: ["paid", "pending"], default: "paid" },
});

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    number: String,
    address: String,
    city: String,
    country: String,

    refCode: { type: String, unique: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },

    balance: { type: Number, default: 0 },
    referralsCount: { type: Number, default: 0 },
    bonusEarned: { type: Number, default: 0 },
    referralHistory: [referralHistorySchema],

    dailyProfit: { type: Number, default: 0 },
    dailyProfitEligible: { type: Boolean, default: false },
    eligibleSince: { type: Date },
    lastDailyBonusAt: { type: Date },


    level: { type: Number, default: 0 },
    rank: { type: String, default: "STARTER" },

    // ✅ Role field
    role: { type: String, enum: ["user", "admin"], default: "user" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("user", userSchema);