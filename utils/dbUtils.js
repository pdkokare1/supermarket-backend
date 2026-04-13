/* utils/dbUtils.js */

const mongoose = require('mongoose');

// Helper for Exponential Backoff during network blips
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

exports.withTransaction = async (operation) => {
    const MAX_RETRIES = 3;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
        const session = await mongoose.startSession();
        session.startTransaction();
        
        try {
            const result = await operation(session);
            
            // Enterprise Optimization: Handle commit-specific network drops
            let commitAttempt = 0;
            while (commitAttempt < MAX_RETRIES) {
                try {
                    await session.commitTransaction();
                    break; // Success
                } catch (commitError) {
                    if (commitError.hasErrorLabel && commitError.hasErrorLabel('UnknownTransactionCommitResult')) {
                        commitAttempt++;
                        await sleep(100 * Math.pow(2, commitAttempt)); // Exponential backoff: 200ms, 400ms...
                        continue;
                    }
                    throw commitError; // Bubble up to the outer catch if it's not a commit timeout
                }
            }
            
            session.endSession();
            return result;
        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            
            // Enterprise Optimization: Handle general transaction network blips or Replica Set elections
            if (error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError')) {
                attempt++;
                if (attempt >= MAX_RETRIES) throw error; // Max retries reached, fail gracefully
                
                console.warn(`[DB_TRANSACTION] Transient blip caught. Retrying attempt ${attempt}...`);
                await sleep(100 * Math.pow(2, attempt)); 
                continue;
            }
            
            // Standard logic error (e.g., Validation Error, AppError), throw immediately without retrying
            throw error; 
        }
    }
};
