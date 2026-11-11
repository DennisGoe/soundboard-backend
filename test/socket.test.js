// Socket.io-Tests fuer Auth + Kampagnen-Raum (Mitgliedschaft, Presence,
// Chat-Persistenz, aktive Karte).
// Ausfuehren: node test/socket.test.js

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
const Map = require('../src/models/Map');
const ChatMessage = require('../src/models/ChatMessage');

function tokenFor(userId) {
    return jwt.sign({ user: { id: String(userId) } }, process.env.JWT_SECRET, {
        expiresIn: '1h',
    });
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

function waitEvent(sock, name, ms = 2000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            sock.off(name);
            reject(new Error(`timeout waiting for ${name}`));
        }, ms);
        sock.once(name, (p) => {
            clearTimeout(t);
            resolve(p);
        });
    });
}

function callAck(sock, event, payload, ms = 2000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout ack ${event}`)), ms);
        sock.emit(event, payload, (res) => {
            clearTimeout(t);
            resolve(res);
        });
    });
}

(async () => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri(), { dbName: 'socket-test' });

    const app = createApp({ includeFileUploads: false });
    const server = http.createServer(app);
    const io = socketIo(server, { cors: { origin: '*' } });
    attachSocket(io);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    app.set('io', io);

    const gm = await User.create({ username: 'gm', password: 'x' });
    const pl = await User.create({ username: 'player', password: 'x' });
    const outsider = await User.create({ username: 'outsider', password: 'x' });

    const map1 = await Map.create({ name: 'Karte 1', owner: gm._id, doc: {} });
    const map2 = await Map.create({ name: 'Karte 2', owner: gm._id, doc: {} });
    const campaign = await Campaign.create({
        name: 'SocketTest', owner: gm._id, players: [pl._id], mapIds: [map1._id, map2._id],
    });

    const tokGM = tokenFor(gm._id);
    const tokPL = tokenFor(pl._id);
    const tokOut = tokenFor(outsider._id);

    try {
        section('Auth');
        let failed = false;
        try {
            await connect(port, null);
        } catch (e) {
            failed = true;
        }
        assert.strictEqual(failed, true);
        ok('Verbindung ohne Token wird abgelehnt');

        failed = false;
        try {
            await connect(port, 'nope.not.a.jwt');
        } catch (e) {
            failed = true;
        }
        assert.strictEqual(failed, true);
        ok('Ungueltiger Token wird abgelehnt');

        const sockGM = await connect(port, tokGM);
        const sockPL = await connect(port, tokPL);
        const sockOut = await connect(port, tokOut);
        ok('Gueltige Tokens verbinden');

        section('Raum-Beitritt: Mitgliedschaft');
        const joinGM = await callAck(sockGM, 'campaign:join', { campaignId: String(campaign._id) });
        assert.strictEqual(joinGM.ok, true);
        assert.strictEqual(joinGM.role, 'owner');
        ok('GM joined als owner');

        const joinOut = await callAck(sockOut, 'campaign:join', { campaignId: String(campaign._id) });
        assert.strictEqual(joinOut.ok, false);
        assert.strictEqual(joinOut.msg, 'forbidden');
        ok('Fremder kommt NICHT in den Raum (forbidden)');

        const joinInvalid = await callAck(sockGM, 'campaign:join', { campaignId: 'not-an-id' });
        assert.strictEqual(joinInvalid.ok, false);
        ok('Kaputte campaignId -> ack.ok=false');

        section('Presence: Spieler kommt, GM sieht Event');
        const presenceWait = waitEvent(sockGM, 'campaign:presence');
        const joinPL = await callAck(sockPL, 'campaign:join', { campaignId: String(campaign._id) });
        assert.strictEqual(joinPL.ok, true);
        const presence = await presenceWait;
        assert.ok(presence.users.some((u) => u.username === 'gm'));
        assert.ok(presence.users.some((u) => u.username === 'player'));
        ok(`Presence-Liste: ${presence.users.map((u) => u.username).join(', ')}`);

        section('Presence: zwei Tabs desselben Users = 1 Eintrag');
        const sockPL2 = await connect(port, tokPL);
        const presenceAfter2 = await callAck(sockPL2, 'campaign:join', { campaignId: String(campaign._id) });
        assert.strictEqual(presenceAfter2.ok, true);
        // 1 x gm + 1 x player
        assert.strictEqual(presenceAfter2.presence.length, 2);
        ok('2 Tabs des Spielers zaehlen als 1 Person');

        section('Chat: broadcast + Persistenz');
        const recvGM = waitEvent(sockGM, 'campaign:chat');
        const recvPL = waitEvent(sockPL, 'campaign:chat');
        const chatAck = await callAck(sockPL, 'campaign:chat', {
            campaignId: String(campaign._id),
            text: 'Hallo Welt',
        });
        assert.strictEqual(chatAck.ok, true);
        const gotGM = await recvGM;
        const gotPL = await recvPL;
        assert.strictEqual(gotGM.text, 'Hallo Welt');
        assert.strictEqual(gotGM.username, 'player');
        assert.strictEqual(gotPL.text, 'Hallo Welt');
        ok('Chat wird an alle im Raum geschickt');
        const stored = await ChatMessage.find({ campaignId: campaign._id });
        assert.strictEqual(stored.length, 1);
        ok('Chat wurde in Mongo gespeichert');

        // Leerer / zu langer Text
        const bad = await callAck(sockPL, 'campaign:chat', {
            campaignId: String(campaign._id), text: '',
        });
        assert.strictEqual(bad.ok, false);
        ok('Leerer Chat-Text -> ack.ok=false');
        const tooLong = await callAck(sockPL, 'campaign:chat', {
            campaignId: String(campaign._id), text: 'x'.repeat(2001),
        });
        assert.strictEqual(tooLong.ok, false);
        ok('Zu langer Chat-Text -> ack.ok=false');

        section('setActiveMap: nur GM');
        const activeWait = waitEvent(sockPL, 'campaign:activeMap');
        const setAck = await callAck(sockGM, 'campaign:setActiveMap', {
            campaignId: String(campaign._id), mapId: String(map1._id),
        });
        assert.strictEqual(setAck.ok, true);
        const broadcast = await activeWait;
        assert.strictEqual(broadcast.activeMapId, String(map1._id));
        ok('GM setzt Karte, Spieler bekommt Push');

        const plSet = await callAck(sockPL, 'campaign:setActiveMap', {
            campaignId: String(campaign._id), mapId: String(map2._id),
        });
        assert.strictEqual(plSet.ok, false);
        ok('Spieler kann Karte nicht setzen');

        const fresh = await Campaign.findById(campaign._id);
        assert.strictEqual(String(fresh.activeMapId), String(map1._id));
        ok('DB behaelt map1 (Spieler-Versuch wurde nicht persistiert)');

        section('Spaeter beitretender Spieler sieht aktuelle Karte');
        const pl2 = await User.create({ username: 'player2', password: 'x' });
        campaign.players.push(pl2._id);
        await campaign.save();
        const sockPL3 = await connect(port, tokenFor(pl2._id));
        const join3 = await callAck(sockPL3, 'campaign:join', { campaignId: String(campaign._id) });
        assert.strictEqual(join3.ok, true);
        assert.strictEqual(join3.activeMapId, String(map1._id));
        ok('Neuer Spieler bekommt activeMapId beim Join');

        section('Soundboard-Events bleiben erhalten');
        const soundWait = waitEvent(sockGM, 'playSound');
        sockPL.emit('playSound', { user: 'player', sound: { name: 'horn' } });
        const sound = await soundWait;
        assert.strictEqual(sound.name, 'horn');
        ok('playSound funktioniert weiterhin an alle Sockets');

        section('Disconnect raeumt Presence auf');
        // Wir sammeln alle presence-Events bis "player" nicht mehr drin ist.
        const presenceEvents = [];
        sockGM.on('campaign:presence', (e) => presenceEvents.push(e));
        sockPL.disconnect();
        sockPL2.disconnect();
        // Kurz warten, bis beide Disconnects verarbeitet wurden.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            const last = presenceEvents[presenceEvents.length - 1];
            if (last && !last.users.some((u) => u.username === 'player')) break;
            await new Promise((r) => setTimeout(r, 50));
        }
        sockGM.off('campaign:presence');
        const finalEv = presenceEvents[presenceEvents.length - 1];
        assert.ok(finalEv, 'mindestens ein presence-Event erwartet');
        assert.ok(!finalEv.users.some((u) => u.username === 'player'));
        ok(`player ist nach Disconnect aller Tabs aus der Liste (events=${presenceEvents.length})`);

        sockGM.disconnect();
        sockOut.disconnect();
        sockPL3.disconnect();

        section('Zusammenfassung');
        console.log(process.exitCode ? 'ERGEBNIS: FAIL' : 'ERGEBNIS: OK');
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
