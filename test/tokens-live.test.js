// Runde 4a: Live-Spielmodus fuer Tokens.
// - Spieler bekommt beim Join automatisch EIN Token auf der aktiven Karte (idempotent).
// - GM darf ALLES bewegen (auch gelockte Tokens, auch Spieler-Tokens).
// - Spieler bewegt nur eigene / eigene Gruppe.
// - Ein Feld = max 1 Token. Drop auf besetztes Feld wird ABGELEHNT (ganze Gruppe).
// - Felder, die Tokens aus derselben Bewegung verlassen, zaehlen als frei.
//
// Ausfuehren: node test/tokens-live.test.js

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const socketIo = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret-r4a';
const { createApp } = require('../src/app');
const { attachSocket } = require('../src/socket');
const User = require('../src/models/User');
const Campaign = require('../src/models/Campaign');
const MapModel = require('../src/models/Map');
const MapTokens = require('../src/models/MapTokens');

function tokenFor(userId) {
    return jwt.sign({ user: { id: String(userId) } }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function ok(d) { console.log(`  OK   ${d}`); }
function section(d) { console.log(`\n--- ${d} ---`); }

function connect(port, token) {
    return new Promise((resolve, reject) => {
        const sock = ioClient(`http://127.0.0.1:${port}`, {
            transports: ['websocket'],
            auth: token ? { token } : undefined,
            reconnection: false, timeout: 3000,
        });
        sock.once('connect', () => resolve(sock));
        sock.once('connect_error', (err) => reject(err));
    });
}

function waitEvent(sock, name, ms = 2000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            sock.off(name);
            reject(new Error(`timeout waiting for ${name}`));
        }, ms);
        sock.once(name, (p) => { clearTimeout(t); resolve(p); });
    });
}

