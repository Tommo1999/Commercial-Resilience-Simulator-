const express = require("express");
const router = express.Router();

const scenarios = require("../data/scenarios");

// GET all scenarios
router.get("/", (req, res) => {
    res.json(scenarios);
});

// GET one scenario by ID
router.get("/:id", (req, res) => {
    const scenario = scenarios.find(
        scenario => scenario.id === parseInt(req.params.id)
    );

    if (!scenario) {
        return res.status(404).json({
            error: "Scenario not found"
        });
    }

    res.json(scenario);
});

module.exports = router;