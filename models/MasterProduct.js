/* models/MasterProduct.js */
const mongoose = require('mongoose');

const masterVariantSchema = new mongoose.Schema({
    weightOrVolume: { type: String, required: true },
    sku: { type: String, default: '' }, // Global Barcode / EAN / UPC
    hsnCode: { type: String, default: '' },
    taxRate: { type: Number, default: 0, min: 0 }
});

const masterProductSchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, required: true },
    brand: { type: String, default: '' }, 
    imageUrl: { 
        type: String, 
        default: '',
        match: [/^(https?:\/\/.+)?$/, 'Please fill a valid image URL']
    },
    description: { type: String, default: '' },
    searchTags: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    
    // --- NEW: PHASE 1 CROWDSOURCED CATALOG PIPELINE ---
    status: { 
        type: String, 
        enum: ['PENDING_APPROVAL', 'ACTIVE', 'REJECTED'], 
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
        gs1Barcode: { type: String, sparse: true, unique: true }, // Strict GS1/UPC global enforcement
        isStrictlyVerified: { type: Boolean, default: false } // Verified centrally by HQ
    }
});

// Spatial lookup index for immediate barcode scanning from POS / Retailer App
masterProductSchema.index({ "compliance.gs1Barcode": 1 });

module.exports = mongoose.model('MasterProduct', masterProductSchema);
