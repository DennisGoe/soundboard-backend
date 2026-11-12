// Backend-Tests fuer Runde 3d: erweiterter Editor-Doc-Validator + Asset-API.
// Ausfuehren: node test/map-editor-r3d.test.js

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
const { createApp } = require('../src/app');
const { validateEditorDoc } = require('../src/routes/maps');
const User = require('../src/models/User');
const UserAsset = require('../src/models/UserAsset');

function tokenFor(userId) {
    return jwt.sign({ user: { id: String(userId) } }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function req(server, method, path, { token, body } = {}) {
    const port = server.address().port;
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const opts = { host: '127.0.0.1', port, path, method, headers: {} };
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
    await mongoose.connect(mem.getUri(), { dbName: 'r3d-test' });

    const app = createApp({ includeFileUploads: false });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        section('validateEditorDoc — neue Felder');
        {
            const doc = sampleDoc(6, 4);
            doc.overlay = Array.from({ length: 24 }, () => 0);
            doc.overlayMat = Array.from({ length: 24 }, () => 0);
            const err = validateEditorDoc(doc);
            if (err) fail('overlay/overlayMat gueltig akzeptiert', err); else ok('overlay/overlayMat gueltig');
        }
        {
            const doc = sampleDoc(4, 4);
            doc.overlay = [0, 1, 2]; // falsche Laenge
            const err = validateEditorDoc(doc);
            if (err && err.includes('overlay length')) ok('overlay falsche Laenge abgelehnt');
            else fail('overlay falsche Laenge nicht erkannt', err || 'kein Fehler');
        }
        {
            const doc = sampleDoc(4, 4);
            doc.overlay = new Array(16).fill(0);
            doc.overlay[0] = 999; // out of 0..255
            const err = validateEditorDoc(doc);
            if (err && err.includes('overlay entry')) ok('overlay-Range abgelehnt');
            else fail('overlay-Range nicht erkannt', err || 'kein Fehler');
        }
        {
            const doc = sampleDoc(4, 4);
            doc.walls.push({ id: 'w1', a: [0, 0], b: [1, 0], kind: 'window', style: 'wood' });
            const err = validateEditorDoc(doc);
            if (err) fail('window/wood-Wand akzeptieren', err); else ok('wand.kind=window, style=wood akzeptiert');
        }
        {
            const doc = sampleDoc(4, 4);
            doc.walls.push({ id: 'w1', a: [0, 0], b: [1, 0], kind: 'portcullis' });
            const err = validateEditorDoc(doc);
            if (err && err.includes('wall.kind')) ok('unbekannte wand.kind abgelehnt');
            else fail('unbekannte wand.kind nicht erkannt', err || 'kein Fehler');
        }
        {
            const doc = sampleDoc(4, 4);
            doc.walls.push({ id: 'w1', a: [0, 0], b: [1, 0], style: 'brick' });
            const err = validateEditorDoc(doc);
            if (err && err.includes('wall.style')) ok('unbekannte wand.style abgelehnt');
            else fail('unbekannte wand.style nicht erkannt', err || 'kein Fehler');
        }
        {
            const doc = sampleDoc(4, 4);
            doc.objects.push({ id: 'o1', type: 'house-small', x: 2, y: 2, sizeX: 2.5, sizeY: 2.5, flipX: true, layer: 'below' });
            const err = validateEditorDoc(doc);
            if (err) fail('erw. Objekt-Felder akzeptiert', err); else ok('obj.sizeX/sizeY/flipX/layer akzeptiert');
        }
        {
            const doc = sampleDoc(4, 4);
            doc.objects.push({ id: 'o1', type: 'tree', x: 1, y: 1, scale: 999 });
            const err = validateEditorDoc(doc);
            if (err && err.includes('scale')) ok('obj.scale > 8 abgelehnt');
            else fail('obj.scale nicht gecapt', err || 'kein Fehler');
        }
        {
            const doc = sampleDoc(4, 4);
            doc.objects.push({ id: 'o1', type: 'tree', x: 1, y: 1, layer: 'floor' });
            const err = validateEditorDoc(doc);
            if (err && err.includes('layer')) ok('obj.layer "floor" abgelehnt');
            else fail('obj.layer nicht validiert', err || 'kein Fehler');
        }
        {
            const doc = sampleDoc(10, 10);
            doc.paths = [{
                id: 'p1', kind: 'road', points: [[1, 1], [5, 1], [5, 5]], width: 0.8, material: 2,
            }];
            const err = validateEditorDoc(doc);
            if (err) fail('path.road akzeptiert', err); else ok('path.road gueltig');
        }
        {
            const doc = sampleDoc(10, 10);
            doc.paths = [{ id: 'p1', kind: 'alien', points: [[1, 1], [2, 2]], width: 1, material: 0 }];
            const err = validateEditorDoc(doc);
            if (err && err.includes('path.kind')) ok('path.kind "alien" abgelehnt');
            else fail('path.kind nicht validiert', err || 'kein Fehler');
        }
        {
            const doc = sampleDoc(10, 10);
            doc.paths = [{ id: 'p1', kind: 'road', points: [[1, 1]], width: 1, material: 0 }];
            const err = validateEditorDoc(doc);
            if (err && err.includes('path.points')) ok('Pfad mit < 2 Punkten abgelehnt');
            else fail('path.points min-Laenge nicht validiert', err || 'kein Fehler');
        }
        {
            const doc = sampleDoc(10, 10);
            doc.paths = [{ id: 'p1', kind: 'road', points: [[1, 1], [5, 5]], width: 999, material: 0 }];
            const err = validateEditorDoc(doc);
            if (err && err.includes('path.width')) ok('path.width-Grenze greift');
            else fail('path.width nicht gecapt', err || 'kein Fehler');
        }

        section('/api/assets — REST');
        const alice = await User.create({ username: 'alice', password: 'x' });
        const bob = await User.create({ username: 'bob', password: 'x' });
        const aT = tokenFor(alice._id);
        const bT = tokenFor(bob._id);

        // Alice hat zwei Assets, Bob keine (direkt via Model, da Upload nur mit Firebase funktioniert).
        const a1 = await UserAsset.create({ owner: alice._id, name: 'Felsfigur', category: 'natur', tags: ['fels','deko'], imageUrl: 'https://example.com/a.png', width: 1, height: 1 });
        const a2 = await UserAsset.create({ owner: alice._id, name: 'Stuhl-Custom', category: 'moebel', tags: ['stuhl'], imageUrl: 'https://example.com/b.png', width: 1, height: 1 });

        {
            const r = await req(server, 'GET', '/api/assets', { token: aT });
            if (r.status === 200 && Array.isArray(r.body.assets) && r.body.assets.length === 2) ok('Alice sieht ihre 2 Assets');
            else fail('GET /api/assets (Alice)', JSON.stringify(r));
        }
        {
            const r = await req(server, 'GET', '/api/assets', { token: bT });
            if (r.status === 200 && r.body.assets.length === 0) ok('Bob sieht Alices Assets NICHT');
            else fail('GET /api/assets (Bob)', JSON.stringify(r));
        }
        {
            const r = await req(server, 'PUT', `/api/assets/${a1._id}`, { token: aT, body: { name: 'Fels', tags: ['gross'], category: 'natur' } });
            if (r.status === 200 && r.body.asset.name === 'Fels') ok('PUT /api/assets rename');
            else fail('PUT /api/assets', JSON.stringify(r));
        }
        {
            const r = await req(server, 'PUT', `/api/assets/${a1._id}`, { token: aT, body: { category: 'BÖSE kategorie!' } });
            if (r.status === 200 && r.body.asset.category === 'eigene') ok('PUT /api/assets sanitize Kategorie');
            else fail('Kategorie-Sanitizer', JSON.stringify(r));
        }
        {
            const r = await req(server, 'PUT', `/api/assets/${a1._id}`, { token: bT, body: { name: 'HiHi' } });
            if (r.status === 404) ok('PUT fremdes Asset -> 404');
            else fail('Owner-Check PUT', JSON.stringify(r));
        }
        {
            const r = await req(server, 'DELETE', `/api/assets/${a1._id}`, { token: bT });
            if (r.status === 404) ok('DELETE fremdes Asset -> 404');
            else fail('Owner-Check DELETE', JSON.stringify(r));
        }
        {
            const r = await req(server, 'DELETE', `/api/assets/${a2._id}`, { token: aT });
            if (r.status === 200) ok('DELETE eigenes Asset');
            else fail('DELETE eigenes Asset', JSON.stringify(r));
        }

        section('maps POST/PUT mit erweitertem Doc');
        // Beispiel einer Karte mit overlay + paths + layer
        {
            const doc = sampleDoc(8, 6);
            doc.overlay = new Array(48).fill(0);
            doc.overlayMat = new Array(48).fill(0);
            doc.paths = [{ id: 'p1', kind: 'road', points: [[1, 1], [6, 1]], width: 0.7, material: 3 }];
            doc.objects.push({ id: 'o1', type: 'house-small', x: 3, y: 3, rot: 0, sizeX: 2, sizeY: 2, layer: 'below' });
            const r = await req(server, 'POST', '/api/maps', { token: aT, body: { name: 'r3d', kind: '2d-editor', doc } });
            if (r.status === 201) ok('POST /api/maps mit overlay+paths+layer');
            else fail('POST /api/maps', JSON.stringify(r));
        }
        {
            const doc = sampleDoc(8, 6);
            doc.objects.push({ id: 'o1', type: 'x', x: 1, y: 1, sizeX: 999 });
            const r = await req(server, 'POST', '/api/maps', { token: aT, body: { name: 'bad', kind: '2d-editor', doc } });
            if (r.status === 400 && r.body?.msg?.includes('sizeX')) ok('POST obj.sizeX gecapt');
            else fail('POST obj.sizeX gecapt', JSON.stringify(r));
        }
    } finally {
        await new Promise((r) => server.close(r));
        await mongoose.disconnect();
        await mem.stop();
    }

    console.log(`\nDone. exitCode=${process.exitCode || 0}`);
    process.exit(process.exitCode || 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
