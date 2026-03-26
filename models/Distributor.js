const mongoose = require('mongoose');

const distributorSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true, 
        unique: true 
    },
    // --- NEW FUNCTIONALITY: Accounts Payable & B2B Ledger ---
    totalPendingAmount: { 
        type: Number, 
        default: 0,
        min: 0 
    },
    totalPaidAmount: { 
        type: Number, 
        default: 0 
    },
    paymentHistory: [{
        amount: { type: Number, required: true },
        paymentMode: { type: String, default: 'Cash' }, // e.g., 'Bank Transfer', 'Cash', 'UPI'
        date: { type: Date, default: Date.now },
        referenceNote: { type: String, default: '' }
    }]
}, { timestamps: true });

module.exports = mongoose.model('Distributor', distributorSchema);
