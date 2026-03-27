/* models/Promotion.js */

const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema({
    // Legacy Fields (Kept for backwards compatibility)
    name: { type: String }, 
    type: { type: String, enum: ['BOGO', 'PERCENTAGE', 'FLAT_AMOUNT', 'percentage', 'fixed'] },
    value: { type: Number, default: 0 }, 
    minCartValue: { type: Number, default: 0 }, 
    applicableCategory: { type: String, default: 'All' }, 
    
    // --- PHASE 3: New UI Standard Fields ---
    code: { type: String, uppercase: true, trim: true }, // e.g., "SUMMER10"
    discountType: { type: String, enum: ['percentage', 'fixed'] },
    discountValue: { type: Number, default: 0 },
    minOrderValue: { type: Number, default: 0 },
    
    isActive: { type: Boolean, default: true },
    startDate: { type: Date },
    endDate: { type: Date }
}, { timestamps: true });

// Pre-save hook to bridge new and old fields seamlessly
promotionSchema.pre('save', function(next) {
    if (this.code && !this.name) this.name = `Promo: ${this.code}`;
    if (this.discountType && !this.type) this.type = this.discountType;
    if (this.discountValue && this.value === 0) this.value = this.discountValue;
    if (this.minOrderValue && this.minCartValue === 0) this.minCartValue = this.minOrderValue;
    next();
});

module.exports = mongoose.model('Promotion', promotionSchema);
