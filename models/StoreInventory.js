/* models/StoreInventory.js */
const mongoose = require('mongoose');

const purchaseHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    invoiceNumber: { type: String, required: true },
    distributorName: { type: String, default: '' },
    addedQuantity: { type: Number, required: true, min: 1 }, 
    purchasingPrice: { type: Number, required: true, min: 0 }, 
    sellingPrice: { type: Number, required: true, min: 0 }
});

const returnHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    distributorName: { type: String, required: true },
    returnedQuantity: { type: Number, required: true, min: 1 }, 
    refundAmount: { type: Number, required: true, min: 0 },
    reason: { type: String, default: 'Expired/Damaged' }
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
    sellingPrice: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    
    // Tenant-Specific History
    purchaseHistory: [purchaseHistorySchema],
    returnHistory: [returnHistorySchema], 
    
    // Local Analytics
    averageDailySales: { type: Number, default: 0, min: 0 },
    daysOfStock: { type: Number, default: 999 },
    
    isActive: { type: Boolean, default: true } // If a store stops selling this item locally
}, { timestamps: true });

// STRICT ISOLATION INDEXES
storeInventorySchema.index({ storeId: 1, masterProductId: 1, variantId: 1 }, { unique: true });
storeInventorySchema.index({ storeId: 1, stock: 1 }); // For fast "low stock" queries per store
storeInventorySchema.index({ storeId: 1, isActive: 1 });

module.exports = mongoose.model('StoreInventory', storeInventorySchema);
