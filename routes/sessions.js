const express = require("express");
const router = express.Router();
const Anthropic = require("@anthropic-ai/sdk");
const scenarios = require("../data/scenarios");
const { connectDB } = require("../db");

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

const MODEL = "claude-sonnet-4-6";
const INPUT_COST_PER_MILLION = 3;
const OUTPUT_COST_PER_MILLION = 15;
const TOTAL_ROUNDS = 4;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getScenarioById(id) {
    return scenarios.find(item => String(item.id) === String(id));
}

function getText(response) {
    const block = response.content?.find(item => item.type === "text");
    if (!block?.text) throw new Error("Claude returned no text response");
    return block.text.trim();
}

function parseClaudeJson(text) {
    const cleaned = String(text || "").trim();

    try {
        return JSON.parse(cleaned);
    } catch (_) {
        // Try extracting a JSON object if Claude wrapped it in commentary/fences.
    }

    const withoutFences = cleaned
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

    try {
        return JSON.parse(withoutFences);
    } catch (_) {
        const first = withoutFences.indexOf("{");
        const last = withoutFences.lastIndexOf("}");
        if (first >= 0 && last > first) {
            return JSON.parse(withoutFences.slice(first, last + 1));
        }
    }

    throw new Error("Claude's response was not valid JSON");
}

