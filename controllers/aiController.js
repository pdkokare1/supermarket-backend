/* controllers/aiController.js */
'use strict';

const axios = require('axios');
const Product = require('../models/Product');
const AppError = require('../utils/AppError');

exports.generateInventoryForecast = async (request, reply) => {
    // 1. Fetch live active inventory
    const products = await Product.find({ isActive: true }).lean();
    
    if (!products || products.length === 0) {
        throw new AppError('No active inventory found to analyze.', 404);
    }

    // 2. Compress the data payload to save API tokens and speed up the response
    const compressedData = products.map(p => {
        const variants = p.variants.map(v => ({
            sku: v.sku,
            size: v.weightOrVolume,
            stock: v.stock,
            threshold: v.lowStockThreshold || 5,
            price: v.price
        }));
        return { name: p.name, category: p.category, variants };
    });

    const apiKey = process.env.GEMINI_API_KEY;
    
    // 3. Failsafe: If no API key is configured yet, return a safe fallback to prevent crashes
    if (!apiKey) {
        request.server.log.warn('Gemini API Key missing. Returning fallback AI forecast.');
        return {
            success: true,
            message: 'Fallback generated (Missing API Key)',
            data: [
                {
                    itemName: "API Key Required",
                    action: "Configure GEMINI_API_KEY in Railway",
                    reason: "The backend needs a valid Google AI key to process live store data.",
                    urgency: "High"
                }
            ]
        };
    }

    // 4. Construct the prompt for Gemini 2.5 Flash
    const promptText = `
    You are an expert retail supply chain AI. Analyze the following live grocery inventory data. 
    Identify the top 3-5 items that urgently need restocking based on low stock relative to their threshold.
    
    Return ONLY a raw JSON array of objects. Do not use markdown formatting like \`\`\`json.
    Each object must strictly have these exact keys:
    - "itemName": (String) Name of the product and variant.
    - "action": (String) Recommended action (e.g., "Order 50 units").
    - "reason": (String) Brief, analytical reason why (e.g., "Stock is at 2, below threshold of 5").
    - "urgency": (String) "High", "Medium", or "Low".

    Inventory Data:
    ${JSON.stringify(compressedData)}
    `;

    try {
        // 5. Execute the REST call via Axios
        const aiResponse = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            {
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: {
                    temperature: 0.2, // Low temperature for highly analytical, deterministic output
                    responseMimeType: "application/json"
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const rawJsonText = aiResponse.data.candidates[0].content.parts[0].text;
        const parsedInsights = JSON.parse(rawJsonText);

        return {
            success: true,
            message: 'AI Forecast generated successfully.',
            data: parsedInsights
        };

    } catch (error) {
        request.server.log.error(`Gemini API Error: ${error.message}`);
        throw new AppError('Failed to generate AI forecast from Google servers.', 500);
    }
};

// --- NEW: PHASE 2 SNAP & SYNC AI INGESTION ---
exports.processProductImage = async (request, reply) => {
    const { imageBase64 } = request.body;
    if (!imageBase64) throw new AppError('Image payload is required', 400);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new AppError('Gemini API Key missing in backend environment', 500);

    const promptText = `You are an expert retail catalog AI. Analyze this product image. Extract and return ONLY a raw JSON object with no markdown formatting. Do not wrap in backticks.
    Required keys:
    - "name": (String) Best and most accurate product name based on packaging
    - "brand": (String) Manufacturer or Brand name
    - "category": (String) Best matching grocery or retail category
    - "weightOrVolume": (String) Product size, e.g. "500g", "1L", "1 Piece"
    - "hsnCode": (String) Best guess 4 or 6 digit Indian HSN code for this item type for billing compliance
    - "searchTags": (String) Comma separated keywords for search indexing`;

    try {
        const aiResponse = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            {
                contents: [
                    {
                        parts: [
                            { text: promptText },
                            {
                                inlineData: {
                                    mimeType: "image/jpeg",
                                    data: imageBase64
                                }
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.1, // Strict deterministic parameters
                    responseMimeType: "application/json"
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const rawJsonText = aiResponse.data.candidates[0].content.parts[0].text;
        const parsedInsights = JSON.parse(rawJsonText);

        return {
            success: true,
            message: 'AI Product Extraction complete.',
            data: parsedInsights
        };
    } catch (error) {
        request.server.log.error(`Gemini Image API Error: ${error.message}`);
        throw new AppError('Failed to process image via Gemini AI.', 500);
    }
};
