/* services/distributorService.js */
const Distributor = require('../models/Distributor');
const AppError = require('../utils/AppError');
const appEvents = require('../utils/eventEmitter'); // Added for event-driven updates
const cacheUtils = require('../utils/cacheUtils'); // OPTIMIZATION: Added for caching

exports.getAllDistributors = async () => {
    // OPTIMIZATION: Cache distributor list to prevent unnecessary DB reads
    const CACHE_KEY = 'distributors:all';
    let distributors = await cacheUtils.getCachedData(CACHE_KEY);
    
    if (!distributors) {
        distributors = await Distributor.find().sort({ name: 1 }).lean();
        await cacheUtils.setCachedData(CACHE_KEY, distributors, 3600); // Cache for 1 hour
    }
    return distributors;
};

exports.createDistributor = async (name) => {
    try {
        const newDistributor = new Distributor({ name });
        await newDistributor.save();

        // OPTIMIZATION: Invalidate cache when new distributor is added
        await cacheUtils.deleteKey('distributors:all');

        // EVENT: Notify system of new distributor
        appEvents.emit('DISTRIBUTOR_ADDED', { distributorId: newDistributor._id });

        return newDistributor;
    } catch (error) {
        if (error.code === 11000) throw new AppError('Distributor already exists', 400);
        throw error;
    }
};

exports.processPayment = async (distributorId, payload) => {
    const { amount, paymentMode, referenceNote } = payload;
    
    // OPTIMIZATION: Floating Point Protection. Forces exact 2-decimal rounding to prevent binary drift in financial ledgers.
    const safeAmount = Number(Number(amount).toFixed(2));
    
    const distributor = await Distributor.findById(distributorId);
    if (!distributor) throw new AppError('Distributor not found', 404);

    const actualDeduction = Number(Math.min(distributor.totalPendingAmount, safeAmount).toFixed(2));
    distributor.totalPendingAmount = Number((distributor.totalPendingAmount - actualDeduction).toFixed(2));
    distributor.totalPaidAmount = Number((distributor.totalPaidAmount + safeAmount).toFixed(2));
    
    distributor.paymentHistory.push({
        amount: safeAmount, paymentMode: paymentMode || 'Cash', referenceNote: referenceNote || 'Manual Payment Logged'
    });

    await distributor.save();

    // OPTIMIZATION: Invalidate cache because financials have updated
    await cacheUtils.deleteKey('distributors:all');

    // EVENT: Notify system of ledger update
    appEvents.emit('DISTRIBUTOR_UPDATED', { distributorId: distributor._id });

    return distributor;
};

// DOMAIN BOUNDARY OPTIMIZATION: Migrated from inventoryService to maintain strict database isolation
exports.incrementPendingAmount = async (distributorName, amount, session) => {
    // OPTIMIZATION: Floating Point Protection.
    const safeAmount = Number(Number(amount).toFixed(2));
    
    await Distributor.findOneAndUpdate(
        { name: distributorName },
        { $inc: { totalPendingAmount: safeAmount } },
        { upsert: true, session }
    );

    // OPTIMIZATION: Invalidate cache because financial ledgers have been updated via credit restock
    await cacheUtils.deleteKey('distributors:all');
};
