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
    // Overlay (Runde 3d) — optional; wenn vorhanden, exakt w*h gross.
    if (doc.overlay !== undefined) {
        if (!Array.isArray(doc.overlay)) return 'overlay must be array';
        if (doc.overlay.length !== w * h) return 'overlay length must equal width*height';
        for (const v of doc.overlay) {
            if (!Number.isInteger(v) || v < 0 || v > 255) return 'overlay entry must be 0..255';
        }
    }
    if (doc.overlayMat !== undefined) {
        if (!Array.isArray(doc.overlayMat)) return 'overlayMat must be array';
        if (doc.overlayMat.length !== w * h) return 'overlayMat length must equal width*height';
        for (const v of doc.overlayMat) {
            if (!Number.isInteger(v) || v < 0 || v > 32) return 'overlayMat entry out of range';
        }
    }
    if (!Array.isArray(doc.walls)) return 'walls must be array';
    if (doc.walls.length > 20000) return 'too many walls';
    for (const wl of doc.walls) {
        if (!isPlainObject(wl)) return 'wall entry not object';
        if (!Array.isArray(wl.a) || wl.a.length !== 2) return 'wall.a invalid';
        if (!Array.isArray(wl.b) || wl.b.length !== 2) return 'wall.b invalid';
        if (!Number.isInteger(wl.a[0]) || !Number.isInteger(wl.a[1])) return 'wall endpoint not int';
        if (!Number.isInteger(wl.b[0]) || !Number.isInteger(wl.b[1])) return 'wall endpoint not int';
        if (wl.kind && !['wall', 'door', 'window'].includes(wl.kind)) return 'wall.kind invalid';
        if (wl.style && !['stone', 'wood'].includes(wl.style)) return 'wall.style invalid';
    }
    if (!Array.isArray(doc.objects)) return 'objects must be array';
    if (doc.objects.length > 5000) return 'too many objects';
    for (const o of doc.objects) {
        if (!isPlainObject(o)) return 'object entry not object';
        if (typeof o.type !== 'string' || o.type.length > 64) return 'object.type invalid';
        if (typeof o.x !== 'number' || typeof o.y !== 'number') return 'object pos invalid';
        if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return 'object pos must be finite';
        if (o.rot !== undefined && (!Number.isFinite(o.rot))) return 'object.rot invalid';
        if (o.scale !== undefined && (!Number.isFinite(o.scale) || o.scale <= 0 || o.scale > 8)) return 'object.scale invalid';
        if (o.sizeX !== undefined && (!Number.isFinite(o.sizeX) || o.sizeX <= 0 || o.sizeX > 20)) return 'object.sizeX invalid';
        if (o.sizeY !== undefined && (!Number.isFinite(o.sizeY) || o.sizeY <= 0 || o.sizeY > 20)) return 'object.sizeY invalid';
        if (o.flipX !== undefined && typeof o.flipX !== 'boolean') return 'object.flipX must be boolean';
        if (o.flipY !== undefined && typeof o.flipY !== 'boolean') return 'object.flipY must be boolean';
        if (o.layer !== undefined && !['above', 'below'].includes(o.layer)) return 'object.layer invalid';
        if (o.assetUrl !== undefined && (typeof o.assetUrl !== 'string' || o.assetUrl.length > 600)) return 'object.assetUrl invalid';
    }
    if (doc.paths !== undefined) {
        if (!Array.isArray(doc.paths)) return 'paths must be array';
        if (doc.paths.length > 500) return 'too many paths';
        for (const p of doc.paths) {
            if (!isPlainObject(p)) return 'path entry not object';
            if (!['road', 'river', 'bridge-wood', 'bridge-stone'].includes(p.kind)) return 'path.kind invalid';
            if (!Array.isArray(p.points) || p.points.length < 2 || p.points.length > 500) return 'path.points invalid';
            for (const pt of p.points) {
                if (!Array.isArray(pt) || pt.length !== 2) return 'path.point invalid';
                if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return 'path.point must be finite';
            }
            if (typeof p.width !== 'number' || p.width <= 0 || p.width > 10) return 'path.width invalid';
            if (!Number.isInteger(p.material) || p.material < 0 || p.material > 32) return 'path.material invalid';
        }
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

// PUT /api/maps/:id/grid -> { grid } Nur Owner. Fuer 2d-image-Karten das
// Raster-Overlay setzen. Pusht ueber Sockets in alle aktiven Spielraeume.
function sanitizeGrid(raw) {
    if (raw === null || raw === undefined) return { ok: true, value: null };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, msg: 'grid must be object or null' };
    }
    const out = {};
    if (raw.cellPx === null) out.cellPx = null;
    else if (typeof raw.cellPx === 'number' && Number.isFinite(raw.cellPx) && raw.cellPx > 0 && raw.cellPx < 10000) {
        out.cellPx = raw.cellPx;
    } else return { ok: false, msg: 'grid.cellPx invalid' };
    for (const k of ['offsetX', 'offsetY']) {
        if (raw[k] === undefined) out[k] = 0;
        else if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) out[k] = raw[k];
        else return { ok: false, msg: `grid.${k} invalid` };
    }
    if (raw.show === undefined) out.show = true;
    else if (typeof raw.show === 'boolean') out.show = raw.show;
    else return { ok: false, msg: 'grid.show invalid' };
    if (raw.color === undefined) out.color = '#000000';
    else if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)) out.color = raw.color;
    else return { ok: false, msg: 'grid.color must be #RRGGBB' };
    if (raw.opacity === undefined) out.opacity = 0.4;
    else if (typeof raw.opacity === 'number' && raw.opacity >= 0 && raw.opacity <= 1) out.opacity = raw.opacity;
    else return { ok: false, msg: 'grid.opacity must be 0..1' };
    return { ok: true, value: out };
}

router.put('/:id/grid', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Map not found' });
    try {
        const map = await Map.findById(id);
        if (!map) return res.status(404).json({ msg: 'Map not found' });
        if (map.isExample) return res.status(403).json({ msg: 'Example maps are read-only' });
        if (!map.owner || String(map.owner) !== String(req.user.id)) {
            return res.status(403).json({ msg: 'Not allowed' });
        }
        if (map.kind !== '2d-image') {
            return res.status(400).json({ msg: 'grid only for kind=2d-image' });
        }
        const check = sanitizeGrid(req.body?.grid);
        if (!check.ok) return res.status(400).json({ msg: check.msg });
        map.grid = check.value || undefined;
        await map.save();
        // Alle Kampagnenraeume, in denen diese Map gerade aktiv ist, benachrichtigen.
        try {
            const io = req.app.get('io');
            if (io) {
                const camps = await Campaign.find({ activeMapId: map._id }).select('_id');
                const payload = {
                    mapId: String(map._id),
                    grid: map.grid || null,
                };
                for (const c of camps) {
                    io.to(`campaign:${c._id}`).emit('campaign:mapGrid', {
                        campaignId: String(c._id),
                        ...payload,
                    });
                }
            }
        } catch (e) { console.error('grid broadcast error:', e); }
        res.json({ map });
    } catch (err) {
        console.error('Error updating grid:', err);
        res.status(500).json({ msg: 'Server error' });
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
// Fuer Tests: Validator-Funktion direkt zugreifbar.
module.exports.validateEditorDoc = validateEditorDoc;