async function recordUsage(response, type, session) {
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const inputCostUSD = (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION;
    const outputCostUSD = (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION;
    const costUSD = inputCostUSD + outputCostUSD;

    session.usage = session.usage || {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        byType: {}
    };

    session.usage.requests += 1;
    session.usage.inputTokens += inputTokens;
    session.usage.outputTokens += outputTokens;
    session.usage.costUSD += costUSD;

    if (!session.usage.byType[type]) {
        session.usage.byType[type] = {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUSD: 0
        };
    }

    const typeTotals = session.usage.byType[type];
    typeTotals.requests += 1;
    typeTotals.inputTokens += inputTokens;
    typeTotals.outputTokens += outputTokens;
    typeTotals.costUSD += costUSD;

    try {
        const db = await connectDB();
        await db.collection("api_usage").insertOne({
            sessionId: session.id,
            type,
            model: response.model || MODEL,
            inputTokens,
            outputTokens,
            inputCostUSD,
            outputCostUSD,
            costUSD,
            timestamp: new Date()
        });
    } catch (error) {
        // Usage-record failure should not discard the simulation response.
        console.error("Failed to save API usage:", error.message);
    }

    console.log(
        `[USAGE] ${type} | Input: ${inputTokens} | Output: ${outputTokens} | Cost: $${costUSD.toFixed(6)}`
    );
}

async function loadSession(sessionId) {
    // MongoDB is the source of truth; this works after a server restart too.
    const db = await connectDB();
    return db.collection("sessions").findOne({ id: String(sessionId) });
}

async function saveSession(session) {
    const db = await connectDB();
    const result = await db.collection("sessions").updateOne(
        { id: session.id },
        {
            $set: {
                scenarioId: session.scenarioId,
                scenarioTitle: session.scenarioTitle,
                scenario: session.scenario,
                status: session.status,
                currentRound: session.currentRound,
                currentEvent: session.currentEvent,
                decisions: session.decisions,
                developments: session.developments,
                state: session.state,
                facts: session.facts,
                assumptions: session.assumptions,
                simulatedEvents: session.simulatedEvents,
                messages: session.messages,
                debrief: session.debrief,
                usage: session.usage,
                startedAt: session.startedAt,
                updatedAt: new Date().toISOString(),
                completedAt: session.completedAt || null
            }
        }
    );

    if (!result.matchedCount) {
        throw new Error("Session record not found in MongoDB");
    }
}

function publicSession(session) {
    return {
        id: session.id,
        sessionId: session.id,
        scenarioId: session.scenarioId,
        scenarioTitle: session.scenarioTitle,
        status: session.status,
        currentRound: session.currentRound,
        totalRounds: TOTAL_ROUNDS,
        currentEvent: session.currentEvent,
        decisions: session.decisions,
        developments: session.developments,
        state: session.state,
        facts: session.facts,
        assumptions: session.assumptions,
        simulatedEvents: session.simulatedEvents,
        messages: session.messages,
        debrief: session.debrief,
        startedAt: session.startedAt,
        completedAt: session.completedAt || null
    };
}

// -----------------------------------------------------------------------------
// Create a simulation session
// POST /api/sessions  { scenarioId: 1 } or { scenario: { id: 1 } }
// -----------------------------------------------------------------------------

router.post("/", async (req, res) => {
    try {
        const requestedId = req.body.scenarioId ?? req.body.scenario?.id ?? 1;
        const scenario = getScenarioById(requestedId);

        if (!scenario) {
            return res.status(400).json({
                error: "Unknown scenario. Choose a scenario from data/scenarios.js."
            });
        }

        const firstRound = scenario.rounds?.[0];
        if (!firstRound) {
            return res.status(500).json({ error: "Scenario has no round configuration." });
        }

        const now = new Date().toISOString();
        const session = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            scenarioId: scenario.id,
            scenarioTitle: scenario.title,
            scenario,
            status: "active",
            currentRound: 1,
            currentEvent: {
                round: 1,
                title: firstRound.title,
                description: firstRound.event,
                objective: firstRound.objective
            },
            decisions: [],
            developments: [],
            state: {
                knownSituation: scenario.initialCrisis?.knownFacts || [],
                inventoryStatus: "Not yet confirmed",
                supplierCapacity: "Not yet confirmed",
                continuityPlan: "No plan recorded yet",
                complianceStatus: "No concern confirmed at session start"
            },
            facts: scenario.initialCrisis?.knownFacts || [],
            assumptions: [],
            simulatedEvents: [],
            messages: [],
            debrief: null,
            usage: {
                requests: 0,
                inputTokens: 0,
                outputTokens: 0,
                costUSD: 0,
                byType: {}
            },
            startedAt: now,
            updatedAt: now,
            completedAt: null
        };

        const db = await connectDB();
        await db.collection("sessions").insertOne(session);

        return res.status(201).json(publicSession(session));
    } catch (error) {
        console.error("Failed to create simulation session:", error);
        return res.status(500).json({ error: "Failed to create simulation session." });
    }
});

// -----------------------------------------------------------------------------
// Save one participant decision for the current round. No Claude call is made
// here; the four saved decisions are reviewed together at the end.
// POST /api/sessions/:sessionId/messages { message: "..." }
// -----------------------------------------------------------------------------

router.post("/:sessionId/messages", async (req, res) => {
    try {
        const session = await loadSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: "Session not found." });

        if (session.status !== "active") {
            return res.status(400).json({
                error: "This simulation is no longer accepting decisions.",
                status: session.status
            });
        }

        const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
        if (!message) return res.status(400).json({ error: "A decision is required." });
        if (message.length > 6000) {
            return res.status(400).json({ error: "Please keep each decision under 6,000 characters." });
        }

        const round = session.currentRound;
        const roundConfig = session.scenario.rounds.find(item => item.number === round);
        if (!roundConfig) return res.status(500).json({ error: "Current round configuration is missing." });

        // Prevent accidental duplicate submissions for a round.
        if (session.decisions.some(item => Number(item.round) === Number(round))) {
            return res.status(409).json({ error: "A decision has already been saved for this round." });
        }

        const timestamp = new Date().toISOString();
        session.decisions.push({
            round,
            roundTitle: roundConfig.title,
            message,
            timestamp
        });
        session.messages.push({ sender: "user", message, round, timestamp });

        if (round >= TOTAL_ROUNDS) {
            session.status = "ready_for_review";
            session.currentEvent = null;
            session.currentRound = TOTAL_ROUNDS;
        } else {
            const nextRound = round + 1;
            const nextConfig = session.scenario.rounds.find(item => item.number === nextRound);
            session.currentRound = nextRound;
            session.currentEvent = {
                round: nextRound,
                title: nextConfig.title,
                description: nextConfig.event,
                objective: nextConfig.objective
            };
        }

        await saveSession(session);

        return res.json({
            ...publicSession(session),
            savedDecision: { round, roundTitle: roundConfig.title, message, timestamp },
            message: "Decision saved. No AI processing was performed for this round."
        });
    } catch (error) {
        console.error("Failed to save simulation decision:", error);
        return res.status(500).json({ error: "The decision could not be saved. Please try again." });
    }
});

// -----------------------------------------------------------------------------
// Generate the after-action review
// POST /api/sessions/:sessionId/debrief
// -----------------------------------------------------------------------------

