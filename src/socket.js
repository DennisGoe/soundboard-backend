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
const Character = require('./models/Character');
const MapTokens = require('./models/MapTokens');

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
    const c = await Campaign.findById(campaignId).select('owner players mapIds activeMapId characterSelections');
    if (!c) return null;
    if (String(c.owner) === String(userId)) return { role: 'owner', campaign: c };
    if ((c.players || []).some((p) => String(p) === String(userId))) {
        return { role: 'player', campaign: c };
    }
    return null;
}

// Hilfs-Funktion: prueft, ob ein Spieler (non-GM) ein Token bewegen darf.
// Regel:
//  - Token nicht locked
//  - groupId (falls gesetzt) ist nicht locked
//  - Token gehoert dem User ODER Token ist in einer Gruppe, in der auch ein
//    Token des Users liegt (Gruppen-Mitbewegung).
function playerCanMoveToken(token, allTokens, groupsById, userId) {
    if (token.locked) return false;
    if (token.groupId) {
        const g = groupsById.get(token.groupId);
        if (g && g.locked) return false;
    }
    if (String(token.ownerUserId || '') === String(userId)) return true;
    if (token.groupId) {
        // Gruppenkamerad eines eigenen Tokens?
        return allTokens.some(
            (t) => t.groupId === token.groupId && String(t.ownerUserId || '') === String(userId)
        );
    }
    return false;
}

