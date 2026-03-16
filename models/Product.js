const mongoose = require('mongoose');

// Sub-schema for individual sizes/prices
const variantSchema = new mongoose.Schema({
    weightOrVolume: { type: String, required: true },
    price: { type: Number, required: true },
    stock: { type: Number, default: 0 }
});

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, required: true },
    imageUrl: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    searchTags: { type: String, default: '' }, // <-- NEW: Invisible Search Keywords
    variants: [variantSchema] 
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
