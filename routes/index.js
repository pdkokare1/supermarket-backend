/* routes/index.js */
'use strict';

const fs = require('fs');
const path = require('path');

async function apiRoutes(fastify, options) {
    // OPTIMIZATION: Enterprise native route loader.
    // Replaces @fastify/autoload to completely eliminate infinite recursion crashes 
    // and safely skip manually registered system routes.
    
    const routesPath = __dirname;
    const files = fs.readdirSync(routesPath);

    for (const file of files) {
        // Prevent recursive loop and duplicate route registration
        if (file === 'index.js' || file === 'systemRoutes.js') {
            continue;
        }
        
        // Only register valid JavaScript files
        if (file.endsWith('.js')) {
            fastify.register(require(path.join(routesPath, file)), options);
        }
    }
}

module.exports = apiRoutes;
