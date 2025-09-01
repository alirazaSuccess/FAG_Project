const express = require("express");
const Admin = require("../models/admin_model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user.js");
const { adminListWithdrawals, adminApproveWithdrawal, adminRejectWithdrawal, adminStats } = require("../Controller/admin_controller.js");
const auth = require("../middleware/auth.js");
const router = express.Router();

// Helper: Generate JWT token
const generateToken = (admin) =>
   jwt.sign(
     { _id: admin._id, email: admin.email, role: "admin" },
     process.env.JWT_SECRET,
     { expiresIn: "1d" }
   );

// ✅ Register admin
router.post("/create", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (await Admin.findOne({ email }))
      return res.status(400).json({ message: "Admin already exists" });

    const hash = await bcrypt.hash(password, 10);
    const admin = await Admin.create({ username, email, password: hash });

    res.json({
      success: true,
      message: "Admin signup successful!",
      admin: { id: admin._id, username: admin.username, email: admin.email },
    });
  } catch (err) {
    console.error("Admin signup error:", err);
    res.status(500).json({ message: err.message });
  }
});

// ✅ Login admin
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const admin = await Admin.findOne({ email });
    if (!admin) return res.status(400).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) return res.status(400).json({ message: "Invalid credentials" });

    const token = generateToken(admin);
    res.json({
      success: true,
      message: "Login successful!",
      token,
      admin: { id: admin._id, username: admin.username, email: admin.email },
    });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ message: err.message });
  }
});

// ✅ Check if any admin exists
router.get("/check", async (req, res) => {
  try {
    const count = await Admin.countDocuments();
    res.json({ exists: count > 0 });
  } catch (err) {
    console.error("Check admin error:", err);
    res.status(500).json({ message: err.message });
  }
});

// Auth middleware
const authAdmin = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "No token provided" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: "Unauthorized" });
  }
};

// Get all users (admin only)
router.get("/users", authAdmin, async (req, res) => {
  try {
    const users = await User.find().lean();
    res.json(users);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

// AFTER ✅ use admin JWT guard you already have in this file
router.get("/withdrawals", auth, authAdmin, adminListWithdrawals);
router.post("/withdrawals/:id/approve", auth, authAdmin, adminApproveWithdrawal);
router.post("/withdrawals/:id/reject", auth, authAdmin, adminRejectWithdrawal);

// NEW metrics route
router.get("/stats", auth, adminStats); 

module.exports = router;