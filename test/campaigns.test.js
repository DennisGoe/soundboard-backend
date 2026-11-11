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
const User = require('../src/models/User');
const ChatMessage = require('../src/models/ChatMessage');

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

    // Richtige User anlegen, damit Spieler/User-Suche funktioniert.
    const uA = await User.create({ username: 'alice', password: 'x' });
    const uB = await User.create({ username: 'bob', password: 'x' });
    const uC = await User.create({ username: 'charlie', password: 'x' });
    const userA = uA._id;
    const userB = uB._id;
    const userC = uC._id;
    const tokA = tokenFor(userA);
    const tokB = tokenFor(userB);
    const tokC = tokenFor(userC);

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

        section('/api/users (Suche)');
        r = await req(server, 'GET', '/api/users?q=ali', { token: tokA });
        assert.strictEqual(r.status, 200);
        assert.ok(Array.isArray(r.body.users));
        assert.ok(r.body.users.some((u) => u.username === 'alice'));
        // Kein Passwort-Feld durchreichen.
        assert.ok(r.body.users.every((u) => !('password' in u)));
        ok('Suche findet alice, enthaelt KEIN password');
        r = await req(server, 'GET', '/api/users', { token: tokA });
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.users.length >= 3);
        ok('Suche ohne q liefert erste 25 User');
        r = await req(server, 'GET', '/api/users?q=.*', { token: tokA });
        assert.strictEqual(r.status, 200);
        ok('Regex-Metazeichen werden escaped (kein 500)');
        r = await req(server, 'GET', '/api/users?q=ali');
        assert.strictEqual(r.status, 401);
        ok('User-Suche ohne Token -> 401');

        section('Players: hinzufuegen / entfernen (POST/DELETE)');
        // Neue Kampagne fuer Spieler-Tests.
        r = await req(server, 'POST', '/api/campaigns', {
            token: tokA, body: { name: 'Spieler-Testkampagne' },
        });
        const campSpId = r.body.campaign._id;
        ok(`Spieler-Testkampagne ${campSpId}`);

        r = await req(server, 'POST', `/api/campaigns/${campSpId}/players`, {
            token: tokA, body: { userId: String(userB) },
        });
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.campaign.players.some((p) => String(p._id) === String(userB)));
        assert.strictEqual(r.body.campaign.players[0].username, 'bob');
        ok('Owner fuegt bob als Spieler hinzu');

        r = await req(server, 'POST', `/api/campaigns/${campSpId}/players`, {
            token: tokA, body: { userId: String(userB) },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.players.length, 1);
        ok('Doppeltes Add bleibt bei 1');

        r = await req(server, 'POST', `/api/campaigns/${campSpId}/players`, {
            token: tokA, body: { userId: String(new mongoose.Types.ObjectId()) },
        });
        assert.strictEqual(r.status, 400);
        ok('Add mit unbekanntem User -> 400');

        r = await req(server, 'POST', `/api/campaigns/${campSpId}/players`, {
            token: tokA, body: { userId: 'nope' },
        });
        assert.strictEqual(r.status, 400);
        ok('Add mit kaputter userId -> 400');

        r = await req(server, 'POST', `/api/campaigns/${campSpId}/players`, {
            token: tokA, body: { userId: String(userA) },
        });
        assert.strictEqual(r.status, 400);
        ok('Owner kann sich nicht selbst als Spieler eintragen -> 400');

        r = await req(server, 'POST', `/api/campaigns/${campSpId}/players`, {
            token: tokB, body: { userId: String(userC) },
        });
        assert.strictEqual(r.status, 403);
        ok('Spieler darf keine Spieler hinzufuegen -> 403');

        section('Players: sieht Kampagne, aber read-only');
        r = await req(server, 'GET', '/api/campaigns', { token: tokB });
        assert.strictEqual(r.status, 200);
        const bobsCampaigns = r.body.campaigns;
        assert.ok(bobsCampaigns.find((c) => c._id === campSpId));
        assert.strictEqual(bobsCampaigns.find((c) => c._id === campSpId).role, 'player');
        ok('bob sieht Kampagne in Liste mit role=player');

        r = await req(server, 'GET', `/api/campaigns/${campSpId}`, { token: tokB });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.role, 'player');
        ok('bob sieht Detail (Role player)');

        r = await req(server, 'PUT', `/api/campaigns/${campSpId}`, {
            token: tokB, body: { name: 'Hack' },
        });
        assert.strictEqual(r.status, 403);
        ok('Spieler kann nicht bearbeiten -> 403');
        r = await req(server, 'DELETE', `/api/campaigns/${campSpId}`, { token: tokB });
        assert.strictEqual(r.status, 403);
        ok('Spieler kann nicht loeschen -> 403');

        section('Players: entfernen');
        r = await req(server, 'DELETE', `/api/campaigns/${campSpId}/players/${userB}`, {
            token: tokA,
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.players.length, 0);
        ok('Owner entfernt bob');
        r = await req(server, 'GET', `/api/campaigns/${campSpId}`, { token: tokB });
        assert.strictEqual(r.status, 404);
        ok('bob sieht Kampagne nach Rauswurf nicht mehr');

        section('Active map (REST PUT)');
        // bob wieder rein; Map mapA zuordnen; active-map setzen.
        await req(server, 'POST', `/api/campaigns/${campSpId}/players`, {
            token: tokA, body: { userId: String(userB) },
        });
        r = await req(server, 'PUT', `/api/campaigns/${campSpId}`, {
            token: tokA, body: { mapIds: [String(mapA._id)] },
        });
        assert.strictEqual(r.status, 200);
        ok('mapA zugewiesen');
        r = await req(server, 'PUT', `/api/campaigns/${campSpId}/active-map`, {
            token: tokA, body: { mapId: String(mapA._id) },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(String(r.body.campaign.activeMapId), String(mapA._id));
        ok('Owner setzt active-map auf mapA');

        r = await req(server, 'PUT', `/api/campaigns/${campSpId}/active-map`, {
            token: tokA, body: { mapId: String(mapB._id) },
        });
        assert.strictEqual(r.status, 400);
        ok('Nicht zugeordnete Map -> 400');

        r = await req(server, 'PUT', `/api/campaigns/${campSpId}/active-map`, {
            token: tokB, body: { mapId: String(mapA._id) },
        });
        assert.strictEqual(r.status, 403);
        ok('Spieler darf active-map nicht setzen -> 403');

        r = await req(server, 'PUT', `/api/campaigns/${campSpId}/active-map`, {
            token: tokA, body: { mapId: null },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.activeMapId, null);
        ok('Owner kann active-map auf null setzen');

        // activeMapId wird auto-geleert, wenn Karte nicht mehr zugewiesen ist.
        await req(server, 'PUT', `/api/campaigns/${campSpId}/active-map`, {
            token: tokA, body: { mapId: String(mapA._id) },
        });
        r = await req(server, 'PUT', `/api/campaigns/${campSpId}`, {
            token: tokA, body: { mapIds: [] },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.activeMapId, null);
        ok('Entfernen der Map leert activeMapId automatisch');

        section('Chat (REST GET)');
        // Chat-Nachrichten direkt in DB (Socket-Pfad hat eigene Suite).
        for (let i = 0; i < 3; i++) {
            await ChatMessage.create({
                campaignId: campSpId,
                userId: userA, username: 'alice', text: `msg ${i}`,
            });
        }
        r = await req(server, 'GET', `/api/campaigns/${campSpId}/chat`, { token: tokA });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.messages.length, 3);
        assert.strictEqual(r.body.messages[0].text, 'msg 0');
        ok('Owner liest Chat');
        r = await req(server, 'GET', `/api/campaigns/${campSpId}/chat`, { token: tokB });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.messages.length, 3);
        ok('Spieler liest Chat');
        r = await req(server, 'GET', `/api/campaigns/${campSpId}/chat`, { token: tokC });
        assert.strictEqual(r.status, 404);
        ok('Fremder bekommt Chat nicht -> 404');

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
