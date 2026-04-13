/* services/brandService.js */

const Brand = require('../models/Brand');
const AppError = require('../utils/AppError');
const cacheUtils = require('../utils/cacheUtils'); // OPTIMIZATION: Added for heavy frontend caching
const appEvents = require('../utils/eventEmitter'); // OPTIMIZATION: Added for ecosystem consistency

exports.getAllBrands = async () => {
    // OPTIMIZATION: Cache brand list to prevent unnecessary DB collection scans on every frontend load
    const CACHE_KEY = 'brands:all';
    let brands = await cacheUtils.getCachedData(CACHE_KEY);
    
    if (!brands) {
        // OPTIMIZED: Added .lean()
        brands = await Brand.find().sort({ name: 1 }).lean();
        await cacheUtils.setCachedData(CACHE_KEY, brands, 86400); // Cache for 24 hours
    }
    
    return brands;
};

exports.createBrand = async (name) => {
    try {
        const newBrand = new Brand({ name });
        await newBrand.save();
        
        // OPTIMIZATION: Invalidate cache when a new brand is added
        await cacheUtils.deleteKey('brands:all');
        
        // EVENT: Notify system of new brand
        appEvents.emit('BRAND_ADDED', { brandId: newBrand._id, brandName: newBrand.name });
        
        return newBrand;
    } catch (error) {
        if (error.code === 11000) {
            throw new AppError('Brand already exists', 400);
        }
        throw error;
    }
};
