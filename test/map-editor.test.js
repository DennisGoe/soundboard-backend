// Backend-Test fuer kind='2d-editor'-Karten. Prueft Validierung, Owner-Schutz
// und das Live-Update-Event. Ausfuehren: node test/map-editor.test.js

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
const { createApp } = require('../src/app');
const { attachSocket } = require('../src/socket');
const socketIo = require('socket.io');
const ClientIO = require('socket.io-client');
const Map = require('../src/models/Map');
const Campaign = require('../src/models/Campaign');
const User = require('../src/models/User');

function tokenFor(userId) {
    return jwt.sign({ user: { id: String(userId) } }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function req(server, method, path, { token, body } = {}) {
    const port = server.address().port;
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const opts = {
        host: '127.0.0.1', port, path, method,
        headers: {},
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (payload != null) {
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    return await new Promise((resolve, reject) => {
        const r = http.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) {}
                resolve({ status: res.statusCode, body: json, raw: data });
            });
        });
        r.on('error', reject);
        if (payload != null) r.write(payload);
        r.end();
    });
}

function section(name) { console.log(`\n--- ${name} ---`); }
function ok(desc) { console.log(`  OK   ${desc}`); }
function fail(desc, extra) {
    console.log(`  FAIL ${desc}${extra ? ' :: ' + extra : ''}`);
    process.exitCode = 1;
}

// Minimal gueltiges Editor-Doc.
function sampleDoc(w = 10, h = 8) {
    return {
        kind: '2d-editor',
        width: w,
        height: h,
        tileSize: 5,
        floor: Array.from({ length: w * h }, () => 0),
        walls: [],
        objects: [],
        labels: [],
    };
}

