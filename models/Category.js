const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }, // e.g., "Chips & Namkeen"
    section: { type: String, required: true }, // e.g., "Snacks & Drinks"
    imageUrl: { type: String, default: '' }, // For the Zepto/Blinkit style square card
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Category', categorySchema);
