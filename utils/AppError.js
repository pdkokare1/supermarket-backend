/* utils/AppError.js */

class AppError extends Error {
    constructor(message, statusCode, extraData = {}) {
        super(message);
        this.statusCode = statusCode;
        
        // This safely attaches extra data (like user objects or reasons) directly to the error 
        // so that existing controller catch blocks can read them without breaking.
        Object.assign(this, extraData);
        
        // Captures the stack trace, keeping it clean for debugging
        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports = AppError;
