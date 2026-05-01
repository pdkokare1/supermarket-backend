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
    },

    // ============================================================================
    // --- NEW: PHASE 23 VIRAL REFERRAL ENGINE ---
    // ============================================================================
    referralCode: {
        type: String,
        unique: true,
        sparse: true
    },
    referredBy: {
        type: String, // The referral code of the user who invited them
        default: null
    },
    hasCompletedFirstOrder: {
        type: Boolean,
        default: false
    },

    // ============================================================================
    // --- NEW: PHASE 28 DAILYPICK PRIME & VERNACULAR ENGINE ---
    // ============================================================================
    isPrime: { type: Boolean, default: false },
    primeExpiry: { type: Date, default: null },
    languagePreference: { type: String, enum: ['EN', 'HI', 'MR'], default: 'EN' }

}, { timestamps: true });

// ENTERPRISE OPTIMIZATION: Immediate memory pointer for lightning-fast POS customer lookup
customerSchema.index({ name: 1 });

// ENTERPRISE OPTIMIZATION: Compound index to instantly sort and filter CRM lists
customerSchema.index({ phone: 1, name: 1, createdAt: -1 });

// ============================================================================
// --- NEW: PHASE 9 FRAUD & COD ABUSE SHIELD ---
// ============================================================================
customerSchema.add({
    codRejections: { type: Number, default: 0 },
    trustScore: { type: Number, default: 100 },
    lastOrderDate: { type: Date, default: null }
});

// Auto-generate referral code on creation
customerSchema.pre('save', function(next) {
    if (this.isNew && !this.referralCode) {
        // e.g. RAHUL1234
        const prefix = this.name ? this.name.split(' ')[0].toUpperCase().substring(0, 5) : 'DP';
        const random = Math.floor(1000 + Math.random() * 9000);
        this.referralCode = `${prefix}${random}`;
    }
    next();
});

module.exports = mongoose.model('Customer', customerSchema);
