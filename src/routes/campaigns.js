const express = require('express');
const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const Map = require('../models/Map');
const User = require('../models/User');
const ChatMessage = require('../models/ChatMessage');
const Character = require('../models/Character');
const MapTokens = require('../models/MapTokens');
const { authMiddleware } = require('../authMiddleware');

const router = express.Router();

// Alle Routen brauchen einen gueltigen JWT.
router.use(authMiddleware);

function isValidId(id) {
    return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

function sanitizeName(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (s.length < 1 || s.length > 120) return null;
    return s;
}

function sanitizeDescription(raw) {
    if (raw === undefined || raw === null) return '';
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (s.length > 4000) return null;
    return s;
}

// Prueft eine Liste von Map-Ids: jede muss ObjectId sein UND entweder dem
// User gehoeren oder eine Beispiel-Map sein. Dedupliziert in der Reihenfolge
// der Eingabe. Gibt { ok, ids, badReason } zurueck.
async function validateMapIds(rawIds, userId) {
    if (rawIds === undefined || rawIds === null) {
        return { ok: true, ids: [] };
    }
    if (!Array.isArray(rawIds)) {
        return { ok: false, badReason: 'mapIds must be an array' };
    }
    const seen = new Set();
    const cleaned = [];
    for (const raw of rawIds) {
        if (!isValidId(raw)) {
            return { ok: false, badReason: 'mapIds contains invalid id' };
        }
        const key = String(raw);
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(key);
    }
    if (cleaned.length === 0) return { ok: true, ids: [] };
    const allowed = await Map.find({
        _id: { $in: cleaned },
        $or: [{ owner: userId }, { isExample: true }],
    }).select('_id');
    const allowedSet = new Set(allowed.map((m) => String(m._id)));
    if (allowedSet.size !== cleaned.length) {
        return { ok: false, badReason: 'mapIds contains unknown or forbidden map' };
    }
    return { ok: true, ids: cleaned.map((id) => new mongoose.Types.ObjectId(id)) };
}

// Spieler-Liste pruefen: jede Id = ObjectId, User existiert, nicht der Owner
// selbst. Dedupliziert in Reihenfolge.
async function validatePlayerIds(rawIds, ownerId) {
    if (rawIds === undefined || rawIds === null) {
        return { ok: true, ids: [] };
    }
    if (!Array.isArray(rawIds)) {
        return { ok: false, badReason: 'players must be an array' };
    }
    const seen = new Set();
    const cleaned = [];
    for (const raw of rawIds) {
        if (!isValidId(raw)) {
            return { ok: false, badReason: 'players contains invalid id' };
        }
        const key = String(raw);
        if (key === String(ownerId)) {
            return { ok: false, badReason: 'owner cannot be in players list' };
        }
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(key);
    }
    if (cleaned.length === 0) return { ok: true, ids: [] };
    const users = await User.find({ _id: { $in: cleaned } }).select('_id');
    const existing = new Set(users.map((u) => String(u._id)));
    if (existing.size !== cleaned.length) {
        return { ok: false, badReason: 'players contains unknown user id' };
    }
    return { ok: true, ids: cleaned.map((id) => new mongoose.Types.ObjectId(id)) };
}

// Rolle in einer Kampagne: 'owner' | 'player' | null (keiner).
function roleFor(campaign, userId) {
    if (String(campaign.owner) === String(userId)) return 'owner';
    if ((campaign.players || []).some((p) => String(p) === String(userId))) return 'player';
    return null;
}

// Serialisiert eine Kampagne inkl. Rolle, Spielerliste und hydratisierten
// Charakter-Auswahlen pro User (characterSelections als Array of {userId, characterId}).
async function serialize(campaign, userId) {
    const playerUsers = await User.find({ _id: { $in: campaign.players || [] } })
        .select('_id username');
    // characterSelections als Map<userIdString, characterId>. Liefere ein
    // Array raus, damit FE JSON sauber verarbeitet.
    const selections = [];
    const charIds = new Set();
    if (campaign.characterSelections && campaign.characterSelections.forEach) {
        campaign.characterSelections.forEach((charId, uid) => {
            selections.push({ userId: uid, characterId: String(charId) });
            charIds.add(String(charId));
        });
    }
    // Zusaetzlich die Chars kurz hydratisieren (fuer Avatar/Name im Spielbrett).
    const characters = charIds.size > 0
        ? await Character.find({ _id: { $in: Array.from(charIds) } })
              .select('_id owner name tokenUrl')
        : [];
    return {
        _id: campaign._id,
        name: campaign.name,
        description: campaign.description,
        owner: campaign.owner,
        players: playerUsers.map((u) => ({ _id: u._id, username: u.username })),
        mapIds: campaign.mapIds,
        activeMapId: campaign.activeMapId || null,
        characterSelections: selections,
        characters,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
        role: roleFor(campaign, userId),
    };
}

// GET /api/campaigns -> eigene UND Kampagnen, in denen man Spieler ist.
// Sortiert nach updatedAt desc; mit mapIds + players + role.
router.get('/', async (req, res) => {
    try {
        const userId = req.user.id;
        const campaigns = await Campaign.find({
            $or: [{ owner: userId }, { players: userId }],
        }).sort({ updatedAt: -1 });
        const out = await Promise.all(campaigns.map((c) => serialize(c, userId)));
        res.json({ campaigns: out });
    } catch (err) {
        console.error('Error listing campaigns:', err);
        res.status(500).json({ msg: 'Server error while listing campaigns' });
    }
});

// GET /api/campaigns/:id -> einzelne Kampagne (Owner oder Spieler).
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Campaign not found' });
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findById(id);
        if (!campaign || !roleFor(campaign, userId)) {
            return res.status(404).json({ msg: 'Campaign not found' });
        }
        res.json({ campaign: await serialize(campaign, userId) });
    } catch (err) {
        console.error('Error fetching campaign:', err);
        res.status(500).json({ msg: 'Server error while fetching campaign' });
    }
});

