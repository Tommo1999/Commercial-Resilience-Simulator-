const express = require("express");
const router = express.Router();

const { connectDB } = require("../db");

// GET all community library scenarios
router.get("/", async (req, res) => {
    try {
        const db = await connectDB();

        const library = await db
            .collection("communityLibrary")
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        res.json(library);

    } catch (error) {
        console.error("Library load error:", error);

        res.status(500).json({
            error: "Could not load community library."
        });
    }
});

// SAVE a community library scenario
router.post("/", async (req, res) => {
    try {
        const db = await connectDB();

        const scenario = {
            ...req.body,
            createdAt: new Date()
        };

        const result = await db
            .collection("communityLibrary")
            .insertOne(scenario);

        res.status(201).json({
            success: true,
            id: result.insertedId,
            scenario
        });

    } catch (error) {
        console.error("Library save error:", error);

        res.status(500).json({
            error: "Could not save community library scenario."
        });
    }
});

module.exports = router;