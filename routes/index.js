/* routes/index.js */

async function apiRoutes(fastify, options) {
    // --- Feature Routes ---
    fastify.register(require('./productRoutes'));
    fastify.register(require('./productOpsRoutes')); 
    fastify.register(require('./orderRoutes'));
    fastify.register(require('./customerRoutes')); 
    fastify.register(require('./categoryRoutes'));
    fastify.register(require('./brandRoutes')); 
    fastify.register(require('./distributorRoutes')); 
    fastify.register(require('./expenseRoutes')); 
    fastify.register(require('./authRoutes')); 
    fastify.register(require('./staffRoutes')); 
    fastify.register(require('./promotionRoutes')); 
    fastify.register(require('./shiftRoutes'));
    fastify.register(require('./storeRoutes'));
    fastify.register(require('./registerRoutes'));
    fastify.register(require('./migrateRoute'));
    fastify.register(require('./settingsRoutes'));
    fastify.register(require('./auditRoutes'));
    fastify.register(require('./analyticsRoutes'));
}

module.exports = apiRoutes;