router.post("/:sessionId/debrief", async (req, res) => {
    try {
        const session = await loadSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: "Session not found." });

        const decisions = Array.isArray(session.decisions) ? session.decisions : [];
        const completedRounds = new Set(decisions.map(item => Number(item.round)));
        if (TOTAL_ROUNDS !== completedRounds.size ||
            ![1, 2, 3, 4].every(round => completedRounds.has(round))) {
            return res.status(400).json({
                error: "Please save a decision for each of the four rounds before generating the after-action review.",
                completedRounds: [...completedRounds].sort((a, b) => a - b)
            });
        }
        if (session.debrief) return res.json({ sessionId: session.id, debrief: session.debrief });

        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 2400,
            output_config: {
                format: {
                    type: "json_schema",
                    schema: {
                        type: "object",
                        properties: {
                            overallSummary: { type: "string" },
                            overallRating: { type: "string", enum: ["Strong", "Effective", "Developing", "Needs improvement"] },
                            strengths: { type: "array", items: { type: "string" } },
                            improvements: { type: "array", items: { type: "string" } },
                            roundReviews: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        round: { type: "integer", enum: [1, 2, 3, 4] },
                                        decisionSummary: { type: "string" },
                                        whatWorked: { type: "array", items: { type: "string" } },
                                        whatToConsider: { type: "array", items: { type: "string" } }
                                    },
                                    required: ["round", "decisionSummary", "whatWorked", "whatToConsider"],
                                    additionalProperties: false
                                }
                            },
                            evidenceAndAssumptions: {
                                type: "object",
                                properties: {
                                    factsUsedWell: { type: "array", items: { type: "string" } },
                                    assumptionsToTest: { type: "array", items: { type: "string" } },
                                    informationToSeek: { type: "array", items: { type: "string" } }
                                },
                                required: ["factsUsedWell", "assumptionsToTest", "informationToSeek"],
                                additionalProperties: false
                            },
                            stakeholderManagement: { type: "array", items: { type: "string" } },
                            resilienceRecommendations: { type: "array", items: { type: "string" } },
                            caveat: { type: "string" }
                        },
                        required: ["overallSummary", "overallRating", "strengths", "improvements", "roundReviews", "evidenceAndAssumptions", "stakeholderManagement", "resilienceRecommendations", "caveat"],
                        additionalProperties: false
                    }
                }
            },
            system: `
You are an experienced supply-chain resilience facilitator reviewing a fictional training simulation.
Assess the quality of the participant's reasoning and process, not whether they guessed a single correct answer.
Be balanced, specific, constructive and use British English. Do not invent actions the participant did not take.

ROUND REVIEW PRESENTATION — IMPORTANT:
- For each round's "whatWorked" field, include only actions or reasoning the participant actually demonstrated that were constructive or useful.
- If the participant did nothing useful in a round, or there is no genuine positive point to report, set "whatWorked" to ["Nothing to report."] rather than an empty array, a dash, or a vague compliment.
- Never use "-", "—", "None", or an empty string as a placeholder in "whatWorked".
- Do not invent strengths just to populate this section.

SCENARIO ACCURACY — IMPORTANT:
- Treat the supplied original scenario and briefing details as authoritative.
- Do not invent company, supplier, customer, product, order, contract, deadline or quantity details.
- Do not invent consequences or events: this simulation records decisions only and does not generate live AI developments during the rounds.
- Base each round review on the participant's actual saved decision and the round objective/event supplied in the scenario.
- Clearly distinguish original scenario facts from participant assumptions and information gaps.
- If a detail cannot be verified from the supplied scenario, identify it as something to check rather than an established fact.
- Review all four rounds together and explain how the participant's approach develops across them.
Return valid JSON only with this shape:
{
  "overallSummary": "short balanced summary",
  "overallRating": "Strong | Effective | Developing | Needs improvement",
  "strengths": ["specific strength"],
  "improvements": ["specific improvement"],
  "roundReviews": [
    {
      "round": 1,
      "decisionSummary": "brief summary",
      "whatWorked": ["specific point"],
      "whatToConsider": ["specific point"]
    }
  ],
  "evidenceAndAssumptions": {
    "factsUsedWell": ["specific point"],
    "assumptionsToTest": ["specific point"],
    "informationToSeek": ["specific point"]
  },
  "stakeholderManagement": ["specific point"],
  "resilienceRecommendations": ["practical recommendation"],
  "caveat": "This is feedback on a fictional training exercise, not operational, legal or compliance advice."
}
`,
            messages: [{
                role: "user",
                content: JSON.stringify({
                    scenario: {
                        title: session.scenario.title,
                        objective: session.scenario.objective,
                        context: session.scenario.context,
                        supplyChain: session.scenario.supplyChain,
                        initialCrisis: session.scenario.initialCrisis,
                        rounds: session.scenario.rounds
                    },
                    decisions: decisions.sort((a, b) => Number(a.round) - Number(b.round)),
                    reviewGuidance: "Review the four saved participant decisions as one complete exercise. No AI-generated round developments exist; do not imply that consequences were simulated or observed.",
                    initialState: session.state,
                    facts: session.facts,
                    assumptions: session.assumptions,
                    simulatedEvents: session.simulatedEvents
                })
            }]
        });

        await recordUsage(response, "debrief", session);
        const reviewText = getText(response);
        if (response.stop_reason === "max_tokens") {
            throw new Error("Claude's review output was truncated at the token limit; increase max_tokens or shorten the requested review.");
        }
        session.debrief = parseClaudeJson(reviewText);

        // Ensure an empty or placeholder What Worked section is displayed clearly.
        if (Array.isArray(session.debrief.roundReviews)) {
            session.debrief.roundReviews.forEach(roundReview => {
                const points = Array.isArray(roundReview.whatWorked)
                    ? roundReview.whatWorked
                        .map(point => String(point ?? "").trim())
                        .filter(point => point && !["-", "—", "–", "none", "n/a"].includes(point.toLowerCase()))
                    : [];

                roundReview.whatWorked = points.length ? points : ["Nothing to report."];
            });
        }

        session.status = "completed";
        session.completedAt = new Date().toISOString();

        await saveSession(session);

        return res.json({ sessionId: session.id, debrief: session.debrief });
    } catch (error) {
        console.error("Failed to generate after-action review:", error);
        return res.status(500).json({ error: "Failed to generate the after-action review." });
    }
});

