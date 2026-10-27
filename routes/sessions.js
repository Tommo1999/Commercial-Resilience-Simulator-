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
        // Try extracting JSON if Claude wrapped it in commentary or code fences.
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

    const inputCostUSD =
        (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION;

    const outputCostUSD =
        (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION;

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
        // A usage-record failure should not discard the simulation response.
        console.error("Failed to save API usage:", error.message);
    }

    console.log(
        `[USAGE] ${type} | Input: ${inputTokens} | Output: ${outputTokens} | Cost: $${costUSD.toFixed(6)}`
    );
}

async function loadSession(sessionId) {
    // MongoDB is the source of truth, including after a server restart.
    const db = await connectDB();

    return db.collection("sessions").findOne({
        id: String(sessionId)
    });
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
// POST /api/sessions
// Body: { scenarioId: 1 } or { scenario: { id: 1 } }
// -----------------------------------------------------------------------------

router.post("/", async (req, res) => {
    try {
        const requestedId =
            req.body.scenarioId ?? req.body.scenario?.id ?? 1;

        const scenario = getScenarioById(requestedId);

        if (!scenario) {
            return res.status(400).json({
                error: "Unknown scenario. Choose a scenario from data/scenarios.js."
            });
        }

        const firstRound = scenario.rounds?.[0];

        if (!firstRound) {
            return res.status(500).json({
                error: "Scenario has no round configuration."
            });
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

        return res.status(500).json({
            error: "Failed to create simulation session."
        });
    }
});

// -----------------------------------------------------------------------------
// Submit a decision for the current round and generate a development
// POST /api/sessions/:sessionId/messages
// Body: { message: "..." }
// -----------------------------------------------------------------------------

router.post("/:sessionId/messages", async (req, res) => {
    try {
        const session = await loadSession(req.params.sessionId);

        if (!session) {
            return res.status(404).json({ error: "Session not found." });
        }

        if (session.status !== "active") {
            return res.status(400).json({
                error: "This simulation is no longer accepting decisions.",
                status: session.status
            });
        }

        const message =
            typeof req.body.message === "string"
                ? req.body.message.trim()
                : "";

        if (!message) {
            return res.status(400).json({
                error: "A decision is required."
            });
        }

        if (message.length > 6000) {
            return res.status(400).json({
                error: "Please keep each decision under 6,000 characters."
            });
        }

        const round = session.currentRound;

        const roundConfig = session.scenario.rounds.find(
            item => item.number === round
        );

        if (!roundConfig) {
            return res.status(500).json({
                error: "Current round configuration is missing."
            });
        }

        const decision = {
            round,
            roundTitle: roundConfig.title,
            message,
            timestamp: new Date().toISOString()
        };

        session.decisions.push(decision);

        session.messages.push({
            sender: "user",
            message,
            round,
            timestamp: decision.timestamp
        });

        const systemPrompt = `
You are the scenario engine for a fictional procurement and supply-chain resilience training simulation.
You are NOT a supplier negotiator and must not turn this into a commercial negotiation.

SCENARIO:
${JSON.stringify({
    title: session.scenario.title,
    context: session.scenario.context,
    supplyChain: session.scenario.supplyChain,
    initialCrisis: session.scenario.initialCrisis,
    rounds: session.scenario.rounds
}, null, 2)}

CURRENT ROUND: ${round} of ${TOTAL_ROUNDS}
ROUND OBJECTIVE: ${roundConfig.objective}
CURRENT EVENT: ${JSON.stringify(session.currentEvent)}
CURRENT SIMULATION STATE: ${JSON.stringify(session.state)}
KNOWN FACTS SO FAR: ${JSON.stringify(session.facts)}
PARTICIPANT ASSUMPTIONS SO FAR: ${JSON.stringify(session.assumptions)}
PREVIOUS DECISIONS: ${JSON.stringify(session.decisions.slice(0, -1))}
NEW DECISION: ${message}

Rules:
- Generate a plausible consequence/development that responds to the participant's decision and the scenario state.
- Keep the underlying scenario facts consistent across rounds. Do not invent real-world research, real companies, real statistics, or external events.
- Use fictional, illustrative details only. If you introduce a new detail, label it as a simulated event or assumption, not a verified fact.
- Distinguish facts, assumptions and simulated events explicitly.
- Do not decide on behalf of the participant. Present consequences, trade-offs and the next decision challenge.
- Decisions should have consequences: strong evidence gathering can reduce uncertainty; premature commitments can create cost, capacity or compliance exposure; reasonable alternatives can still have drawbacks.
- Avoid punishing a reasonable decision just because it differs from one preferred answer.
- Do not guarantee supplier capacity, recovery dates or legal conclusions unless the scenario has established them.
- Round 3 allegations are initially unverified. Never state allegations are proven without simulated evidence explicitly establishing that.
- Do not introduce a new crisis unrelated to the scenario.
- Be concise but useful. Use British English.
- Return valid JSON only, with this exact shape:
{
  "development": "2-4 sentence description of what happens because of the decision",
  "consequences": ["consequence 1", "consequence 2"],
  "newFacts": ["facts confirmed within this fictional simulation, if any"],
  "assumptions": ["assumptions the participant made or that remain untested"],
  "simulatedEvents": ["clearly labelled simulated developments"],
  "stateUpdates": {
    "inventoryStatus": "current best-known status",
    "supplierCapacity": "current best-known status",
    "continuityPlan": "current best-known status",
    "complianceStatus": "current best-known status"
  },
  "nextChallenge": "the next round's challenge, or the final leadership decision if this was round 4"
}
`;

const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 3000,
            system: systemPrompt,
            messages: [
                {
                    role: "user",
                    content: "Process the decision and return the JSON development."
                }
            ]
        });

      await recordUsage(response, "simulation", session);

const rawText = getText(response);

console.log("[DEBUG] Claude response stop reason:", response.stop_reason);
console.log("[DEBUG] Claude response text:");
console.log(rawText.slice(0, 6000));

const generated = parseClaudeJson(rawText);

        const development = {
            round,
            title: roundConfig.title,
            participantDecision: message,

            development: String(
                generated.development || "The decision has been recorded."
            ),

            consequences: Array.isArray(generated.consequences)
                ? generated.consequences
                : [],

            newFacts: Array.isArray(generated.newFacts)
                ? generated.newFacts
                : [],

            assumptions: Array.isArray(generated.assumptions)
                ? generated.assumptions
                : [],

            simulatedEvents: Array.isArray(generated.simulatedEvents)
                ? generated.simulatedEvents
                : [],

            timestamp: new Date().toISOString()
        };

        session.developments.push(development);

        session.messages.push({
            sender: "simulation",
            message: development.development,
            round,
            timestamp: development.timestamp
        });

        session.facts = [
            ...new Set([
                ...(session.facts || []),
                ...development.newFacts
            ])
        ];

        session.assumptions = [
            ...new Set([
                ...(session.assumptions || []),
                ...development.assumptions
            ])
        ];

        session.simulatedEvents = [
            ...(session.simulatedEvents || []),

            ...development.simulatedEvents.map(event => ({
                round,
                description: event,
                label: "Simulated event"
            }))
        ];

        const updates = generated.stateUpdates || {};

        session.state = {
            ...(session.state || {}),

            ...Object.fromEntries(
                [
                    "inventoryStatus",
                    "supplierCapacity",
                    "continuityPlan",
                    "complianceStatus"
                ]
                    .filter(key => typeof updates[key] === "string")
                    .map(key => [key, updates[key]])
            ),

            lastDevelopment: development.development,
            nextChallenge: String(generated.nextChallenge || "")
        };

        if (round >= TOTAL_ROUNDS) {
            session.status = "ready_for_review";
            session.currentEvent = null;

        } else {
            const nextRound = round + 1;

            const nextConfig = session.scenario.rounds.find(
                item => item.number === nextRound
            );

            session.currentRound = nextRound;

            session.currentEvent = {
                round: nextRound,
                title: nextConfig.title,
                description: nextConfig.event,
                objective: nextConfig.objective,
                contextualDevelopment: development.development,
                challenge: String(generated.nextChallenge || "")
            };
        }

        await saveSession(session);

        return res.json({
            ...publicSession(session),
            latestDevelopment: development
        });

    } catch (error) {
        console.error("Simulation decision failed:", error);

        return res.status(500).json({
            error: "The simulation could not process that decision. Please try again."
        });
    }
});

