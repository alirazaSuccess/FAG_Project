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
  payment,
} = require("../Controller/controller");

// public
router.post("/signup", signup);
router.post("/login", login);
router.post("/payment", auth, payment);

// private
router.get("/me", auth, me);
router.get("/subusers", auth, subusers);
router.get("/referral", auth, referral);
router.get("/tree", auth, tree);

module.exports = router;