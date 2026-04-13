/* utils/dateUtils.js */
'use strict';

/**
 * Returns MongoDB date filter objects based on a string label.
 */
exports.getFilterDates = (dateFilter) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(today.getDate() - 7);

    if (dateFilter === 'Today') return { $gte: today };
    if (dateFilter === 'Yesterday') return { $gte: yesterday, $lt: today };
    if (dateFilter === '7Days') return { $gte: sevenDaysAgo };
    return null;
};