// POST /api/campaigns -> { name, description?, mapIds?, players? }. Owner = JWT.
router.post('/', async (req, res) => {
    try {
        const name = sanitizeName(req.body?.name);
        if (!name) return res.status(400).json({ msg: 'Name required (1-120 chars)' });
        const description = sanitizeDescription(req.body?.description);
        if (description === null) return res.status(400).json({ msg: 'Description too long (max 4000 chars)' });
        const mapCheck = await validateMapIds(req.body?.mapIds, req.user.id);
        if (!mapCheck.ok) return res.status(400).json({ msg: mapCheck.badReason });
        const playerCheck = await validatePlayerIds(req.body?.players, req.user.id);
        if (!playerCheck.ok) return res.status(400).json({ msg: playerCheck.badReason });
        const campaign = await Campaign.create({
            name,
            description,
            owner: req.user.id,
            mapIds: mapCheck.ids,
            players: playerCheck.ids,
        });
        res.status(201).json({ campaign: await serialize(campaign, req.user.id) });
    } catch (err) {
        console.error('Error creating campaign:', err);
        res.status(500).json({ msg: 'Server error while creating campaign' });
    }
});

// PUT /api/campaigns/:id -> { name?, description?, mapIds?, players? }. Nur Owner.
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Campaign not found' });
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findById(id);
        if (!campaign) return res.status(404).json({ msg: 'Campaign not found' });
        if (String(campaign.owner) !== String(userId)) {
            return res.status(403).json({ msg: 'Not allowed' });
        }
        const patch = {};
        if (req.body?.name !== undefined) {
            const name = sanitizeName(req.body.name);
            if (!name) return res.status(400).json({ msg: 'Name required (1-120 chars)' });
            patch.name = name;
        }
        if (req.body?.description !== undefined) {
            const description = sanitizeDescription(req.body.description);
            if (description === null) return res.status(400).json({ msg: 'Description too long (max 4000 chars)' });
            patch.description = description;
        }
        if (req.body?.mapIds !== undefined) {
            const check = await validateMapIds(req.body.mapIds, userId);
            if (!check.ok) return res.status(400).json({ msg: check.badReason });
            patch.mapIds = check.ids;
        }
        if (req.body?.players !== undefined) {
            const check = await validatePlayerIds(req.body.players, userId);
            if (!check.ok) return res.status(400).json({ msg: check.badReason });
            patch.players = check.ids;
        }
        if (Object.keys(patch).length === 0) {
            return res.json({ campaign: await serialize(campaign, userId) });
        }
        Object.assign(campaign, patch);
        // activeMapId automatisch ruecksetzen, wenn Karte nicht mehr zugewiesen ist.
        if (patch.mapIds && campaign.activeMapId) {
            const stillAssigned = patch.mapIds.some((m) => String(m) === String(campaign.activeMapId));
            if (!stillAssigned) campaign.activeMapId = null;
        }
        await campaign.save();
        res.json({ campaign: await serialize(campaign, userId) });
    } catch (err) {
        console.error('Error updating campaign:', err);
        res.status(500).json({ msg: 'Server error while updating campaign' });
    }
});

