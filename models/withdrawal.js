// backend/models/withdrawal.js (unchanged)
const mongoose = require("mongoose");

const withdrawalSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "USDT" },
    chain: { type: String, default: "BEP20" }, // USDT on BEP20
    address: { type: String, required: true },
    fee: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "paid", "failed"],
      default: "pending",
      index: true,
    },
    txId: { type: String }, // we store Binance withdrawId here
    note: { type: String },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
    approvedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("withdrawal", withdrawalSchema);