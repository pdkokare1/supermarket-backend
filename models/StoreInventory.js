/* models/StoreInventory.js */
const mongoose = require('mongoose');

const purchaseHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    invoiceNumber: { type: String, required: [true, 'Invoice number is required'], trim: true },
    distributorName: { type: String, default: '', trim: true },
    // ENTERPRISE HARDENING: Strict financial integer protection
    addedQuantity: { type: Number, required: [true, 'Quantity is required'], min: [1, 'Added quantity must be at least 1'] }, 
    purchasingPrice: { type: Number, required: [true, 'Purchasing price is required'], min: [0, 'Purchasing price cannot be negative'] }, 
    sellingPrice: { type: Number, required: [true, 'Selling price is required'], min: [0, 'Selling price cannot be negative'] }
});

const returnHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    distributorName: { type: String, required: [true, 'Distributor name is required'], trim: true },
    returnedQuantity: { type: Number, required: [true, 'Returned quantity is required'], min: [1, 'Returned quantity must be at least 1'] }, 
    refundAmount: { type: Number, required: [true, 'Refund amount is required'], min: [0, 'Refund amount cannot be negative'] },
    reason: { type: String, default: 'Expired/Damaged', trim: true }
});

const storeInventorySchema = new mongoose.Schema({
    storeId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Store', 
        required: true 
    },
    masterProductId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'MasterProduct', 
        required: true 
    },
    variantId: { 
        type: mongoose.Schema.Types.ObjectId, 
        required: true // Points to the specific variant in MasterProduct
    },
    
    // Localized Pricing and Stock
    sellingPrice: { type: Number, required: [true, 'Selling price is required'], min: [0, 'Selling price cannot be negative'] },
    stock: { type: Number, default: 0, min: [0, 'Stock cannot fall below zero'] },
    lowStockThreshold: { type: Number, default: 5, min: [0, 'Threshold cannot be negative'] },
    
    // Tenant-Specific History
    purchaseHistory: [purchaseHistorySchema],
    returnHistory: [returnHistorySchema], 
    
    // Local Analytics
    averageDailySales: { type: Number, default: 0, min: [0, 'Sales cannot be negative'] },
    daysOfStock: { type: Number, default: 999, min: [0, 'Days of stock cannot be negative'] },
    
    // --- NEW: PHASE 10 ENTERPRISE ERP MAPPING ---
    erpIntegration: {
        erpSku: { type: String, default: null, trim: true }, // Mapped SKU in external SAP/Oracle systems
        lastErpSync: { type: Date, default: null },
        autoSyncEnabled: { type: Boolean, default: true }
    },

    isActive: { type: Boolean, default: true } // If a store stops selling this item locally
}, { timestamps: true });

// STRICT ISOLATION INDEXES
storeInventorySchema.index({ storeId: 1, masterProductId: 1, variantId: 1 }, { unique: true });
storeInventorySchema.index({ storeId: 1, stock: 1 }); // For fast "low stock" queries per store
storeInventorySchema.index({ storeId: 1, isActive: 1 });

// ============================================================================
// --- NEW: PHASE 8 COMPOUND DATABASE INDEXING FOR PERFORMANCE ---
// ============================================================================
// High-performance compound index to prevent full collection scans on cron-jobs and B2B lookups
storeInventorySchema.index({ storeId: 1, masterProductId: 1, stock: 1, isActive: 1 });

module.exports = mongoose.model('StoreInventory', storeInventorySchema);
