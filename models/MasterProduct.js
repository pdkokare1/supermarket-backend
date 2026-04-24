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
    
    variants: [masterVariantSchema] 
}, { timestamps: true });

// Optimized indexes for global catalog search
masterProductSchema.index({ name: 1, brand: 1 });
masterProductSchema.index({ searchTags: 1 });
masterProductSchema.index({ "variants.sku": 1 });
masterProductSchema.index({ name: 'text', brand: 'text', searchTags: 'text' });

module.exports = mongoose.model('MasterProduct', masterProductSchema);
