// Socket.io-Setup mit JWT-Auth, Soundboard-Events (playSound/log) UND
// Kampagnen-Spielraum (Presence, Chat, aktive Karte).
//
// Auth: handshake.auth.token (gesetzt vom FE-Client) ODER
// Authorization-Header ("Bearer ..."). Ungueltig -> next(Error) -> Client
// bekommt 'connect_error'.
//
// Rooms: pro Kampagne genau EIN Raum, Name "campaign:<id>". Beitritt nur,
// wenn der User owner oder in players ist.
//
// Presence: wir fuehren in diesem Modul eine In-Memory-Map pro Prozess.
// Mehrere Tabs desselben Users zaehlen als eine Person (wir zaehlen sockets
// pro user). Bei Disconnect wird entfernt; wenn der letzte Socket eines
// Users den Raum verlaesst, feuern wir "presence:leave" an den Raum.
// Hinweis: bei mehreren Backend-Instanzen wuerde man Redis-Adapter brauchen —
// Render-Starter deployt genau 1 Instanz, daher reicht Memory.

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Campaign = require('./models/Campaign');
const User = require('./models/User');
const ChatMessage = require('./models/ChatMessage');

function parseToken(socket) {
    const raw =
        socket.handshake?.auth?.token ||
        (socket.handshake?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!raw) return null;
    try {
        return jwt.verify(raw, process.env.JWT_SECRET);
    } catch {
        return null;
    }
}

function isValidId(id) {
    return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

// Pro Kampagne: Map<userId, Set<socketId>>. Liefert "Anzahl aktiver User".
const presence = new Map(); // campaignId -> Map<userId, Set<socketId>>

function addPresence(campaignId, userId, socketId) {
    let perUser = presence.get(campaignId);
    if (!perUser) {
        perUser = new Map();
        presence.set(campaignId, perUser);
    }
    let sockets = perUser.get(userId);
    const wasEmpty = !sockets || sockets.size === 0;
    if (!sockets) {
        sockets = new Set();
        perUser.set(userId, sockets);
    }
    sockets.add(socketId);
    return wasEmpty;
}

function removePresence(campaignId, userId, socketId) {
    const perUser = presence.get(campaignId);
    if (!perUser) return false;
    const sockets = perUser.get(userId);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size === 0) {
        perUser.delete(userId);
        if (perUser.size === 0) presence.delete(campaignId);
        return true;
    }
    return false;
}

async function presenceList(campaignId) {
    const perUser = presence.get(campaignId);
    if (!perUser || perUser.size === 0) return [];
    const ids = Array.from(perUser.keys());
    const users = await User.find({ _id: { $in: ids } }).select('_id username');
    return users.map((u) => ({ _id: String(u._id), username: u.username }));
}

async function roleFor(campaignId, userId) {
    const c = await Campaign.findById(campaignId).select('owner players activeMapId');
    if (!c) return null;
    if (String(c.owner) === String(userId)) return { role: 'owner', campaign: c };
    if ((c.players || []).some((p) => String(p) === String(userId))) {
        return { role: 'player', campaign: c };
    }
    return null;
}

