/* controllers/brandController.js */

const brandService = require('../services/brandService');

exports.getBrands = async (request, reply) => {
    const brands = await brandService.getAllBrands();
    return { success: true, count: brands.length, data: brands };
};

exports.createBrand = async (request, reply) => {
    const newBrand = await brandService.createBrand(request.body.name);

    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'BRAND_ADDED', brandId: newBrand._id });
    }

    return { success: true, message: 'Brand added', data: newBrand };
};