// -----------------------------------------------------------------------------
// Generate the after-action review
// POST /api/sessions/:sessionId/debrief
// -----------------------------------------------------------------------------

router.post("/:sessionId/debrief", async (req, res) => {
    try {
        const session = await loadSession(req.params.sessionId);

        if (!session) {
            return res.status(404).json({ error: "Session not found." });
        }

        if (!session.decisions?.length) {
            return res.status(400).json({
                error: "There are no decisions to review yet."
            });
        }

        if (session.debrief) {
            return res.json({
                sessionId: session.id,
                debrief: session.debrief
            });
        }

        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 6000,

            system: `
You are an experienced supply-chain resilience facilitator reviewing a fictional training simulation.

Assess the quality of the participant's reasoning and process, not whether they guessed a single correct answer.

Be balanced, specific, constructive and use British English.
Do not invent actions the participant did not take.
Clearly distinguish scenario facts from assumptions and simulated events.

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

Every property shown in the JSON template is required.
Keep each array concise, with no more than 3 items per array.
Keep each string concise and specific.
Return one complete JSON object only.
Do not use Markdown code fences.
Do not stop until every property is complete and all braces and brackets are closed.
`,

            messages: [
                {
                    role: "user",

                    content: JSON.stringify({
                        scenario: {
                            title: session.scenario.title,
                            objective: session.scenario.objective,
                            context: session.scenario.context,
                            supplyChain: session.scenario.supplyChain
                        },

                        decisions: session.decisions,
                        developments: session.developments,
                        currentState: session.state,
                        facts: session.facts,
                        assumptions: session.assumptions,
                        simulatedEvents: session.simulatedEvents
                    })
                }
            ]
        });

       await recordUsage(response, "debrief", session);

const rawText = getText(response);

console.log("[DEBRIEF] Stop reason:", response.stop_reason);
console.log("[DEBRIEF] Response length:", rawText.length);
console.log("[DEBRIEF] Response ending:", rawText.slice(-1500));

session.debrief = parseClaudeJson(rawText);

        session.status = "completed";
        session.completedAt = new Date().toISOString();

        await saveSession(session);

        return res.json({
            sessionId: session.id,
            debrief: session.debrief
        });

    } catch (error) {
        console.error("Failed to generate after-action review:", error);

        return res.status(500).json({
            error: "Failed to generate the after-action review."
        });
    }
});

