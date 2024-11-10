const express = require('express');
const http = require('http'); // Import http to create server
const socketIo = require('socket.io'); // Import socket.io
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const fileUploadRoutes = require('./routes/fileUpload');
const favoritesRoutes = require("./routes/favorites")

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Could not connect to MongoDB:', err));

io.on('connection', (socket) => {
    console.log('New client connected');
    socket.on('playSound', (data) => {
        console.log(`${data.user} played sound: ${data.sound.name}`);
        io.emit('playSound', data.sound);
        io.emit("log", `${new Date().toLocaleTimeString()} ${data.user} played sound: ${data.sound.name}`)
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

app.set('io', io);

app.use('/api/auth', authRoutes);
app.use('/api/files', fileUploadRoutes);
app.use('/api/favorites', favoritesRoutes)

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
