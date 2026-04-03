/* controllers/analyticsController.js */

const analyticsService = require('../services/analyticsService');
const catchAsync = require('../utils/catchAsync');
const cacheUtils = require('../utils/cacheUtils');

exports.getPnl = catchAsync(async (request, reply) => {
    const cacheKey = cacheUtils.generateKey('analytics:pnl', request.query);
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const data = await analyticsService.getPnl(request.query.startDate, request.query.endDate);
    const responseData = { success: true, data };
    
    await cacheUtils.setCachedData(cacheKey, responseData, 900);
    return responseData;
}, 'calculating P&L');

exports.getForecast = catchAsync(async (request, reply) => {
    const cacheKey = 'analytics:forecast:latest';
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const data = await analyticsService.generateForecast(process.env.GEMINI_API_KEY);
    const responseData = { success: true, data };
    
    await cacheUtils.setCachedData(cacheKey, responseData, 1800);
    return responseData;
}, 'AI Engine generating forecast');

exports.getLeaderboard = catchAsync(async (request, reply) => {
    const cacheKey = 'analytics:leaderboard';
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const data = await analyticsService.getLeaderboard();
    const responseData = { success: true, data };
    
    await cacheUtils.setCachedData(cacheKey, responseData, 300);
    return responseData;
}, 'fetching leaderboard');