// DELETE /api/campaigns/:id -> nur Owner.
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Campaign not found' });
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findById(id);
        if (!campaign) return res.status(404).json({ msg: 'Campaign not found' });
        if (String(campaign.owner) !== String(userId)) {
            return res.status(403).json({ msg: 'Not allowed' });
        }
        await Campaign.deleteOne({ _id: id });
        // Chat-Nachrichten derselben Kampagne wegraeumen.
        await ChatMessage.deleteMany({ campaignId: id });
        res.json({ msg: 'Campaign deleted' });
    } catch (err) {
        console.error('Error deleting campaign:', err);
        res.status(500).json({ msg: 'Server error while deleting campaign' });
    }
});

// POST /api/campaigns/:id/players  { userId } -> Spieler hinzufuegen (nur Owner).
router.post('/:id/players', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Campaign not found' });
    const addId = req.body?.userId;
    if (!isValidId(addId)) return res.status(400).json({ msg: 'userId invalid' });
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findById(id);
        if (!campaign) return res.status(404).json({ msg: 'Campaign not found' });
        if (String(campaign.owner) !== String(userId)) {
            return res.status(403).json({ msg: 'Not allowed' });
        }
        if (String(addId) === String(userId)) {
            return res.status(400).json({ msg: 'Owner is not a player' });
        }
        const user = await User.findById(addId).select('_id username');
        if (!user) return res.status(400).json({ msg: 'User not found' });
        const already = campaign.players.some((p) => String(p) === String(addId));
        if (!already) {
            campaign.players.push(user._id);
            await campaign.save();
        }
        res.json({ campaign: await serialize(campaign, userId) });
    } catch (err) {
        console.error('Error adding player:', err);
        res.status(500).json({ msg: 'Server error while adding player' });
    }
});

// DELETE /api/campaigns/:id/players/:userId -> Spieler entfernen (nur Owner).
router.delete('/:id/players/:userId', async (req, res) => {
    const { id, userId: removeId } = req.params;
    if (!isValidId(id) || !isValidId(removeId)) {
        return res.status(404).json({ msg: 'Not found' });
    }
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findById(id);
        if (!campaign) return res.status(404).json({ msg: 'Campaign not found' });
        if (String(campaign.owner) !== String(userId)) {
            return res.status(403).json({ msg: 'Not allowed' });
        }
        campaign.players = (campaign.players || []).filter(
            (p) => String(p) !== String(removeId)
        );
        await campaign.save();
        res.json({ campaign: await serialize(campaign, userId) });
    } catch (err) {
        console.error('Error removing player:', err);
        res.status(500).json({ msg: 'Server error while removing player' });
    }
});

