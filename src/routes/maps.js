const express = require('express');
const mongoose = require('mongoose');
const Map = require('../models/Map');
const Campaign = require('../models/Campaign');
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
    if (s.length < 1 || s.length > 80) return null;
    return s;
}

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Grob-Validierung eines 2d-editor-Docs. Haelt Produktion vor abartig grossen
// oder absichtlich kaputten Clients. Pedanterie (zB einzelne Wand-Koordinaten
// mit bogus ids) uebernimmt der Renderer stillschweigend — die harten Grenzen
// hier schuetzen vor DoS und Datenschrott. Siehe FE/src/mapEditor/engine.ts
// fuer die eigentliche Doc-Form.
function validateEditorDoc(doc) {
    if (!isPlainObject(doc)) return 'doc must be an object';
    const w = doc.width, h = doc.height;
    if (!Number.isInteger(w) || w < 4 || w > 200) return 'width must be int 4..200';
    if (!Number.isInteger(h) || h < 4 || h > 200) return 'height must be int 4..200';
    if (!Array.isArray(doc.floor)) return 'floor must be array';
    if (doc.floor.length !== w * h) return 'floor length must equal width*height';
    for (const v of doc.floor) {
        if (!Number.isInteger(v) || v < 0 || v > 32) return 'floor entry out of range';
    }
    if (!Array.isArray(doc.walls)) return 'walls must be array';
    if (doc.walls.length > 20000) return 'too many walls';
    for (const wl of doc.walls) {
        if (!isPlainObject(wl)) return 'wall entry not object';
        if (!Array.isArray(wl.a) || wl.a.length !== 2) return 'wall.a invalid';
        if (!Array.isArray(wl.b) || wl.b.length !== 2) return 'wall.b invalid';
        if (!Number.isInteger(wl.a[0]) || !Number.isInteger(wl.a[1])) return 'wall endpoint not int';
        if (!Number.isInteger(wl.b[0]) || !Number.isInteger(wl.b[1])) return 'wall endpoint not int';
        if (wl.kind && wl.kind !== 'wall' && wl.kind !== 'door') return 'wall.kind invalid';
    }
    if (!Array.isArray(doc.objects)) return 'objects must be array';
    if (doc.objects.length > 5000) return 'too many objects';
    for (const o of doc.objects) {
        if (!isPlainObject(o)) return 'object entry not object';
        if (typeof o.type !== 'string' || o.type.length > 32) return 'object.type invalid';
        if (typeof o.x !== 'number' || typeof o.y !== 'number') return 'object pos invalid';
    }
    if (!Array.isArray(doc.labels)) return 'labels must be array';
    if (doc.labels.length > 2000) return 'too many labels';
    for (const l of doc.labels) {
        if (!isPlainObject(l)) return 'label entry not object';
        if (typeof l.text !== 'string' || l.text.length > 200) return 'label.text invalid';
        if (typeof l.x !== 'number' || typeof l.y !== 'number') return 'label pos invalid';
    }
    return null;
}

// Nach einem Save eines 2d-editor-Docs allen Kampagnen-Raeumen, die genau
// diese Map als activeMap haben, die neue Version live pushen. Wir laden
// die neue Map nicht noch einmal — doc liegt uns ja schon vor.
async function broadcastMapUpdate(req, mapId, map) {
    try {
        const io = req.app.get('io');
        if (!io) return;
        const campaigns = await Campaign.find({ activeMapId: mapId }).select('_id');
        if (campaigns.length === 0) return;
        const payload = {
            mapId: String(mapId),
            map: {
                _id: String(map._id),
                name: map.name,
                kind: map.kind,
                owner: map.owner,
                imageUrl: map.imageUrl || null,
                isExample: map.isExample,
                createdAt: map.createdAt,
                updatedAt: map.updatedAt,
                doc: map.doc,
            },
        };
        for (const c of campaigns) {
            io.to(`campaign:${c._id}`).emit('campaign:mapUpdated', {
                campaignId: String(c._id),
                ...payload,
            });
        }
    } catch (e) {
        // live push ist best-effort — ein Fehler hier darf den Save nicht killen
        console.error('broadcastMapUpdate error:', e);
    }
}

// Zusaetzlich zu eigenen + Beispielen sollen Mitspieler die Maps sehen,
// die in einer Kampagne auftauchen, in der sie Owner oder Spieler sind.
// Diese Funktion liefert die Menge dieser "sichtbaren" Map-Ids.
async function visibleCampaignMapIds(userId) {
    const campaigns = await Campaign.find({
        $or: [{ owner: userId }, { players: userId }],
    }).select('mapIds');
    const set = new Set();
    campaigns.forEach((c) => (c.mapIds || []).forEach((id) => set.add(String(id))));
    return Array.from(set).map((id) => new mongoose.Types.ObjectId(id));
}