function attach(io) {
    // JWT-Middleware fuer ALLE Sockets (auch Soundboard). Ohne Token wird
    // der handshake abgelehnt.
    io.use((socket, next) => {
        const payload = parseToken(socket);
        if (!payload?.user?.id) {
            return next(new Error('Unauthorized'));
        }
        socket.userId = String(payload.user.id);
        next();
    });

    io.on('connection', (socket) => {
        // Welche Kampagnen-Raeume dieser Socket aktuell halten soll.
        const joinedCampaigns = new Set();

        // --- Soundboard-Events (bestehend, nur jetzt authentifiziert) ---
        socket.on('playSound', (data) => {
            io.emit('playSound', data.sound);
            const time = new Date().toLocaleTimeString('de-DE', { hour12: false });
            io.emit(
                'log',
                `${time} ${data.user} played sound: ${data.sound?.name}`
            );
        });

        // --- Kampagnen-Spielraum ---

        // Beitreten: prueft Mitgliedschaft; fuegt Socket zum Raum hinzu;
        // aktualisiert Presence; sendet dem Aufrufer die aktuelle Liste.
        socket.on('campaign:join', async ({ campaignId } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const room = `campaign:${campaignId}`;
                socket.join(room);
                joinedCampaigns.add(campaignId);
                const firstTab = addPresence(campaignId, socket.userId, socket.id);
                const list = await presenceList(campaignId);
                // dem Caller die aktuelle Liste geben
                if (typeof ack === 'function') {
                    ack({
                        ok: true,
                        role: info.role,
                        presence: list,
                        activeMapId: info.campaign.activeMapId
                            ? String(info.campaign.activeMapId)
                            : null,
                    });
                }
                // allen (inkl. Caller) die neue Liste pushen, damit UIs
                // nicht ein zweites Event brauchen
                io.to(room).emit('campaign:presence', { campaignId, users: list });
                if (firstTab) {
                    // Optional ein leichtes Join-Event, falls das FE Toasts will.
                    io.to(room).emit('campaign:userJoined', {
                        campaignId,
                        userId: socket.userId,
                    });
                }
            } catch (e) {
                console.error('campaign:join error:', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // Freiwilliges Verlassen (z.B. User navigiert weg; wir trennen den
        // Socket aber nicht, falls er noch Soundboard-Events hoert).
        socket.on('campaign:leave', async ({ campaignId } = {}) => {
            if (!isValidId(campaignId)) return;
            const room = `campaign:${campaignId}`;
            socket.leave(room);
            joinedCampaigns.delete(campaignId);
            const lastTab = removePresence(campaignId, socket.userId, socket.id);
            const list = await presenceList(campaignId);
            io.to(room).emit('campaign:presence', { campaignId, users: list });
            if (lastTab) {
                io.to(room).emit('campaign:userLeft', {
                    campaignId,
                    userId: socket.userId,
                });
            }
        });

        // Chat-Nachricht: in Mongo speichern + an Raum broadcasten.
        socket.on('campaign:chat', async ({ campaignId, text } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                if (typeof text !== 'string') {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'text required' });
                    return;
                }
                const trimmed = text.trim();
                if (trimmed.length < 1 || trimmed.length > 2000) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'text length' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const user = await User.findById(socket.userId).select('username');
                const username = user?.username || 'Unbekannt';
                const msg = await ChatMessage.create({
                    campaignId,
                    userId: socket.userId,
                    username,
                    text: trimmed,
                });
                const payload = {
                    _id: String(msg._id),
                    userId: String(msg.userId),
                    username: msg.username,
                    text: msg.text,
                    createdAt: msg.createdAt,
                    campaignId: String(campaignId),
                };
                io.to(`campaign:${campaignId}`).emit('campaign:chat', payload);
                if (typeof ack === 'function') ack({ ok: true, message: payload });
            } catch (e) {
                console.error('campaign:chat error:', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM waehlt aktive Karte. Server validiert gegen DB (nicht Vertrauen
        // auf Socket-Payload) und broadcastet.
        socket.on('campaign:setActiveMap', async ({ campaignId, mapId } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                if (mapId !== null && !isValidId(mapId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid mapId' });
                    return;
                }
                const campaign = await Campaign.findById(campaignId);
                if (!campaign) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'not found' });
                    return;
                }
                if (String(campaign.owner) !== socket.userId) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                if (mapId) {
                    const assigned = (campaign.mapIds || []).some(
                        (m) => String(m) === String(mapId)
                    );
                    if (!assigned) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'map not assigned' });
                        return;
                    }
                }
                campaign.activeMapId = mapId
                    ? new mongoose.Types.ObjectId(mapId)
                    : null;
                await campaign.save();
                io.to(`campaign:${campaignId}`).emit('campaign:activeMap', {
                    campaignId: String(campaignId),
                    activeMapId: campaign.activeMapId ? String(campaign.activeMapId) : null,
                });
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('campaign:setActiveMap error:', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        socket.on('disconnect', async () => {
            // Presence in allen betretenen Raeumen aufraeumen.
            for (const campaignId of Array.from(joinedCampaigns)) {
                const room = `campaign:${campaignId}`;
                const lastTab = removePresence(campaignId, socket.userId, socket.id);
                try {
                    const list = await presenceList(campaignId);
                    io.to(room).emit('campaign:presence', { campaignId, users: list });
                    if (lastTab) {
                        io.to(room).emit('campaign:userLeft', {
                            campaignId,
                            userId: socket.userId,
                        });
                    }
                } catch (e) {
                    console.error('disconnect cleanup error:', e);
                }
            }
        });
    });
}

module.exports = {
    attachSocket: attach,
    // fuer Tests exportieren:
    _presence: presence,
};
