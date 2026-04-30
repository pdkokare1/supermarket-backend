/* controllers/analyticsController.js */

const analyticsService = require('../services/analyticsService');
const cacheUtils = require('../utils/cacheUtils');

// MODULARITY: Standardized helper for caching analytics responses
const respondWithCache = async (reply, cacheKey, ttl, fetchFn) => {
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const data = await fetchFn();
    const responseData = { success: true, data };
    
    await cacheUtils.setCachedData(cacheKey, responseData, ttl);
    return responseData;
};

// ENTERPRISE OPTIMIZATION: Endpoint to retrieve core platform growth metrics
exports.getPlatformGrowthMetrics = async (request, reply) => {
    const cacheKey = 'analytics:dailypick:growth_metrics';
    return await respondWithCache(reply, cacheKey, 3600, () => 
        analyticsService.getDailyPickGrowthMetrics()
    );
};

exports.getPnl = async (request, reply) => {
    // OPTIMIZATION: Relies on the underlying Materialized View inside the Service layer
    const cacheKey = cacheUtils.generateKey('analytics:pnl', request.query);
    return await respondWithCache(reply, cacheKey, 900, () => 
        analyticsService.getPnl(request.query.startDate, request.query.endDate)
    );
};

exports.getForecast = async (request, reply) => {
    const cacheKey = 'analytics:forecast:latest';
    return await respondWithCache(reply, cacheKey, 1800, () => 
        analyticsService.generateForecast(process.env.GEMINI_API_KEY)
    );
};

exports.getLeaderboard = async (request, reply) => {
    const cacheKey = 'analytics:leaderboard';
    return await respondWithCache(reply, cacheKey, 300, () => 
        analyticsService.getLeaderboard()
    );
};

exports.getOrdersAnalytics = async (request, reply) => {
    return await analyticsService.getAnalyticsData();
};

// ============================================================================
// --- NEW: PHASE 18 GSTR TAX & COMPLIANCE CSV EXPORT ---
// ============================================================================
exports.exportGSTRReport = async (request, reply) => {
    const Order = require('../models/Order');
    const { sendCsvResponse } = require('../utils/csvUtils');
    
    const orders = await Order.find({ status: { $in: ['Delivered', 'Completed'] } }).lean();
    
    const csvData = orders.map(o => {
        const total = o.totalAmount || 0;
        // Uses the exact tax breakdown we generated in Phase 7 during checkout
        const tax = o.taxBreakdown ? o.taxBreakdown.totalTaxRs : (total * 0.05); 
        const cgst = o.taxBreakdown ? o.taxBreakdown.cgstRs : (tax / 2);
        const sgst = o.taxBreakdown ? o.taxBreakdown.sgstRs : (tax / 2);
        const taxableValue = total - tax;

        return {
            'Invoice No': o.orderNumber || o._id.toString(),
            'Date': new Date(o.createdAt).toLocaleDateString('en-IN'),
            'Customer State': 'Maharashtra', // DailyPick Local Jurisdiction
            'Taxable Value (Rs)': taxableValue.toFixed(2),
            'CGST (Rs)': cgst.toFixed(2),
            'SGST (Rs)': sgst.toFixed(2),
            'Total Invoice Value (Rs)': total.toFixed(2),
            'Invoice Type': o.b2bTaxInvoice ? 'B2B' : 'B2C'
        };
    });

    return sendCsvResponse(reply, csvData, `DailyPick_GSTR_Report_${Date.now()}.csv`);
};
