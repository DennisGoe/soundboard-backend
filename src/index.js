const http = require('http');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { createApp } = require('./app');
const { seedExampleMap } = require('./seedExampleMap');
const { attachSocket } = require('./socket');

dotenv.config();

const app = createApp();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

mongoose
    .connect(process.env.MONGO_URI)
    .then(() => {
        console.log('Connected to MongoDB');
        seedExampleMap();
    })
    .catch((err) => console.error('Could not connect to MongoDB:', err));

attachSocket(io);

app.set('io', io);

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
