/* routes/analyticsRoutes.js */

const Product = require('../models/Product');
const Order = require('../models/Order');
const Expense = require('../models/Expense');

async function analyticsRoutes(fastify, options) {
    
    // --- PHASE 5: Advanced Financials (Profit & Loss) ---
    fastify.get('/api/analytics/pnl', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const { startDate, endDate } = request.query;
            let dateFilter = {};
            
            if (startDate && endDate) {
                dateFilter.createdAt = {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate)
                };
            }

            // 1. Calculate Revenue & COGS
            const orders = await Order.find({ 
                ...dateFilter, 
                status: { $nin: ['Cancelled'] } 
            }).lean();

            let totalRevenue = 0;
            let totalCOGS = 0;
            let totalDiscounts = 0;
            let totalTax = 0;

            // To calculate COGS accurately, we map current average purchase prices
            const products = await Product.find({ isActive: true }).select('name variants').lean();
            const costMap = {};
            products.forEach(p => {
                p.variants.forEach(v => {
                    // Find the most recent purchase price, default to 70% of selling price if unknown
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

            // 2. Calculate Operational Expenses
            const expenses = await Expense.find(dateFilter).lean();
            const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

            // 3. Formulate P&L
            const grossProfit = totalRevenue - totalCOGS - totalTax;
            const netProfit = grossProfit - totalExpenses;

            return {
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
        } catch (error) {
            fastify.log.error('P&L Generation Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error calculating P&L' });
        }
    });

    // --- PHASE 5: AI-Driven Demand Forecasting ---
    fastify.post('/api/analytics/forecast', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            if (!process.env.GEMINI_API_KEY) {
                return reply.status(400).send({ success: false, message: 'Gemini API key not configured on server.' });
            }

            // Gather inventory data for AI analysis
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

            // Limit array size to prevent token overflow on massive databases
            const analysisData = inventorySnapshot.sort((a, b) => a.currentStock - b.currentStock).slice(0, 60);

            if (analysisData.length === 0) {
                return { success: true, data: { recommendations: [], message: "Inventory levels are exceptionally healthy. No AI forecast needed." } };
            }

            const prompt = `
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
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2 } // Low temp for structured data consistency
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
            return { success: true, data: parsedForecast };

        } catch (error) {
            fastify.log.error('AI Forecast Error:', error);
            reply.status(500).send({ success: false, message: 'AI Engine failed to generate forecast.' });
        }
    });
}

module.exports = analyticsRoutes;
