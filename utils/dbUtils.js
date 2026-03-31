/* utils/dbUtils.js */

const mongoose = require('mongoose');

exports.withTransaction = async (operation) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const result = await operation(session);
        await session.commitTransaction();
        session.endSession();
        return result;
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        throw error;
    }
};
