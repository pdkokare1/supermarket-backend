/* controllers/analyticsController.js */

const analyticsService = require('../services/analyticsService');
const catchAsync = require('../utils/catchAsync');
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

exports.getPnl = catchAsync(async (request, reply) => {
    const cacheKey = cacheUtils.generateKey('analytics:pnl', request.query);
    return await respondWithCache(reply, cacheKey, 900, () => 
        analyticsService.getPnl(request.query.startDate, request.query.endDate)
    );
}, 'calculating P&L');

exports.getForecast = catchAsync(async (request, reply) => {
    const cacheKey = 'analytics:forecast:latest';
    return await respondWithCache(reply, cacheKey, 1800, () => 
        analyticsService.generateForecast(process.env.GEMINI_API_KEY)
    );
}, 'AI Engine generating forecast');

exports.getLeaderboard = catchAsync(async (request, reply) => {
    const cacheKey = 'analytics:leaderboard';
    return await respondWithCache(reply, cacheKey, 300, () => 
        analyticsService.getLeaderboard()
    );
}, 'fetching leaderboard');

exports.getOrdersAnalytics = catchAsync(async (request, reply) => {
    return await analyticsService.getAnalyticsData();
}, 'fetching order analytics');
