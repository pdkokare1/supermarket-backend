/* controllers/settlementController.js */
'use strict';

const Settlement = require('../models/Settlement');
const AppError = require('../utils/AppError');

// ==========================================
// SUPERADMIN HQ SETTLEMENT ROUTES
// ==========================================

exports.getGlobalSettlements = async (request, reply) => {
    // Security check: Only HQ SuperAdmins can view global settlements
    if (request.user.role !== 'SuperAdmin') {
        throw new AppError('Unauthorized: HQ access required', 403);
    }

    // Fetch all pending settlements that are ready for payout
    const settlements = await Settlement.find({ status: 'Pending' })
        .populate('storeId', 'name bankDetails')
        .sort('-createdAt');

    return { success: true, data: settlements };
};

exports.getDisputes = async (request, reply) => {
    if (request.user.role !== 'SuperAdmin') {
        throw new AppError('Unauthorized: HQ access required', 403);
    }

    // Fetch all frozen settlements under active dispute
    const disputes = await Settlement.find({ status: 'Disputed' })
        .populate('storeId', 'name contactPhone')
        .sort('-createdAt');

    return { success: true, data: disputes };
};

exports.processSettlement = async (request, reply) => {
    if (request.user.role !== 'SuperAdmin') {
        throw new AppError('Unauthorized: HQ access required', 403);
    }

    const { id } = request.params;
    
    const settlement = await Settlement.findById(id);
    if (!settlement) {
        throw new AppError('Settlement record not found', 404);
    }

    // Mark as paid
    settlement.status = 'Paid';
    settlement.processedAt = new Date();
    await settlement.save();

    return { success: true, message: 'Payout marked as complete', data: settlement };
};

exports.resolveDispute = async (request, reply) => {
    if (request.user.role !== 'SuperAdmin') {
        throw new AppError('Unauthorized: HQ access required', 403);
    }

    const { id } = request.params;
    
    const settlement = await Settlement.findById(id);
    if (!settlement || settlement.status !== 'Disputed') {
        throw new AppError('Valid disputed settlement record not found', 404);
    }

    // Resolving a dispute voids the payout (since the item was returned/damaged)
    settlement.status = 'Voided';
    settlement.processedAt = new Date();
    await settlement.save();

    return { success: true, message: 'Dispute resolved and payout voided', data: settlement };
};
