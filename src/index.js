const http = require('http');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { createApp } = require('./app');
const { seedExampleMap } = require('./seedExampleMap');
const { attachSocket } = require('./socket');
const { runFackelMigration } = require('./lightingOps');
const MapLighting = require('./models/MapLighting');

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
        // Einmalige, idempotente Migration der Fackel-Lichter 20/20 -> 2.5/2.5
        // (Runde 3e). Darf Startup nicht blockieren.
        runFackelMigration(MapLighting).catch((e) =>
            console.error('Fackel migration failed:', e)
        );
    })
    .catch((err) => console.error('Could not connect to MongoDB:', err));

attachSocket(io);

app.set('io', io);

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
