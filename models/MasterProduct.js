/* models/MasterProduct.js */
const mongoose = require('mongoose');

const masterVariantSchema = new mongoose.Schema({
    // ENTERPRISE HARDENING: Added trim and explicit required messages
    weightOrVolume: { type: String, required: [true, 'Variant weight or volume is required'], trim: true },
    sku: { type: String, default: '', trim: true }, // Global Barcode / EAN / UPC
    hsnCode: { type: String, default: '', trim: true },
    taxRate: { type: Number, default: 0, min: [0, 'Tax rate cannot be negative'] }
});

const masterProductSchema = new mongoose.Schema({
    // ENTERPRISE HARDENING: Strict string enforcement
    name: { type: String, required: [true, 'Product name is required'], trim: true, minlength: [2, 'Name must be at least 2 characters long'] },
    category: { type: String, required: [true, 'Category is required'], trim: true },
    brand: { type: String, default: '', trim: true }, 
    imageUrl: { 
        type: String, 
        default: '',
        match: [/^(https?:\/\/.+)?$/, 'Please fill a valid image URL'],
        trim: true
    },
    description: { type: String, default: '', trim: true },
    searchTags: { type: String, default: '', trim: true },
    isActive: { type: Boolean, default: true },
    
    // --- NEW: PHASE 1 CROWDSOURCED CATALOG PIPELINE ---
    status: { 
        type: String, 
        enum: {
            values: ['PENDING_APPROVAL', 'ACTIVE', 'REJECTED'],
            message: '{VALUE} is not a valid catalog status'
        }, 
        default: 'PENDING_APPROVAL' 
    },
    submittedBy: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        default: null 
    },
    
    variants: [masterVariantSchema] 
}, { timestamps: true });

// Optimized indexes for global catalog search
masterProductSchema.index({ name: 1, brand: 1 });
masterProductSchema.index({ searchTags: 1 });
masterProductSchema.index({ "variants.sku": 1 });
masterProductSchema.index({ name: 'text', brand: 'text', searchTags: 'text' });
// NEW INDEX: For fast querying of the Super-Admin Approval Queue
masterProductSchema.index({ status: 1 });

// ============================================================================
// --- NEW: PHASE 10 SINGLE SOURCE OF TRUTH (CATALOG LOCKDOWN) ---
// ============================================================================
masterProductSchema.add({
    compliance: {
        gs1Barcode: { type: String, sparse: true, unique: true, trim: true }, // Strict GS1/UPC global enforcement
        isStrictlyVerified: { type: Boolean, default: false } // Verified centrally by HQ
    }
});

// Spatial lookup index for immediate barcode scanning from POS / Retailer App
masterProductSchema.index({ "compliance.gs1Barcode": 1 });

module.exports = mongoose.model('MasterProduct', masterProductSchema);
