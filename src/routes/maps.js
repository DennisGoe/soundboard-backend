const express = require('express');
const mongoose = require('mongoose');
const Map = require('../models/Map');
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

// GET /api/maps -> Liste: eigene + Beispiele, sortiert nach updatedAt desc,
// OHNE das doc-Feld (ListView-Performance; Clients laden Details per GET /:id).
router.get('/', async (req, res) => {
    try {
        const userId = req.user.id;
        const maps = await Map.find({
            $or: [{ owner: userId }, { isExample: true }],
        })
            .select('name owner isExample createdAt updatedAt')
            .sort({ updatedAt: -1 });
        res.json({ maps });
    } catch (err) {
        console.error('Error listing maps:', err);
        res.status(500).json({ msg: 'Server error while listing maps' });
    }
});

// GET /api/maps/:id -> Vollstaendige Karte inkl. doc.
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Map not found' });
    try {
        const userId = req.user.id;
        const map = await Map.findOne({
            _id: id,
            $or: [{ owner: userId }, { isExample: true }],
        });
        if (!map) return res.status(404).json({ msg: 'Map not found' });
        res.json({ map });
    } catch (err) {
        console.error('Error fetching map:', err);
        res.status(500).json({ msg: 'Server error while fetching map' });
    }
});

// POST /api/maps -> body { name, doc }. Owner wird aus JWT gesetzt. isExample
// darf vom Client nie gesetzt werden (nur Server-Seeding erstellt Beispiele).
router.post('/', async (req, res) => {
    try {
        const name = sanitizeName(req.body?.name);
        if (!name) return res.status(400).json({ msg: 'Name required (1-80 chars)' });
        const doc = req.body?.doc;
        if (!isPlainObject(doc)) return res.status(400).json({ msg: 'doc must be an object' });
        const map = await Map.create({
            name,
            owner: req.user.id,
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
            patch.doc = req.body.doc;
        }
        if (Object.keys(patch).length === 0) return res.json({ map });
        Object.assign(map, patch);
        // Mongoose erkennt Mixed-Aenderungen nicht automatisch.
        if (patch.doc) map.markModified('doc');
        await map.save();
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
