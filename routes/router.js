const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const {
  signup,
  login,
  me,
  subusers,
  referral,
  tree,
  dailyProfit,
  verifyPayment,
} = require("../Controller/controller");

// WithDrawel Controller
const { requestWithdrawal, myWithdrawals } = require("../Controller/admin_controller");
const { getUsdtBalancePublic } = require("../Controller/binance_controller");

// public
router.post("/signup", signup);
router.post("/login", login);

// private
router.post("/verify-payment", auth, verifyPayment);
router.get("/me", auth, me);
router.get("/subusers", auth, subusers);
router.get("/referral", auth, referral);
router.get("/tree", auth, tree);
router.post("/daily-profit", auth, dailyProfit);

// NEW user withdrawal endpoints
router.post("/withdrawals/request", auth, requestWithdrawal);
router.get("/withdrawals/mine", auth, myWithdrawals);
// Read-only public (no auth) – yeh sirf amount return karta hai, keys leak nahi hotin
router.get("/binance/usdt", getUsdtBalancePublic);

module.exports = router;
