const scenarios = [
    {
        id: 1,
        title: "Clothing Supply Chain Crisis",
        category: "Supply Chain Resilience",
        difficulty: "Medium",

        description:
            "A UK-based clothing business relies on manufacturers in Turkey, Vietnam and India. A severe storm has disrupted production at its Vietnamese supplier. The procurement team must investigate the impact, assess alternatives and recommend actions as the situation develops over four rounds.",

        objective:
            "Maintain business continuity while balancing cost, supplier capacity, delivery commitments, compliance and reputational risk. Investigate uncertain information, explain assumptions and make justified recommendations.",

        context:
            "The business sources clothing from three fictional manufacturing suppliers. Each supplier has different production capacity, lead times, qualifications and contractual arrangements. The Vietnamese supplier produces several important product lines and has experienced a severe storm-related disruption.",

        supplyChain: {
            company: "Northstar Clothing Ltd",
            industry: "Clothing retail",
            suppliers: [
                {
                    name: "Anatolia Textiles",
                    country: "Turkey",
                    role: "Alternative clothing manufacturer",
                    capacity: "Limited spare capacity",
                    leadTime: "Three to four weeks"
                },
                {
                    name: "VietWear Manufacturing",
                    country: "Vietnam",
                    role: "Primary manufacturer of key product lines",
                    capacity: "Temporarily disrupted",
                    leadTime: "Uncertain due to storm damage"
                },
                {
                    name: "Indus Garments",
                    country: "India",
                    role: "Alternative clothing manufacturer",
                    capacity: "Moderate spare capacity, subject to qualification",
                    leadTime: "Four to six weeks"
                }
            ]
        },

        initialCrisis: {
            title: "Storm Disrupts Vietnamese Production",
            description:
                "Severe weather has disrupted operations at VietWear Manufacturing. The supplier has not confirmed when full production will resume.",
            knownFacts: [
                "Production at the Vietnamese supplier has been disrupted.",
                "The business relies on the affected supplier for several important product lines.",
                "Alternative suppliers operate under different capacity and qualification constraints."
            ],
            unknowns: [
                "The full extent of the production disruption.",
                "The quantity of usable inventory remaining.",
                "The confirmed recovery date.",
                "The extent to which alternative suppliers can increase production."
            ]
        },

        rounds: [
            {
                number: 1,
                title: "Disruption",
                event:
                    "A severe storm disrupts production at the Vietnamese supplier.",
                objective:
                    "Establish the likely business impact, identify missing information, check inventory and advise Operations."
            },
            {
                number: 2,
                title: "Escalation",
                event:
                    "The business requests an immediate transfer of production, but alternative suppliers have capacity and qualification constraints.",
                objective:
                    "Evaluate available options, costs, contractual provisions and lead times."
            },
            {
                number: 3,
                title: "Complication",
                event:
                    "New, initially unverified allegations of labour-standard violations emerge concerning one potential alternative supplier.",
                objective:
                    "Distinguish verified facts from allegations, identify appropriate investigations and decide whom to involve."
            },
            {
                number: 4,
                title: "Leadership Decision",
                event:
                    "The executive team requests a clear recommendation for managing the disruption.",
                objective:
                    "Recommend a response balancing service continuity, cost, compliance and business reputation."
            }
        ],

        assessmentCriteria: [
            "Investigation and evidence gathering",
            "Distinguishing facts, assumptions and unverified information",
            "Understanding supplier dependencies and contractual obligations",
            "Evaluating alternatives and potential consequences",
            "Involving appropriate stakeholders",
            "Clear communication and justified recommendations"
        ]
    }
];

module.exports = scenarios;