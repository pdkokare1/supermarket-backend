/* models/Settlement.js */
const mongoose = require('mongoose');

const settlementSchema = new mongoose.Schema({
    storeId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Store', 
        required: true 
    },
    orderId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Order', 
        required: true 
    },
    orderNumber: {
        type: String,
        required: true
    },
    // The total amount the B2C customer paid for this specific store's items
    totalOrderValue: { 
        type: Number, 
        required: true,
        min: 0
    },
    // Your startup's revenue
    platformCommission: { 
        type: Number, 
        required: true,
        min: 0
    },
    gatewayFee: { 
        type: Number, 
        default: 0,
        min: 0
    },
    // The exact Rs amount to be deposited into the Enterprise Partner's bank account
    netPayoutToStore: { 
        type: Number, 
        required: true,
        min: 0
    },
    status: {
        type: String,
        // EXPANDED: Added 'Paid' and 'Voided' to support the new automated controller logic
        enum: ['Pending', 'Processed', 'Paid', 'Disputed', 'Refunded', 'Voided'],
        default: 'Pending'
    },
    settlementDate: {
        type: Date,
        default: null
    },
    // NEW: Timestamp for when the manual or automated payout occurred
    processedAt: {
        type: Date,
        default: null
    },
    // NEW: Stores the banking reference ID from the payment gateway
    transactionId: {
        type: String,
        default: null
    },
    // Links to the return/dispute flow
    disputeReason: {
        type: String,
        default: null
    }
}, { timestamps: true });

// Strict indexes for hyper-fast financial reporting by Tenant
settlementSchema.index({ storeId: 1, status: 1 });
settlementSchema.index({ orderId: 1 }, { unique: true });
settlementSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Settlement', settlementSchema);
