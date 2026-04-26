/* controllers/settlementController.js */
'use strict';

const Settlement = require('../models/Settlement');
const AppError = require('../utils/AppError');
const Razorpay = require('razorpay');

// NEW: Initialize Razorpay securely via Railway Variables
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret',
});

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
    
    const settlement = await Settlement.findById(id).populate('storeId');
    if (!settlement) {
        throw new AppError('Settlement record not found', 404);
    }

    // NEW: Attempt automated Razorpay Payout if keys are present
    if (process.env.RAZORPAY_KEY_ID) {
        try {
            const transfer = await razorpay.transfers.create({
                account: settlement.storeId.razorpayAccountId || 'acc_dummy', 
                // Mapped to safely fallback between legacy amount or the new strict schema netPayoutToStore
                amount: (settlement.netPayoutToStore || settlement.amount || 0) * 100, // Razorpay expects paise (Rs * 100)
                currency: "INR",
                notes: { settlement_id: settlement._id.toString() }
            });

            settlement.transactionId = transfer.id;
        } catch (error) {
            request.server.log.error(`Razorpay Error: ${error.message}`);
            throw new AppError('Gateway failed, but manual payout is still available.', 500);
        }
    }

    // Mark as paid (Executes whether automated or manual)
    settlement.status = 'Paid';
    settlement.processedAt = new Date();
    await settlement.save();

    // --- NEW: WEBSOCKET PUSH NOTIFICATION TO VENDOR ---
    // Instantly alerts the specific store's dashboard that funds have cleared
    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({
            type: 'SETTLEMENT_PAID',
            storeId: settlement.storeId._id ? settlement.storeId._id.toString() : settlement.storeId.toString(),
            amount: settlement.netPayoutToStore || settlement.amount || 0
        });
    }

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
