/* services/customerService.js */

const Customer = require('../models/Customer');
const Order = require('../models/Order');
const AppError = require('../utils/AppError'); // NEW IMPORT

exports.getAggregatedCustomers = async () => {
    return await Order.aggregate([
        { $match: { status: { $ne: 'Cancelled' } } },
        { $sort: { createdAt: 1 } }, 
        { 
            $group: {
                _id: { $ifNull: ["$customerPhone", "Unknown"] },
                name: { $last: { $ifNull: ["$customerName", "Guest"] } },
                phone: { $last: { $ifNull: ["$customerPhone", "Unknown"] } },
                orderCount: { $sum: 1 },
                lifetimeValue: { $sum: "$totalAmount" },
                lastOrderDate: { $max: "$createdAt" }
            }
        },
        { $sort: { lifetimeValue: -1 } },
        { $project: { _id: 0 } } 
    ]);
};

exports.getAllCustomers = async () => {
    return await Customer.find({}).lean();
};

exports.getCustomerByPhone = async (phone) => {
    return await Customer.findOne({ phone }).lean();
};

exports.updateCustomerLimit = async (phone, name, isCreditEnabled, creditLimit) => {
    let cust = await Customer.findOne({ phone });
    if (!cust) {
        cust = new Customer({ phone, name: name || 'Valued Customer' });
    }
    cust.isCreditEnabled = isCreditEnabled;
    cust.creditLimit = Number(creditLimit);
    await cust.save();
    return cust;
};

exports.recordPayment = async (phone, amount) => {
    let cust = await Customer.findOne({ phone });
    if (!cust) throw new AppError('Customer not found.', 404); // UPDATED
    
    // Optimized: Replaced manual negative check with Math.max
    cust.creditUsed = Math.max(0, cust.creditUsed - Number(amount));
    
    await cust.save();
    return cust;
};
