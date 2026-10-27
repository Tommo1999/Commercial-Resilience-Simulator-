const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const cors = require("cors");
const path = require("path");
require("dotenv").config();
const { connectDB } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

const scenarioRoutes = require("./routes/scenarios");
const sessionRoutes = require("./routes/sessions");
const libraryRoutes = require("./routes/library");

// Middleware
app.use(cors());
app.use(express.json());

// Serve the frontend
app.use(express.static(path.join(__dirname, "public")));

// API routes
app.use("/api/scenarios", scenarioRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/library", libraryRoutes);

// Test route
app.get("/api/test", (req, res) => {
    res.json({
        message: "Off Book backend is working!"
    });
});

// Start server
connectDB()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error("MongoDB connection failed:", err);
    });