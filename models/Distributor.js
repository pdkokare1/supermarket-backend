/* models/Distributor.js */
const mongoose = require('mongoose');

const distributorSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true, 
        unique: true 
    },
    // --- NEW FUNCTIONALITY: Accounts Payable & B2B Ledger ---
    // All financial ledgers track amounts in Rs
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
        amount: { type: Number, required: true }, // Logged in Rs
        paymentMode: { type: String, default: 'Cash' }, // e.g., 'Bank Transfer', 'Cash', 'UPI'
        date: { type: Date, default: Date.now },
        referenceNote: { type: String, default: '' }
    }],
    
    // --- NEW: PHASE 1 DYNAMIC COMMERCIAL TERMS ---
    commercialTerms: {
        commissionType: { type: String, enum: ['PERCENTAGE', 'FLAT_FEE', 'SUBSCRIPTION'], default: 'PERCENTAGE' },
        commissionValue: { type: Number, default: 0, min: 0 }
    }
}, { timestamps: true });

module.exports = mongoose.model('Distributor', distributorSchema);
