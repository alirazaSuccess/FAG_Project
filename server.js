const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();
const app = express();

// Middleware
app.use(cors({
  origin: process.env.CLIENT_ORIGIN,
  credentials: true
}));
app.use(express.json());

// Routes
app.get("/", (_req, res) => res.json({ ok: true, service: "FAG API" }));
app.use("/api/users", require("./routes/router"));
app.use("/api/admin", require("./routes/admin_route"));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { })
  .then(() => console.log("✅ MongoDB Connected Successfully"))
  .catch(err => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));