// -----------------------------------------------------------------------------
// Usage and cost report (protected when ADMIN_USAGE_KEY is configured)
// GET /api/sessions/usage
// -----------------------------------------------------------------------------

router.get("/usage", async (req, res) => {
    const adminKey = process.env.ADMIN_USAGE_KEY;

    if (adminKey && req.headers["x-admin-key"] !== adminKey) {
        return res.status(401).json({
            error: "Unauthorised"
        });
    }

    try {
        const db = await connectDB();

        const records = await db
            .collection("api_usage")
            .find({})
            .toArray();

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

        totals.totalCostUSD = Number(
            totals.totalCostUSD.toFixed(8)
        );

        for (const item of Object.values(totals.byType)) {
            item.costUSD = Number(item.costUSD.toFixed(8));
        }

        for (const item of Object.values(totals.bySession)) {
            item.costUSD = Number(item.costUSD.toFixed(8));
        }

        return res.json(totals);

    } catch (error) {
        console.error("Failed to calculate usage:", error);

        return res.status(500).json({
            error: "Failed to calculate usage."
        });
    }
});

// -----------------------------------------------------------------------------
// Retrieve a session, including after a server restart
// GET /api/sessions/:sessionId
// -----------------------------------------------------------------------------

router.get("/:sessionId", async (req, res) => {
    try {
        const session = await loadSession(req.params.sessionId);

        if (!session) {
            return res.status(404).json({
                error: "Session not found."
            });
        }

        return res.json(publicSession(session));

    } catch (error) {
        console.error("Failed to retrieve session:", error);

        return res.status(500).json({
            error: "Failed to retrieve session."
        });
    }
});

// -----------------------------------------------------------------------------
// Export the router
// -----------------------------------------------------------------------------

module.exports = router;

    