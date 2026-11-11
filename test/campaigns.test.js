// Backend-Test fuer /api/campaigns. Startet In-Memory-Mongo, mountet die
// komplette App aus src/app.js (gleiche Middleware wie Produktion), und
// prueft die wichtigsten Pfade: Auth, Validierung, Owner-Trennung, Mapping
// zwischen Campaigns und Maps (nur eigene + Beispiele erlaubt).
// Ausfuehren: node test/campaigns.test.js

const assert = require('assert');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
const { createApp } = require('../src/app');
const Map = require('../src/models/Map');
const Campaign = require('../src/models/Campaign');

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
    await mongoose.connect(mem.getUri(), { dbName: 'campaigns-test' });

    const app = createApp({ includeFileUploads: false });
    const server = http.createServer(app).listen(0);

    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();
    const tokA = tokenFor(userA);
    const tokB = tokenFor(userB);

    try {
        section('Fixtures (Maps)');
        const exampleMap = await Map.create({
            name: 'Beispiel: Dorf', owner: null, isExample: true, doc: { objects: [] },
        });
        const mapA = await Map.create({
            name: 'A-Karte', owner: userA, doc: { objects: [] },
        });
        const mapB = await Map.create({
            name: 'B-Karte', owner: userB, doc: { objects: [] },
        });
        ok(`Maps angelegt: example=${exampleMap._id}, A=${mapA._id}, B=${mapB._id}`);

        section('Auth');
        let r = await req(server, 'GET', '/api/campaigns');
        assert.strictEqual(r.status, 401);
        ok('GET / ohne Token -> 401');

        section('POST / (anlegen)');
        r = await req(server, 'POST', '/api/campaigns', {
            token: tokA, body: { name: '  Kampagne X  ', description: 'Dark forest adventure' },
        });
        assert.strictEqual(r.status, 201);
        const campAid = r.body.campaign._id;
        assert.strictEqual(r.body.campaign.name, 'Kampagne X');
        assert.strictEqual(r.body.campaign.description, 'Dark forest adventure');
        assert.strictEqual(String(r.body.campaign.owner), String(userA));
        assert.deepStrictEqual(r.body.campaign.mapIds, []);
        ok('Angelegt, Name getrimmt, owner korrekt, mapIds leer');

        section('Validation');
        r = await req(server, 'POST', '/api/campaigns', { token: tokA, body: { name: '' } });
        assert.strictEqual(r.status, 400);
        ok('Leerer Name -> 400');
        r = await req(server, 'POST', '/api/campaigns', { token: tokA, body: { name: 'x'.repeat(121) } });
        assert.strictEqual(r.status, 400);
        ok('Name > 120 Zeichen -> 400');
        r = await req(server, 'POST', '/api/campaigns', { token: tokA, body: { name: 'Ok', description: 'x'.repeat(4001) } });
        assert.strictEqual(r.status, 400);
        ok('Description > 4000 -> 400');
        r = await req(server, 'POST', '/api/campaigns', { token: tokA, body: { name: 'Ok', mapIds: 'nope' } });
        assert.strictEqual(r.status, 400);
        ok('mapIds als String -> 400');
        r = await req(server, 'POST', '/api/campaigns', { token: tokA, body: { name: 'Ok', mapIds: ['no-objectid'] } });
        assert.strictEqual(r.status, 400);
        ok('mapIds mit Mist -> 400');
        // Query-Injection-Versuch via JSON: ein Objekt wie { $ne: null } darf nicht als Id durchgehen.
        r = await req(server, 'POST', '/api/campaigns', { token: tokA, body: { name: 'Ok', mapIds: [{ $ne: null }] } });
        assert.strictEqual(r.status, 400);
        ok('mapIds mit Mongo-Operator-Objekt -> 400 (keine Query-Injection)');

        section('POST /: Map-Zuordnung');
        r = await req(server, 'POST', '/api/campaigns', {
            token: tokA, body: { name: 'Mit Karte', mapIds: [String(mapA._id), String(exampleMap._id)] },
        });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.body.campaign.mapIds.length, 2);
        ok('Owner darf eigene + Beispiel zuordnen');
        r = await req(server, 'POST', '/api/campaigns', {
            token: tokA, body: { name: 'Fremd', mapIds: [String(mapB._id)] },
        });
        assert.strictEqual(r.status, 400);
        ok('Owner darf fremde Map nicht zuordnen -> 400');
        r = await req(server, 'POST', '/api/campaigns', {
            token: tokA, body: { name: 'Unbekannt', mapIds: [String(new mongoose.Types.ObjectId())] },
        });
        assert.strictEqual(r.status, 400);
        ok('Unbekannte Map-ID -> 400');

        section('GET / (Liste)');
        r = await req(server, 'GET', '/api/campaigns', { token: tokA });
        assert.strictEqual(r.status, 200);
        assert.ok(Array.isArray(r.body.campaigns));
        assert.strictEqual(r.body.campaigns.length, 2);
        ok('A sieht 2 eigene Kampagnen');
        r = await req(server, 'GET', '/api/campaigns', { token: tokB });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaigns.length, 0);
        ok('B sieht keine fremden Kampagnen');

        section('GET /:id');
        r = await req(server, 'GET', `/api/campaigns/${campAid}`, { token: tokA });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign._id, campAid);
        ok('Owner sieht eigene Kampagne');
        r = await req(server, 'GET', `/api/campaigns/${campAid}`, { token: tokB });
        assert.strictEqual(r.status, 404);
        ok('Fremder sieht fremde Kampagne nicht -> 404');
        r = await req(server, 'GET', '/api/campaigns/not-an-objectid', { token: tokA });
        assert.strictEqual(r.status, 404);
        ok('Ungueltige ID -> 404 (nicht 500)');
        r = await req(server, 'GET', `/api/campaigns/${new mongoose.Types.ObjectId()}`, { token: tokA });
        assert.strictEqual(r.status, 404);
        ok('Unbekannte ID -> 404');

        section('PUT /:id');
        r = await req(server, 'PUT', `/api/campaigns/${campAid}`, {
            token: tokA, body: { name: 'Umbenannt' },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.name, 'Umbenannt');
        ok('Owner kann umbenennen');
        r = await req(server, 'PUT', `/api/campaigns/${campAid}`, {
            token: tokB, body: { name: 'Hack' },
        });
        assert.strictEqual(r.status, 403);
        ok('Fremder bekommt 403');
        r = await req(server, 'PUT', `/api/campaigns/${campAid}`, {
            token: tokA, body: { mapIds: [String(mapA._id)] },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.mapIds.length, 1);
        ok('mapIds-Update setzt Liste neu');
        r = await req(server, 'PUT', `/api/campaigns/${campAid}`, {
            token: tokA, body: { mapIds: [String(mapB._id)] },
        });
        assert.strictEqual(r.status, 400);
        ok('PUT mit fremder Map -> 400');
        r = await req(server, 'PUT', `/api/campaigns/${campAid}`, {
            token: tokA, body: { mapIds: [] },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.mapIds.length, 0);
        ok('mapIds leer leert Liste');
        r = await req(server, 'PUT', `/api/campaigns/${campAid}`, {
            token: tokA, body: { description: 'Neue Beschreibung' },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.description, 'Neue Beschreibung');
        ok('Description-Update');

        section('DELETE /:id');
        r = await req(server, 'DELETE', `/api/campaigns/${campAid}`, { token: tokB });
        assert.strictEqual(r.status, 403);
        ok('Fremder kann nicht loeschen -> 403');
        r = await req(server, 'DELETE', `/api/campaigns/${campAid}`, { token: tokA });
        assert.strictEqual(r.status, 200);
        ok('Owner loescht');
        r = await req(server, 'GET', `/api/campaigns/${campAid}`, { token: tokA });
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
