/* routes/index.js */

const fs = require('fs');
const path = require('path');

async function apiRoutes(fastify, options) {
    // Dynamically read all files in the current directory asynchronously
    const routesDir = __dirname;
    const files = await fs.promises.readdir(routesDir);

    for (const file of files) {
        // OPTIMIZED: Strict check ensuring it only registers legitimate route files.
        // Prevent boot errors if a map file or utility JS file is accidentally placed here.
        // NEW: Explicitly ignore systemRoutes.js since it is manually registered in server.js to receive the redisClient.
        if (file !== 'index.js' && file !== 'systemRoutes.js' && file.endsWith('Routes.js')) {
            fastify.register(require(path.join(routesDir, file)));
        }
    }
}

module.exports = apiRoutes;
