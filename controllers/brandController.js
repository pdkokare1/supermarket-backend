/* controllers/brandController.js */

const brandService = require('../services/brandService');
const catchAsync = require('../utils/catchAsync');

exports.getBrands = catchAsync(async (request, reply) => {
    const brands = await brandService.getAllBrands();
    return { success: true, count: brands.length, data: brands };
}, 'fetching brands');

exports.createBrand = catchAsync(async (request, reply) => {
    const newBrand = await brandService.createBrand(request.body.name);

    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'BRAND_ADDED', brandId: newBrand._id });
    }

    return { success: true, message: 'Brand added', data: newBrand };
}, 'creating brand');
