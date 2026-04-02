/* services/analyticsService.js */

const Order = require('../models/Order');
const Expense = require('../models/Expense');
const cacheUtils = require('../utils/cacheUtils');

exports.getDailyFinancialTotals = async (today, tomorrow, todayStr) => {
    const orderCursor = Order.find({ createdAt: { $gte: today, $lt: tomorrow }, status: { $ne: 'Cancelled' } }).lean().cursor();
    let totalRevenue = 0, cash = 0, upi = 0, payLater = 0, totalOrderCount = 0;

    for await (const o of orderCursor) {
        totalOrderCount++;
        totalRevenue += o.totalAmount;
        if (o.paymentMethod === 'Cash') cash += o.totalAmount;
        else if (o.paymentMethod === 'UPI') upi += o.totalAmount;
        else if (o.paymentMethod === 'Pay Later') payLater += o.totalAmount;
        else if (o.paymentMethod === 'Split' && o.splitDetails) {
            cash += (o.splitDetails.cash || 0);
            upi += (o.splitDetails.upi || 0);
        }
    }

    const expenseCursor = Expense.find({ dateStr: todayStr }).lean().cursor();
    let totalExpenses = 0;
    for await (const ex of expenseCursor) {
        totalExpenses += ex.amount;
    }
    
    return { totalOrderCount, totalRevenue, cash, upi, payLater, totalExpenses, netProfit: totalRevenue - totalExpenses };
};

exports.getAnalyticsData = async () => {
    const cachedAnalytics = await cacheUtils.getCachedData('orders:analytics');
    if (cachedAnalytics) return cachedAnalytics; 
    
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(today.getDate() - 6); sevenDaysAgo.setHours(0, 0, 0, 0);

    const [revenueAgg, topItemsAgg] = await Promise.all([
        Order.aggregate([{ $match: { status: { $in: ['Dispatched', 'Completed'] }, createdAt: { $gte: sevenDaysAgo, $lte: today } } }, { $group: { _id: "$dateString", dailyRevenue: { $sum: "$totalAmount" } } }, { $sort: { _id: 1 } }]),
        Order.aggregate([{ $match: { status: { $in: ['Dispatched', 'Completed'] }, createdAt: { $gte: sevenDaysAgo, $lte: today } } }, { $unwind: "$items" }, { $group: { _id: { name: "$items.name", variant: "$items.selectedVariant" }, qty: { $sum: "$items.qty" }, revenue: { $sum: { $multiply: ["$items.price", "$items.qty"] } } } }, { $sort: { qty: -1 } }, { $limit: 5 }])
    ]);

    let revenueLast7Days = [0, 0, 0, 0, 0, 0, 0];
    const datesToMap = [];
    for(let i=0; i<7; i++){ const d = new Date(sevenDaysAgo); d.setDate(sevenDaysAgo.getDate() + i); datesToMap.push(d.toISOString().split('T')[0]); }
    revenueAgg.forEach(item => { const index = datesToMap.indexOf(item._id); if (index !== -1) revenueLast7Days[index] = item.dailyRevenue; });
    const topItems = topItemsAgg.map(item => ({ name: `${item._id.name} (${item._id.variant})`, qty: item.qty, revenue: item.revenue }));

    const responsePayload = { success: true, data: { chartLabels: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Yesterday', 'Today'], revenueData: revenueLast7Days, topItems: topItems } };
    await cacheUtils.setCachedData('orders:analytics', responsePayload, 900);

    return responsePayload;
};
