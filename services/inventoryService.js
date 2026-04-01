/* services/inventoryService.js */

const Product = require('../models/Product');
const Distributor = require('../models/Distributor');
const { withTransaction } = require('../utils/dbUtils'); 
const AppError = require('../utils/AppError'); 
const auditService = require('./auditService'); 

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const getProductAndVariant = async (productId, variantId, session = null) => {
    const query = Product.findById(productId);
    if (session) query.session(session);
    
    const product = await query;
    if (!product) throw new AppError('Product not found', 404);
    
    const variant = product.variants.id(variantId);
    if (!variant) throw new AppError('Variant not found', 404);
    
    return { product, variant };
};

// ==========================================
// --- SERVICE EXPORTS ---
// ==========================================

exports.processRestock = async (productId, payload) => {
    return withTransaction(async (session) => {
        const { variantId, invoiceNumber, addedQuantity, purchasingPrice, newSellingPrice, paymentStatus, storeId } = payload;
        
        // Fetch to validate existence and structure
        const { product, variant } = await getProductAndVariant(productId, variantId, session);
        
        const purchaseHistoryEntry = { 
            invoiceNumber, 
            addedQuantity: Number(addedQuantity), 
            purchasingPrice: Number(purchasingPrice), 
            sellingPrice: Number(newSellingPrice),
            storeId: storeId 
        };

        // OPTIMIZED: Building an atomic update query to prevent save race conditions
        const updateQuery = {
            $push: { "variants.$[var].purchaseHistory": purchaseHistoryEntry },
            $inc: { "variants.$[var].stock": Number(addedQuantity) },
            $set: { "variants.$[var].price": Number(newSellingPrice) }
        };
        
        const arrayFilters = [{ "var._id": variantId }];

        if (storeId) {
            const hasStore = variant.locationInventory.some(l => l.storeId && l.storeId.toString() === storeId);
            if (hasStore) {
                updateQuery.$inc["variants.$[var].locationInventory.$[loc].stock"] = Number(addedQuantity);
                arrayFilters.push({ "loc.storeId": storeId });
            } else {
                updateQuery.$push["variants.$[var].locationInventory"] = { storeId: storeId, stock: Number(addedQuantity) };
            }
        }

        const updatedProduct = await Product.findOneAndUpdate(
            { _id: productId },
            updateQuery,
            { new: true, arrayFilters, session }
        );
        
        if (paymentStatus === 'Credit' && updatedProduct.distributorName) {
            const totalCost = Number(addedQuantity) * Number(purchasingPrice);
            await Distributor.findOneAndUpdate(
                { name: updatedProduct.distributorName },
                { $inc: { totalPendingAmount: totalCost } },
                { upsert: true, session }
            );
        }
        return updatedProduct;
    });
};

exports.processRTV = async (productId, payload) => {
    return withTransaction(async (session) => {
        const { variantId, distributorName, returnedQuantity, refundAmount, reason, storeId } = payload;
        
        const { product, variant } = await getProductAndVariant(productId, variantId, session);
        
        if (variant.stock < returnedQuantity) {
            throw new AppError('Not enough stock to return', 400);
        }

        const returnHistoryEntry = { distributorName, returnedQuantity: Number(returnedQuantity), refundAmount: Number(refundAmount), reason, storeId };

        const updateQuery = {
            $push: { "variants.$[var].returnHistory": returnHistoryEntry },
            $inc: { "variants.$[var].stock": -Number(returnedQuantity) }
        };
        
        const arrayFilters = [{ "var._id": variantId }];

        if (storeId) {
            let locStock = variant.locationInventory.find(l => l.storeId && l.storeId.toString() === storeId);
            if (locStock && locStock.stock >= returnedQuantity) {
                updateQuery.$inc["variants.$[var].locationInventory.$[loc].stock"] = -Number(returnedQuantity);
                arrayFilters.push({ "loc.storeId": storeId });
            }
        }
        
        const updatedProduct = await Product.findOneAndUpdate(
            { _id: productId },
            updateQuery,
            { new: true, arrayFilters, session }
        );

        return updatedProduct;
    });
};

exports.processTransfer = async (payload, username, logError) => {
    return withTransaction(async (session) => {
        const { productId, variantId, fromStoreId, toStoreId, quantity } = payload;
        
        if (!productId || !variantId || !fromStoreId || !toStoreId || !quantity || quantity <= 0) {
            throw new AppError('Invalid transfer parameters.', 400);
        }

        const { product, variant } = await getProductAndVariant(productId, variantId, session);

        let fromLoc = variant.locationInventory.find(l => l.storeId.toString() === fromStoreId);
        if (!fromLoc || fromLoc.stock < quantity) {
            throw new AppError('Insufficient stock at source location.', 400);
        }

        const updateQuery = {
            $inc: { "variants.$[var].locationInventory.$[fromLoc].stock": -Number(quantity) }
        };
        
        const arrayFilters = [
            { "var._id": variantId },
            { "fromLoc.storeId": fromStoreId }
        ];

        let toLoc = variant.locationInventory.find(l => l.storeId.toString() === toStoreId);
        if (toLoc) {
            updateQuery.$inc["variants.$[var].locationInventory.$[toLoc].stock"] = Number(quantity);
            arrayFilters.push({ "toLoc.storeId": toStoreId });
        } else {
            // Need to initialize the location field dynamically if it isn't mapped yet
            updateQuery.$push = {
                "variants.$[var].locationInventory": { storeId: toStoreId, stock: Number(quantity) }
            };
        }

        const updatedProduct = await Product.findOneAndUpdate(
            { _id: productId },
            updateQuery,
            { new: true, arrayFilters, session }
        );
        
        await auditService.logEvent({
            action: 'STOCK_TRANSFER',
            targetType: 'Product',
            targetId: updatedProduct._id.toString(),
            username: username,
            details: { variantId, fromStoreId, toStoreId, quantity },
            session,
            logError
        });
        
        return updatedProduct;
    });
};
