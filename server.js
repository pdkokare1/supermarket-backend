const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware configuration
app.use(cors()); // Will allow the Vercel frontend to connect safely
app.use(express.json()); // Allows the server to read JSON data

// Basic Health Check Route
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'Active',
        message: 'Supermarket Backend MVP is running and connected!' 
    });
});

// Database Connection and Server Initialization
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('Successfully connected to MongoDB Atlas');
        
        // Start the server only after DB is connected
        app.listen(PORT, () => {
            console.log(`Live Operations Center backend is listening on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error('Critical Error connecting to MongoDB:', error.message);
    });
