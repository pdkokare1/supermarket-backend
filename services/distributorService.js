/* services/distributorService.js */
const Distributor = require('../models/Distributor');
const AppError = require('../utils/AppError');

exports.getAllDistributors = async () => {
    return await Distributor.find().sort({ name: 1 }).lean();
};

exports.createDistributor = async (name) => {
    try {
        const newDistributor = new Distributor({ name });
        await newDistributor.save();
        return newDistributor;
    } catch (error) {
        if (error.code === 11000) throw new AppError('Distributor already exists', 400);
        throw error;
    }
};

exports.processPayment = async (distributorId, payload) => {
    const { amount, paymentMode, referenceNote } = payload;
    const distributor = await Distributor.findById(distributorId);
    if (!distributor) throw new AppError('Distributor not found', 404);

    const actualDeduction = Math.min(distributor.totalPendingAmount, amount);
    distributor.totalPendingAmount -= actualDeduction;
    distributor.totalPaidAmount += amount;
    
    distributor.paymentHistory.push({
        amount, paymentMode: paymentMode || 'Cash', referenceNote: referenceNote || 'Manual Payment Logged'
    });

    await distributor.save();
    return distributor;
};
