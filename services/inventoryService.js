/* services/inventoryService.js */

const Product = require('../models/Product');
const Distributor = require('../models/Distributor');
const AuditLog = require('../models/AuditLog');
const { withTransaction } = require('../utils/dbUtils'); // NEW IMPORT

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const getProductAndVariant = async (productId, variantId, session = null) => {
    const query = Product.findById(productId);
    if (session) query.session(session);
    
    const product = await query;
    if (!product) throw new Error('Product not found');
    
    const variant = product.variants.id(variantId);
    if (!variant) throw new Error('Variant not found');
    
    return { product, variant };
};

// ==========================================
// --- SERVICE EXPORTS ---
// ==========================================

exports.processRestock = async (productId, payload) => {
    return withTransaction(async (session) => {
        const { variantId, invoiceNumber, addedQuantity, purchasingPrice, newSellingPrice, paymentStatus, storeId } = payload;
        
        const { product, variant } = await getProductAndVariant(productId, variantId, session);
        
        variant.purchaseHistory.push({ 
            invoiceNumber, 
            addedQuantity: Number(addedQuantity), 
            purchasingPrice: Number(purchasingPrice), 
            sellingPrice: Number(newSellingPrice),
            storeId: storeId 
        });
        
        variant.stock += Number(addedQuantity); 
        variant.price = Number(newSellingPrice);

        if (storeId) {
            let locStock = variant.locationInventory.find(l => l.storeId && l.storeId.toString() === storeId);
            if (locStock) {
                locStock.stock += Number(addedQuantity);
            } else {
                variant.locationInventory.push({ storeId: storeId, stock: Number(addedQuantity) });
            }
        }
        
        await product.save({ session });
        
        if (paymentStatus === 'Credit' && product.distributorName) {
            const totalCost = Number(addedQuantity) * Number(purchasingPrice);
            await Distributor.findOneAndUpdate(
                { name: product.distributorName },
                { $inc: { totalPendingAmount: totalCost } },
                { upsert: true, session }
            );
        }
        return product;
    });
};

exports.processRTV = async (productId, payload) => {
    return withTransaction(async (session) => {
        const { variantId, distributorName, returnedQuantity, refundAmount, reason, storeId } = payload;
        
        const { product, variant } = await getProductAndVariant(productId, variantId, session);
        
        if (variant.stock < returnedQuantity) throw new Error('Not enough stock to return');

        variant.returnHistory.push({ distributorName, returnedQuantity: Number(returnedQuantity), refundAmount: Number(refundAmount), reason, storeId });
        
        variant.stock -= Number(returnedQuantity); 

        if (storeId) {
            let locStock = variant.locationInventory.find(l => l.storeId && l.storeId.toString() === storeId);
            if (locStock && locStock.stock >= returnedQuantity) {
                locStock.stock -= Number(returnedQuantity);
            }
        }
        
        await product.save({ session });
        return product;
    });
};

exports.processTransfer = async (payload, username, logError) => {
    return withTransaction(async (session) => {
        const { productId, variantId, fromStoreId, toStoreId, quantity } = payload;
        
        if (!productId || !variantId || !fromStoreId || !toStoreId || !quantity || quantity <= 0) {
            throw new Error('Invalid transfer parameters.');
        }

        const { product, variant } = await getProductAndVariant(productId, variantId, session);

        let fromLoc = variant.locationInventory.find(l => l.storeId.toString() === fromStoreId);
        let toLoc = variant.locationInventory.find(l => l.storeId.toString() === toStoreId);

        if (!fromLoc || fromLoc.stock < quantity) {
            throw new Error('Insufficient stock at source location.');
        }

        fromLoc.stock -= quantity;
        
        if (toLoc) {
            toLoc.stock += quantity;
        } else {
            variant.locationInventory.push({ storeId: toStoreId, stock: quantity });
        }

        await product.save({ session });
        
        if (AuditLog) {
            await AuditLog.create([{
                action: 'STOCK_TRANSFER',
                targetType: 'Product',
                targetId: product._id.toString(),
                username: username,
                details: { variantId, fromStoreId, toStoreId, quantity }
            }], { session }).catch(e => logError('AuditLog Error:', e));
        }
        
        return product;
    });
};
