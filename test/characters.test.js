// Backend-Test fuer Characters-CRUD + Map-Grid + Character-Selection + Tokens.
// Ausfuehren: node test/characters.test.js
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
const Character = require('../src/models/Character');
const MapTokens = require('../src/models/MapTokens');

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
                try { json = data ? JSON.parse(data) : null; } catch {}
                resolve({ status: res.statusCode, body: json });
            });
        });
        r.on('error', reject);
        if (payload != null) r.write(payload);
        r.end();
    });
}

function section(n) { console.log(`\n--- ${n} ---`); }
function ok(d) { console.log(`  OK   ${d}`); }
function fail(d, e) { console.log(`  FAIL ${d}${e ? ' :: ' + e : ''}`); process.exitCode = 1; }

(async () => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri(), { dbName: 't-chars' });
    const app = createApp({ includeFileUploads: false });
    const server = http.createServer(app);
    const io = socketIo(server, { cors: { origin: '*' } });
    attachSocket(io);
    app.set('io', io);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    const gm = await User.create({ username: 'gm', password: 'x' });
    const alice = await User.create({ username: 'alice', password: 'x' });
    const bob = await User.create({ username: 'bob', password: 'x' });
    const tGm = tokenFor(gm._id);
    const tAlice = tokenFor(alice._id);
    const tBob = tokenFor(bob._id);

    try {
        section('/api/characters CRUD');
        let r = await req(server, 'POST', '/api/characters', { token: tAlice, body: { name: 'Lyra' } });
        assert.strictEqual(r.status, 201);
        const charAlice = r.body.character;
        ok('Char angelegt');

        r = await req(server, 'POST', '/api/characters', { token: tAlice, body: { name: '' } });
        assert.strictEqual(r.status, 400); ok('Leerer Name -> 400');
        r = await req(server, 'POST', '/api/characters', { token: tAlice, body: { name: 'x'.repeat(100) } });
        assert.strictEqual(r.status, 400); ok('>80 Zeichen -> 400');

        r = await req(server, 'GET', '/api/characters', { token: tAlice });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.characters.length, 1);
        ok('Liste eigener Chars');

        r = await req(server, 'GET', '/api/characters', { token: tBob });
        assert.strictEqual(r.body.characters.length, 0);
        ok('Fremder sieht keine Chars');

        r = await req(server, 'PUT', `/api/characters/${charAlice._id}`, { token: tAlice, body: { name: 'Lyra Falkenauge' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.character.name, 'Lyra Falkenauge');
        ok('Umbenannt');

        r = await req(server, 'PUT', `/api/characters/${charAlice._id}`, { token: tBob, body: { name: 'Hijack' } });
        assert.strictEqual(r.status, 404);
        ok('Fremder darf nicht aendern');

        // Delete am Ende, nachdem wir den Char noch in Kampagne brauchen
        const charBob = (await req(server, 'POST', '/api/characters', { token: tBob, body: { name: 'Thorgrim' } })).body.character;

        section('Kampagne mit Spielern + Char-Selection');
        const camp = await Campaign.create({
            name: 'Reise nach Nord', owner: gm._id, players: [alice._id, bob._id],
        });
        r = await req(server, 'GET', `/api/campaigns/${camp._id}`, { token: tGm });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.campaign.characterSelections, []);
        ok('Serialize enthaelt characterSelections=[]');

        r = await req(server, 'PUT', `/api/campaigns/${camp._id}/my-character`, {
            token: tAlice, body: { characterId: charAlice._id },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.campaign.characterSelections.length, 1);
        assert.strictEqual(r.body.campaign.characterSelections[0].userId, String(alice._id));
        ok('Alice waehlt ihren Char');

        r = await req(server, 'PUT', `/api/campaigns/${camp._id}/my-character`, {
            token: tBob, body: { characterId: charAlice._id },
        });
        assert.strictEqual(r.status, 403);
        ok('Bob darf nicht Alices Char waehlen');

        r = await req(server, 'PUT', `/api/campaigns/${camp._id}/my-character`, {
            token: tBob, body: { characterId: charBob._id },
        });
        assert.strictEqual(r.status, 200);
        ok('Bob waehlt seinen Char');

        r = await req(server, 'GET', `/api/campaigns/${camp._id}`, { token: tGm });
        assert.strictEqual(r.body.campaign.characters.length, 2);
        ok('Serialize hydratisiert characters-Array');

        section('Map.grid (2d-image)');
        const img = await Map.create({ name: 'Taverne', owner: gm._id, kind: '2d-image', imageUrl: 'http://x', doc: {} });
        r = await req(server, 'PUT', `/api/maps/${img._id}/grid`, {
            token: tGm, body: { grid: { cellPx: 48, offsetX: 10, offsetY: 5, show: true, color: '#ff0000', opacity: 0.5 } },
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.map.grid.cellPx, 48);
        ok('GM setzt Grid');

        r = await req(server, 'PUT', `/api/maps/${img._id}/grid`, {
            token: tGm, body: { grid: { cellPx: 'nein' } },
        });
        assert.strictEqual(r.status, 400); ok('cellPx String -> 400');

        r = await req(server, 'PUT', `/api/maps/${img._id}/grid`, {
            token: tGm, body: { grid: { cellPx: 20, color: 'red' } },
        });
        assert.strictEqual(r.status, 400); ok('color ohne # -> 400');

        r = await req(server, 'PUT', `/api/maps/${img._id}/grid`, {
            token: tAlice, body: { grid: { cellPx: 20 } },
        });
        assert.strictEqual(r.status, 403); ok('Fremder darf Grid nicht setzen');

        // Grid auf 2d-editor nicht erlaubt
        const editor = await Map.create({ name: 'Edit', owner: gm._id, kind: '2d-editor', doc: {
            kind: '2d-editor', width: 10, height: 8, tileSize: 5,
            floor: Array.from({ length: 80 }, () => 0), walls: [], objects: [], labels: [],
        } });
        r = await req(server, 'PUT', `/api/maps/${editor._id}/grid`, { token: tGm, body: { grid: { cellPx: 10 } } });
        assert.strictEqual(r.status, 400); ok('Grid auf 2d-editor -> 400');

        // Map in Kampagne haengen, damit socket tests spaeter laufen.
        camp.mapIds = [img._id, editor._id];
        camp.activeMapId = img._id;
        await camp.save();

        section('Tokens: REST GET');
        r = await req(server, 'GET', `/api/campaigns/${camp._id}/maps/${img._id}/tokens`, { token: tGm });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.tokens, []);
        ok('Leeres Token-Set GM');

        r = await req(server, 'GET', `/api/campaigns/${camp._id}/maps/${img._id}/tokens`, { token: tAlice });
        assert.strictEqual(r.status, 200);
        ok('Spieler darf lesen');

        // Unbekannter User
        const outsider = await User.create({ username: 'outsider', password: 'x' });
        r = await req(server, 'GET', `/api/campaigns/${camp._id}/maps/${img._id}/tokens`, { token: tokenFor(outsider._id) });
        assert.strictEqual(r.status, 404);
        ok('Nicht-Mitglied -> 404');

        section('Tokens live via Socket');
        const url = `http://127.0.0.1:${port}`;
        const cGm = ClientIO(url, { auth: { token: tGm }, transports: ['websocket'], forceNew: true });
        const cAlice = ClientIO(url, { auth: { token: tAlice }, transports: ['websocket'], forceNew: true });
        const cBob = ClientIO(url, { auth: { token: tBob }, transports: ['websocket'], forceNew: true });
        await Promise.all([cGm, cAlice, cBob].map((s) => new Promise((resolve, reject) => {
            s.once('connect', resolve); s.once('connect_error', reject);
        })));

        // join
        for (const [name, s] of [['gm', cGm], ['alice', cAlice], ['bob', cBob]]) {
            const ack = await new Promise((r) => s.emit('campaign:join', { campaignId: String(camp._id) }, r));
            assert.strictEqual(ack.ok, true, `join ${name}`);
        }
        ok('Alle 3 beigetreten');

        // GM fuegt Alices Token hinzu
        let updatePromise = new Promise((resolve) => cAlice.once('campaign:tokens:update', resolve));
        let ack = await new Promise((r) => cGm.emit('campaign:tokens:add', {
            campaignId: String(camp._id), mapId: String(img._id),
            token: { id: 'tok-alice', characterId: String(charAlice._id), ownerUserId: String(alice._id), x: 5, y: 5, size: 1 },
        }, r));
        assert.strictEqual(ack.ok, true);
        let up = await updatePromise;
        assert.strictEqual(up.tokens.length, 1);
        assert.strictEqual(String(up.tokens[0].ownerUserId), String(alice._id));
        ok('GM fuegt Token hinzu, Alice bekommt update');

        // Spieler darf nicht hinzufuegen
        ack = await new Promise((r) => cAlice.emit('campaign:tokens:add', {
            campaignId: String(camp._id), mapId: String(img._id),
            token: { id: 'hack', x: 0, y: 0 },
        }, r));
        assert.strictEqual(ack.ok, false);
        ok('Spieler darf nicht adden');

        // Alice darf ihr Token bewegen
        updatePromise = new Promise((resolve) => cBob.once('campaign:tokens:update', resolve));
        ack = await new Promise((r) => cAlice.emit('campaign:tokens:drop', {
            campaignId: String(camp._id), mapId: String(img._id),
            updates: [{ id: 'tok-alice', x: 7, y: 8 }],
        }, r));
        assert.strictEqual(ack.ok, true); assert.strictEqual(ack.changed, 1);
        up = await updatePromise;
        assert.strictEqual(up.tokens[0].x, 7);
        assert.strictEqual(up.tokens[0].y, 8);
        ok('Alice bewegt ihr Token (persistiert)');

        // Bob darf Alices Token nicht bewegen
        ack = await new Promise((r) => cBob.emit('campaign:tokens:drop', {
            campaignId: String(camp._id), mapId: String(img._id),
            updates: [{ id: 'tok-alice', x: 0, y: 0 }],
        }, r));
        assert.strictEqual(ack.ok, true); assert.strictEqual(ack.changed, 0);
        ok('Bob kann Alices Token nicht bewegen');

        // GM lockt Alices Token -> Alice kann es nicht mehr bewegen
        ack = await new Promise((r) => cGm.emit('campaign:tokens:lock', {
            campaignId: String(camp._id), mapId: String(img._id),
            tokenId: 'tok-alice', locked: true,
        }, r));
        assert.strictEqual(ack.ok, true);
        ack = await new Promise((r) => cAlice.emit('campaign:tokens:drop', {
            campaignId: String(camp._id), mapId: String(img._id),
            updates: [{ id: 'tok-alice', x: 1, y: 1 }],
        }, r));
        assert.strictEqual(ack.changed, 0);
        ok('Gesperrtes Token: Spieler kann nicht bewegen');

        // GM bewegt gesperrtes Token trotzdem
        ack = await new Promise((r) => cGm.emit('campaign:tokens:drop', {
            campaignId: String(camp._id), mapId: String(img._id),
            updates: [{ id: 'tok-alice', x: 2, y: 2 }],
        }, r));
        assert.strictEqual(ack.changed, 1);
        ok('GM ueberschreibt Lock');

        // GM resized
        ack = await new Promise((r) => cGm.emit('campaign:tokens:resize', {
            campaignId: String(camp._id), mapId: String(img._id),
            tokenId: 'tok-alice', size: 2,
        }, r));
        assert.strictEqual(ack.ok, true);
        const doc = await MapTokens.findOne({ campaignId: camp._id, mapId: img._id });
        assert.strictEqual(doc.tokens[0].size, 2);
        ok('GM resized auf 2 Felder');

        // Spieler darf nicht resizen
        ack = await new Promise((r) => cAlice.emit('campaign:tokens:resize', {
            campaignId: String(camp._id), mapId: String(img._id),
            tokenId: 'tok-alice', size: 4,
        }, r));
        assert.strictEqual(ack.ok, false);
        ok('Spieler darf nicht resizen');

        // GM unlockt + fuegt Bob-Token + gruppiert
        await new Promise((r) => cGm.emit('campaign:tokens:lock', { campaignId: String(camp._id), mapId: String(img._id), tokenId: 'tok-alice', locked: false }, r));
        await new Promise((r) => cGm.emit('campaign:tokens:add', {
            campaignId: String(camp._id), mapId: String(img._id),
            token: { id: 'tok-bob', characterId: String(charBob._id), ownerUserId: String(bob._id), x: 3, y: 3 },
        }, r));
        ack = await new Promise((r) => cGm.emit('campaign:tokens:group', {
            campaignId: String(camp._id), mapId: String(img._id),
            name: 'Team', tokenIds: ['tok-alice', 'tok-bob'],
        }, r));
        assert.strictEqual(ack.ok, true);
        const gid = ack.groupId;
        ok('GM gruppiert 2 Tokens');

        // Alice bewegt ihr Token -> in Gruppe, Bob-Token muesste Alice auch bewegen koennen
        ack = await new Promise((r) => cAlice.emit('campaign:tokens:drop', {
            campaignId: String(camp._id), mapId: String(img._id),
            updates: [{ id: 'tok-alice', x: 10, y: 10 }, { id: 'tok-bob', x: 11, y: 11 }],
        }, r));
        assert.strictEqual(ack.changed, 2);
        ok('Alice bewegt die ganze Gruppe');

        // GM entgruppiert
        ack = await new Promise((r) => cGm.emit('campaign:tokens:ungroup', {
            campaignId: String(camp._id), mapId: String(img._id), groupId: gid,
        }, r));
        assert.strictEqual(ack.ok, true);
        ok('GM entgruppiert');

        // Danach darf Alice bob-token nicht mehr bewegen
        ack = await new Promise((r) => cAlice.emit('campaign:tokens:drop', {
            campaignId: String(camp._id), mapId: String(img._id),
            updates: [{ id: 'tok-bob', x: 0, y: 0 }],
        }, r));
        assert.strictEqual(ack.changed, 0);
        ok('Alice darf Bobs Token nach Entgruppen nicht mehr bewegen');

        // Tick-Event (ohne persist)
        const tickPromise = new Promise((resolve) => cBob.once('campaign:tokens:tick', resolve));
        cAlice.emit('campaign:tokens:move', {
            campaignId: String(camp._id), mapId: String(img._id),
            updates: [{ id: 'tok-alice', x: 12.5, y: 12.5 }],
        });
        const tick = await Promise.race([
            tickPromise,
            new Promise((_, rej) => setTimeout(() => rej(new Error('tick timeout')), 2000)),
        ]);
        assert.strictEqual(tick.updates.length, 1);
        assert.strictEqual(tick.updates[0].x, 12.5);
        // DB nicht geaendert:
        const doc2 = await MapTokens.findOne({ campaignId: camp._id, mapId: img._id });
        const aliceAfter = doc2.tokens.find((t) => t.id === 'tok-alice');
        assert.strictEqual(aliceAfter.x, 10);
        ok('tick-Event broadcastet, DB unveraendert');

        cGm.disconnect(); cAlice.disconnect(); cBob.disconnect();

        section('Char-Delete raeumt Selection auf');
        r = await req(server, 'DELETE', `/api/characters/${charAlice._id}`, { token: tAlice });
        assert.strictEqual(r.status, 200);
        const campAfter = await Campaign.findById(camp._id);
        assert.strictEqual(campAfter.characterSelections.get(String(alice._id)), undefined);
        ok('Nach Char-Delete ist Selection weg');

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
