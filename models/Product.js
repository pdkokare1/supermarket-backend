const mongoose = require('mongoose');

const purchaseHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    invoiceNumber: { type: String, required: true },
    addedQuantity: { type: Number, required: true },
    purchasingPrice: { type: Number, required: true }, 
    sellingPrice: { type: Number, required: true }     
});

const returnHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    distributorName: { type: String, required: true },
    returnedQuantity: { type: Number, required: true },
    refundAmount: { type: Number, required: true },
    reason: { type: String, default: 'Expired/Damaged' }
});

const variantSchema = new mongoose.Schema({
    weightOrVolume: { type: String, required: true },
    price: { type: Number, required: true },
    stock: { type: Number, default: 0 },
    sku: { type: String, default: '' }, 
    lowStockThreshold: { type: Number, default: 5 },
    expiryDate: { type: Date, default: null }, 
    purchaseHistory: [purchaseHistorySchema],
    returnHistory: [returnHistorySchema], 
    
    averageDailySales: { type: Number, default: 0 },
    daysOfStock: { type: Number, default: 999 }
});

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, required: true },
    brand: { type: String, default: '' }, 
    distributorName: { type: String, default: '' }, 
    imageUrl: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    isArchived: { type: Boolean, default: false }, // NEW: Feature B (Soft Deletes)
    searchTags: { type: String, default: '' },
    
    hsnCode: { type: String, default: '' },
    taxRate: { type: Number, default: 0 }, 
    taxType: { type: String, enum: ['Inclusive', 'Exclusive'], default: 'Inclusive' },

    variants: [variantSchema] 
}, { timestamps: true });

// --- OPTIMIZATION ADDITIONS ---
// Indexing for faster catalog queries and SKU lookups
productSchema.index({ isActive: 1, category: 1 });
productSchema.index({ "variants.sku": 1 });

module.exports = mongoose.model('Product', productSchema);
