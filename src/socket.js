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
const MapLighting = require('./models/MapLighting');
const Initiative = require('./models/Initiative');
const Inventory = require('./models/Inventory');
const {
    applyFogOps,
    ensureFogDims,
    sanitizeLight,
    MAX_LIGHTS,
    emptyBits,
} = require('./lightingOps');
const {
    applySort, rollD20, newEntryId, sanitizeEntryPatch,
    sanitizeItemInput, newItemId,
} = require('./combatOps');

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

        // --- Lighting (Nebel + Dunkelheit + Lichter) ---

        async function loadLighting(campaignId, mapId) {
            return MapLighting.findOneAndUpdate(
                { campaignId, mapId },
                { $setOnInsert: { campaignId, mapId, fogW: 0, fogH: 0, fogBits: '', darkness: false, lights: [] } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }

        function broadcastLighting(campaignId, mapId, doc) {
            io.to(`campaign:${campaignId}`).emit('campaign:lighting:update', {
                campaignId: String(campaignId),
                mapId: String(mapId),
                lighting: {
                    fogW: doc.fogW,
                    fogH: doc.fogH,
                    fogBits: doc.fogBits,
                    darkness: doc.darkness,
                    lights: doc.lights,
                },
            });
        }

        socket.on('campaign:lighting:get', async ({ campaignId, mapId } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, false, ack);
                if (!ctx) return;
                const light = await loadLighting(campaignId, mapId);
                if (typeof ack === 'function') ack({
                    ok: true,
                    lighting: {
                        fogW: light.fogW, fogH: light.fogH, fogBits: light.fogBits,
                        darkness: light.darkness, lights: light.lights,
                    },
                });
            } catch (e) {
                console.error('lighting:get error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM teilt dem Server die Fog-Dimensionen mit (zb aus activeEditorDoc.width/height).
        // Setzt bei erstmaligem Aufruf die Maske auf "alles abgedeckt", sonst resized.
        socket.on('campaign:lighting:ensureFog', async ({ campaignId, mapId, w, h } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, true, ack);
                if (!ctx) return;
                const light = await loadLighting(campaignId, mapId);
                const changed = ensureFogDims(light, w, h);
                if (changed) {
                    await light.save();
                    broadcastLighting(campaignId, mapId, light);
                }
                if (typeof ack === 'function') ack({
                    ok: true, fogW: light.fogW, fogH: light.fogH, fogBits: light.fogBits,
                });
            } catch (e) {
                console.error('lighting:ensureFog error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM wendet Fog-Operationen an.
        socket.on('campaign:lighting:fog', async ({ campaignId, mapId, ops } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, true, ack);
                if (!ctx) return;
                const light = await loadLighting(campaignId, mapId);
                const result = applyFogOps(light, ops);
                if (!result.changed) {
                    if (typeof ack === 'function') ack({ ok: false, msg: result.msg || 'no change' });
                    return;
                }
                await light.save();
                broadcastLighting(campaignId, mapId, light);
                if (typeof ack === 'function') ack({ ok: true, applied: result.applied });
            } catch (e) {
                console.error('lighting:fog error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM schaltet Dunkelheit an/aus.
        socket.on('campaign:lighting:darkness', async ({ campaignId, mapId, on } = {}, ack) => {
            try {
                const ctx = await withRoom(campaignId, mapId, true, ack);
                if (!ctx) return;
                const light = await loadLighting(campaignId, mapId);
                light.darkness = !!on;
                await light.save();
                broadcastLighting(campaignId, mapId, light);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('lighting:darkness error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // Prueft: Darf dieser User (nicht GM) das Token-Licht berechtigen?
        // Regel: Lichter sind zunaechst GM-Sache. Ein Spieler darf jedoch:
        //   - ein neues Licht fuer sein eigenes Token hinzufuegen
        //   - ein existierendes Licht zu seinem eigenen Token toggeln/aendern
        async function canPlayerManageLight(campaignId, mapId, userId, light) {
            if (light.kind !== 'token' || !light.tokenId) return false;
            const tdoc = await MapTokens.findOne({ campaignId, mapId }).select('tokens');
            const t = (tdoc?.tokens || []).find((x) => x.id === light.tokenId);
            if (!t) return false;
            return String(t.ownerUserId || '') === String(userId);
        }

        socket.on('campaign:lighting:light:add', async ({ campaignId, mapId, light } = {}, ack) => {
            try {
                if (!isValidId(campaignId) || !isValidId(mapId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const assigned = (info.campaign.mapIds || []).some(
                    (m) => String(m) === String(mapId)
                );
                if (!assigned) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'map not assigned' });
                    return;
                }
                const doc = await loadLighting(campaignId, mapId);
                if (doc.lights.length >= MAX_LIGHTS) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'too many lights' });
                    return;
                }
                const clean = sanitizeLight(light, doc.lights.length);
                if (!clean) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid light' });
                    return;
                }
                if (info.role !== 'owner') {
                    const okForPlayer = await canPlayerManageLight(campaignId, mapId, socket.userId, clean);
                    if (!okForPlayer) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                        return;
                    }
                }
                // Dedupe falls id kollidiert.
                if (doc.lights.some((l) => l.id === clean.id)) {
                    clean.id = `lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
                }
                doc.lights.push(clean);
                await doc.save();
                broadcastLighting(campaignId, mapId, doc);
                if (typeof ack === 'function') ack({ ok: true, light: clean });
            } catch (e) {
                console.error('lighting:light:add error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        socket.on('campaign:lighting:light:update', async ({ campaignId, mapId, lightId, patch } = {}, ack) => {
            try {
                if (!isValidId(campaignId) || !isValidId(mapId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const doc = await loadLighting(campaignId, mapId);
                const l = doc.lights.find((x) => x.id === lightId);
                if (!l) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'not found' });
                    return;
                }
                if (info.role !== 'owner') {
                    const okForPlayer = await canPlayerManageLight(campaignId, mapId, socket.userId, l);
                    if (!okForPlayer) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                        return;
                    }
                }
                // Nur ausgewaehlte Felder uebernehmen.
                if (patch && typeof patch === 'object') {
                    if (patch.enabled !== undefined) l.enabled = !!patch.enabled;
                    if (patch.bright !== undefined) {
                        const b = Number(patch.bright);
                        if (Number.isFinite(b) && b >= 0 && b <= 200) l.bright = b;
                    }
                    if (patch.dim !== undefined) {
                        const d = Number(patch.dim);
                        if (Number.isFinite(d) && d >= 0 && d <= 200) l.dim = d;
                    }
                    if (typeof patch.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.color)) {
                        l.color = patch.color;
                    }
                    if (typeof patch.label === 'string') l.label = patch.label.slice(0, 64);
                    // Position nur bei static und nur GM.
                    if (info.role === 'owner' && l.kind === 'static') {
                        if (Number.isFinite(+patch.x)) l.x = +patch.x;
                        if (Number.isFinite(+patch.y)) l.y = +patch.y;
                    }
                }
                doc.markModified('lights');
                await doc.save();
                broadcastLighting(campaignId, mapId, doc);
                if (typeof ack === 'function') ack({ ok: true, light: l });
            } catch (e) {
                console.error('lighting:light:update error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        socket.on('campaign:lighting:light:remove', async ({ campaignId, mapId, lightId } = {}, ack) => {
            try {
                if (!isValidId(campaignId) || !isValidId(mapId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const doc = await loadLighting(campaignId, mapId);
                const l = doc.lights.find((x) => x.id === lightId);
                if (!l) {
                    if (typeof ack === 'function') ack({ ok: true });
                    return;
                }
                if (info.role !== 'owner') {
                    const okForPlayer = await canPlayerManageLight(campaignId, mapId, socket.userId, l);
                    if (!okForPlayer) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                        return;
                    }
                }
                doc.lights = doc.lights.filter((x) => x.id !== lightId);
                await doc.save();
                broadcastLighting(campaignId, mapId, doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('lighting:light:remove error', e);
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

        // ---------- Initiative ----------

        async function loadInitiative(campaignId) {
            return Initiative.findOneAndUpdate(
                { campaignId },
                { $setOnInsert: { campaignId, active: false, round: 1, turnIndex: 0, entries: [], orderCounter: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }

        function broadcastInitiative(campaignId, doc) {
            io.to(`campaign:${campaignId}`).emit('campaign:initiative:update', {
                campaignId: String(campaignId),
                initiative: {
                    active: doc.active, round: doc.round, turnIndex: doc.turnIndex,
                    entries: doc.entries,
                },
            });
        }

        // Postet eine System-Chat-Nachricht fuer Wuerfe & Rundenwechsel.
        async function postSystemChat(campaignId, text) {
            try {
                const msg = await ChatMessage.create({
                    campaignId,
                    userId: new mongoose.Types.ObjectId(),  // kein echter User
                    username: 'System',
                    text: text.slice(0, 2000),
                });
                io.to(`campaign:${campaignId}`).emit('campaign:chat', {
                    _id: String(msg._id),
                    userId: String(msg.userId),
                    username: msg.username,
                    text: msg.text,
                    createdAt: msg.createdAt,
                    campaignId: String(campaignId),
                });
            } catch (e) {
                console.error('system chat error', e);
            }
        }

        socket.on('campaign:initiative:get', async ({ campaignId } = {}, ack) => {
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
                const doc = await loadInitiative(campaignId);
                if (typeof ack === 'function') ack({
                    ok: true,
                    initiative: {
                        active: doc.active, round: doc.round, turnIndex: doc.turnIndex,
                        entries: doc.entries,
                    },
                });
            } catch (e) {
                console.error('initiative:get error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // Spieler (und GM) wuerfeln fuer SICH. Server wuerfelt (kein Client-Wert vertrauen).
        // Nimmt bonusOverride wenn gesetzt, sonst Char.initiativeBonus, sonst 0.
        // Wenn der Entry schon existiert (selbe userId + characterId), wird sein
        // Wurf UEBERSCHRIEBEN (nicht gestapelt).
        socket.on('campaign:initiative:roll', async ({ campaignId, characterId, bonusOverride } = {}, ack) => {
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
                // Charakter laden (optional). Wenn gesetzt, muss der User Owner sein.
                let char = null;
                if (characterId) {
                    if (!isValidId(characterId)) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'character invalid' });
                        return;
                    }
                    char = await Character.findById(characterId);
                    if (!char || String(char.owner) !== String(socket.userId)) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'character not yours' });
                        return;
                    }
                }
                // Fallback: aus Campaign.characterSelections ermitteln.
                if (!char) {
                    const sel = info.campaign.characterSelections?.get?.(String(socket.userId));
                    if (sel) {
                        char = await Character.findById(sel);
                        if (char && String(char.owner) !== String(socket.userId)) char = null;
                    }
                }
                let bonus;
                if (bonusOverride !== undefined && bonusOverride !== null) {
                    const b = Number(bonusOverride);
                    if (!Number.isFinite(b) || b < -10 || b > 30) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'bonus invalid' });
                        return;
                    }
                    bonus = Math.round(b);
                } else {
                    bonus = char?.initiativeBonus ?? 0;
                }
                const roll = rollD20();
                const user = await User.findById(socket.userId).select('username');
                const username = user?.username || 'Unbekannt';
                const name = char?.name || username;
                const tokenUrl = char?.tokenUrl || null;

                const doc = await loadInitiative(campaignId);
                // Vorhandenen Eintrag suchen (selbe userId + characterId-Identitaet).
                let entry = doc.entries.find((e) =>
                    String(e.userId || '') === String(socket.userId) &&
                    String(e.characterId || '') === String(characterId || '')
                );
                doc.orderCounter = (doc.orderCounter || 0) + 1;
                if (entry) {
                    entry.roll = roll;
                    entry.bonus = bonus;
                    entry.name = name;
                    entry.tokenUrl = tokenUrl;
                    entry.order = doc.orderCounter;
                } else {
                    entry = {
                        id: newEntryId(),
                        userId: socket.userId,
                        characterId: characterId || null,
                        isNpc: false,
                        name,
                        tokenUrl,
                        roll,
                        bonus,
                        order: doc.orderCounter,
                    };
                    doc.entries.push(entry);
                }
                applySort(doc);
                doc.markModified('entries');
                await doc.save();
                broadcastInitiative(campaignId, doc);
                const total = roll + bonus;
                const signed = bonus >= 0 ? `+${bonus}` : `${bonus}`;
                await postSystemChat(campaignId, `🎲 ${name} würfelt Initiative: ${roll} ${signed} = ${total}`);
                if (typeof ack === 'function') ack({ ok: true, roll, bonus, total });
            } catch (e) {
                console.error('initiative:roll error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM legt NSC/Monster-Entry an. { name, bonus?, roll? }. Fehlt roll, wird
        // sofort gewuerfelt (sonst kennt GM das Monster schon).
        socket.on('campaign:initiative:addNpc', async ({ campaignId, name, bonus, roll } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info || info.role !== 'owner') {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'name required' });
                    return;
                }
                const b = Number(bonus ?? 0);
                if (!Number.isFinite(b) || b < -10 || b > 30) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'bonus invalid' });
                    return;
                }
                let r = null;
                if (roll !== undefined && roll !== null) {
                    const n = Number(roll);
                    if (!Number.isFinite(n) || n < 1 || n > 20) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'roll invalid' });
                        return;
                    }
                    r = Math.round(n);
                } else {
                    r = rollD20();
                }
                const doc = await loadInitiative(campaignId);
                doc.orderCounter = (doc.orderCounter || 0) + 1;
                const entry = {
                    id: newEntryId(),
                    userId: null,
                    characterId: null,
                    isNpc: true,
                    name: name.trim(),
                    tokenUrl: null,
                    roll: r,
                    bonus: Math.round(b),
                    order: doc.orderCounter,
                };
                doc.entries.push(entry);
                applySort(doc);
                doc.markModified('entries');
                await doc.save();
                broadcastInitiative(campaignId, doc);
                const total = r + Math.round(b);
                const signed = b >= 0 ? `+${Math.round(b)}` : `${Math.round(b)}`;
                await postSystemChat(campaignId, `🎲 ${entry.name} (NSC) würfelt Initiative: ${r} ${signed} = ${total}`);
                if (typeof ack === 'function') ack({ ok: true, entry });
            } catch (e) {
                console.error('initiative:addNpc error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM: Wurf oder Bonus eines Entrys korrigieren.
        socket.on('campaign:initiative:update', async ({ campaignId, entryId, patch } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info || info.role !== 'owner') {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const doc = await loadInitiative(campaignId);
                const e = doc.entries.find((x) => x.id === entryId);
                if (!e) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'not found' });
                    return;
                }
                const clean = sanitizeEntryPatch(patch);
                Object.assign(e, clean);
                applySort(doc);
                doc.markModified('entries');
                await doc.save();
                broadcastInitiative(campaignId, doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('initiative:update error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM: Entry entfernen.
        socket.on('campaign:initiative:remove', async ({ campaignId, entryId } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info || info.role !== 'owner') {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const doc = await loadInitiative(campaignId);
                const before = doc.entries.length;
                doc.entries = doc.entries.filter((x) => x.id !== entryId);
                if (doc.entries.length === before) {
                    if (typeof ack === 'function') ack({ ok: true });
                    return;
                }
                applySort(doc);
                if (doc.turnIndex >= doc.entries.length) doc.turnIndex = 0;
                await doc.save();
                broadcastInitiative(campaignId, doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('initiative:remove error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM: Kampf starten (active=true), zuruecksetzen auf Runde 1, TurnIndex 0.
        socket.on('campaign:initiative:start', async ({ campaignId } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info || info.role !== 'owner') {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const doc = await loadInitiative(campaignId);
                applySort(doc);
                doc.active = true;
                doc.round = 1;
                doc.turnIndex = 0;
                await doc.save();
                broadcastInitiative(campaignId, doc);
                await postSystemChat(campaignId, `⚔ Kampf beginnt — Runde 1`);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('initiative:start error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM: Kampf beenden. Entries bleiben erhalten, bis "reset".
        socket.on('campaign:initiative:end', async ({ campaignId } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info || info.role !== 'owner') {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const doc = await loadInitiative(campaignId);
                doc.active = false;
                await doc.save();
                broadcastInitiative(campaignId, doc);
                await postSystemChat(campaignId, `⚔ Kampf beendet`);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('initiative:end error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM: Zug weiterschalten. Am Ende der Liste: Runde+1.
        socket.on('campaign:initiative:next', async ({ campaignId } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info || info.role !== 'owner') {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const doc = await loadInitiative(campaignId);
                if (doc.entries.length === 0) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'empty' });
                    return;
                }
                doc.turnIndex += 1;
                if (doc.turnIndex >= doc.entries.length) {
                    doc.turnIndex = 0;
                    doc.round += 1;
                    await doc.save();
                    broadcastInitiative(campaignId, doc);
                    await postSystemChat(campaignId, `⌛ Runde ${doc.round} beginnt`);
                } else {
                    await doc.save();
                    broadcastInitiative(campaignId, doc);
                }
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('initiative:next error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // GM: Alles leeren.
        socket.on('campaign:initiative:reset', async ({ campaignId } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info || info.role !== 'owner') {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                const doc = await loadInitiative(campaignId);
                doc.entries = [];
                doc.active = false;
                doc.round = 1;
                doc.turnIndex = 0;
                doc.orderCounter = 0;
                await doc.save();
                broadcastInitiative(campaignId, doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('initiative:reset error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // ---------- Inventar ----------

        async function loadInventory(campaignId, userId) {
            return Inventory.findOneAndUpdate(
                { campaignId, userId },
                { $setOnInsert: { campaignId, userId, notes: '', items: [] } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }

        // Pusht ein geaendertes Inventar an:
        //   - den Owner-User (per userId-"Zone": alle Sockets dieses Users im Raum)
        //   - den GM (owner der Kampagne)
        // socket.io hat keine User-Raeume per-se; wir broadcasten an den
        // Campaign-Room, aber der Payload enthaelt den userId; FE filtert.
        //
        // Das ist OK, weil die Daten nur betroffene User zeigen (Spieler sieht
        // nichts von anderen; FE blendet das aus). Falls Spieler den Payload im
        // Netzwerk mitlesen koennen, waere das ein Problem — deshalb pushen wir
        // NUR gezielt pro Sockets.
        async function pushInventoryTo(campaignId, inventory) {
            const campaign = await Campaign.findById(campaignId).select('owner players');
            if (!campaign) return;
            const targets = new Set([
                String(campaign.owner),
                String(inventory.userId),
            ]);
            const payload = {
                campaignId: String(campaignId),
                inventory: {
                    userId: String(inventory.userId),
                    notes: inventory.notes,
                    items: inventory.items,
                },
            };
            // Alle Sockets im Campaign-Raum durchgehen, nur Zielusers pushen.
            const room = io.sockets.adapter.rooms.get(`campaign:${campaignId}`);
            if (!room) return;
            for (const sid of room) {
                const s = io.sockets.sockets.get(sid);
                if (!s) continue;
                if (targets.has(String(s.userId))) {
                    s.emit('campaign:inventory:update', payload);
                }
            }
        }

        // GET fuer sich selbst (jeder) ODER fuer einen fremden User (nur GM).
        socket.on('campaign:inventory:get', async ({ campaignId, targetUserId } = {}, ack) => {
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
                let target = socket.userId;
                if (targetUserId && String(targetUserId) !== String(socket.userId)) {
                    if (info.role !== 'owner') {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                        return;
                    }
                    if (!isValidId(targetUserId)) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'target invalid' });
                        return;
                    }
                    target = targetUserId;
                }
                const doc = await loadInventory(campaignId, target);
                if (typeof ack === 'function') ack({
                    ok: true,
                    inventory: {
                        userId: String(target),
                        notes: doc.notes, items: doc.items,
                    },
                });
            } catch (e) {
                console.error('inventory:get error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // Notizen setzen (Spieler fuer sich selbst, GM fuer beliebigen User).
        socket.on('campaign:inventory:setNotes', async ({ campaignId, targetUserId, notes } = {}, ack) => {
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
                let target = socket.userId;
                if (targetUserId && String(targetUserId) !== String(socket.userId)) {
                    if (info.role !== 'owner') {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                        return;
                    }
                    if (!isValidId(targetUserId)) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'target invalid' });
                        return;
                    }
                    target = targetUserId;
                }
                if (typeof notes !== 'string' || notes.length > 8000) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'notes invalid' });
                    return;
                }
                const doc = await loadInventory(campaignId, target);
                doc.notes = notes;
                await doc.save();
                await pushInventoryTo(campaignId, doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('inventory:setNotes error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // Item hinzufuegen (Spieler fuer sich, GM fuer beliebigen User).
        socket.on('campaign:inventory:addItem', async ({ campaignId, targetUserId, item } = {}, ack) => {
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
                let target = socket.userId;
                if (targetUserId && String(targetUserId) !== String(socket.userId)) {
                    if (info.role !== 'owner') {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                        return;
                    }
                    if (!isValidId(targetUserId)) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'target invalid' });
                        return;
                    }
                    target = targetUserId;
                }
                const clean = sanitizeItemInput(item);
                if (!clean) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'item invalid' });
                    return;
                }
                const doc = await loadInventory(campaignId, target);
                if (doc.items.length >= 500) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'too many items' });
                    return;
                }
                const entry = { id: newItemId(), ...clean };
                doc.items.push(entry);
                doc.markModified('items');
                await doc.save();
                await pushInventoryTo(campaignId, doc);
                if (typeof ack === 'function') ack({ ok: true, item: entry });
            } catch (e) {
                console.error('inventory:addItem error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // Item aktualisieren.
        socket.on('campaign:inventory:updateItem', async ({ campaignId, targetUserId, itemId, patch } = {}, ack) => {
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
                let target = socket.userId;
                if (targetUserId && String(targetUserId) !== String(socket.userId)) {
                    if (info.role !== 'owner') {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                        return;
                    }
                    if (!isValidId(targetUserId)) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'target invalid' });
                        return;
                    }
                    target = targetUserId;
                }
                const doc = await loadInventory(campaignId, target);
                const it = doc.items.find((x) => x.id === itemId);
                if (!it) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'not found' });
                    return;
                }
                if (patch && typeof patch === 'object') {
                    if (typeof patch.name === 'string') {
                        const n = patch.name.trim();
                        if (n.length > 0 && n.length <= 120) it.name = n;
                    }
                    if (patch.qty !== undefined) {
                        const q = Number(patch.qty);
                        if (Number.isFinite(q) && q >= 1 && q <= 99999) it.qty = Math.round(q);
                    }
                    if (typeof patch.description === 'string') {
                        it.description = patch.description.slice(0, 2000);
                    }
                }
                doc.markModified('items');
                await doc.save();
                await pushInventoryTo(campaignId, doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('inventory:updateItem error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // Item loeschen.
        socket.on('campaign:inventory:removeItem', async ({ campaignId, targetUserId, itemId } = {}, ack) => {
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
                let target = socket.userId;
                if (targetUserId && String(targetUserId) !== String(socket.userId)) {
                    if (info.role !== 'owner') {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                        return;
                    }
                    if (!isValidId(targetUserId)) {
                        if (typeof ack === 'function') ack({ ok: false, msg: 'target invalid' });
                        return;
                    }
                    target = targetUserId;
                }
                const doc = await loadInventory(campaignId, target);
                doc.items = doc.items.filter((x) => x.id !== itemId);
                doc.markModified('items');
                await doc.save();
                await pushInventoryTo(campaignId, doc);
                if (typeof ack === 'function') ack({ ok: true });
            } catch (e) {
                console.error('inventory:removeItem error', e);
                if (typeof ack === 'function') ack({ ok: false, msg: 'server error' });
            }
        });

        // Transfer: Teil- oder Komplettmenge eines Items von A nach B (nur GM).
        // { fromUserId, toUserId, itemId, qty }. Wenn qty >= item.qty -> ganzes
        // Item geht ueber. Wenn <, splittet qty ab und reduziert Original.
        socket.on('campaign:inventory:transfer', async ({ campaignId, fromUserId, toUserId, itemId, qty } = {}, ack) => {
            try {
                if (!isValidId(campaignId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'invalid id' });
                    return;
                }
                const info = await roleFor(campaignId, socket.userId);
                if (!info || info.role !== 'owner') {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'forbidden' });
                    return;
                }
                if (!isValidId(fromUserId) || !isValidId(toUserId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'users invalid' });
                    return;
                }
                if (String(fromUserId) === String(toUserId)) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'same user' });
                    return;
                }
                // Beide User muessen Mitglied sein (owner oder player).
                const members = new Set([
                    String(info.campaign.owner),
                    ...(info.campaign.players || []).map((p) => String(p)),
                ]);
                if (!members.has(String(fromUserId)) || !members.has(String(toUserId))) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'user not in campaign' });
                    return;
                }
                const q = Number(qty);
                if (!Number.isFinite(q) || q <= 0) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'qty invalid' });
                    return;
                }
                const fromDoc = await loadInventory(campaignId, fromUserId);
                const it = fromDoc.items.find((x) => x.id === itemId);
                if (!it) {
                    if (typeof ack === 'function') ack({ ok: false, msg: 'item not found' });
                    return;
                }
                const take = Math.min(it.qty, Math.round(q));
                const toDoc = await loadInventory(campaignId, toUserId);
                // Falls Ziel ein Item gleichen Namens+description hat, stapeln; sonst neu.
                const existing = toDoc.items.find((x) =>
                    x.name === it.name && (x.description || '') === (it.description || '')
                );
                if (existing) {
                    existing.qty = Math.min(99999, existing.qty + take);
                } else {
                    toDoc.items.push({
                        id: newItemId(),
                        name: it.name, qty: take, description: it.description || '',
                    });
                }
                if (take >= it.qty) {
                    fromDoc.items = fromDoc.items.filter((x) => x.id !== it.id);
                } else {
                    it.qty = it.qty - take;
                }
                fromDoc.markModified('items');
                toDoc.markModified('items');
                await fromDoc.save();
                await toDoc.save();
                await pushInventoryTo(campaignId, fromDoc);
                await pushInventoryTo(campaignId, toDoc);
                if (typeof ack === 'function') ack({ ok: true, taken: take });
            } catch (e) {
                console.error('inventory:transfer error', e);
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
