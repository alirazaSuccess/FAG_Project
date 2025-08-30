const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
require('dotenv').config();
const cors = require("cors");

dotenv.config();

const app = express();

// ================== Middleware ==================
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
  credentials: true
}));
app.use(express.json());

// ================== Routes ==================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "FAG API" });
});

// User Routes
const userRoutes = require("./routes/router");
app.use("/api/users", userRoutes);

// Admin Routes
const adminRoutes = require("./routes/admin_route");
app.use("/api/admin", adminRoutes);

// ================== MongoDB Connection ==================
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log("✅ MongoDB Connected Successfully"))
.catch(err => {
  console.error("❌ MongoDB connection error:", err.message);
  process.exit(1);
});

// ================== Start Server ==================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});