// middleware/authAdmin.js
const jwt = require("jsonwebtoken");
const Admin = require("../models/admin_model");

const authAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1]; // Bearer token
    if (!token) return res.status(401).json({ message: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await Admin.findById(decoded.id);
    if (!admin) return res.status(401).json({ message: "Unauthorized" });

    req.admin = admin; // optional, store admin in request
    next();
  } catch (err) {
    console.error("Admin auth error:", err);
    res.status(401).json({ message: "Unauthorized" });
  }
};

module.exports = authAdmin;