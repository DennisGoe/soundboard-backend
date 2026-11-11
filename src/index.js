const http = require('http'); // Import http to create server
const socketIo = require('socket.io'); // Import socket.io
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { createApp } = require('./app');
const { seedExampleMap } = require('./seedExampleMap');

dotenv.config();

const app = createApp();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('Connected to MongoDB');
        seedExampleMap();
    })
    .catch(err => console.error('Could not connect to MongoDB:', err));

io.on('connection', (socket) => {
    console.log('New client connected');
    socket.on('playSound', (data) => {
        console.log(`${data.user} played sound: ${data.sound.name}`);
        io.emit('playSound', data.sound);
        io.emit("log", `${new Date().toLocaleTimeString("de-DE", { hour12: false })} ${data.user} played sound: ${data.sound.name}`)
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

app.set('io', io);

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
