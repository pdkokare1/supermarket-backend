/* controllers/settlementController.js */
'use strict';

const Settlement = require('../models/Settlement');
const Store = require('../models/Store');
const Order = require('../models/Order');
const AppError = require('../utils/AppError');
const Razorpay = require('razorpay');
const { withTransaction } = require('../utils/dbUtils');

// NEW: Initialize Razorpay securely via Railway Variables
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret',
});

// ==========================================
// SUPERADMIN HQ SETTLEMENT ROUTES
// ==========================================

exports.getGlobalSettlements = async (request, reply) => {
    if (request.user.role !== 'SuperAdmin') {
        throw new AppError('Unauthorized: HQ access required', 403);
    }
    const settlements = await Settlement.find({ status: 'Pending' })
        .populate('storeId', 'name bankDetails')
        .sort('-createdAt');
    return { success: true, data: settlements };
};

exports.getDisputes = async (request, reply) => {
    if (request.user.role !== 'SuperAdmin') {
        throw new AppError('Unauthorized: HQ access required', 403);
    }
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
    if (!settlement) throw new AppError('Settlement record not found', 404);

    if (process.env.RAZORPAY_KEY_ID) {
        try {
            const transfer = await razorpay.transfers.create({
                account: settlement.storeId.razorpayAccountId || 'acc_dummy', 
                amount: (settlement.netPayoutToStore || settlement.amount || 0) * 100, 
                currency: "INR",
                notes: { settlement_id: settlement._id.toString() }
            });
            settlement.transactionId = transfer.id;
        } catch (error) {
            request.server.log.error(`Razorpay Error: ${error.message}`);
            throw new AppError('Gateway failed, but manual payout is still available.', 500);
        }
    }

    settlement.status = 'Paid';
    settlement.processedAt = new Date();
    await settlement.save();

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
    if (request.user.role !== 'SuperAdmin') throw new AppError('Unauthorized: HQ access required', 403);
    const { id } = request.params;
    const settlement = await Settlement.findById(id);
    if (!settlement || settlement.status !== 'Disputed') throw new AppError('Valid disputed settlement record not found', 404);

    settlement.status = 'Voided';
    settlement.processedAt = new Date();
    await settlement.save();

    return { success: true, message: 'Dispute resolved and payout voided', data: settlement };
};

// ==========================================
// --- NEW: PHASE 3 OMNI-CART CLEARING HOUSE ---
// ==========================================

// Webhook/Internal trigger called when an Omni-Cart is fully delivered
exports.triggerOmniCartClearing = async (request, reply) => {
    // Requires system-level auth or superadmin
    if (request.user.role !== 'SuperAdmin') throw new AppError('Unauthorized: System clearing required', 403);
    
    const { splitShipmentGroupId } = request.body;
    if (!splitShipmentGroupId) throw new AppError('splitShipmentGroupId required', 400);

    const orders = await Order.find({ splitShipmentGroupId, status: 'Delivered' });
    if (orders.length === 0) return { success: false, message: 'No delivered orders found for this group.' };

    const payoutsCreated = [];

    await withTransaction(async (session) => {
        for (const order of orders) {
            const store = await Store.findById(order.storeId).session(session);
            if (!store) continue;

            // Mathematical calculation of platform commission based on specific Store's terms
            const commRate = store.commercialTerms?.commissionValue || 5.0; // Default 5%
            const platformFeeRs = (order.totalAmount * commRate) / 100;
            const netPayoutRs = order.totalAmount - platformFeeRs;

            const settlementDoc = new Settlement({
                storeId: store._id,
                orderId: order._id,
                amount: order.totalAmount, // Gross
                platformFeeRs: Number(platformFeeRs.toFixed(2)),
                netPayoutToStore: Number(netPayoutRs.toFixed(2)),
                status: 'Pending',
                currency: 'Rs'
            });

            await settlementDoc.save({ session });
            payoutsCreated.push(settlementDoc._id);
        }
    });

    return { 
        success: true, 
        message: `Clearing House processed ${payoutsCreated.length} payouts to partner ledgers.`,
        payoutsCreated 
    };
};

