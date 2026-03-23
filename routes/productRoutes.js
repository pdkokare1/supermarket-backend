const Product = require('../models/Product');
const Category = require('../models/Category');

async function productRoutes(fastify, options) {
    
    fastify.get('/api/products', async (request, reply) => {
        try {
            let filter = request.query.all === 'true' ? {} : { isActive: true };
            
            if (request.query.search) { 
                filter.$or = [ 
                    { name: { $regex: request.query.search, $options: 'i' } }, 
                    { searchTags: { $regex: request.query.search, $options: 'i' } } 
                ]; 
            }
            
            if (request.query.category && request.query.category !== 'All') { 
                filter.category = request.query.category; 
            }

            if (request.query.brand && request.query.brand !== 'All') {
                filter.brand = request.query.brand;
            }
            if (request.query.distributor && request.query.distributor !== 'All') {
                filter.distributorName = request.query.distributor;
            }
            
            const page = parseInt(request.query.page) || 1; 
            const limit = parseInt(request.query.limit); 
            
            let query = Product.find(filter).sort({ createdAt: -1 });
            
            if (limit) { 
                const skip = (page - 1) * limit; 
                query = query.skip(skip).limit(limit); 
            }
            
            // MODIFIED: Added .lean() for significantly faster read performance
            const products = await query.lean(); 
            const total = await Product.countDocuments(filter);
            
            return { success: true, count: products.length, total: total, data: products };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.post('/api/products', async (request, reply) => {
        try {
            const { name, category, brand, distributorName, imageUrl, searchTags, variants, hsnCode, taxRate, taxType } = request.body;
            
            const newProduct = new Product({ 
                name, category, brand, distributorName, imageUrl, searchTags, variants, hsnCode, taxRate, taxType 
            });
            
            await newProduct.save();
            return { success: true, message: 'Product added', data: newProduct };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.put('/api/products/:id', async (request, reply) => {
        try {
            const { name, category, brand, distributorName, imageUrl, searchTags, variants, hsnCode, taxRate, taxType } = request.body;
            
            const updateData = { name, category, brand, distributorName, searchTags, variants, hsnCode, taxRate, taxType };
            if (imageUrl !== undefined && imageUrl !== null) {
                updateData.imageUrl = imageUrl;
            }
            
            const updatedProduct = await Product.findByIdAndUpdate(
                request.params.id, 
                { $set: updateData }, 
                { new: true, runValidators: true }
            );
            
            if (!updatedProduct) {
                return reply.status(404).send({ success: false, message: 'Not found' });
            }
            
            return { success: true, message: 'Product updated', data: updatedProduct };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.put('/api/products/:id/restock', async (request, reply) => {
        try {
            const { variantId, invoiceNumber, addedQuantity, purchasingPrice, newSellingPrice } = request.body;
            
            const product = await Product.findById(request.params.id);
            if (!product) {
                return reply.status(404).send({ success: false, message: 'Product not found' });
            }
            
            const variant = product.variants.id(variantId);
            if (!variant) {
                return reply.status(404).send({ success: false, message: 'Variant not found' });
            }
            
            variant.purchaseHistory.push({ 
                invoiceNumber, 
                addedQuantity: Number(addedQuantity), 
                purchasingPrice: Number(purchasingPrice), 
                sellingPrice: Number(newSellingPrice) 
            });
            
            variant.stock += Number(addedQuantity); 
            variant.price = Number(newSellingPrice);
            
            await product.save();
            return { success: true, message: 'Restock processed successfully', data: product };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    // --- NEW: Handle Return To Vendor (RTV) Deductions ---
    fastify.put('/api/products/:id/rtv', async (request, reply) => {
        try {
            const { variantId, distributorName, returnedQuantity, refundAmount, reason } = request.body;
            
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Product not found' });
            
            const variant = product.variants.id(variantId);
            if (!variant) return reply.status(404).send({ success: false, message: 'Variant not found' });
            
            if (variant.stock < returnedQuantity) {
                return reply.status(400).send({ success: false, message: 'Not enough stock to return' });
            }

            variant.returnHistory.push({ 
                distributorName, 
                returnedQuantity: Number(returnedQuantity), 
                refundAmount: Number(refundAmount), 
                reason 
            });
            
            variant.stock -= Number(returnedQuantity); 
            
            await product.save();
            return { success: true, message: 'RTV processed successfully', data: product };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error processing RTV' }); 
        }
    });

    fastify.post('/api/products/bulk', async (request, reply) => {
        try {
            const { products } = request.body;
            if (!Array.isArray(products)) {
                return reply.status(400).send({ success: false, message: 'Invalid format' });
            }
            
            let updatedCount = 0; 
            let insertedCount = 0;
            
            for (const p of products) {
                const result = await Product.updateOne( 
                    { name: p.name }, 
                    { $set: { 
                        category: p.category, 
                        brand: p.brand || '', 
                        distributorName: p.distributorName || '', 
                        imageUrl: p.imageUrl || '', 
                        searchTags: p.searchTags || '', 
                        variants: p.variants || [],
                        hsnCode: p.hsnCode || '', 
                        taxRate: p.taxRate || 0,  
                        taxType: p.taxType || 'Inclusive' 
                    }}, 
                    { upsert: true } 
                );
                
                if (result.upsertedCount > 0) insertedCount++; 
                else if (result.modifiedCount > 0) updatedCount++;
            }
            
            return { success: true, message: `Imported! Added ${insertedCount}, Updated ${updatedCount}.` };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.put('/api/products/:id/toggle', async (request, reply) => {
        try {
            const product = await Product.findById(request.params.id);
            if (!product) {
                return reply.status(404).send({ success: false, message: 'Not found' });
            }
            
            product.isActive = !product.isActive; 
            await product.save();
            
            return { success: true, message: `Toggled`, data: product };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.get('/api/seed', async (request, reply) => {
        try {
            await Category.deleteMany({});
            const sampleCategories = [
                { name: 'Dairy & Breakfast' }, { name: 'Snacks & Munchies' }, 
                { name: 'Cold Drinks & Juices' }, { name: 'Personal Care' }, 
                { name: 'Cleaning Essentials' }, { name: 'Grocery & Kitchen' }
            ];
            await Category.insertMany(sampleCategories);

            await Product.deleteMany({});
            const sampleProducts = [
                { 
                    name: 'Amul Taaza Toned Milk', category: 'Dairy & Breakfast', brand: 'Amul', searchTags: 'milk, liquid, morning, dairy, promo-morning', imageUrl: 'https://m.media-amazon.com/images/I/61H4YpTfGLL._SL1500_.jpg', 
                    hsnCode: '0401', taxRate: 0, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '1 Litre', price: 68, stock: 3, lowStockThreshold: 10, sku: '8901262150171' }] 
                },
                { 
                    name: 'Britannia Fresh White Bread', category: 'Dairy & Breakfast', brand: 'Britannia', searchTags: 'bread, bakery, toast, breakfast, promo-morning', imageUrl: 'https://m.media-amazon.com/images/I/71I3uXhYyPL._SL1500_.jpg', 
                    hsnCode: '1905', taxRate: 0, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '400 g', price: 45, stock: 30, sku: '8901063132030' }] 
                },
                { 
                    name: 'Lay\'s Magic Masala Chips', category: 'Snacks & Munchies', brand: 'Lay\'s', searchTags: 'chips, namkeen, blue, potato, snack, promo-snack', imageUrl: 'https://m.media-amazon.com/images/I/71XmZ7Kq9vL._SL1500_.jpg', 
                    hsnCode: '2005', taxRate: 12, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '50 g', price: 20, stock: 2, lowStockThreshold: 5, sku: '8901491100512' }] 
                },
                { 
                    name: 'Haldiram\'s Aloo Bhujia', category: 'Snacks & Munchies', brand: 'Haldiram', searchTags: 'namkeen, spicy, snack, bhujiya, promo-snack', imageUrl: 'https://m.media-amazon.com/images/I/71+G94Y0U6L._SL1500_.jpg', 
                    hsnCode: '2106', taxRate: 12, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '200 g', price: 55, stock: 80, sku: '8904004400263' }] 
                },
                { 
                    name: 'Pepsi Soft Drink', category: 'Cold Drinks & Juices', brand: 'Pepsi', searchTags: 'cold drink, soda, cola, beverage, promo-summer', imageUrl: 'https://m.media-amazon.com/images/I/51r5I9fWqFL._SL1200_.jpg', 
                    hsnCode: '2202', taxRate: 28, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '750 ml', price: 40, stock: 80, sku: '8902080204144' }] 
                },
                { 
                    name: 'Pears Pure & Gentle Soap', category: 'Personal Care', brand: 'Pears', searchTags: 'bath, body, wash, hygiene', imageUrl: 'https://m.media-amazon.com/images/I/61A83wYQ4oL._SL1500_.jpg', 
                    hsnCode: '3401', taxRate: 18, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '125 g', price: 55, stock: 65, sku: '8901030739941' }] 
                },
                { 
                    name: 'Vim Dishwash Gel Lemon', category: 'Cleaning Essentials', brand: 'Vim', searchTags: 'clean, dishes, liquid, kitchen', imageUrl: 'https://m.media-amazon.com/images/I/51I7s-r-TCL._SL1000_.jpg', 
                    hsnCode: '3402', taxRate: 18, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '250 ml', price: 55, stock: 40, sku: '8901030739942' }] 
                },
                { 
                    name: 'Aashirvaad Shudh Chakki Atta', category: 'Grocery & Kitchen', brand: 'Aashirvaad', searchTags: 'flour, wheat, roti, chapati', imageUrl: 'https://m.media-amazon.com/images/I/81kIitI3KPL._SL1500_.jpg', 
                    hsnCode: '1101', taxRate: 5, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '5 kg', price: 230, stock: 60, sku: '8901725132514' }] 
                }
            ];
            await Product.insertMany(sampleProducts);

            return { success: true, message: 'Database seeded with Low Stock triggers & Tax data!' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error seeding database' });
        }
    });
}

module.exports = productRoutes;
