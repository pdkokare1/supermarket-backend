const Product = require('../models/Product');
const Category = require('../models/Category');

async function productRoutes(fastify, options) {
    // GET /api/products
    fastify.get('/api/products', async (request, reply) => {
        try {
            let filter = request.query.all === 'true' ? {} : { isActive: true };
            if (request.query.search) { filter.$or = [ { name: { $regex: request.query.search, $options: 'i' } }, { searchTags: { $regex: request.query.search, $options: 'i' } } ]; }
            if (request.query.category && request.query.category !== 'All') { filter.category = request.query.category; }
            const page = parseInt(request.query.page) || 1; const limit = parseInt(request.query.limit); 
            let query = Product.find(filter).sort({ createdAt: -1 });
            if (limit) { const skip = (page - 1) * limit; query = query.skip(skip).limit(limit); }
            const products = await query; const total = await Product.countDocuments(filter);
            return { success: true, count: products.length, total: total, data: products };
        } catch (error) { fastify.log.error(error); reply.status(500).send({ success: false, message: 'Server Error' }); }
    });

    // POST /api/products 
    fastify.post('/api/products', async (request, reply) => {
        try {
            const { name, category, brand, distributorName, imageUrl, searchTags, variants } = request.body;
            const newProduct = new Product({ name, category, brand, distributorName, imageUrl, searchTags, variants });
            await newProduct.save();
            return { success: true, message: 'Product added', data: newProduct };
        } catch (error) { fastify.log.error(error); reply.status(500).send({ success: false, message: 'Server Error' }); }
    });

    // PUT /api/products/:id 
    fastify.put('/api/products/:id', async (request, reply) => {
        try {
            const { name, category, brand, distributorName, imageUrl, searchTags, variants } = request.body;
            const updateData = { name, category, brand, distributorName, searchTags, variants };
            if (imageUrl !== undefined && imageUrl !== null) updateData.imageUrl = imageUrl;
            const updatedProduct = await Product.findByIdAndUpdate(request.params.id, { $set: updateData }, { new: true, runValidators: true });
            if (!updatedProduct) return reply.status(404).send({ success: false, message: 'Not found' });
            return { success: true, message: 'Product updated', data: updatedProduct };
        } catch (error) { fastify.log.error(error); reply.status(500).send({ success: false, message: 'Server Error' }); }
    });

    // PUT /api/products/:id/restock 
    fastify.put('/api/products/:id/restock', async (request, reply) => {
        try {
            const { variantId, invoiceNumber, addedQuantity, purchasingPrice, newSellingPrice } = request.body;
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Product not found' });
            const variant = product.variants.id(variantId);
            if (!variant) return reply.status(404).send({ success: false, message: 'Variant not found' });
            variant.purchaseHistory.push({ invoiceNumber, addedQuantity: Number(addedQuantity), purchasingPrice: Number(purchasingPrice), sellingPrice: Number(newSellingPrice) });
            variant.stock += Number(addedQuantity); variant.price = Number(newSellingPrice);
            await product.save();
            return { success: true, message: 'Restock processed successfully', data: product };
        } catch (error) { fastify.log.error(error); reply.status(500).send({ success: false, message: 'Server Error' }); }
    });

    // POST /api/products/bulk 
    fastify.post('/api/products/bulk', async (request, reply) => {
        try {
            const { products } = request.body;
            if (!Array.isArray(products)) return reply.status(400).send({ success: false, message: 'Invalid format' });
            let updatedCount = 0; let insertedCount = 0;
            for (const p of products) {
                const result = await Product.updateOne( { name: p.name }, { $set: { category: p.category, brand: p.brand || '', distributorName: p.distributorName || '', imageUrl: p.imageUrl || '', searchTags: p.searchTags || '', variants: p.variants || [] }}, { upsert: true } );
                if (result.upsertedCount > 0) insertedCount++; else if (result.modifiedCount > 0) updatedCount++;
            }
            return { success: true, message: `Imported! Added ${insertedCount}, Updated ${updatedCount}.` };
        } catch (error) { fastify.log.error(error); reply.status(500).send({ success: false, message: 'Server Error' }); }
    });

    // PUT /api/products/:id/toggle 
    fastify.put('/api/products/:id/toggle', async (request, reply) => {
        try {
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Not found' });
            product.isActive = !product.isActive; await product.save();
            return { success: true, message: `Toggled`, data: product };
        } catch (error) { fastify.log.error(error); reply.status(500).send({ success: false, message: 'Server Error' }); }
    });

    // GET /api/seed - UPDATED TO MATCH NEW SCREENSHOTS
    fastify.get('/api/seed', async (request, reply) => {
        try {
            await Category.deleteMany({});
            const sampleCategories = [
                { name: 'Dairy, Bread & Eggs' }, { name: 'Snacks & Drinks' }, 
                { name: 'Grocery & Kitchen' }, { name: 'Beauty & Personal Care' }, 
                { name: 'Home Essentials' }
            ];
            await Category.insertMany(sampleCategories);

            await Product.deleteMany({});
            const sampleProducts = [
                // Snacks & Drinks
                { name: 'Lay\'s Magic Masala Chips', category: 'Snacks & Drinks', brand: 'Lay\'s', distributorName: 'PepsiCo', searchTags: 'chips, namkeen, blue, potato', imageUrl: 'https://m.media-amazon.com/images/I/71XmZ7Kq9vL._SL1500_.jpg', variants: [{ weightOrVolume: '50 g', price: 20, stock: 100, sku: '8901491100512' }] },
                { name: 'Cadbury Dairy Milk Silk', category: 'Snacks & Drinks', brand: 'Cadbury', distributorName: 'Mondelez', searchTags: 'chocolate, sweet, bar', imageUrl: 'https://m.media-amazon.com/images/I/61y8BhhV7+L._SL1500_.jpg', variants: [{ weightOrVolume: '60 g', price: 80, stock: 50, sku: '7622201402263' }] },
                { name: 'Pepsi Soft Drink Bottle', category: 'Snacks & Drinks', brand: 'Pepsi', distributorName: 'PepsiCo', searchTags: 'cold drink, soda, cola, beverage', imageUrl: 'https://m.media-amazon.com/images/I/51r5I9fWqFL._SL1200_.jpg', variants: [{ weightOrVolume: '750 ml', price: 40, stock: 80, sku: '8902080204144' }] },
                { name: 'Nescafe Classic Coffee', category: 'Snacks & Drinks', brand: 'Nescafe', distributorName: 'Nestle', searchTags: 'tea, coffee, caffeine, morning', imageUrl: 'https://m.media-amazon.com/images/I/71pE1Q5NnDL._SL1500_.jpg', variants: [{ weightOrVolume: '50 g', price: 160, stock: 40, sku: '8901058814729' }] },
                
                // Grocery & Kitchen
                { name: 'Aashirvaad Shudh Chakki Atta', category: 'Grocery & Kitchen', brand: 'Aashirvaad', distributorName: 'ITC', searchTags: 'flour, wheat, roti, chapati', imageUrl: 'https://m.media-amazon.com/images/I/81kIitI3KPL._SL1500_.jpg', variants: [{ weightOrVolume: '5 kg', price: 230, stock: 60, sku: '8901725132514' }] },
                { name: 'Fortune Sunlite Refined Sunflower Oil', category: 'Grocery & Kitchen', brand: 'Fortune', distributorName: 'Adani Wilmar', searchTags: 'oil, ghee, cooking', imageUrl: 'https://m.media-amazon.com/images/I/61k9H6M5pHL._SL1500_.jpg', variants: [{ weightOrVolume: '1 Litre', price: 145, stock: 90, sku: '8906007270213' }] },
                { name: 'Tata Salt Lite', category: 'Grocery & Kitchen', brand: 'Tata', distributorName: 'Tata Consumer', searchTags: 'salt, namak, sodium', imageUrl: 'https://m.media-amazon.com/images/I/61zLz6T8mPL._SL1500_.jpg', variants: [{ weightOrVolume: '1 kg', price: 45, stock: 120, sku: '8904004400262' }] },
                
                // Dairy, Bread & Eggs
                { name: 'Amul Taaza Toned Milk', category: 'Dairy, Bread & Eggs', brand: 'Amul', distributorName: 'GCMMF', searchTags: 'milk, liquid, dairy', imageUrl: 'https://m.media-amazon.com/images/I/61H4YpTfGLL._SL1500_.jpg', variants: [{ weightOrVolume: '1 Litre', price: 68, stock: 150, sku: '8901262150171' }] },
                { name: 'Britannia Daily Fresh White Bread', category: 'Dairy, Bread & Eggs', brand: 'Britannia', distributorName: 'Britannia Ind', searchTags: 'bread, bakery, toast', imageUrl: 'https://m.media-amazon.com/images/I/71I3uXhYyPL._SL1500_.jpg', variants: [{ weightOrVolume: '400 g', price: 45, stock: 30, sku: '8901063132030' }] },
                { name: 'Farm Fresh White Eggs', category: 'Dairy, Bread & Eggs', brand: 'Farm Fresh', distributorName: 'Local Farms', searchTags: 'anda, protein, poultry', imageUrl: 'https://m.media-amazon.com/images/I/61bM5YfWdXL._SL1500_.jpg', variants: [{ weightOrVolume: '6 Pack', price: 48, stock: 45, sku: 'DP-EGG-006' }] },

                // Beauty & Personal Care
                { name: 'Pears Pure & Gentle Soap', category: 'Beauty & Personal Care', brand: 'Pears', distributorName: 'HUL', searchTags: 'bath, body, wash, hygiene', imageUrl: 'https://m.media-amazon.com/images/I/61A83wYQ4oL._SL1500_.jpg', variants: [{ weightOrVolume: '125 g', price: 55, stock: 65, sku: '8901030739941' }] },
                { name: 'Tresemme Keratin Smooth Shampoo', category: 'Beauty & Personal Care', brand: 'Tresemme', distributorName: 'HUL', searchTags: 'hair, care, wash', imageUrl: 'https://m.media-amazon.com/images/I/51r5I9fWqFL._SL1200_.jpg', variants: [{ weightOrVolume: '340 ml', price: 299, stock: 25, sku: '8901030612183' }] }
            ];
            await Product.insertMany(sampleProducts);

            return { success: true, message: 'Database successfully seeded with Branded Quick-Commerce layout!' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error seeding database' });
        }
    });
}

module.exports = productRoutes;
