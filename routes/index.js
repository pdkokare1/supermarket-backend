/* routes/index.js */

async function apiRoutes(fastify, options) {
    // Explicit registration for performance and maintainability.
    // This avoids dynamic file scanning at runtime.
    
    fastify.register(require('./authRoutes'));
    fastify.register(require('./customerRoutes'));
    fastify.register(require('./productRoutes'));
    fastify.register(require('./productOpsRoutes'));
    fastify.register(require('./orderRoutes'));
    fastify.register(require('./analyticsRoutes'));
    fastify.register(require('./storeRoutes'));
    fastify.register(require('./staffRoutes'));
    fastify.register(require('./shiftRoutes'));
    fastify.register(require('./promotionRoutes'));
    fastify.register(require('./expenseRoutes'));
    fastify.register(require('./distributorRoutes'));
    fastify.register(require('./categoryRoutes'));
    fastify.register(require('./brandRoutes'));
    fastify.register(require('./auditRoutes'));
    fastify.register(require('./registerRoutes'));
    fastify.register(require('./settingsRoutes'));
}

module.exports = apiRoutes;
