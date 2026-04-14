/* models/Customer.js */

const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
    phone: { 
        type: String, 
        required: true,
        unique: true,
        // --- SECURITY HARDENING: Regex for E.164-ish Phone Format ---
        match: [/^\+?[0-9]{10,15}$/, 'Please fill a valid phone number']
    },
    name: { 
        type: String, 
        required: true 
    },
    isCreditEnabled: { 
        type: Boolean, 
        default: false 
    },
    creditLimit: { 
        type: Number, 
        default: 0,
        min: 0 // Deep Hardening: Cannot have negative limits
    },
    creditUsed: { 
        type: Number, 
        default: 0,
        min: 0 
    },
    loyaltyPoints: { 
        type: Number, 
        default: 0,
        min: 0 
    }
}, { timestamps: true });

// ENTERPRISE OPTIMIZATION: Immediate memory pointers for lightning-fast POS customer lookup
customerSchema.index({ phone: 1 });
customerSchema.index({ name: 1 });

module.exports = mongoose.model('Customer', customerSchema);
