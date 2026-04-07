/* services/analyticsService.js */

const Order = require('../models/Order');
const Expense = require('../models/Expense');
const Product = require('../models/Product');
const Shift = require('../models/Shift');
const cacheUtils = require('../utils/cacheUtils');

// --- (From Phase 1) ---
exports.getDailyFinancialTotals = async (today, tomorrow, todayStr) => {
    // OPTIMIZED: Replaced RAM-heavy cursors and loops with parallel MongoDB aggregation pipelines.
    // The database engine now handles the complex mathematical summing (including split logic), returning O(1) memory footprint.
    const [orderStats, expenseStats] = await Promise.all([
        Order.aggregate([
            { $match: { createdAt: { $gte: today, $lt: tomorrow }, status: { $ne: 'Cancelled' } } },
            { $group: {
                _id: null,
                totalOrderCount: { $sum: 1 },
                totalRevenue: { $sum: "$totalAmount" },
                cash: { $sum: { $cond: [{ $eq: ["$paymentMethod", "Cash"] }, "$totalAmount", { $cond: [{ $eq: ["$paymentMethod", "Split"] }, { $ifNull: ["$splitDetails.cash", 0] }, 0] }] } },
                upi: { $sum: { $cond: [{ $eq: ["$paymentMethod", "UPI"] }, "$totalAmount", { $cond: [{ $eq: ["$paymentMethod", "Split"] }, { $ifNull: ["$splitDetails.upi", 0] }, 0] }] } },
                payLater: { $sum: { $cond: [{ $eq: ["$paymentMethod", "Pay Later"] }, "$totalAmount", 0] } }
            }}
        ]),
        Expense.aggregate([
            { $match: { dateStr: todayStr } },
            { $group: { _id: null, totalExpenses: { $sum: "$amount" } } }
        ])
    ]);

    const oStats = orderStats[0] || { totalOrderCount: 0, totalRevenue: 0, cash: 0, upi: 0, payLater: 0 };
    const eStats = expenseStats[0] || { totalExpenses: 0 };

    return { 
        totalOrderCount: oStats.totalOrderCount, 
        totalRevenue: oStats.totalRevenue, 
        cash: oStats.cash, 
        upi: oStats.upi, 
        payLater: oStats.payLater, 
        totalExpenses: eStats.totalExpenses, 
        netProfit: oStats.totalRevenue - eStats.totalExpenses 
    };
};

exports.getAnalyticsData = async () => {
    // ... (Phase 1 logic remains here in your actual file)
};

// --- (NEW) Phase 5: P&L ---
exports.getPnl = async (startDate, endDate) => {
    let dateFilter = {};
    if (startDate && endDate) {
        dateFilter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    // OPTIMIZED: Added strict .select() to prevent OOM errors when processing long date ranges.
    const orders = await Order.find({ ...dateFilter, status: { $nin: ['Cancelled'] } })
        .select('totalAmount discountAmount taxAmount items')
        .lean();
        
    let totalRevenue = 0, totalCOGS = 0, totalDiscounts = 0, totalTax = 0;

    // OPTIMIZED: Reduced projection to only the exact variant fields needed for COGS calculation.
    const products = await Product.find({ isActive: true })
        .select('variants.price variants.purchaseHistory')
        .lean();
        
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

    // OPTIMIZED: Only pull the amount field to minimize memory overhead.
    const expenses = await Expense.find(dateFilter)
        .select('amount')
        .lean();
        
    const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

    return {
        totalRevenue, totalCOGS, grossProfit: totalRevenue - totalCOGS - totalTax,
        totalExpenses, netProfit: (totalRevenue - totalCOGS - totalTax) - totalExpenses,
        totalDiscounts, totalTax, orderCount: orders.length
    };
};

// --- (NEW) Phase 5: AI Forecasting ---
exports.generateForecast = async (geminiKey) => {
    if (!geminiKey) throw new Error('Gemini API key not configured on server.');

    // OPTIMIZED: Added .select() to drastically reduce memory footprint before passing data to the AI.
    const products = await Product.find({ isActive: true, isArchived: { $ne: true } })
        .select('name variants.weightOrVolume variants.stock variants.price variants.lowStockThreshold')
        .lean();
        
    const inventorySnapshot = [];
    products.forEach(p => {
        if (p.variants) {
            p.variants.forEach(v => {
                if (v.stock <= (v.lowStockThreshold || 10)) {
                    inventorySnapshot.push({ name: p.name, variant: v.weightOrVolume, currentStock: v.stock, price: v.price });
                }
            });
        }
    });

    const analysisData = inventorySnapshot.sort((a, b) => a.currentStock - b.currentStock).slice(0, 60);
    if (analysisData.length === 0) {
        return { recommendations: [], message: "Inventory levels are exceptionally healthy. No AI forecast needed." };
    }

    const promptText = `
    You are an advanced AI Supply Chain Analyst for a retail supermarket.
    Analyze this list of low-stock items: ${JSON.stringify(analysisData)}
    Return ONLY a raw, valid JSON object with a single array key called "recommendations".
    Each object in the array must have: "itemName", "priority" ("CRITICAL", "HIGH", or "MODERATE"), "suggestedAction", and "reasoning".
    Do NOT include markdown formatting, backticks, or explanatory text outside the JSON.`;

    const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], generationConfig: { temperature: 0.2 } })
    });

    const aiData = await aiRes.json();
    if (!aiData.candidates || aiData.candidates.length === 0) throw new Error("Invalid response from Gemini AI");

    let textResult = aiData.candidates[0].content.parts[0].text.trim();
    if (textResult.startsWith('```json')) textResult = textResult.replace(/```json/g, '');
    if (textResult.startsWith('```')) textResult = textResult.replace(/```/g, '');
    
    return JSON.parse(textResult.trim());
};

// --- (NEW) Phase 6: Leaderboard ---
exports.getLeaderboard = async () => {
    return await Shift.aggregate([
        { $match: { status: 'Closed' } },
        { $group: { _id: "$userName", totalShifts: { $sum: 1 }, totalRevenueHandled: { $sum: "$actualCash" }, netDiscrepancy: { $sum: "$discrepancy" } } },
        { $sort: { totalRevenueHandled: -1 } }
    ]);
};
