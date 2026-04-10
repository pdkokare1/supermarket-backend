/* services/customerService.js */

const Customer = require('../models/Customer');
const Order = require('../models/Order');
const AppError = require('../utils/AppError'); 
const appEvents = require('../utils/eventEmitter'); // Added for event-driven updates

// --- MOVED FROM CONTROLLER ---
const formatCustomerForExport = (c) => ({
    Name: c.name,
    Phone: c.phone,
    LoyaltyPoints: c.loyaltyPoints || 0,
    CreditEnabled: c.isCreditEnabled ? 'Yes' : 'No',
    CreditLimit: c.creditLimit || 0,
    CreditUsed: c.creditUsed || 0,
    JoinedDate: new Date(c.createdAt).toLocaleDateString()
});

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
    return await Customer.find({})
        .select('name phone loyaltyPoints isCreditEnabled creditLimit creditUsed createdAt')
        .lean();
};

exports.getCustomersForExport = async () => {
    const customers = await Customer.find({})
        .select('name phone loyaltyPoints isCreditEnabled creditLimit creditUsed createdAt')
        .lean();
    return customers.map(formatCustomerForExport);
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

    // EVENT: Notify system of profile change
    appEvents.emit('CUSTOMER_UPDATED', { phone: cust.phone });

    return cust;
};

exports.recordPayment = async (phone, amount) => {
    let cust = await Customer.findOne({ phone });
    if (!cust) throw new AppError('Customer not found.', 404); 
    
    cust.creditUsed = Math.max(0, cust.creditUsed - Number(amount));
    await cust.save();

    // EVENT: Notify system of payment
    appEvents.emit('CUSTOMER_PAYMENT_RECORDED', { phone: cust.phone });

    return cust;
};