function callAck(sock, event, payload, ms = 2000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout ack ${event}`)), ms);
        sock.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
    });
}

(async () => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri(), { dbName: 't-r4a' });
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
    const outsider = await User.create({ username: 'outsider', password: 'x' });
    const tGm = tokenFor(gm._id);
    const tAlice = tokenFor(alice._id);
    const tBob = tokenFor(bob._id);
    const tOut = tokenFor(outsider._id);

    // Eine 2d-editor-Karte 20x15; findFreeField startet bei Mitte.
    const map = await MapModel.create({
        name: 'Taverne', owner: gm._id,
        kind: '2d-editor',
        doc: { width: 20, height: 15, tileSize: 32, floor: [], walls: [], objects: [], labels: [] },
    });
    const campaign = await Campaign.create({
        name: 'R4a-Test', owner: gm._id,
        players: [alice._id, bob._id],
        mapIds: [map._id],
        activeMapId: map._id,
    });

    try {
        section('Auto-Token beim Join (Spieler)');
        const sGm = await connect(port, tGm);
        const sAlice = await connect(port, tAlice);
        const sBob = await connect(port, tBob);

        const aliceWait = waitEvent(sAlice, 'campaign:tokens:update', 2500);
        const joinA = await callAck(sAlice, 'campaign:join', { campaignId: String(campaign._id) });
        assert.strictEqual(joinA.ok, true);
        const upd = await aliceWait;
        assert.ok(Array.isArray(upd.tokens));
        const aliceTokens = upd.tokens.filter((t) => String(t.ownerUserId) === String(alice._id));
        assert.strictEqual(aliceTokens.length, 1);
        assert.strictEqual(aliceTokens[0].size, 1);
        ok(`Alice bekam EIN Token @ (${aliceTokens[0].x},${aliceTokens[0].y})`);

        section('Auto-Token ist idempotent (2. Join / 2. Tab)');
        // GM joint
        await callAck(sGm, 'campaign:join', { campaignId: String(campaign._id) });
        // Alice-Zweittab joint
        const sAlice2 = await connect(port, tAlice);
        await callAck(sAlice2, 'campaign:join', { campaignId: String(campaign._id) });
        // Token-Count fuer Alice unveraendert.
        const r = await callAck(sGm, 'campaign:tokens:get', { campaignId: String(campaign._id), mapId: String(map._id) });
        const aliceCount = r.tokens.filter((t) => String(t.ownerUserId) === String(alice._id)).length;
        assert.strictEqual(aliceCount, 1);
        ok('Zweiter Tab erzeugt kein zusaetzliches Token');

        section('GM darf alles bewegen (auch gelockte Tokens)');
        // Bob tritt bei.
        const bobWait = waitEvent(sBob, 'campaign:tokens:update', 2500);
        await callAck(sBob, 'campaign:join', { campaignId: String(campaign._id) });
        await bobWait;
        // GM sperrt Alice-Token.
        const tks1 = (await callAck(sGm, 'campaign:tokens:get', { campaignId: String(campaign._id), mapId: String(map._id) })).tokens;
        const aliceTok = tks1.find((t) => String(t.ownerUserId) === String(alice._id));
        await callAck(sGm, 'campaign:tokens:lock', {
            campaignId: String(campaign._id), mapId: String(map._id),
            tokenId: aliceTok.id, locked: true,
        });
        // GM zieht das gelockte Token auf ein freies Feld.
        const freeCell = { x: 1, y: 1 };
        const dropGm = await callAck(sGm, 'campaign:tokens:drop', {
            campaignId: String(campaign._id), mapId: String(map._id),
            updates: [{ id: aliceTok.id, x: freeCell.x, y: freeCell.y }],
        });
        assert.strictEqual(dropGm.ok, true);
        assert.strictEqual(dropGm.changed, 1);
        const tks2 = (await callAck(sGm, 'campaign:tokens:get', { campaignId: String(campaign._id), mapId: String(map._id) })).tokens;
        const aliceTok2 = tks2.find((t) => t.id === aliceTok.id);
        assert.strictEqual(aliceTok2.x, 1);
        assert.strictEqual(aliceTok2.y, 1);
        ok('GM darf gelocktes Spieler-Token verschieben');

        section('Snap auf Feldmitte (Math.round)');
        // Nicht-snappier Zug fuer Alice (sie darf sich selbst, lock wieder weg).
        await callAck(sGm, 'campaign:tokens:lock', {
            campaignId: String(campaign._id), mapId: String(map._id),
            tokenId: aliceTok.id, locked: false,
        });
        const dropSnap = await callAck(sAlice, 'campaign:tokens:drop', {
            campaignId: String(campaign._id), mapId: String(map._id),
            updates: [{ id: aliceTok.id, x: 5.3, y: 7.7 }],
        });
        assert.strictEqual(dropSnap.ok, true);
        const tks3 = (await callAck(sGm, 'campaign:tokens:get', { campaignId: String(campaign._id), mapId: String(map._id) })).tokens;
        const aliceTok3 = tks3.find((t) => t.id === aliceTok.id);
        assert.strictEqual(aliceTok3.x, 5);
        assert.strictEqual(aliceTok3.y, 8);
        ok('Zielfeld snappt auf Math.round (5.3,7.7 -> 5,8)');

        section('Spieler bewegt nur eigenes Token');
        // Alice versucht Bob-Token zu bewegen
        const bobTok = tks3.find((t) => String(t.ownerUserId) === String(bob._id));
        const dropForeign = await callAck(sAlice, 'campaign:tokens:drop', {
            campaignId: String(campaign._id), mapId: String(map._id),
            updates: [{ id: bobTok.id, x: 2, y: 2 }],
        });
        // Kein Change (Permission-Filter laesst nichts durch) -> ok: true, changed: 0.
        assert.strictEqual(dropForeign.ok, true);
        assert.strictEqual(dropForeign.changed, 0);
        ok('Alice kann Bobs Token nicht bewegen');

        section('Kollision: Drop auf besetztes Feld wird abgelehnt');
        // Bob-Token irgendwo (merken), Alice-Token woanders. Alice versucht auf Bobs Feld.
        const tks4 = (await callAck(sGm, 'campaign:tokens:get', { campaignId: String(campaign._id), mapId: String(map._id) })).tokens;
        const aliceT = tks4.find((t) => t.id === aliceTok.id);
        const bobT = tks4.find((t) => t.id === bobTok.id);
        // Alice landet auf Bob-Feld
        const aliceAttack = await callAck(sAlice, 'campaign:tokens:drop', {
            campaignId: String(campaign._id), mapId: String(map._id),
            updates: [{ id: aliceT.id, x: bobT.x, y: bobT.y }],
        });
        assert.strictEqual(aliceAttack.ok, false);
        assert.ok(aliceAttack.rejectedIds.includes(aliceT.id));
        // Alice-Token blieb unveraendert.
        const tks5 = (await callAck(sGm, 'campaign:tokens:get', { campaignId: String(campaign._id), mapId: String(map._id) })).tokens;
        const aliceT2 = tks5.find((t) => t.id === aliceTok.id);
        assert.strictEqual(aliceT2.x, aliceT.x);
        assert.strictEqual(aliceT2.y, aliceT.y);
        ok('Drop auf besetztes Feld -> ok:false, Position unveraendert');

        section('Gruppen-Drop: eine Zielzelle besetzt -> alle abgelehnt');
        // GM legt 3 Tokens an, verschiebt sie als Gruppe. Eine Zielzelle ist belegt.
        const addA = await callAck(sGm, 'campaign:tokens:add', {
            campaignId: String(campaign._id), mapId: String(map._id),
            token: { x: 10, y: 10, label: 'A', color: '#ffaa00' },
        });
        const addB = await callAck(sGm, 'campaign:tokens:add', {
            campaignId: String(campaign._id), mapId: String(map._id),
            token: { x: 11, y: 10, label: 'B', color: '#ff5500' },
        });
        // Platziere ein "Hindernis" bei (12,10).
        const addObstacle = await callAck(sGm, 'campaign:tokens:add', {
            campaignId: String(campaign._id), mapId: String(map._id),
            token: { x: 12, y: 10, label: 'X', color: '#777777' },
        });
        // GM versucht A->(11,10) und B->(12,10) gleichzeitig.
        // A->(11,10) ist das Feld, das B gerade verlaesst -> OK.
        // B->(12,10) kollidiert mit Hindernis -> ganze Gruppe abgelehnt.
        const groupTry = await callAck(sGm, 'campaign:tokens:drop', {
            campaignId: String(campaign._id), mapId: String(map._id),
            updates: [
                { id: addA.token.id, x: 11, y: 10 },
                { id: addB.token.id, x: 12, y: 10 },
            ],
        });
        assert.strictEqual(groupTry.ok, false);
        assert.ok(groupTry.rejectedIds.length >= 1);
        // A hat sich nicht bewegt.
        const tks6 = (await callAck(sGm, 'campaign:tokens:get', { campaignId: String(campaign._id), mapId: String(map._id) })).tokens;
        const aLoad = tks6.find((t) => t.id === addA.token.id);
        const bLoad = tks6.find((t) => t.id === addB.token.id);
        assert.strictEqual(aLoad.x, 10); assert.strictEqual(aLoad.y, 10);
        assert.strictEqual(bLoad.x, 11); assert.strictEqual(bLoad.y, 10);
        ok('Gruppenzug mit einer Kollision wird komplett abgelehnt');

        section('Gruppen-Tausch: A->B.pos, B->A.pos (Felder tauschen) ist erlaubt');
        // A @ (10,10), B @ (11,10). Tausch: A->(11,10), B->(10,10).
        // Beide Felder werden wechselseitig frei, weil beide in moving.
        const swap = await callAck(sGm, 'campaign:tokens:drop', {
            campaignId: String(campaign._id), mapId: String(map._id),
            updates: [
                { id: addA.token.id, x: 11, y: 10 },
                { id: addB.token.id, x: 10, y: 10 },
            ],
        });
        assert.strictEqual(swap.ok, true);
        assert.strictEqual(swap.changed, 2);
        ok('A/B tauschen Felder (beide "bewegende" Felder zaehlen als frei)');

        section('Add snappt + weicht besetztem Feld aus');
        // Nochmal ein Token @ (10,10) hinzufuegen — da liegt gerade B.
        const squeeze = await callAck(sGm, 'campaign:tokens:add', {
            campaignId: String(campaign._id), mapId: String(map._id),
            token: { x: 10, y: 10, label: 'C', color: '#44aa44' },
        });
        assert.strictEqual(squeeze.ok, true);
        assert.ok(!(squeeze.token.x === 10 && squeeze.token.y === 10));
        ok(`Neues Token wich aus auf (${squeeze.token.x},${squeeze.token.y})`);

        section('Outsider bekommt KEIN Auto-Token');
        const sOut = await connect(port, tOut);
        const joinOut = await callAck(sOut, 'campaign:join', { campaignId: String(campaign._id) });
        assert.strictEqual(joinOut.ok, false);
        ok('Fremder wird gar nicht erst reingelassen');

        section('GM selbst bekommt KEIN Auto-Token');
        const tksFinal = (await callAck(sGm, 'campaign:tokens:get', { campaignId: String(campaign._id), mapId: String(map._id) })).tokens;
        const gmTok = tksFinal.find((t) => String(t.ownerUserId) === String(gm._id));
        assert.strictEqual(gmTok, undefined);
        ok('Kein Token mit ownerUserId=gm vorhanden');

        sGm.close(); sAlice.close(); sAlice2.close(); sBob.close(); sOut.close();

        console.log('\nAlles gruen (tokens-live.test.js).');
    } catch (e) {
        console.error('FAIL', e);
        process.exitCode = 1;
    } finally {
        server.close();
        await mongoose.disconnect();
        await mem.stop();
    }
})();