// GET /api/maps -> Liste: eigene + Beispiele + Maps aus "meinen" Kampagnen.
// Sortiert nach updatedAt desc, OHNE das doc-Feld.
router.get('/', async (req, res) => {
    try {
        const userId = req.user.id;
        const extra = await visibleCampaignMapIds(userId);
        const maps = await Map.find({
            $or: [
                { owner: userId },
                { isExample: true },
                ...(extra.length > 0 ? [{ _id: { $in: extra } }] : []),
            ],
        })
            .select('name owner isExample kind imageUrl createdAt updatedAt')
            .sort({ updatedAt: -1 });
        res.json({ maps });
    } catch (err) {
        console.error('Error listing maps:', err);
        res.status(500).json({ msg: 'Server error while listing maps' });
    }
});

// GET /api/maps/:id -> Vollstaendige Karte inkl. doc (eigene, Beispiel,
// oder in einer meiner Kampagnen).
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Map not found' });
    try {
        const userId = req.user.id;
        const extra = await visibleCampaignMapIds(userId);
        const map = await Map.findOne({
            _id: id,
            $or: [
                { owner: userId },
                { isExample: true },
                ...(extra.length > 0 ? [{ _id: { $in: extra } }] : []),
            ],
        });
        if (!map) return res.status(404).json({ msg: 'Map not found' });
        res.json({ map });
    } catch (err) {
        console.error('Error fetching map:', err);
        res.status(500).json({ msg: 'Server error while fetching map' });
    }
});

// POST /api/maps -> body { name, doc, kind? }. Owner wird aus JWT gesetzt.
// isExample darf vom Client nie gesetzt werden (nur Server-Seeding erstellt
// Beispiele). kind='2d-editor' wird hier zusaetzlich grob validiert, damit wir
// beim Save im Editor direkt Feedback geben.
router.post('/', async (req, res) => {
    try {
        const name = sanitizeName(req.body?.name);
        if (!name) return res.status(400).json({ msg: 'Name required (1-80 chars)' });
        const doc = req.body?.doc;
        if (!isPlainObject(doc)) return res.status(400).json({ msg: 'doc must be an object' });
        const rawKind = req.body?.kind;
        const kind = rawKind === '2d-editor' ? '2d-editor' : '3d';
        if (kind === '2d-editor') {
            const err = validateEditorDoc(doc);
            if (err) return res.status(400).json({ msg: err });
        }
        const map = await Map.create({
            name,
            owner: req.user.id,
            kind,
            doc,
            isExample: false,
        });
        res.status(201).json({ map });
    } catch (err) {
        console.error('Error creating map:', err);
        res.status(500).json({ msg: 'Server error while creating map' });
    }
});

// PUT /api/maps/:id -> body { name?, doc? }. Nur Owner darf aendern. Beispiele
// sind nie aenderbar (auch nicht ueber manuell gesetzten Owner — der ist null).
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Map not found' });
    try {
        const map = await Map.findById(id);
        if (!map) return res.status(404).json({ msg: 'Map not found' });
        if (map.isExample) return res.status(403).json({ msg: 'Example maps are read-only' });
        if (!map.owner || String(map.owner) !== String(req.user.id)) {
            return res.status(403).json({ msg: 'Not allowed' });
        }
        const patch = {};
        if (req.body?.name !== undefined) {
            const name = sanitizeName(req.body.name);
            if (!name) return res.status(400).json({ msg: 'Name required (1-80 chars)' });
            patch.name = name;
        }
        if (req.body?.doc !== undefined) {
            if (!isPlainObject(req.body.doc)) return res.status(400).json({ msg: 'doc must be an object' });
            // Fuer 2d-editor-Karten: Doc nach demselben Schema wie beim POST pruefen.
            if (map.kind === '2d-editor') {
                const vErr = validateEditorDoc(req.body.doc);
                if (vErr) return res.status(400).json({ msg: vErr });
            }
            patch.doc = req.body.doc;
        }
        if (Object.keys(patch).length === 0) return res.json({ map });
        Object.assign(map, patch);
        // Mongoose erkennt Mixed-Aenderungen nicht automatisch.
        if (patch.doc) map.markModified('doc');
        await map.save();
        // 2d-editor-Karten im aktiven Kampagnenraum sofort allen Sockets pushen.
        if (map.kind === '2d-editor' && patch.doc) {
            await broadcastMapUpdate(req, map._id, map);
        }
        res.json({ map });
    } catch (err) {
        console.error('Error updating map:', err);
        res.status(500).json({ msg: 'Server error while updating map' });
    }
});

// DELETE /api/maps/:id -> nur Owner, Beispiele nie.
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Map not found' });
    try {
        const map = await Map.findById(id);
        if (!map) return res.status(404).json({ msg: 'Map not found' });
        if (map.isExample) return res.status(403).json({ msg: 'Example maps are read-only' });
        if (!map.owner || String(map.owner) !== String(req.user.id)) {
            return res.status(403).json({ msg: 'Not allowed' });
        }
        await Map.deleteOne({ _id: id });
        res.json({ msg: 'Map deleted' });
    } catch (err) {
        console.error('Error deleting map:', err);
        res.status(500).json({ msg: 'Server error while deleting map' });
    }
});

module.exports = router;
