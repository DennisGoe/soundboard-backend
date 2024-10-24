const express = require('express');
const http = require('http'); // Import http to create server
const socketIo = require('socket.io'); // Import socket.io
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const fileUploadRoutes = require('./routes/fileUpload');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Create an HTTP server and attach Socket.IO
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Replace with your frontend domain for better security
        methods: ["GET", "POST"],
    },
});

// Middleware to parse JSON requests
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Could not connect to MongoDB:', err));

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('New client connected');
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Make io available globally
app.set('io', io);

// Use the authentication routes
app.use('/api/auth', authRoutes);
app.use('/api/files', fileUploadRoutes);

// Start the server
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
