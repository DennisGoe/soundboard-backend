// Tests fuer Inventar (REST + Socket). Rechte, Transfer, Live-Push gezielt.
// Ausfuehren: node test/inventory.test.js
const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const socketIo = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
const { createApp } = require('../src/app');
const { attachSocket } = require('../src/socket');
const User = require('../src/models/User');
const Campaign = require('../src/models/Campaign');

function tokenFor(uid) {
    return jwt.sign({ user: { id: String(uid) } }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function ok(d) { console.log(`  OK   ${d}`); }
function section(d) { console.log(`\n--- ${d} ---`); }

function connect(port, token) {
    return new Promise((resolve, reject) => {
        const sock = ioClient(`http://127.0.0.1:${port}`, {
            transports: ['websocket'], auth: token ? { token } : undefined,
            reconnection: false, timeout: 3000,
        });
        sock.once('connect', () => resolve(sock));
        sock.once('connect_error', (err) => reject(err));
    });
}
function callAck(sock, event, payload, ms = 2500) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout ack ${event}`)), ms);
        sock.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
    });
}
function waitEvent(sock, name, ms = 2000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { sock.off(name); reject(new Error(`timeout ${name}`)); }, ms);
        sock.once(name, (p) => { clearTimeout(t); resolve(p); });
    });
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
                let json = null; try { json = data ? JSON.parse(data) : null; } catch {}
                resolve({ status: res.statusCode, body: json });
            });
        });
        r.on('error', reject);
        if (payload != null) r.write(payload);
        r.end();
    });
}

(async () => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri(), { dbName: 't-inv' });
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
    const tGm = tokenFor(gm._id); const tAlice = tokenFor(alice._id);
    const tBob = tokenFor(bob._id); const tOut = tokenFor(outsider._id);

    const campaign = await Campaign.create({
        name: 'Beutetour', owner: gm._id, players: [alice._id, bob._id],
    });
    const cid = String(campaign._id);

    try {
        section('REST GET /inventory legt leeres Doc an');
        let r = await req(server, 'GET', `/api/campaigns/${cid}/inventory`, { token: tAlice });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.inventory.items, []);
        assert.strictEqual(r.body.inventory.notes, '');
        assert.strictEqual(String(r.body.inventory.userId), String(alice._id));
        ok('Alice GET /inventory');

        r = await req(server, 'GET', `/api/campaigns/${cid}/inventory`, { token: tOut });
        assert.strictEqual(r.status, 404);
        ok('Outsider /inventory -> 404');

        section('REST GET /inventories nur GM');
        r = await req(server, 'GET', `/api/campaigns/${cid}/inventories`, { token: tAlice });
        assert.strictEqual(r.status, 403);
        ok('Spieler -> 403');
        r = await req(server, 'GET', `/api/campaigns/${cid}/inventories`, { token: tGm });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.inventories.length, 3); // gm + alice + bob
        const usernames = r.body.inventories.map((i) => i.username).sort();
        assert.deepStrictEqual(usernames, ['alice', 'bob', 'gm']);
        ok('GM sieht 3 Inventare');

        section('Socket: Items hinzufuegen/aendern — gezielter Push an Spieler + GM');
        const sAlice = await connect(port, tAlice);
        const sBob   = await connect(port, tBob);
        const sGm    = await connect(port, tGm);
        await callAck(sAlice, 'campaign:join', { campaignId: cid });
        await callAck(sBob,   'campaign:join', { campaignId: cid });
        await callAck(sGm,    'campaign:join', { campaignId: cid });

        const pGm = waitEvent(sGm, 'campaign:inventory:update');
        const pAlice = waitEvent(sAlice, 'campaign:inventory:update');
        const addAck = await callAck(sAlice, 'campaign:inventory:addItem', {
            campaignId: cid, item: { name: 'Goldstueck', qty: 10, description: 'glitzert' },
        });
        assert.strictEqual(addAck.ok, true);
        const upAlice = await pAlice;
        const upGm    = await pGm;
        assert.strictEqual(upAlice.inventory.items.length, 1);
        assert.strictEqual(upGm.inventory.items[0].name, 'Goldstueck');
        ok('Alice + GM bekommen Push');

        // Bob darf NICHT Alices Inventory sehen.
        let gotBob = false;
        sBob.once('campaign:inventory:update', () => { gotBob = true; });
        await new Promise((r2) => setTimeout(r2, 200));
        assert.strictEqual(gotBob, false);
        ok('Bob bekommt KEIN Push von Alices Add');

        section('Spieler darf nur sich selbst anlegen');
        const stealAck = await callAck(sAlice, 'campaign:inventory:addItem', {
            campaignId: cid, targetUserId: String(bob._id),
            item: { name: 'Trojaner', qty: 1 },
        });
        assert.strictEqual(stealAck.ok, false);
        assert.strictEqual(stealAck.msg, 'forbidden');
        ok('Alice -> Bobs Inventory add verweigert');

        section('GM darf fuer Spieler anlegen');
        const pBobInv = waitEvent(sBob, 'campaign:inventory:update');
        const gmAddAck = await callAck(sGm, 'campaign:inventory:addItem', {
            campaignId: cid, targetUserId: String(bob._id),
            item: { name: 'Rüstung', qty: 1, description: 'Leder' },
        });
        assert.strictEqual(gmAddAck.ok, true);
        const bobInv = await pBobInv;
        assert.strictEqual(bobInv.inventory.items[0].name, 'Rüstung');
        assert.strictEqual(String(bobInv.inventory.userId), String(bob._id));
        ok('GM add fuer Bob -> Bob sieht Push');

        section('Transfer Alice -> Bob (Teilmenge)');
        const aliceGoldId = addAck.item.id;
        const pA = waitEvent(sAlice, 'campaign:inventory:update');
        const pB = waitEvent(sBob, 'campaign:inventory:update');
        const trAck = await callAck(sGm, 'campaign:inventory:transfer', {
            campaignId: cid,
            fromUserId: String(alice._id), toUserId: String(bob._id),
            itemId: aliceGoldId, qty: 4,
        });
        assert.strictEqual(trAck.ok, true);
        assert.strictEqual(trAck.taken, 4);
        const aAfter = await pA;
        const bAfter = await pB;
        const aliceGold = aAfter.inventory.items.find((i) => i.name === 'Goldstueck');
        assert.strictEqual(aliceGold.qty, 6);
        const bobGold = bAfter.inventory.items.find((i) => i.name === 'Goldstueck');
        assert.strictEqual(bobGold.qty, 4);
        ok('Teilmengen-Transfer korrekt');

        // Transfer-Rest: Alices Rest 6 ganz nach Bob -> Alice hat Item nicht mehr.
        const pA2 = waitEvent(sAlice, 'campaign:inventory:update');
        const pB2 = waitEvent(sBob, 'campaign:inventory:update');
        const trRestAck = await callAck(sGm, 'campaign:inventory:transfer', {
            campaignId: cid,
            fromUserId: String(alice._id), toUserId: String(bob._id),
            itemId: aliceGoldId, qty: 100, // >= 6
        });
        assert.strictEqual(trRestAck.ok, true);
        assert.strictEqual(trRestAck.taken, 6);
        const aAfter2 = await pA2;
        const bAfter2 = await pB2;
        assert.strictEqual(aAfter2.inventory.items.find((i) => i.name === 'Goldstueck'), undefined);
        assert.strictEqual(bAfter2.inventory.items.find((i) => i.name === 'Goldstueck').qty, 10);
        ok('Rest-Transfer stapelt in Bobs bestehendes Goldstueck');

        section('Spieler darf transfer NICHT');
        const plTr = await callAck(sAlice, 'campaign:inventory:transfer', {
            campaignId: cid, fromUserId: String(bob._id), toUserId: String(alice._id),
            itemId: 'xxx', qty: 1,
        });
        assert.strictEqual(plTr.ok, false);
        ok('Spieler-Transfer verweigert');

        section('setNotes, updateItem, removeItem Rechte');
        // Alice schreibt eigene Notes
        const pN = waitEvent(sAlice, 'campaign:inventory:update');
        await callAck(sAlice, 'campaign:inventory:setNotes', {
            campaignId: cid, notes: 'Mein Charakterblatt.',
        });
        const nMsg = await pN;
        assert.strictEqual(nMsg.inventory.notes, 'Mein Charakterblatt.');
        ok('Alice setNotes eigen');
        // Spieler kann KEINE Notes fuer Bob setzen.
        const bN = await callAck(sAlice, 'campaign:inventory:setNotes', {
            campaignId: cid, targetUserId: String(bob._id), notes: 'hack',
        });
        assert.strictEqual(bN.ok, false);
        ok('Alice setNotes bei Bob verweigert');

        // Update Item (Bob macht Ruestung +Beschreibung)
        const items = (await callAck(sBob, 'campaign:inventory:get', { campaignId: cid })).inventory.items;
        const ruest = items.find((i) => i.name === 'Rüstung');
        await callAck(sBob, 'campaign:inventory:updateItem', {
            campaignId: cid, itemId: ruest.id, patch: { description: 'alt+abgewetzt' },
        });
        const upd = await callAck(sBob, 'campaign:inventory:get', { campaignId: cid });
        assert.strictEqual(upd.inventory.items.find((i) => i.id === ruest.id).description, 'alt+abgewetzt');
        ok('Bob updateItem eigen');

        // Remove nur eigenes.
        const stealRm = await callAck(sAlice, 'campaign:inventory:removeItem', {
            campaignId: cid, targetUserId: String(bob._id), itemId: ruest.id,
        });
        assert.strictEqual(stealRm.ok, false);
        ok('Alice remove bei Bob verweigert');

        // GM darf.
        const pBobRm = waitEvent(sBob, 'campaign:inventory:update');
        await callAck(sGm, 'campaign:inventory:removeItem', {
            campaignId: cid, targetUserId: String(bob._id), itemId: ruest.id,
        });
        const bRm = await pBobRm;
        assert.strictEqual(bRm.inventory.items.find((i) => i.id === ruest.id), undefined);
        ok('GM remove bei Bob OK');

        section('Validierungen: Item-Name Pflicht, qty-Grenzen');
        const bad1 = await callAck(sAlice, 'campaign:inventory:addItem', {
            campaignId: cid, item: { name: '', qty: 1 },
        });
        assert.strictEqual(bad1.ok, false);
        const bad2 = await callAck(sAlice, 'campaign:inventory:addItem', {
            campaignId: cid, item: { name: 'X', qty: 0 },
        });
        // qty=0 wird auf 1 geclampt (gueltig)
        assert.strictEqual(bad2.ok, true);
        ok('Name-Pflicht + qty default 1');

        sAlice.close(); sBob.close(); sGm.close();
        console.log('\nAll inventory tests passed.');
    } catch (err) {
        console.error('\nTest failure:', err);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        await mem.stop();
        server.close();
    }
})();
