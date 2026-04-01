/* routes/analyticsRoutes.js */

const Product = require('../models/Product');
const Order = require('../models/Order');
const Expense = require('../models/Expense');
const Shift = require('../models/Shift'); // Phase 6 addition
const cacheUtils = require('../utils/cacheUtils'); // NEW IMPORT

async function analyticsRoutes(fastify, options) {
    
    // --- PHASE 5: Advanced Financials (Profit & Loss) ---
    fastify.get('/api/analytics/pnl', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            // OPTIMIZATION: Check Cache First
            const cacheKey = cacheUtils.generateKey('analytics:pnl', request.query);
            const cachedData = await cacheUtils.getCachedData(cacheKey);
            if (cachedData) return cachedData;

            const { startDate, endDate } = request.query;
            let dateFilter = {};
            
            if (startDate && endDate) {
                dateFilter.createdAt = {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate)
                };
            }

            const orders = await Order.find({ 
                ...dateFilter, 
                status: { $nin: ['Cancelled'] } 
            }).lean();

            let totalRevenue = 0;
            let totalCOGS = 0;
            let totalDiscounts = 0;
            let totalTax = 0;

            const products = await Product.find({ isActive: true }).select('name variants').lean();
            const costMap = {};
            products.forEach(p => {
                p.variants.forEach(v => {
                    let avgCost = v.price * 0.7; 
                    if (v.purchaseHistory && v.purchaseHistory.length > 0) {
                        const recent = v.purchaseHistory[v.purchaseHistory.length - 1];
                        if (recent.purchasingPrice > 0) avgCost = recent.purchasingPrice;
                    }
                    costMap[`${p._id}_${v._id}`] = avgCost;
                });
            });

            orders.forEach(order => {
                totalRevenue += (order.totalAmount || 0);
                totalDiscounts += (order.discountAmount || 0);
                totalTax += (order.taxAmount || 0);

                order.items.forEach(item => {
                    const estimatedCost = costMap[`${item.productId}_${item.variantId}`] || (item.price * 0.7);
                    totalCOGS += (estimatedCost * item.qty);
                });
            });

            const expenses = await Expense.find(dateFilter).lean();
            const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

            const grossProfit = totalRevenue - totalCOGS - totalTax;
            const netProfit = grossProfit - totalExpenses;

            const responseData = {
                success: true,
                data: {
                    totalRevenue,
                    totalCOGS,
                    grossProfit,
                    totalExpenses,
                    netProfit,
                    totalDiscounts,
                    totalTax,
                    orderCount: orders.length
                }
            };

            // OPTIMIZATION: Save to Cache (15 minutes)
            await cacheUtils.setCachedData(cacheKey, responseData, 900);
            return responseData;

        } catch (error) {
            fastify.log.error('P&L Generation Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error calculating P&L' });
        }
    });

    // --- PHASE 5: AI-Driven Demand Forecasting ---
    fastify.post('/api/analytics/forecast', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            // OPTIMIZATION: Check Cache First (30 minutes for AI tasks)
            const cacheKey = 'analytics:forecast:latest';
            const cachedData = await cacheUtils.getCachedData(cacheKey);
            if (cachedData) return cachedData;

            if (!process.env.GEMINI_API_KEY) {
                return reply.status(400).send({ success: false, message: 'Gemini API key not configured on server.' });
            }

            const products = await Product.find({ isActive: true, isArchived: { $ne: true } }).lean();
            
            const inventorySnapshot = [];
            products.forEach(p => {
                if (p.variants) {
                    p.variants.forEach(v => {
                        if (v.stock <= (v.lowStockThreshold || 10)) {
                            inventorySnapshot.push({
                                name: p.name,
                                variant: v.weightOrVolume,
                                currentStock: v.stock,
                                price: v.price
                            });
                        }
                    });
                }
            });

            const analysisData = inventorySnapshot.sort((a, b) => a.currentStock - b.currentStock).slice(0, 60);

            if (analysisData.length === 0) {
                return { success: true, data: { recommendations: [], message: "Inventory levels are exceptionally healthy. No AI forecast needed." } };
            }

            const promptText = `
            You are an advanced AI Supply Chain Analyst for a retail supermarket.
            Analyze this list of low-stock items:
            ${JSON.stringify(analysisData)}

            Return ONLY a raw, valid JSON object with a single array key called "recommendations".
            Each object in the array must have:
            1. "itemName" (String)
            2. "priority" (String: "CRITICAL", "HIGH", or "MODERATE")
            3. "suggestedAction" (String: e.g., "Order 50 units immediately", "Monitor for weekend spike")
            4. "reasoning" (String: A brief, logical explanation based on standard retail velocity).
            
            Do NOT include markdown formatting, backticks, or explanatory text outside the JSON.`;

            const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: promptText }] }], // Fixed variable name to map correctly
                    generationConfig: { temperature: 0.2 } 
                })
            });

            const aiData = await aiRes.json();
            
            if (!aiData.candidates || aiData.candidates.length === 0) {
                throw new Error("Invalid response from Gemini AI");
            }

            let textResult = aiData.candidates[0].content.parts[0].text.trim();
            if (textResult.startsWith('```json')) textResult = textResult.replace(/```json/g, '');
            if (textResult.startsWith('```')) textResult = textResult.replace(/```/g, '');
            textResult = textResult.trim();

            const parsedForecast = JSON.parse(textResult);
            const responseData = { success: true, data: parsedForecast };
            
            // OPTIMIZATION: Save to Cache (30 minutes)
            await cacheUtils.setCachedData(cacheKey, responseData, 1800);
            return responseData;

        } catch (error) {
            fastify.log.error('AI Forecast Error:', error);
            reply.status(500).send({ success: false, message: 'AI Engine failed to generate forecast.' });
        }
    });

    // --- PHASE 6: Staff Leaderboard / Gamification ---
    fastify.get('/api/analytics/leaderboard', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            // OPTIMIZATION: Check Cache First
            const cacheKey = 'analytics:leaderboard';
            const cachedData = await cacheUtils.getCachedData(cacheKey);
            if (cachedData) return cachedData;

            // Aggregate shift history to determine best cashiers
            const leaderboard = await Shift.aggregate([
                { $match: { status: 'Closed' } },
                { 
                    $group: {
                        _id: "$userName",
                        totalShifts: { $sum: 1 },
                        totalRevenueHandled: { $sum: "$actualCash" },
                        netDiscrepancy: { $sum: "$discrepancy" } // Closer to 0 is better
                    }
                },
                { $sort: { totalRevenueHandled: -1 } } // Sort by most revenue handled
            ]);

            const responseData = { success: true, data: leaderboard };
            
            // OPTIMIZATION: Save to Cache (5 minutes)
            await cacheUtils.setCachedData(cacheKey, responseData, 300);
            return responseData;

        } catch (error) {
            fastify.log.error('Leaderboard Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching leaderboard' });
        }
    });
}

module.exports = analyticsRoutes;
