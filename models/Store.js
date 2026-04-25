/* models/Store.js */
const mongoose = require('mongoose');

const storeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    chainName: { type: String, default: '' },
    storeType: { type: String, enum: ['INDEPENDENT', 'ENTERPRISE', 'DISTRIBUTOR'], default: 'INDEPENDENT' },
    location: { type: String, required: true },
    coordinates: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null }
    },
    contactNumber: { type: String, default: '' },
    fulfillmentOptions: [{
        type: String,
        enum: ['PLATFORM_DELIVERY', 'STORE_DELIVERY', 'PICKUP'],
        default: ['PICKUP']
    }],
    apiIntegration: {
        apiSecretKey: { type: String, default: '' },
        webhookUrl: { type: String, default: '' },
        lastSync: { type: Date, default: null }
    },

    // --- NEW: VENDOR KYC & SETTLEMENT ROUTING ---
    kyc: {
        gstin: { type: String, default: '' },
        panNumber: { type: String, default: '' }
    },
    financials: {
        commissionRate: { type: Number, default: 5.0, min: 0, max: 100 }, // Percentage platform fee
        bankAccount: { type: String, default: '' },
        ifscCode: { type: String, default: '' },
        upiId: { type: String, default: '' }
    },

    // --- NEW: MARKETPLACE TRUST ---
    metrics: {
        rating: { type: Number, default: 0, min: 0, max: 5 },
        totalReviews: { type: Number, default: 0, min: 0 }
    },

    isActive: { type: Boolean, default: true }
}, { timestamps: true });

// Indexes for hyper-local discovery and fast querying
storeSchema.index({ "coordinates.lat": 1, "coordinates.lng": 1 });
storeSchema.index({ storeType: 1, isActive: 1 });

module.exports = mongoose.model('Store', storeSchema);
