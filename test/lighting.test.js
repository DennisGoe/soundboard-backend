// Tests fuer Nebel / Dunkelheit / Lichter (Runde 3b).
// Deckt: REST-Initial-Load, Socket-Rechte (GM vs Spieler), Fog-Ops,
// Fog-Dimensionen (resize behaelt alte Bits), Dunkelheit-Toggle,
// Lichter (static + token, Spieler darf eigenes Token-Licht).
// Ausfuehren: node test/lighting.test.js

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const socketIo = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function httpReq(server, method, path, { token, body } = {}) {
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
                try { json = data ? JSON.parse(data) : null; } catch { /* ignore */ }
                resolve({ status: res.statusCode, body: json, raw: data });
            });
        });
        r.on('error', reject);
        if (payload != null) r.write(payload);
        r.end();
    });
}

process.env.JWT_SECRET = 'test-secret';
const { createApp } = require('../src/app');
const { attachSocket } = require('../src/socket');
const User = require('../src/models/User');
const Campaign = require('../src/models/Campaign');
const Map = require('../src/models/Map');
const MapTokens = require('../src/models/MapTokens');
const MapLighting = require('../src/models/MapLighting');
const { emptyBits, toBuffer, applyFogOps, ensureFogDims, sanitizeLight } = require('../src/lightingOps');

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
            reconnection: false,
            timeout: 3000,
        });
        sock.once('connect', () => resolve(sock));
        sock.once('connect_error', (err) => reject(err));
    });
}
function callAck(sock, event, payload, ms = 3000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout ack ${event}`)), ms);
        sock.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
    });
}
function waitEvent(sock, name, ms = 3000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { sock.off(name); reject(new Error(`timeout ${name}`)); }, ms);
        sock.once(name, (p) => { clearTimeout(t); resolve(p); });
    });
}

function bitAt(buf, w, x, y) {
    const i = y * w + x;
    return (buf[i >> 3] >> (i & 7)) & 1;
}

(async () => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri(), { dbName: 'lighting-test' });

    const app = createApp({ includeFileUploads: false });
    const server = http.createServer(app);
    const io = socketIo(server, { cors: { origin: '*' } });
    attachSocket(io);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    app.set('io', io);

    const gm = await User.create({ username: 'gm', password: 'x' });
    const pl = await User.create({ username: 'pl', password: 'x' });
    const outsider = await User.create({ username: 'out', password: 'x' });

    const map = await Map.create({ name: 'LTest', owner: gm._id, kind: '2d-editor', doc: {} });
    const campaign = await Campaign.create({
        name: 'LightTest', owner: gm._id, players: [pl._id], mapIds: [map._id],
    });

    // Token des Spielers (fuer Token-Licht-Rechte).
    await MapTokens.create({
        campaignId: campaign._id, mapId: map._id,
        tokens: [{ id: 'tok-pl', ownerUserId: pl._id, x: 5, y: 5, size: 1, locked: false }],
        groups: [],
    });

    const tokGM = tokenFor(gm._id);
    const tokPL = tokenFor(pl._id);
    const tokOut = tokenFor(outsider._id);

    try {
        // --- Unit-Tests der Ops (pure) ---
        section('Unit: emptyBits + ensureFogDims + applyFogOps');
        const doc0 = { fogW: 0, fogH: 0, fogBits: '' };
        assert.strictEqual(ensureFogDims(doc0, 10, 10), true);
        assert.strictEqual(doc0.fogW, 10);
        assert.strictEqual(doc0.fogH, 10);
        let buf = toBuffer(doc0.fogBits, 10, 10);
        for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
            assert.strictEqual(bitAt(buf, 10, x, y), 1, `start covered @${x},${y}`);
        }
        ok('neu angelegte 10x10-Maske ist voll abgedeckt');

        // reveal rect (3,3,5,5) -> inside leer
        const r = applyFogOps(doc0, [{ kind: 'reveal', shape: 'rect', x: 3, y: 3, w: 2, h: 2 }]);
        assert.strictEqual(r.changed, true);
        assert.strictEqual(r.applied, 1);
        buf = toBuffer(doc0.fogBits, 10, 10);
        assert.strictEqual(bitAt(buf, 10, 3, 3), 0);
        assert.strictEqual(bitAt(buf, 10, 4, 4), 0);
        assert.strictEqual(bitAt(buf, 10, 5, 5), 1, 'exklusiver x1');
        ok('reveal rect clippt sauber (exklusiver rechter/unterer Rand)');

        // cover circle (3.5, 3.5, 2) -> alle 4 vorher-revealed wieder covered
        applyFogOps(doc0, [{ kind: 'cover', shape: 'circle', x: 3.5, y: 3.5, r: 2 }]);
        buf = toBuffer(doc0.fogBits, 10, 10);
        assert.strictEqual(bitAt(buf, 10, 3, 3), 1);
        assert.strictEqual(bitAt(buf, 10, 4, 4), 1);
        ok('cover circle wirkt');

        // 'all' covered=false -> alles 0
        applyFogOps(doc0, [{ kind: 'all', covered: false }]);
        buf = toBuffer(doc0.fogBits, 10, 10);
        for (let i = 0; i < 10 * 10; i++) {
            assert.strictEqual((buf[i >> 3] >> (i & 7)) & 1, 0);
        }
        ok('all covered=false deckt vollstaendig auf');

        // 'all' covered=true -> alles 1
        applyFogOps(doc0, [{ kind: 'all', covered: true }]);
        buf = toBuffer(doc0.fogBits, 10, 10);
        for (let i = 0; i < 10 * 10; i++) {
            assert.strictEqual((buf[i >> 3] >> (i & 7)) & 1, 1);
        }
        ok('all covered=true deckt alles ab');

        // Resize behaelt Bits links-oben: 10x10 covered, 2x2 revealed oben links, resize auf 20x20
        const docR = { fogW: 0, fogH: 0, fogBits: '' };
        ensureFogDims(docR, 10, 10);
        applyFogOps(docR, [{ kind: 'reveal', shape: 'rect', x: 0, y: 0, w: 2, h: 2 }]);
        ensureFogDims(docR, 20, 20);
        const bufR = toBuffer(docR.fogBits, 20, 20);
        assert.strictEqual(bitAt(bufR, 20, 0, 0), 0);
        assert.strictEqual(bitAt(bufR, 20, 1, 1), 0);
        assert.strictEqual(bitAt(bufR, 20, 2, 2), 1);
        assert.strictEqual(bitAt(bufR, 20, 15, 15), 1, 'neues Feld default covered');
        ok('resize behaelt links-oben Bits und fuellt den Rest mit covered');

        // Ungueltige Ops werden geschluckt
        const r2 = applyFogOps(doc0, [{ shape: 'nope' }, null, { kind: 'cover' }]);
        assert.strictEqual(r2.applied, 0);
        ok('ungueltige Ops werden verworfen');

        // Poly: deckt Dreieck ab
        ensureFogDims(docR, 10, 10);
        applyFogOps(docR, [{ kind: 'all', covered: false }]);
        applyFogOps(docR, [{ kind: 'cover', shape: 'poly', points: [[0, 0], [5, 0], [0, 5]] }]);
        const bufP = toBuffer(docR.fogBits, 10, 10);
        assert.strictEqual(bitAt(bufP, 10, 1, 1), 1);
        assert.strictEqual(bitAt(bufP, 10, 6, 6), 0);
        ok('poly cover zeichnet Dreieck');

        // --- sanitizeLight ---
        section('Unit: sanitizeLight');
        assert.strictEqual(sanitizeLight(null), null);
        assert.strictEqual(sanitizeLight({ kind: 'token' }), null, 'ohne tokenId null');
        const sStatic = sanitizeLight({ kind: 'static', x: 3, y: 5, bright: 25, dim: 30 });
        assert.strictEqual(sStatic.kind, 'static');
        assert.strictEqual(sStatic.bright, 25);
        assert.strictEqual(sStatic.dim, 30);
        const sTok = sanitizeLight({ kind: 'token', tokenId: 'tok-pl', bright: 20 });
        assert.strictEqual(sTok.tokenId, 'tok-pl');
        const sClamped = sanitizeLight({ kind: 'static', x: 1, y: 1, bright: 9999 });
        assert.strictEqual(sClamped.bright, 200, 'clamp an Obergrenze');
        const sBadColor = sanitizeLight({ kind: 'static', x: 0, y: 0, color: 'red' });
        assert.strictEqual(sBadColor.color, '#ffcf80', 'ungueltige Farbe -> default');
        ok('sanitizeLight validiert');

        // --- REST ---
        section('REST: GET /api/campaigns/:id/maps/:mapId/lighting');
        let res = await httpReq(server, 'GET', `/api/campaigns/${campaign._id}/maps/${map._id}/lighting`, { token: tokGM });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.lighting.lights, []);
        assert.strictEqual(res.body.lighting.darkness, false);
        ok('GM bekommt initial leere Lighting');

        res = await httpReq(server, 'GET', `/api/campaigns/${campaign._id}/maps/${map._id}/lighting`, { token: tokPL });
        assert.strictEqual(res.status, 200);
        ok('Spieler bekommt die Lighting auch');

        res = await httpReq(server, 'GET', `/api/campaigns/${campaign._id}/maps/${map._id}/lighting`, { token: tokOut });
        assert.strictEqual(res.status, 404);
        ok('Fremder bekommt 404');

        // --- Socket ---
        section('Socket: Fog-Ops Rechte');
        const sGM = await connect(port, tokGM);
        const sPL = await connect(port, tokPL);
        const sOut = await connect(port, tokOut);
        await callAck(sGM, 'campaign:join', { campaignId: String(campaign._id) });
        await callAck(sPL, 'campaign:join', { campaignId: String(campaign._id) });

        // ensureFog nur GM
        const eF = await callAck(sGM, 'campaign:lighting:ensureFog', {
            campaignId: String(campaign._id), mapId: String(map._id), w: 30, h: 20,
        });
        assert.strictEqual(eF.ok, true);
        assert.strictEqual(eF.fogW, 30);
        assert.strictEqual(eF.fogH, 20);
        ok('GM setzt Fog-Dimensionen');

        const eFpl = await callAck(sPL, 'campaign:lighting:ensureFog', {
            campaignId: String(campaign._id), mapId: String(map._id), w: 10, h: 10,
        });
        assert.strictEqual(eFpl.ok, false);
        ok('Spieler darf Fog-Dimensionen NICHT setzen');

        // Spieler versucht Fog-Op
        const plFog = await callAck(sPL, 'campaign:lighting:fog', {
            campaignId: String(campaign._id), mapId: String(map._id),
            ops: [{ kind: 'reveal', shape: 'rect', x: 0, y: 0, w: 2, h: 2 }],
        });
        assert.strictEqual(plFog.ok, false);
        ok('Spieler darf Fog NICHT aendern');

        // GM Fog-Op -> Broadcast
        const liveWait = waitEvent(sPL, 'campaign:lighting:update');
        const gmFog = await callAck(sGM, 'campaign:lighting:fog', {
            campaignId: String(campaign._id), mapId: String(map._id),
            ops: [{ kind: 'reveal', shape: 'rect', x: 5, y: 5, w: 3, h: 3 }],
        });
        assert.strictEqual(gmFog.ok, true);
        const live = await liveWait;
        assert.strictEqual(live.mapId, String(map._id));
        const buf2 = toBuffer(live.lighting.fogBits, live.lighting.fogW, live.lighting.fogH);
        assert.strictEqual(bitAt(buf2, live.lighting.fogW, 5, 5), 0);
        ok('GM-Fog-Op -> Broadcast kommt beim Spieler an und zeigt aufgedeckte Zelle');

        section('Socket: Darkness-Toggle');
        const dWait = waitEvent(sPL, 'campaign:lighting:update');
        const dk = await callAck(sGM, 'campaign:lighting:darkness', {
            campaignId: String(campaign._id), mapId: String(map._id), on: true,
        });
        assert.strictEqual(dk.ok, true);
        const dEv = await dWait;
        assert.strictEqual(dEv.lighting.darkness, true);
        ok('Darkness an -> Push');

        const plDark = await callAck(sPL, 'campaign:lighting:darkness', {
            campaignId: String(campaign._id), mapId: String(map._id), on: false,
        });
        assert.strictEqual(plDark.ok, false);
        ok('Spieler darf Darkness nicht togglen');

        section('Socket: Lichter-Add (GM + Spieler eigenes Token)');
        const addWait = waitEvent(sPL, 'campaign:lighting:update');
        const addGM = await callAck(sGM, 'campaign:lighting:light:add', {
            campaignId: String(campaign._id), mapId: String(map._id),
            light: { kind: 'static', x: 10, y: 10, bright: 20, dim: 20, label: 'Fackel' },
        });
        assert.strictEqual(addGM.ok, true);
        assert.strictEqual(addGM.light.kind, 'static');
        const addEv = await addWait;
        assert.strictEqual(addEv.lighting.lights.length, 1);
        ok('GM legt static-Licht an');

        // Spieler versucht ein static-Licht anzulegen -> forbidden
        const plAddStatic = await callAck(sPL, 'campaign:lighting:light:add', {
            campaignId: String(campaign._id), mapId: String(map._id),
            light: { kind: 'static', x: 1, y: 1, bright: 10, dim: 10 },
        });
        assert.strictEqual(plAddStatic.ok, false);
        ok('Spieler darf NICHT static-Licht anlegen');

        // Spieler legt Licht an seinem eigenen Token an
        const plAddTok = await callAck(sPL, 'campaign:lighting:light:add', {
            campaignId: String(campaign._id), mapId: String(map._id),
            light: { kind: 'token', tokenId: 'tok-pl', bright: 20, dim: 20, label: 'Fackel' },
        });
        assert.strictEqual(plAddTok.ok, true);
        ok('Spieler darf Licht an eigenem Token anlegen');

        // Spieler versucht Licht an FREMDEM Token anzulegen
        await MapTokens.updateOne(
            { campaignId: campaign._id, mapId: map._id },
            { $push: { tokens: { id: 'tok-gm', ownerUserId: null, x: 2, y: 2, size: 1 } } }
        );
        const plAddFremd = await callAck(sPL, 'campaign:lighting:light:add', {
            campaignId: String(campaign._id), mapId: String(map._id),
            light: { kind: 'token', tokenId: 'tok-gm', bright: 20, dim: 20 },
        });
        assert.strictEqual(plAddFremd.ok, false);
        ok('Spieler darf NICHT Licht an fremdem Token anlegen');

        section('Socket: Lichter-Update + Remove');
        const plLightId = addEv.lighting.lights[0].id; // das war das static vom GM
        // Spieler darf das static-Licht nicht updaten
        const plUp = await callAck(sPL, 'campaign:lighting:light:update', {
            campaignId: String(campaign._id), mapId: String(map._id),
            lightId: plLightId, patch: { enabled: false },
        });
        assert.strictEqual(plUp.ok, false);

        // GM darf das static-Licht patchen
        const gmUp = await callAck(sGM, 'campaign:lighting:light:update', {
            campaignId: String(campaign._id), mapId: String(map._id),
            lightId: plLightId, patch: { bright: 40, dim: 40, color: '#ff0000' },
        });
        assert.strictEqual(gmUp.ok, true);
        assert.strictEqual(gmUp.light.bright, 40);
        assert.strictEqual(gmUp.light.color, '#ff0000');
        ok('GM patcht static-Licht (bright/dim/color)');

        // Spieler patcht sein eigenes Token-Licht (toggle enabled)
        const doc = await MapLighting.findOne({ campaignId: campaign._id, mapId: map._id });
        const tokLight = doc.lights.find((l) => l.kind === 'token' && l.tokenId === 'tok-pl');
        const plPatch = await callAck(sPL, 'campaign:lighting:light:update', {
            campaignId: String(campaign._id), mapId: String(map._id),
            lightId: tokLight.id, patch: { enabled: false },
        });
        assert.strictEqual(plPatch.ok, true);
        assert.strictEqual(plPatch.light.enabled, false);
        ok('Spieler darf sein eigenes Token-Licht togglen');

        // GM entfernt das static-Licht
        const gmRm = await callAck(sGM, 'campaign:lighting:light:remove', {
            campaignId: String(campaign._id), mapId: String(map._id), lightId: plLightId,
        });
        assert.strictEqual(gmRm.ok, true);
        ok('GM entfernt static-Licht');

        // Limit
        section('Socket: zu viele Lichter');
        const doc2 = await MapLighting.findOne({ campaignId: campaign._id, mapId: map._id });
        // push 50 Dummy-Lichter direkt in DB
        const seed = [];
        for (let i = 0; i < 50; i++) {
            seed.push({ id: `lt-s-${i}`, kind: 'static', x: i, y: 0, bright: 10, dim: 10, color: '#ffcf80', enabled: true });
        }
        doc2.lights = seed;
        await doc2.save();
        const over = await callAck(sGM, 'campaign:lighting:light:add', {
            campaignId: String(campaign._id), mapId: String(map._id),
            light: { kind: 'static', x: 99, y: 99, bright: 10, dim: 10 },
        });
        assert.strictEqual(over.ok, false);
        assert.strictEqual(over.msg, 'too many lights');
        ok('Limit MAX_LIGHTS wirkt');

        // Fremder Socket
        section('Socket: Fremder wird abgewiesen');
        const outFog = await callAck(sOut, 'campaign:lighting:fog', {
            campaignId: String(campaign._id), mapId: String(map._id),
            ops: [{ kind: 'reveal', shape: 'rect', x: 0, y: 0, w: 1, h: 1 }],
        });
        assert.strictEqual(outFog.ok, false);
        ok('Fremder darf keine Fog-Op schicken');

        // cleanup
        sGM.disconnect(); sPL.disconnect(); sOut.disconnect();

        console.log(process.exitCode ? '\nERGEBNIS: FAIL' : '\nERGEBNIS: OK');
    } catch (e) {
        console.error('Test error:', e);
        process.exitCode = 1;
    } finally {
        await new Promise((r) => io.close(r));
        await new Promise((r) => server.close(r));
        await mongoose.disconnect();
        await mem.stop();
    }
})();