// ==========================================
// --- NEW: PHASE 3 B2B WHOLESALE FINANCIAL LEDGER ---
// ==========================================

exports.processB2BWholesaleSettlement = async (request, reply) => {
    // Triggered when a B2B Purchase Order is fulfilled and paid by the Local Shop
    if (request.user.role !== 'SuperAdmin' && request.user.role !== 'System') {
        throw new AppError('Unauthorized: System clearing required', 403);
    }
    
    const { poId, distributorId, localStoreId, totalValueRs } = request.body;
    if (!poId || !distributorId || !totalValueRs) {
        throw new AppError('Missing required B2B settlement parameters', 400);
    }

    // DailyPick's standard B2B aggregator commission (e.g., 2.5% on wholesale transactions)
    const platformB2BCommissionRate = 2.5; 
    const platformFeeRs = (totalValueRs * platformB2BCommissionRate) / 100;
    const netPayoutToDistributorRs = totalValueRs - platformFeeRs;

    const settlementDoc = new Settlement({
        storeId: distributorId, // The Distributor entity receiving the funds
        orderId: poId, // The B2B Purchase Order ID
        amount: totalValueRs,
        platformFeeRs: Number(platformFeeRs.toFixed(2)),
        netPayoutToStore: Number(netPayoutToDistributorRs.toFixed(2)),
        status: 'Pending',
        currency: 'Rs',
        notes: `B2B Wholesale PO settlement from Store ID: ${localStoreId}`
    });

    await settlementDoc.save();

    return { 
        success: true, 
        message: `B2B Wholesale settlement recorded. Distributor Payout: Rs ${netPayoutToDistributorRs}`,
        data: settlementDoc
    };
};

// ============================================================================
// --- NEW: PHASE 11 AUTOMATED B2B TAX INVOICE EMAILING ---
// ============================================================================
const originalProcessB2BSettlementPhase11 = exports.processB2BWholesaleSettlement;

exports.processB2BWholesaleSettlement = async (request, reply) => {
    const result = await originalProcessB2BSettlementPhase11(request, reply);
    
    // Automatically trigger the secure invoice email when the backend payment clears
    if (result.success && result.data) {
        setImmediate(async () => {
            try {
                const { poId, localStoreId, totalValueRs } = request.body;
                
                const Order = require('../models/Order');
                const Store = require('../models/Store');
                const notificationService = require('../services/notificationService');
                
                const store = await Store.findById(localStoreId);
                const order = await Order.findById(poId);
                
                if (store && store.contactEmail && order) {
                    // System-generated Digital Invoice 
                    const htmlInvoice = `
                        <h2>DailyPick B2B Wholesale Tax Invoice</h2>
                        <p><strong>Invoice Number:</strong> ${order.orderNumber || order._id}</p>
                        <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
                        <p><strong>Billed To:</strong> ${store.name}</p>
                        <hr/>
                        <h3>Total Amount Paid: Rs ${totalValueRs}</h3>
                        ${order.taxBreakdown ? `
                            <p>CGST: Rs ${order.taxBreakdown.cgstRs}</p>
                            <p>SGST: Rs ${order.taxBreakdown.sgstRs}</p>
                            <p><strong>Total Tax: Rs ${order.taxBreakdown.totalTaxRs}</strong></p>
                        ` : ''}
                        <hr/>
                        <p style="font-size: 11px; color: #64748B;">This is a system generated B2B tax invoice. You may use this for your Input Tax Credit (ITC) filings.</p>
                    `;
                    
                    // Dispatch instantly via background queue
                    await notificationService.sendAdminEmail(
                        request.server, 
                        `B2B Tax Invoice - ${order.orderNumber || order._id}`, 
                        htmlInvoice, 
                        `Your B2B tax invoice for Rs ${totalValueRs} is attached.`
                    );
                    
                    console.log(`[B2B AUTOMATION] Tax Invoice automatically emailed to ${store.contactEmail}`);
                }
            } catch (e) {
                console.error("[B2B AUTOMATION ERROR] Failed to email invoice:", e.message);
            }
        });
    }
    
    return result;
};