// -----------------------------------------------------------------------------
// Usage and cost report (protected when ADMIN_USAGE_KEY is configured)
// GET /api/sessions/usage
// -----------------------------------------------------------------------------

router.get("/usage", async (req, res) => {
    const adminKey = process.env.ADMIN_USAGE_KEY;
    if (adminKey && req.headers["x-admin-key"] !== adminKey) {
        return res.status(401).json({ error: "Unauthorised" });
    }

    try {
        const db = await connectDB();
        const records = await db.collection("api_usage").find({}).toArray();
        const totals = {
            totalRequests: records.length,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCostUSD: 0,
            byType: {},
            bySession: {}
        };

        for (const record of records) {
            const type = record.type || "unknown";
            totals.totalInputTokens += record.inputTokens || 0;
            totals.totalOutputTokens += record.outputTokens || 0;
            totals.totalCostUSD += record.costUSD || 0;

            if (!totals.byType[type]) {
                totals.byType[type] = {
                    requests: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    costUSD: 0
                };
            }
            const typeTotal = totals.byType[type];
            typeTotal.requests += 1;
            typeTotal.inputTokens += record.inputTokens || 0;
            typeTotal.outputTokens += record.outputTokens || 0;
            typeTotal.costUSD += record.costUSD || 0;

            if (record.sessionId) {
                if (!totals.bySession[record.sessionId]) {
                    totals.bySession[record.sessionId] = {
                        requests: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        costUSD: 0
                    };
                }
                const sessionTotal = totals.bySession[record.sessionId];
                sessionTotal.requests += 1;
                sessionTotal.inputTokens += record.inputTokens || 0;
                sessionTotal.outputTokens += record.outputTokens || 0;
                sessionTotal.costUSD += record.costUSD || 0;
            }
        }

        totals.totalCostUSD = Number(totals.totalCostUSD.toFixed(8));
        for (const item of Object.values(totals.byType)) {
            item.costUSD = Number(item.costUSD.toFixed(8));
        }
        for (const item of Object.values(totals.bySession)) {
            item.costUSD = Number(item.costUSD.toFixed(8));
        }

        return res.json(totals);
    } catch (error) {
        console.error("Failed to calculate usage:", error);
        return res.status(500).json({ error: "Failed to calculate usage." });
    }
});


// Retrieve a session (including after a server restart)
// GET /api/sessions/:sessionId
// -----------------------------------------------------------------------------

router.get("/:sessionId", async (req, res) => {
    try {
        const session = await loadSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: "Session not found." });
        return res.json(publicSession(session));
    } catch (error) {
        console.error("Failed to retrieve session:", error);
        return res.status(500).json({ error: "Failed to retrieve session." });
    }
});

// -----------------------------------------------------------------------------
module.exports = router;
