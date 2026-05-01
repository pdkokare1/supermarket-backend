/* models/Collective.js */

const mongoose = require('mongoose');

const collectiveSchema = new mongoose.Schema({
    // --- PRODUCT BEING BULK BOUGHT ---
    masterProductId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'MasterProduct',
        required: true 
    },
    variantId: { 
        type: String, 
        required: true 
    },
    productName: { 
        type: String, 
        required: true 
    },
    
    // --- THE PINDUODUO MATH ---
    originalPriceRs: { 
        type: Number, 
        required: true 
    },
    collectiveDiscountRs: { 
        type: Number, 
        required: true // The exact price everyone pays if the threshold is met
    },
    targetParticipants: { 
        type: Number, 
        required: true,
        default: 5 
    },

    // --- THE PARTICIPANTS ---
    participants: [{
        customerPhone: { type: String, required: true },
        razorpayAuthId: { type: String, required: true }, // Pre-authorization lock
        joinedAt: { type: Date, default: Date.now }
    }],

    // --- THE LOGISTICS ---
    dropoffAddress: { 
        type: String, 
        required: true // E.g., "Lodha Belmondo Gate 4"
    },
    storeId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Store',
        required: true // Which dark store is fulfilling this bulk shipment
    },
    
    // --- THE COUNTDOWN ---
    status: {
        type: String,
        enum: ['GATHERING', 'SUCCESSFUL', 'FAILED'],
        default: 'GATHERING'
    },
    expiresAt: { 
        type: Date, 
        required: true // Typically 24 hours from creation
    }

}, { timestamps: true });

// High-speed indices for checking active Group Buys in a specific neighborhood
collectiveSchema.index({ status: 1, expiresAt: 1 });
collectiveSchema.index({ dropoffAddress: 'text' });

module.exports = mongoose.model('Collective', collectiveSchema);
