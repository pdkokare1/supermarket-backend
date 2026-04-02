/* utils/catchAsync.js */

const { handleControllerError } = require('./errorUtils');

/**
 * Wraps an async route handler to automatically catch errors 
 * and pass them to the standardized error handler.
 */
const catchAsync = (fn, contextMessage) => {
    return async (request, reply) => {
        try {
            return await fn(request, reply);
        } catch (error) {
            handleControllerError(request, reply, error, contextMessage);
        }
    };
};

module.exports = catchAsync;
