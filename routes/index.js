/* routes/index.js */

const fs = require('fs');
const path = require('path');

async function apiRoutes(fastify, options) {
    const routesDir = __dirname;
    
    // OPTIMIZED: Asynchronous directory reading ensures the Node.js event loop
    // is not blocked while the server registers routes.
    const files = await fs.promises.readdir(routesDir);

    for (const file of files) {
        // Strict check ensuring it only registers legitimate route files.
        // Explicitly ignore systemRoutes.js since it is manually registered in server.js to receive the redisClient.
        if (file !== 'index.js' && file !== 'systemRoutes.js' && file.endsWith('Routes.js')) {
            fastify.register(require(path.join(routesDir, file)));
        }
    }
}

module.exports = apiRoutes;
