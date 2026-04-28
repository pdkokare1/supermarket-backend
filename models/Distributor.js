/* models/Distributor.js */
const mongoose = require('mongoose');

const distributorSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true, 
        unique: true 
    },
    // --- EXISTING: Accounts Payable & B2B Ledger ---
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
    
    // --- EXISTING: DYNAMIC COMMERCIAL TERMS ---
    commercialTerms: {
        commissionType: { type: String, enum: ['PERCENTAGE', 'FLAT_FEE', 'SUBSCRIPTION'], default: 'PERCENTAGE' },
        commissionValue: { type: Number, default: 0, min: 0 }
    },

    // --- NEW: PHASE 2 B2B PROCUREMENT PORTAL ---
    // Allows local shops to browse wholesale prices directly from Distributors in their area
    serviceablePincodes: [{
        type: String
    }],
    wholesaleCatalog: [{
        masterProductId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'MasterProduct',
            required: true
        },
        bulkPriceRs: {
            type: Number,
            required: true // B2B Wholesale price
        },
        minimumOrderQuantity: {
            type: Number,
            default: 10
        },
        stockAvailable: {
            type: Number,
            default: 0
        }
    }],
    kycVerified: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Index to quickly find distributors that service a shop's location
distributorSchema.index({ serviceablePincodes: 1 });

module.exports = mongoose.model('Distributor', distributorSchema);
