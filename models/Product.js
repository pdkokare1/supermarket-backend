/* models/Product.js */

const mongoose = require('mongoose');

const purchaseHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    invoiceNumber: { type: String, required: true },
    addedQuantity: { type: Number, required: true, min: 1 }, // Hardening
    purchasingPrice: { type: Number, required: true, min: 0 }, 
    sellingPrice: { type: Number, required: true, min: 0 },
    // --- NEW: Multi-Store Support ---
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', sparse: true }
});

const returnHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    distributorName: { type: String, required: true },
    returnedQuantity: { type: Number, required: true, min: 1 }, // Hardening
    refundAmount: { type: Number, required: true, min: 0 },
    reason: { type: String, default: 'Expired/Damaged' },
    // --- NEW: Multi-Store Support ---
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', sparse: true }
});

// --- NEW: Store-Specific Inventory Tracker ---
const locationInventorySchema = new mongoose.Schema({
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
    stock: { type: Number, default: 0, min: 0 },
    lowStockThreshold: { type: Number, default: 5, min: 0 }
});

const variantSchema = new mongoose.Schema({
    weightOrVolume: { type: String, required: true },
    price: { type: Number, required: true, min: 0 }, // Hardening
    stock: { type: Number, default: 0, min: 0 }, // Prevents negative ghost stock (Kept for legacy sync)
    
    // --- NEW: Multi-Store Inventory ---
    locationInventory: [locationInventorySchema],

    sku: { type: String, default: '' }, 
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    expiryDate: { type: Date, default: null }, 
    purchaseHistory: [purchaseHistorySchema],
    returnHistory: [returnHistorySchema], 
    
    averageDailySales: { type: Number, default: 0, min: 0 },
    daysOfStock: { type: Number, default: 999 }
});

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, required: true },
    brand: { type: String, default: '' }, 
    distributorName: { type: String, default: '' }, 
    imageUrl: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    isArchived: { type: Boolean, default: false }, 
    searchTags: { type: String, default: '' },
    
    hsnCode: { type: String, default: '' },
    taxRate: { type: Number, default: 0, min: 0 }, // Hardening
    taxType: { type: String, enum: ['Inclusive', 'Exclusive'], default: 'Inclusive' },

    variants: [variantSchema] 
}, { timestamps: true });

// Existing Indexes
productSchema.index({ isActive: 1, category: 1 });
productSchema.index({ "variants.sku": 1 });
productSchema.index({ isArchived: 1 });
productSchema.index({ "variants.stock": 1, "variants.lowStockThreshold": 1 });
productSchema.index({ name: 1, brand: 1 });
productSchema.index({ searchTags: 1 });
productSchema.index({ "variants.locationInventory.storeId": 1 });

// NEW: Compound Index strictly for the Daily Inventory Cron Job (Velocity)
productSchema.index({ isActive: 1, "variants.stock": 1 });

// ENTERPRISE OPTIMIZATION: Front-end Catalog Pre-computation Index
productSchema.index({ isArchived: 1, isActive: 1, category: 1, "variants.price": 1 });

module.exports = mongoose.model('Product', productSchema);