async function loadMapTokens(campaignId, mapId) {
    // Atomar: anlegen wenn noch nicht vorhanden. Schuetzt gegen Race-Condition
    // (z.B. GM + Spieler laden gleichzeitig beim Karteneinstieg).
    const doc = await MapTokens.findOneAndUpdate(
        { campaignId, mapId },
        { $setOnInsert: { campaignId, mapId, tokens: [], groups: [] } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return doc;
}

function sanitizeTokenForAdd(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x), y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const size = Number.isFinite(raw.size) && raw.size >= 0.25 && raw.size <= 10 ? raw.size : 1;
    const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64
        ? raw.id : `tok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return {
        id,
        characterId: raw.characterId && mongoose.Types.ObjectId.isValid(raw.characterId)
            ? new mongoose.Types.ObjectId(raw.characterId) : null,
        ownerUserId: raw.ownerUserId && mongoose.Types.ObjectId.isValid(raw.ownerUserId)
            ? new mongoose.Types.ObjectId(raw.ownerUserId) : null,
        label: typeof raw.label === 'string' ? raw.label.slice(0, 80) : '',
        color: typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)
            ? raw.color : '#9b2a1e',
        x, y, size,
        groupId: typeof raw.groupId === 'string' ? raw.groupId.slice(0, 64) : null,
        locked: !!raw.locked,
    };
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

        // --- Tokens (pro Campaign x Map) ---
        // Hilfsmethode: Auslesen und ggf. anlegen.
        async function withRoom(campaignId, mapId, requireOwner, ack) {
            if (!isValidId(campaignId) || !isValidId(mapId)) {
                if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                return null;
            }
            const info = await roleFor(campaignId, socket.userId);
            if (!info) {
                if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                return null;
            }
            if (requireOwner && info.role !== 'owner') {
                if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                return null;
            }
            // map muss in der Kampagne zugewiesen sein.
            const assigned = (info.campaign.mapIds || []).some(
                (m) => String(m) === String(mapId)
            );
            if (!assigned) {
                if (typeof ack === 'function') ack({ ok: false, msg: 'map not assigned' });
                return null;
            }
            const doc = await loadMapTokens(campaignId, mapId);
            return { info, doc };
        }

        function broadcastTokens(campaignId, mapId, doc) {
            io.to(`campaign:${campaignId}`).emit('campaign:tokens:update', {
                campaignId: String(campaignId),
                mapId: String(mapId),
                tokens: doc.tokens,
                groups: doc.groups,
            });
        }

        socket.on('campaign:tokens:get', async ({ campaignId, mapId } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, false, ack);
                if (!ctx) return;
                if (typeof ack === 'function') {
                    ack({ ok: true, tokens: ctx.doc.tokens, groups: ctx.doc.groups });
                }
            } catch (e) {
                console.error('tokens:get error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        socket.on('campaign:tokens:add', async ({ campaignId, mapId, token } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, true, ack);
                if (!ctx) return;
                const clean = sanitizeTokenForAdd(token);
                if (!clean) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid token' });
                    return;
                }
                // Dedupe falls id kollidiert.
                if (ctx.doc.tokens.some((t) => t.id === clean.id)) {
                    clean.id = `tok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
                }
                ctx.doc.tokens.push(clean);
                await ctx.doc.save();
                broadcastTokens(campaignId, mapId, ctx.doc);
                if (typeof ack === 'function') ack({ ok: true, token: clean });
            } catch (e) {
                console.error('tokens:add error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        socket.on('campaign:tokens:remove', async ({ campaignId, mapId, tokenId } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, true, ack);
                if (!ctx) return;
                ctx.doc.tokens = ctx.doc.tokens.filter((t) => t.id !== tokenId);
                await ctx.doc.save();
                broadcastTokens(campaignId, mapId, ctx.doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('tokens:remove error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // Live-Tick waehrend des Draggens — NICHT persistiert. Broadcast ohne DB.
        // Rechte trotzdem pruefen, damit kein Spieler fremde Tokens schubsen kann.
        socket.on('campaign:tokens:move', async ({ campaignId, mapId, updates } = {}) => {
            try {
                if (!isValidId(campaignId) || !isValidId(mapId)) return;
                if (!Array.isArray(updates) || updates.length === 0) return;
                const info = await roleFor(campaignId, socket.userId);
                if (!info) return;
                const doc = await loadMapTokens(campaignId, mapId);
                const groupsById = new Map(doc.groups.map((g) => [g.id, g]));
                const tokensById = new Map(doc.tokens.map((t) => [t.id, t]));
                const allowed = [];
                for (const u of updates) {
                    if (!u || typeof u !== 'object') continue;
                    const t = tokensById.get(u.id);
                    if (!t) continue;
                    if (!Number.isFinite(u.x) || !Number.isFinite(u.y)) continue;
                    if (info.role !== 'owner') {
                        if (!playerCanMoveToken(t, doc.tokens, groupsById, socket.userId)) continue;
                    }
                    allowed.push({ id: u.id, x: u.x, y: u.y });
                }
                if (allowed.length === 0) return;
                io.to(`campaign:${campaignId}`).emit('campaign:tokens:tick', {
                    campaignId: String(campaignId),
                    mapId: String(mapId),
                    updates: allowed,
                });
            } catch (e) {
                console.error('tokens:move error', e);
            }
        });

        // Loslassen -> persistieren und broadcast final state.
        socket.on('campaign:tokens:drop', async ({ campaignId, mapId, updates } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, false, ack);
                if (!ctx) return;
                if (!Array.isArray(updates)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'updates required' });
                    return;
                }
                const groupsById = new Map(ctx.doc.groups.map((g) => [g.id, g]));
                const tokensById = new Map(ctx.doc.tokens.map((t) => [t.id, t]));
                let changed = 0;
                for (const u of updates) {
                    if (!u || typeof u !== 'object') continue;
                    const t = tokensById.get(u.id);
                    if (!t) continue;
                    if (!Number.isFinite(u.x) || !Number.isFinite(u.y)) continue;
                    if (ctx.info.role !== 'owner') {
                        if (!playerCanMoveToken(t, ctx.doc.tokens, groupsById, socket.userId)) continue;
                    }
                    t.x = u.x; t.y = u.y;
                    changed++;
                }
                if (changed > 0) {
                    ctx.doc.markModified('tokens');
                    await ctx.doc.save();
                    broadcastTokens(campaignId, mapId, ctx.doc);
                }
                if (typeof ack === 'function') ack({ ok: true, changed });
            } catch (e) {
                console.error('tokens:drop error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        socket.on('campaign:tokens:resize', async ({ campaignId, mapId, tokenId, size } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, true, ack);
                if (!ctx) return;
                const s = Number(size);
                if (!Number.isFinite(s) || s < 0.25 || s > 10) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'size invalid' });
                    return;
                }
                const t = ctx.doc.tokens.find((x) => x.id === tokenId);
                if (!t) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'not found' });
                    return;
                }
                t.size = s;
                ctx.doc.markModified('tokens');
                await ctx.doc.save();
                broadcastTokens(campaignId, mapId, ctx.doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('tokens:resize error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        socket.on('campaign:tokens:lock', async ({ campaignId, mapId, tokenId, locked } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, true, ack);
                if (!ctx) return;
                const t = ctx.doc.tokens.find((x) => x.id === tokenId);
                if (!t) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'not found' });
                    return;
                }
                t.locked = !!locked;
                ctx.doc.markModified('tokens');
                await ctx.doc.save();
                broadcastTokens(campaignId, mapId, ctx.doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('tokens:lock error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        socket.on('campaign:tokens:group', async ({ campaignId, mapId, name, tokenIds } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, true, ack);
                if (!ctx) return;
                if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'need >=2 tokens' });
                    return;
                }
                const gid = `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                const groupName = typeof name === 'string' ? name.slice(0, 64) : '';
                ctx.doc.groups.push({ id: gid, name: groupName, locked: false });
                for (const t of ctx.doc.tokens) {
                    if (tokenIds.includes(t.id)) t.groupId = gid;
                }
                ctx.doc.markModified('tokens');
                ctx.doc.markModified('groups');
                await ctx.doc.save();
                broadcastTokens(campaignId, mapId, ctx.doc);
                if (typeof ack === 'function') ack({ ok: true, groupId: gid });
            } catch (e) {
                console.error('tokens:group error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        socket.on('campaign:tokens:ungroup', async ({ campaignId, mapId, groupId } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, true, ack);
                if (!ctx) return;
                ctx.doc.groups = ctx.doc.groups.filter((g) => g.id !== groupId);
                for (const t of ctx.doc.tokens) {
                    if (t.groupId === groupId) t.groupId = null;
                }
                ctx.doc.markModified('tokens');
                ctx.doc.markModified('groups');
                await ctx.doc.save();
                broadcastTokens(campaignId, mapId, ctx.doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('tokens:ungroup error', e);
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