// PUT /api/campaigns/:id/active-map  { mapId: string | null } (nur Owner).
// Setzt die aktuell im Spielraum sichtbare Karte und pusht per socket.
router.put('/:id/active-map', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Campaign not found' });
    const rawMapId = req.body?.mapId;
    if (rawMapId !== null && !isValidId(rawMapId)) {
        return res.status(400).json({ msg: 'mapId invalid' });
    }
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findById(id);
        if (!campaign) return res.status(404).json({ msg: 'Campaign not found' });
        if (String(campaign.owner) !== String(userId)) {
            return res.status(403).json({ msg: 'Not allowed' });
        }
        if (rawMapId) {
            const assigned = (campaign.mapIds || []).some(
                (m) => String(m) === String(rawMapId)
            );
            if (!assigned) return res.status(400).json({ msg: 'mapId not assigned to campaign' });
        }
        campaign.activeMapId = rawMapId
            ? new mongoose.Types.ObjectId(rawMapId)
            : null;
        await campaign.save();
        // Allen Sockets im Raum die Aenderung pushen.
        const io = req.app.get('io');
        if (io) {
            io.to(`campaign:${id}`).emit('campaign:activeMap', {
                campaignId: String(id),
                activeMapId: campaign.activeMapId ? String(campaign.activeMapId) : null,
            });
        }
        res.json({ campaign: await serialize(campaign, userId) });
    } catch (err) {
        console.error('Error setting active map:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

// GET /api/campaigns/:id/chat -> letzte 100 Nachrichten, aelteste zuerst.
// Zugriff: Owner oder Spieler.
router.get('/:id/chat', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Not found' });
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findById(id);
        if (!campaign || !roleFor(campaign, userId)) {
            return res.status(404).json({ msg: 'Not found' });
        }
        const rows = await ChatMessage.find({ campaignId: id })
            .sort({ createdAt: -1 })
            .limit(100);
        rows.reverse();
        res.json({
            messages: rows.map((r) => ({
                _id: r._id,
                userId: r.userId,
                username: r.username,
                text: r.text,
                createdAt: r.createdAt,
            })),
        });
    } catch (err) {
        console.error('Error loading chat:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

// PUT /api/campaigns/:id/my-character  { characterId: string | null }
// Setzt den aktuellen Charakter des aufrufenden Users (Owner oder Spieler).
// Nur eigene Charaktere zulaessig. Pusht Socket-Event an den Raum.
router.put('/:id/my-character', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Not found' });
    const raw = req.body?.characterId;
    if (raw !== null && !isValidId(raw)) {
        return res.status(400).json({ msg: 'characterId invalid' });
    }
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findById(id);
        if (!campaign || !roleFor(campaign, userId)) {
            return res.status(404).json({ msg: 'Not found' });
        }
        if (raw) {
            const c = await Character.findById(raw);
            if (!c || String(c.owner) !== String(userId)) {
                return res.status(403).json({ msg: 'character not yours' });
            }
        }
        if (!campaign.characterSelections) campaign.characterSelections = new Map();
        if (raw === null) {
            campaign.characterSelections.delete(String(userId));
        } else {
            campaign.characterSelections.set(String(userId), new mongoose.Types.ObjectId(raw));
        }
        await campaign.save();
        const io = req.app.get('io');
        if (io) {
            io.to(`campaign:${id}`).emit('campaign:characterSelection', {
                campaignId: String(id),
                userId: String(userId),
                characterId: raw ? String(raw) : null,
            });
        }
        res.json({ campaign: await serialize(campaign, userId) });
    } catch (err) {
        console.error('Error selecting character:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

// GET /api/campaigns/:id/maps/:mapId/tokens
// Liefert den aktuellen Token-Zustand fuer (Campaign, Map). Jeder in der
// Kampagne darf lesen. Fehlt der Datensatz, wird ein leeres Dokument angelegt.
router.get('/:id/maps/:mapId/tokens', async (req, res) => {
    const { id, mapId } = req.params;
    if (!isValidId(id) || !isValidId(mapId)) return res.status(404).json({ msg: 'Not found' });
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findById(id);
        if (!campaign || !roleFor(campaign, userId)) {
            return res.status(404).json({ msg: 'Not found' });
        }
        const assigned = (campaign.mapIds || []).some((m) => String(m) === String(mapId));
        if (!assigned) return res.status(404).json({ msg: 'Map not in campaign' });
        const doc = await MapTokens.findOneAndUpdate(
            { campaignId: id, mapId },
            { $setOnInsert: { campaignId: id, mapId, tokens: [], groups: [] } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        res.json({ tokens: doc.tokens, groups: doc.groups });
    } catch (err) {
        console.error('Error loading tokens:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

module.exports = router;
