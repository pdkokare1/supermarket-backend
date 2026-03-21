const mongoose = require('mongoose');

const purchaseHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    invoiceNumber: { type: String, required: true },
    addedQuantity: { type: Number, required: true },
    purchasingPrice: { type: Number, required: true }, 
    sellingPrice: { type: Number, required: true }     
});

const variantSchema = new mongoose.Schema({
    weightOrVolume: { type: String, required: true },
    price: { type: Number, required: true },
    stock: { type: Number, default: 0 },
    sku: { type: String, default: '' }, 
    lowStockThreshold: { type: Number, default: 5 },
    expiryDate: { type: Date, default: null }, // NEW: Added for Expiry Tracking
    purchaseHistory: [purchaseHistorySchema] 
});

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, required: true },
    brand: { type: String, default: '' }, 
    distributorName: { type: String, default: '' }, 
    imageUrl: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    searchTags: { type: String, default: '' },
    
    // --- NEW: PHASE 1 TAX/GST FIELDS ---
    hsnCode: { type: String, default: '' },
    taxRate: { type: Number, default: 0 }, // e.g., 0, 5, 12, 18
    taxType: { type: String, enum: ['Inclusive', 'Exclusive'], default: 'Inclusive' },
    // -----------------------------------

    variants: [variantSchema] 
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
