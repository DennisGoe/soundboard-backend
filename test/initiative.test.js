// Tests fuer Initiative (REST + Socket). Auch die Sortier-Regel + Zug-Logik.
// Ausfuehren: node test/initiative.test.js
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
const Character = require('../src/models/Character');
const Initiative = require('../src/models/Initiative');
const { sortEntries } = require('../src/combatOps');

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
        sock.emit(event, payload, (res) => {
            clearTimeout(t);
            resolve(res);
        });
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
    await mongoose.connect(mem.getUri(), { dbName: 't-init' });
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
    const outsider = await User.create({ username: 'out', password: 'x' });
    const tGm = tokenFor(gm._id);
    const tAlice = tokenFor(alice._id);
    const tBob = tokenFor(bob._id);
    const tOut = tokenFor(outsider._id);

    const charAlice = await Character.create({ owner: alice._id, name: 'Lyra', initiativeBonus: 4 });
    const charBob = await Character.create({ owner: bob._id, name: 'Thorin', initiativeBonus: 1 });

    const campaign = await Campaign.create({
        name: 'Kampf', owner: gm._id, players: [alice._id, bob._id],
    });
    const cid = String(campaign._id);

    try {
        section('sortEntries: Regel total desc, bonus Tiebreak, order Tiebreak');
        // Alice: 15+4=19, bonus 4
        // Bob:   18+1=19, bonus 1 -> schlechter trotz hoeherem Roll (?) NEIN: beide 19, Alice bonus hoeher -> zuerst
        // Carol: 10+5=15, bonus 5
        // Dan:   10+3=13, bonus 3
        const entries = [
            { id: 'a', name: 'Alice', roll: 15, bonus: 4, order: 1 },
            { id: 'b', name: 'Bob',   roll: 18, bonus: 1, order: 2 },
            { id: 'c', name: 'Carol', roll: 10, bonus: 5, order: 3 },
            { id: 'd', name: 'Dan',   roll: 10, bonus: 3, order: 4 },
        ];
        const sorted = sortEntries(entries);
        assert.deepStrictEqual(sorted.map((e) => e.id), ['a', 'b', 'c', 'd']);
        ok('Tie 19: Alice (bonus 4) vor Bob (bonus 1)');
        // Gleiche totals + bonus -> order: a vs. a2
        const t = sortEntries([
            { id: 'p', name: 'p', roll: 10, bonus: 3, order: 7 },
            { id: 'q', name: 'q', roll: 10, bonus: 3, order: 1 },
        ]);
        assert.deepStrictEqual(t.map((e) => e.id), ['q', 'p']);
        ok('Tie bonus: frueherer order gewinnt');

        section('REST GET /initiative legt leeren Tracker an');
        let r = await req(server, 'GET', `/api/campaigns/${cid}/initiative`, { token: tAlice });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.initiative.entries, []);
        assert.strictEqual(r.body.initiative.active, false);
        ok('Spieler darf lesen, leerer Tracker');
        r = await req(server, 'GET', `/api/campaigns/${cid}/initiative`, { token: tOut });
        assert.strictEqual(r.status, 404);
        ok('Outsider -> 404');

        section('Socket: Spieler wuerfelt; Server wuerfelt + sortiert + postet im Chat');
        const sAlice = await connect(port, tAlice);
        const sGm = await connect(port, tGm);
        const sBob = await connect(port, tBob);
        await callAck(sAlice, 'campaign:join', { campaignId: cid });
        await callAck(sGm,    'campaign:join', { campaignId: cid });
        await callAck(sBob,   'campaign:join', { campaignId: cid });
        ok('Alle beigetreten');

        // Alice wuerfelt; wir fangen BEIDES ab: initiative:update + chat (System 🎲)
        const pUpdate = waitEvent(sGm, 'campaign:initiative:update');
        const pChat   = waitEvent(sGm, 'campaign:chat');
        const rollAck = await callAck(sAlice, 'campaign:initiative:roll', {
            campaignId: cid, characterId: String(charAlice._id),
        });
        assert.strictEqual(rollAck.ok, true);
        assert.ok(rollAck.roll >= 1 && rollAck.roll <= 20);
        assert.strictEqual(rollAck.bonus, 4);
        const upd = await pUpdate;
        assert.strictEqual(upd.initiative.entries.length, 1);
        assert.strictEqual(upd.initiative.entries[0].name, 'Lyra');
        assert.strictEqual(upd.initiative.entries[0].bonus, 4);
        const msg = await pChat;
        assert.ok(/Lyra.*Initiative/.test(msg.text));
        assert.strictEqual(msg.username, 'System');
        ok('Alice gewuerfelt — alle bekommen Update + System-Chat');

        // Bob wuerfelt
        const rollBob = await callAck(sBob, 'campaign:initiative:roll', {
            campaignId: cid, characterId: String(charBob._id),
        });
        assert.strictEqual(rollBob.ok, true);
        assert.strictEqual(rollBob.bonus, 1);
        ok('Bob gewuerfelt');

        // Outsider darf nicht wuerfeln.
        const sOut = await connect(port, tOut);
        const rAck = await callAck(sOut, 'campaign:initiative:roll', { campaignId: cid });
        assert.strictEqual(rAck.ok, false);
        assert.strictEqual(rAck.msg, 'forbidden');
        ok('Outsider roll -> forbidden');
        sOut.close();

        section('GM: NSC hinzufuegen, Spieler sehen Update');
        const pU2 = waitEvent(sAlice, 'campaign:initiative:update');
        const npcAck = await callAck(sGm, 'campaign:initiative:addNpc', {
            campaignId: cid, name: 'Goblin', bonus: 2, roll: 17,
        });
        assert.strictEqual(npcAck.ok, true);
        const u2 = await pU2;
        assert.ok(u2.initiative.entries.find((e) => e.name === 'Goblin' && e.isNpc));
        ok('NSC sichtbar bei Spieler');

        // Spieler darf KEIN NSC
        const npcDeny = await callAck(sAlice, 'campaign:initiative:addNpc', {
            campaignId: cid, name: 'Dragon',
        });
        assert.strictEqual(npcDeny.ok, false);
        ok('Spieler darf keinen NSC anlegen');

        section('GM: Entry korrigieren');
        // Hole aktuellen State
        const stAck = await callAck(sGm, 'campaign:initiative:get', { campaignId: cid });
        const first = stAck.initiative.entries[0];
        const pU3 = waitEvent(sAlice, 'campaign:initiative:update');
        await callAck(sGm, 'campaign:initiative:update', {
            campaignId: cid, entryId: first.id,
            patch: { roll: 1, bonus: 0 },
        });
        const u3 = await pU3;
        // Entry sollte nach Korrektur weiter hinten einsortiert sein.
        const idx = u3.initiative.entries.findIndex((e) => e.id === first.id);
        assert.ok(idx >= 0);
        assert.strictEqual(u3.initiative.entries[idx].roll, 1);
        ok('GM Korrektur, neu sortiert');

        section('Kampf: Start, Zug weiter, Runde+1');
        await callAck(sGm, 'campaign:initiative:start', { campaignId: cid });
        let st = await callAck(sGm, 'campaign:initiative:get', { campaignId: cid });
        assert.strictEqual(st.initiative.active, true);
        assert.strictEqual(st.initiative.round, 1);
        assert.strictEqual(st.initiative.turnIndex, 0);
        ok('Start: Runde 1, Turn 0');

        const nEntries = st.initiative.entries.length;
        for (let i = 1; i < nEntries; i++) {
            await callAck(sGm, 'campaign:initiative:next', { campaignId: cid });
        }
        st = await callAck(sGm, 'campaign:initiative:get', { campaignId: cid });
        assert.strictEqual(st.initiative.turnIndex, nEntries - 1);
        assert.strictEqual(st.initiative.round, 1);
        ok('Durch alle durch, noch Runde 1');
        await callAck(sGm, 'campaign:initiative:next', { campaignId: cid });
        st = await callAck(sGm, 'campaign:initiative:get', { campaignId: cid });
        assert.strictEqual(st.initiative.turnIndex, 0);
        assert.strictEqual(st.initiative.round, 2);
        ok('Nach letzter -> Runde 2 Turn 0');

        // Spieler darf nicht weiter.
        const deny = await callAck(sAlice, 'campaign:initiative:next', { campaignId: cid });
        assert.strictEqual(deny.ok, false);
        ok('Spieler darf nicht weiter');

        await callAck(sGm, 'campaign:initiative:end', { campaignId: cid });
        st = await callAck(sGm, 'campaign:initiative:get', { campaignId: cid });
        assert.strictEqual(st.initiative.active, false);
        ok('Kampf beendet');

        section('Reset leert Entries');
        await callAck(sGm, 'campaign:initiative:reset', { campaignId: cid });
        st = await callAck(sGm, 'campaign:initiative:get', { campaignId: cid });
        assert.strictEqual(st.initiative.entries.length, 0);
        ok('Reset leer');

        section('Wurf-Override bonusOverride wird beachtet');
        await callAck(sAlice, 'campaign:initiative:roll', {
            campaignId: cid, characterId: String(charAlice._id), bonusOverride: 7,
        });
        st = await callAck(sAlice, 'campaign:initiative:get', { campaignId: cid });
        assert.strictEqual(st.initiative.entries[0].bonus, 7);
        ok('bonusOverride 7 verwendet');

        sAlice.close(); sGm.close(); sBob.close();

        console.log('\nAll initiative tests passed.');
    } catch (err) {
        console.error('\nTest failure:', err);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        await mem.stop();
        server.close();
    }
})();
