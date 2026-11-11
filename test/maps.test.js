// Backend-Test fuer /api/maps. Startet eine In-Memory-Mongo, mountet den
// Router hinter authMiddleware, und prueft die wichtigsten Pfade.
// Ausfuehren: node test/maps.test.js  (nutzt NIE die Produktions-DB.)

const assert = require('assert');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
const mapsRoutes = require('../src/routes/maps');
const Map = require('../src/models/Map');
const { seedExampleMap, EXAMPLE_NAME } = require('../src/seedExampleMap');

function tokenFor(userId) {
    return jwt.sign({ user: { id: String(userId) } }, process.env.JWT_SECRET, {
        expiresIn: '1h',
    });
}

async function req(server, method, path, { token, body } = {}) {
    const port = server.address().port;
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const opts = {
        host: '127.0.0.1',
        port,
        path,
        method,
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
                try { json = data ? JSON.parse(data) : null; } catch (e) { /* non-JSON ok */ }
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

(async () => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri(), { dbName: 'maps-test' });

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/maps', mapsRoutes);
    const server = http.createServer(app).listen(0);

    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();
    const tokA = tokenFor(userA);
    const tokB = tokenFor(userB);

    try {
        section('Seeding');
        await seedExampleMap();
        const exampleCount1 = await Map.countDocuments({ isExample: true });
        assert.strictEqual(exampleCount1, 1);
        ok('Beispiel-Karte angelegt');
        await seedExampleMap();
        const exampleCount2 = await Map.countDocuments({ isExample: true });
        assert.strictEqual(exampleCount2, 1);
        ok('Zweiter Seed-Lauf idempotent (bleibt 1)');
        const ex = await Map.findOne({ name: EXAMPLE_NAME });
        assert.ok(ex);
        assert.strictEqual(ex.isExample, true);
        assert.strictEqual(ex.owner, null);
        ok('Beispiel hat isExample=true + owner=null');
        assert.ok(ex.doc && typeof ex.doc === 'object');
        ok('Beispiel enthaelt ein Doc');

        section('Auth');
        let r = await req(server, 'GET', '/api/maps');
        assert.strictEqual(r.status, 401);
        ok('GET / ohne Token -> 401');

        section('GET / (Liste)');
        r = await req(server, 'GET', '/api/maps', { token: tokA });
        assert.strictEqual(r.status, 200);
        assert.ok(Array.isArray(r.body.maps));
        assert.ok(r.body.maps.find((m) => m.isExample));
        assert.ok(r.body.maps.every((m) => m.doc === undefined));
        ok('Liste enthaelt Beispiel, kein doc-Feld');

        section('POST / (eigene Karte)');
        r = await req(server, 'POST', '/api/maps', {
            token: tokA, body: { name: '  Dennis Dorf  ', doc: { objects: [] } },
        });
        assert.strictEqual(r.status, 201);
        const mapAid = r.body.map._id;
        assert.strictEqual(r.body.map.name, 'Dennis Dorf');
        assert.strictEqual(String(r.body.map.owner), String(userA));
        assert.strictEqual(r.body.map.isExample, false);
        ok('Angelegt, Name getrimmt, owner korrekt, isExample=false');

        section('Validation');
        r = await req(server, 'POST', '/api/maps', { token: tokA, body: { name: '', doc: {} } });
        assert.strictEqual(r.status, 400);
        ok('Leerer Name -> 400');
        r = await req(server, 'POST', '/api/maps', { token: tokA, body: { name: 'x'.repeat(81), doc: {} } });
        assert.strictEqual(r.status, 400);
        ok('Name > 80 Zeichen -> 400');
        r = await req(server, 'POST', '/api/maps', { token: tokA, body: { name: 'x', doc: 'nope' } });
        assert.strictEqual(r.status, 400);
        ok('doc muss Objekt sein -> 400');
        r = await req(server, 'POST', '/api/maps', { token: tokA, body: { name: 'x', doc: [1, 2] } });
        assert.strictEqual(r.status, 400);
        ok('doc = Array -> 400');

        section('GET /:id');
        r = await req(server, 'GET', `/api/maps/${mapAid}`, { token: tokA });
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.map.doc);
        ok('Owner sieht eigene Karte inkl. doc');
        r = await req(server, 'GET', `/api/maps/${mapAid}`, { token: tokB });
        assert.strictEqual(r.status, 404);
        ok('Fremder sieht fremde Karte nicht');
        r = await req(server, 'GET', '/api/maps/not-an-objectid', { token: tokA });
        assert.strictEqual(r.status, 404);
        ok('Ungueltige ID -> 404 (nicht 500)');
        r = await req(server, 'GET', `/api/maps/${new mongoose.Types.ObjectId()}`, { token: tokA });
        assert.strictEqual(r.status, 404);
        ok('Unbekannte ID -> 404');
        r = await req(server, 'GET', `/api/maps/${ex._id}`, { token: tokA });
        assert.strictEqual(r.status, 200);
        ok('Beispiel ist fuer jeden lesbar');

        section('PUT /:id');
        r = await req(server, 'PUT', `/api/maps/${mapAid}`, {
            token: tokA, body: { name: 'Umbenannt' },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.map.name, 'Umbenannt');
        ok('Owner kann umbenennen');
        r = await req(server, 'PUT', `/api/maps/${mapAid}`, {
            token: tokB, body: { name: 'Hack' },
        });
        assert.strictEqual(r.status, 403);
        ok('Fremder bekommt 403');
        r = await req(server, 'PUT', `/api/maps/${ex._id}`, {
            token: tokA, body: { name: 'Hack' },
        });
        assert.strictEqual(r.status, 403);
        ok('Beispiel laesst sich nicht aendern -> 403');
        r = await req(server, 'PUT', `/api/maps/${mapAid}`, {
            token: tokA, body: { doc: { objects: [{ id: 'x', type: 'house.homeA_blue', x: 1, z: 2 }] } },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.map.doc.objects.length, 1);
        ok('Doc-Update speichert Mixed-Felder korrekt');

        section('Grosses Doc');
        // ~500KB base64-Grid -> 500 kB JSON etwa
        const bigPaint = 'A'.repeat(500 * 1024);
        r = await req(server, 'PUT', `/api/maps/${mapAid}`, {
            token: tokA, body: { doc: { objects: [], paint: bigPaint } },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.map.doc.paint.length, bigPaint.length);
        ok('500 KB Doc wird akzeptiert');

        section('DELETE /:id');
        r = await req(server, 'DELETE', `/api/maps/${ex._id}`, { token: tokA });
        assert.strictEqual(r.status, 403);
        ok('Beispiel kann nicht geloescht werden -> 403');
        r = await req(server, 'DELETE', `/api/maps/${mapAid}`, { token: tokB });
        assert.strictEqual(r.status, 403);
        ok('Fremder kann nicht loeschen -> 403');
        r = await req(server, 'DELETE', `/api/maps/${mapAid}`, { token: tokA });
        assert.strictEqual(r.status, 200);
        ok('Owner loescht');
        r = await req(server, 'GET', `/api/maps/${mapAid}`, { token: tokA });
        assert.strictEqual(r.status, 404);
        ok('Nach DELETE -> 404');

        section('Zusammenfassung');
        console.log(process.exitCode ? 'ERGEBNIS: FAIL' : 'ERGEBNIS: OK');
    } catch (e) {
        console.error('Test error:', e);
        process.exitCode = 1;
    } finally {
        await new Promise((r) => server.close(r));
        await mongoose.disconnect();
        await mem.stop();
    }
})();