(async () => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri(), { dbName: 'map-editor-test' });

    const app = createApp({ includeFileUploads: false });
    const server = http.createServer(app);
    const io = socketIo(server, { cors: { origin: '*' } });
    attachSocket(io);
    app.set('io', io);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    const userA = await User.create({ username: 'ueno', password: 'x' });
    const userB = await User.create({ username: 'player', password: 'x' });
    const tokA = tokenFor(userA._id);
    const tokB = tokenFor(userB._id);

    try {
        section('POST /api/maps (kind=2d-editor)');
        let r = await req(server, 'POST', '/api/maps', {
            token: tokA, body: { name: 'Meine Karte', kind: '2d-editor', doc: sampleDoc(12, 10) },
        });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.body.map.kind, '2d-editor');
        assert.strictEqual(r.body.map.doc.floor.length, 120);
        const mapId = r.body.map._id;
        ok('Editor-Karte angelegt (12x10 Felder)');

        section('Validation beim POST');
        // width/height out of range
        r = await req(server, 'POST', '/api/maps', {
            token: tokA, body: { name: 'bad', kind: '2d-editor', doc: { ...sampleDoc(), width: 300 } },
        });
        assert.strictEqual(r.status, 400);
        ok('width > 200 -> 400');
        r = await req(server, 'POST', '/api/maps', {
            token: tokA, body: { name: 'bad', kind: '2d-editor', doc: { ...sampleDoc(), floor: [] } },
        });
        assert.strictEqual(r.status, 400);
        ok('floor length mismatch -> 400');
        r = await req(server, 'POST', '/api/maps', {
            token: tokA, body: { name: 'bad', kind: '2d-editor', doc: {
                ...sampleDoc(),
                walls: [{ a: [0, 0], b: [1, 0], kind: 'zomb' }],
            }},
        });
        assert.strictEqual(r.status, 400);
        ok('wall.kind unbekannt -> 400');
        r = await req(server, 'POST', '/api/maps', {
            token: tokA, body: { name: 'bad', kind: '2d-editor', doc: {
                ...sampleDoc(),
                objects: [{ type: 'tree', x: 'nein', y: 1 }],
            }},
        });
        assert.strictEqual(r.status, 400);
        ok('object.x nicht Number -> 400');

        section('PUT /:id (nur Owner, 2d-editor-Validierung)');
        r = await req(server, 'PUT', `/api/maps/${mapId}`, {
            token: tokB, body: { doc: sampleDoc(12, 10) },
        });
        assert.strictEqual(r.status, 403);
        ok('Fremder -> 403');
        const okDoc = sampleDoc(12, 10);
        okDoc.walls.push({ a: [0, 0], b: [1, 0], kind: 'wall' });
        okDoc.objects.push({ type: 'tree', x: 2.5, y: 3.5, rot: 0 });
        okDoc.labels.push({ x: 1.5, y: 1.5, text: 'Taverne' });
        r = await req(server, 'PUT', `/api/maps/${mapId}`, {
            token: tokA, body: { doc: okDoc },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.map.doc.walls.length, 1);
        assert.strictEqual(r.body.map.doc.objects.length, 1);
        assert.strictEqual(r.body.map.doc.labels.length, 1);
        ok('Wand+Objekt+Label werden gespeichert');

        r = await req(server, 'PUT', `/api/maps/${mapId}`, {
            token: tokA, body: { doc: { ...okDoc, width: 3 } },
        });
        assert.strictEqual(r.status, 400);
        ok('PUT mit ungueltigem Doc -> 400');

        section('Live-Push: campaign:mapUpdated');
        // Kampagne mit activeMap = unsere Karte.
        const camp = await Campaign.create({
            name: 'Test-Kampagne', owner: userA._id, mapIds: [mapId], activeMapId: mapId,
            players: [userB._id],
        });
        const url = `http://127.0.0.1:${port}`;
        const client = ClientIO(url, { auth: { token: tokB }, transports: ['websocket'] });
        await new Promise((resolve, reject) => {
            client.once('connect', resolve);
            client.once('connect_error', reject);
        });
        const joinAck = await new Promise((resolve) => {
            client.emit('campaign:join', { campaignId: String(camp._id) }, resolve);
        });
        assert.strictEqual(joinAck.ok, true);

        const pushPromise = new Promise((resolve) => {
            client.once('campaign:mapUpdated', resolve);
        });

        // PUT auf die Map triggert broadcastMapUpdate.
        const nextDoc = sampleDoc(12, 10);
        nextDoc.floor[0] = 3; // irgendeine Aenderung
        r = await req(server, 'PUT', `/api/maps/${mapId}`, {
            token: tokA, body: { doc: nextDoc },
        });
        assert.strictEqual(r.status, 200);
        const pushed = await Promise.race([
            pushPromise,
            new Promise((_, rej) => setTimeout(() => rej(new Error('push timeout')), 3000)),
        ]);
        assert.strictEqual(pushed.campaignId, String(camp._id));
        assert.strictEqual(pushed.mapId, String(mapId));
        assert.ok(pushed.map && pushed.map.doc, 'payload has doc');
        assert.strictEqual(pushed.map.doc.floor[0], 3);
        ok('mapUpdated-Event enthaelt neuen Doc-Inhalt');

        client.disconnect();

        section('Image-Karten bleiben unberuehrt');
        // Keine Regression: 2d-image-Karte laesst sich nicht als Editor-Doc umwandeln.
        const img = await Map.create({ name: 'Bild', owner: userA._id, kind: '2d-image', imageUrl: 'http://x', doc: {} });
        r = await req(server, 'PUT', `/api/maps/${img._id}`, {
            token: tokA, body: { doc: { foo: 'bar' } },
        });
        assert.strictEqual(r.status, 200);
        ok('PUT auf 2d-image mit freiem Doc -> 200 (keine Editor-Validierung)');

        section('Zusammenfassung');
        console.log(process.exitCode ? 'ERGEBNIS: FAIL' : 'ERGEBNIS: OK');
    } catch (e) {
        console.error('Test error:', e);
        process.exitCode = 1;
    } finally {
        try { io.close(); } catch {}
        await new Promise((r) => server.close(r));
        await mongoose.disconnect();
        await mem.stop();
    }
})();
