const mongoose = require("mongoose");

const referralHistorySchema = new mongoose.Schema({
  name: String,
  email: String,
  profit: { type: Number, default: 0 },
  date: { type: Date, default: Date.now },
  status: { type: String, enum: ["paid", "pending"], default: "paid" }, // added status
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
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    balance: { type: Number, default: 0 },
    referralsCount: { type: Number, default: 0 },
    bonusEarned: { type: Number, default: 0 },
    referralHistory: [referralHistorySchema],
    level: { type: Number, default: 0 },
    rank: { type: String, default: "STARTER" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);