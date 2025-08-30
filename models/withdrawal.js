// models/withdrawal.js
const mongoose = require("mongoose");

const withdrawalSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "USDT" },
    chain: { type: String, default: "TRC20" }, // USDT on TRON
    address: { type: String, required: true },
    fee: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "paid", "failed"],
      default: "pending",
      index: true
    },
    txId: { type: String },
    note: { type: String },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
    approvedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("withdrawal", withdrawalSchema);