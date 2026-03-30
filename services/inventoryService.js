/* services/inventoryService.js */

const Product = require('../models/Product');
const Distributor = require('../models/Distributor');
const AuditLog = require('../models/AuditLog');

exports.processRestock = async (productId, payload) => {
    const { variantId, invoiceNumber, addedQuantity, purchasingPrice, newSellingPrice, paymentStatus, storeId } = payload;
    
    const product = await Product.findById(productId);
    if (!product) throw new Error('Product not found');
    
    const variant = product.variants.id(variantId);
    if (!variant) throw new Error('Variant not found');
    
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
    
    await product.save();
    
    if (paymentStatus === 'Credit' && product.distributorName) {
        const totalCost = Number(addedQuantity) * Number(purchasingPrice);
        await Distributor.findOneAndUpdate(
            { name: product.distributorName },
            { $inc: { totalPendingAmount: totalCost } },
            { upsert: true }
        );
    }
    return product;
};

exports.processRTV = async (productId, payload) => {
    const { variantId, distributorName, returnedQuantity, refundAmount, reason, storeId } = payload;
    
    const product = await Product.findById(productId);
    if (!product) throw new Error('Product not found');
    
    const variant = product.variants.id(variantId);
    if (!variant) throw new Error('Variant not found');
    
    if (variant.stock < returnedQuantity) throw new Error('Not enough stock to return');

    variant.returnHistory.push({ distributorName, returnedQuantity: Number(returnedQuantity), refundAmount: Number(refundAmount), reason, storeId });
    
    variant.stock -= Number(returnedQuantity); 

    if (storeId) {
        let locStock = variant.locationInventory.find(l => l.storeId && l.storeId.toString() === storeId);
        if (locStock && locStock.stock >= returnedQuantity) {
            locStock.stock -= Number(returnedQuantity);
        }
    }
    
    await product.save();
    return product;
};

exports.processTransfer = async (payload, username, logError) => {
    const { productId, variantId, fromStoreId, toStoreId, quantity } = payload;
    
    if (!productId || !variantId || !fromStoreId || !toStoreId || !quantity || quantity <= 0) {
        throw new Error('Invalid transfer parameters.');
    }

    const product = await Product.findById(productId);
    if (!product) throw new Error('Product not found.');

    const variant = product.variants.id(variantId);
    if (!variant) throw new Error('Variant not found.');

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

    await product.save();
    
    if (AuditLog) {
        await AuditLog.create({
            action: 'STOCK_TRANSFER',
            targetType: 'Product',
            targetId: product._id.toString(),
            username: username,
            details: { variantId, fromStoreId, toStoreId, quantity }
        }).catch(e => logError('AuditLog Error:', e));
    }
    
    return product;
};
