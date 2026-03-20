const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema({
    name: { type: String, required: true }, // e.g., "Morning Dairy Discount"
    type: { type: String, enum: ['BOGO', 'PERCENTAGE', 'FLAT_AMOUNT'], required: true },
    value: { type: Number, default: 0 }, // e.g., 10 for 10%, or 50 for ₹50 off
    minCartValue: { type: Number, default: 0 }, // Minimum spend to trigger
    applicableCategory: { type: String, default: 'All' }, // Specific category or 'All'
    isActive: { type: Boolean, default: true },
    startDate: { type: Date },
    endDate: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Promotion', promotionSchema);
