/* models/Store.js */
const mongoose = require('mongoose');

const storeSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true 
    },
    chainName: {
        type: String,
        default: '' // e.g., "Reliance Smart" or "Croma"
    },
    storeType: {
        type: String,
        enum: ['INDEPENDENT', 'ENTERPRISE', 'DISTRIBUTOR'],
        default: 'INDEPENDENT'
    },
    location: { 
        type: String, 
        required: true 
    },
    // Geospatial data for routing riders and calculating B2C "Stores Near Me"
    coordinates: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null }
    },
    contactNumber: { 
        type: String, 
        default: '' 
    },
    fulfillmentOptions: [{
        type: String,
        enum: ['PLATFORM_DELIVERY', 'STORE_DELIVERY', 'PICKUP'],
        default: ['PICKUP']
    }],
    // API Integration for Enterprise Legacy Systems
    apiIntegration: {
        apiSecretKey: { type: String, default: '' },
        webhookUrl: { type: String, default: '' },
        lastSync: { type: Date, default: null }
    },
    isActive: { 
        type: Boolean, 
        default: true 
    }
}, { timestamps: true });

// Index for hyper-local store discovery
storeSchema.index({ "coordinates.lat": 1, "coordinates.lng": 1 });

module.exports = mongoose.model('Store', storeSchema);
