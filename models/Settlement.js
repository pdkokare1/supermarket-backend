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
        enum: ['Pending', 'Processed', 'Disputed', 'Refunded'],
        default: 'Pending'
    },
    settlementDate: {
        type: Date,
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
