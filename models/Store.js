/* models/Store.js */
const mongoose = require('mongoose');

/**
 * DailyPick - Master Store Schema
 * Acts as the Single Source of Truth for all physical and enterprise marketplace partners.
 */
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
    
    // --- B2B API GATEWAY CREDENTIALS ---
    // Used by enterprise partners to access their dedicated endpoints
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

    // --- NEW: PHASE 1 DYNAMIC COMMERCIAL TERMS ---
    // Calculates platform cut and payouts strictly in Rs
    commercialTerms: {
        commissionType: { type: String, enum: ['PERCENTAGE', 'FLAT_FEE', 'SUBSCRIPTION'], default: 'PERCENTAGE' },
        commissionValue: { type: Number, default: 5.0, min: 0 } 
    },

    // --- NEW: MARKETPLACE TRUST ---
    metrics: {
        rating: { type: Number, default: 0, min: 0, max: 5 },
        totalReviews: { type: Number, default: 0, min: 0 }
    },

    // --- NEW: PHASE 10 B2B OMNICHANNEL & SPATIAL ROUTING ---
    spatialLocation: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], default: [73.7997, 18.6298] } // [lng, lat] for $geoNear Mapbox/MongoDB routing
    },
    maxDeliveryRadius: { type: Number, default: 5000 }, // Delivery radius in meters for hyper-local filtering
    erpIntegration: {
        erpStoreId: { type: String, default: '' }, // e.g., 'RELIANCE_PIMPRI_001'
        legacySyncMethod: { type: String, enum: ['API', 'FTP_CSV', 'MANUAL'], default: 'API' }
    },

    isActive: { type: Boolean, default: true }
}, { timestamps: true });

// Indexes for hyper-local discovery and fast querying
storeSchema.index({ "coordinates.lat": 1, "coordinates.lng": 1 });
storeSchema.index({ storeType: 1, isActive: 1 });
// Geospatial index for hyper-local B2C discovery and spatial routing
storeSchema.index({ spatialLocation: '2dsphere' });

module.exports = mongoose.model('Store', storeSchema);
