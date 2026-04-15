/* services/customerService.js */

const Customer = require('../models/Customer');
const Order = require('../models/Order');
const AppError = require('../utils/AppError'); 
const appEvents = require('../utils/eventEmitter'); 
const cacheUtils = require('../utils/cacheUtils'); 

const formatCustomerForExport = (c) => ({
    Name: c.name,
    Phone: c.phone,
    LoyaltyPoints: c.loyaltyPoints || 0,
    CreditEnabled: c.isCreditEnabled ? 'Yes' : 'No',
    CreditLimit: c.creditLimit || 0,
    CreditUsed: c.creditUsed || 0,
    JoinedDate: new Date(c.createdAt).toLocaleDateString()
});

function validateAndApplyPayLater(custProfile, amount) {
    if (!custProfile || !custProfile.isCreditEnabled) {
        throw new AppError('Pay Later is not enabled for this account.', 400);
    }
    if ((custProfile.creditUsed + amount) > custProfile.creditLimit) {
        throw new AppError(`Credit limit exceeded. Available credit: Rs ${custProfile.creditLimit - custProfile.creditUsed}`, 400);
    }
    custProfile.creditUsed += amount;
}

exports.getAggregatedCustomers = async () => {
    // OPTIMIZATION: Cache the heavy CRM aggregation for 1 hour to save DB CPU
    const CACHE_KEY = 'crm:aggregated_customers';
    const cachedData = await cacheUtils.getCachedData(CACHE_KEY);
    if (cachedData) return cachedData;

    const data = await Order.aggregate([
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

    await cacheUtils.setCachedData(CACHE_KEY, data, 3600); 
    return data;
};

exports.getAllCustomers = async () => {
    return await Customer.find({})
        .select('name phone loyaltyPoints isCreditEnabled creditLimit creditUsed createdAt')
        .lean();
};

exports.getCustomersForExport = async () => {
    const exportData = [];
    
    // OPTIMIZATION: Memory safe cursor iteration prevents OOM crashes on large exports
    const cursor = Customer.find()
        .select('name phone loyaltyPoints isCreditEnabled creditLimit creditUsed createdAt')
        .cursor();

    for (let c = await cursor.next(); c != null; c = await cursor.next()) {
        exportData.push(formatCustomerForExport(c));
    }
    
    return exportData;
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

    appEvents.emit('CUSTOMER_UPDATED', { phone: cust.phone });

    return cust;
};

exports.recordPayment = async (phone, amount) => {
    let cust = await Customer.findOne({ phone });
    if (!cust) throw new AppError('Customer not found.', 404); 
    
    cust.creditUsed = Math.max(0, cust.creditUsed - Number(amount));
    await cust.save();

    appEvents.emit('CUSTOMER_PAYMENT_RECORDED', { phone: cust.phone });

    return cust;
};

exports.refundPayLaterCredit = async (customerPhone, amount, session) => {
    // OPTIMIZATION: Replaced memory-heavy document fetch & save with an atomic database pipeline update.
    // This guarantees thread safety under high concurrency and reduces Node.js memory overhead.
    await Customer.updateOne(
        { phone: customerPhone },
        [ { $set: { creditUsed: { $max: [0, { $subtract: ["$creditUsed", amount] }] } } } ],
        { session }
    );
};

// DOMAIN BOUNDARY OPTIMIZATION: Migrated from checkoutService
exports.processOnlineCheckoutProfile = async (customerPhone, customerName, totalAmount, paymentMethod, session) => {
    let custProfile = await Customer.findOneAndUpdate(
        { phone: customerPhone },
        { 
            $setOnInsert: { phone: customerPhone, loyaltyPoints: 0 },
            $set: { name: customerName } 
        },
        { new: true, upsert: true, session }
    ).select('name phone loyaltyPoints creditUsed creditLimit isCreditEnabled');

    if (paymentMethod === 'Pay Later') validateAndApplyPayLater(custProfile, totalAmount);
    await custProfile.save({ session }); 

    appEvents.emit('CUSTOMER_UPDATED', { phone: custProfile.phone });
    return custProfile;
};

// DOMAIN BOUNDARY OPTIMIZATION: Migrated from checkoutService
exports.processPosCheckoutProfile = async (customerPhone, totalAmount, paymentMethod, pointsRedeemed, session) => {
    let custProfile = await Customer.findOneAndUpdate(
        { phone: customerPhone },
        { $setOnInsert: { phone: customerPhone, name: 'In-Store Customer', loyaltyPoints: 0 } },
        { new: true, upsert: true, session }
    ).select('name phone loyaltyPoints creditUsed creditLimit isCreditEnabled');
        
    let finalCustomerName = custProfile.name;
    
    if (pointsRedeemed && pointsRedeemed > 0) {
        custProfile.loyaltyPoints = Math.max(0, (custProfile.loyaltyPoints || 0) - pointsRedeemed);
    }
    custProfile.loyaltyPoints = (custProfile.loyaltyPoints || 0) + Math.floor(totalAmount / 100);
    
    if (paymentMethod === 'Pay Later') validateAndApplyPayLater(custProfile, totalAmount);
    await custProfile.save({ session });
    
    appEvents.emit('CUSTOMER_UPDATED', { phone: custProfile.phone });
    return finalCustomerName;
};
