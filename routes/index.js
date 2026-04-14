/* routes/index.js */
'use strict';

const path = require('path');
const autoLoad = require('@fastify/autoload');

async function apiRoutes(fastify, options) {
    // OPTIMIZATION: Enterprise Auto-loading routes
    // Dynamically registers all route files in this directory automatically
    fastify.register(autoLoad, {
        dir: path.join(__dirname),
        ignorePattern: /index\.js/, // Ignore this index file to prevent looping
        options: Object.assign({}, options)
    });
}

module.exports = apiRoutes;
