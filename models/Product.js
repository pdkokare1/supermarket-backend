const mongoose = require('mongoose');

// NEW: Embedded schema for the purchase ledger
const purchaseHistorySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    invoiceNumber: { type: String, required: true },
    addedQuantity: { type: Number, required: true },
    purchasingPrice: { type: Number, required: true }, // Cost Price
    sellingPrice: { type: Number, required: true }     // Retail Price at time of restock
});

// Sub-schema for individual sizes/prices
const variantSchema = new mongoose.Schema({
    weightOrVolume: { type: String, required: true },
    price: { type: Number, required: true },
    stock: { type: Number, default: 0 },
    sku: { type: String, default: '' }, // <-- NEW: Barcode/SKU identifier
    purchaseHistory: [purchaseHistorySchema] // <-- NEW: Accounting Ledger
});

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, required: true },
    brand: { type: String, default: '' }, // <-- NEW
    distributorName: { type: String, default: '' }, // <-- NEW
    imageUrl: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    searchTags: { type: String, default: '' },
    variants: [variantSchema] 
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
