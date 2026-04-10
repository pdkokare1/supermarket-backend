/* services/jobsService.js */
'use strict';

const Order = require('../models/Order');

/**
 * Deletes cancelled orders older than the specified number of days.
 */
exports.deleteOldCancelledOrders = async (days) => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - days);
    return await Order.deleteMany({ status: 'Cancelled', createdAt: { $lt: targetDate } });
};

/**
 * Scans for 'Routine' delivery type orders and generates active 'Instant' orders for the day.
 */
exports.generateRoutineDeliveries = async () => {
    const routineOrders = await Order.find({ deliveryType: 'Routine', status: { $ne: 'Cancelled' } }).lean();
    if (routineOrders.length > 0) {
        const bulkOps = routineOrders.map(ro => ({
            insertOne: {
                document: {
                    customerName: ro.customerName, 
                    customerPhone: ro.customerPhone,
                    deliveryAddress: ro.deliveryAddress, 
                    items: ro.items,
                    totalAmount: ro.totalAmount, 
                    paymentMethod: ro.paymentMethod,
                    deliveryType: 'Instant', 
                    scheduleTime: 'Generated via Routine', 
                    status: 'Order Placed'
                }
            }
        }));
        await Order.bulkWrite(bulkOps);
    }
    return routineOrders.length;
};
