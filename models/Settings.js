/* models/Settings.js */

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    storeName: { type: String, default: 'DAILYPICK.' },
    storeAddress: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    gstin: { type: String, default: '' },
    receiptFooterMessage: { type: String, default: 'Thank you for shopping with us!' },
    loyaltyPointValue: { type: Number, default: 1 }, // Default: ₹100 = 1 point
    autoSendWhatsAppReceipts: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);
