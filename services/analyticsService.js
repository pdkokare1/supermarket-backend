/* services/analyticsService.js */

const Order = require('../models/Order');
const Expense = require('../models/Expense');
const Product = require('../models/Product');
const Shift = require('../models/Shift');
const cacheUtils = require('../utils/cacheUtils');

// --- (From Phase 1) ---
exports.getDailyFinancialTotals = async (today, tomorrow, todayStr) => {
    const orderCursor = Order.find({ createdAt: { $gte: today, $lt: tomorrow }, status: { $ne: 'Cancelled' } }).lean().cursor();
    let totalRevenue = 0, cash = 0, upi = 0, payLater = 0, totalOrderCount = 0;
    for await (const o of orderCursor) {
        totalOrderCount++; totalRevenue += o.totalAmount;
        if (o.paymentMethod === 'Cash') cash += o.totalAmount;
        else if (o.paymentMethod === 'UPI') upi += o.totalAmount;
        else if (o.paymentMethod === 'Pay Later') payLater += o.totalAmount;
        else if (o.paymentMethod === 'Split' && o.splitDetails) { cash += (o.splitDetails.cash || 0); upi += (o.splitDetails.upi || 0); }
    }
    const expenseCursor = Expense.find({ dateStr: todayStr }).lean().cursor();
    let totalExpenses = 0;
    for await (const ex of expenseCursor) totalExpenses += ex.amount;
    return { totalOrderCount, totalRevenue, cash, upi, payLater, totalExpenses, netProfit: totalRevenue - totalExpenses };
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

    const orders = await Order.find({ ...dateFilter, status: { $nin: ['Cancelled'] } }).lean();
    let totalRevenue = 0, totalCOGS = 0, totalDiscounts = 0, totalTax = 0;

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

    return {
        totalRevenue, totalCOGS, grossProfit: totalRevenue - totalCOGS - totalTax,
        totalExpenses, netProfit: (totalRevenue - totalCOGS - totalTax) - totalExpenses,
        totalDiscounts, totalTax, orderCount: orders.length
    };
};

// --- (NEW) Phase 5: AI Forecasting ---
exports.generateForecast = async (geminiKey) => {
    if (!geminiKey) throw new Error('Gemini API key not configured on server.');

    const products = await Product.find({ isActive: true, isArchived: { $ne: true } }).lean();
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
