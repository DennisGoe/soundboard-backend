// REST-Teile der User-Assets. Der Firebase-Upload liegt in assetUpload.js
// (lazy, siehe app.js). Lesen/Loeschen funktioniert OHNE Firebase-Env, daher
// trennen wir die Routen auf — damit die Tests ohne Firebase-Env laufen.
const express = require('express');
const mongoose = require('mongoose');
const UserAsset = require('../models/UserAsset');
const { authMiddleware } = require('../authMiddleware');

const router = express.Router();
router.use(authMiddleware);

function isValidId(id) {
    return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

function sanitizeTags(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((t) => typeof t === 'string')
        .map((t) => t.trim().slice(0, 32))
        .filter((t) => t.length > 0)
        .slice(0, 20);
}
function sanitizeCategory(raw) {
    if (typeof raw !== 'string') return 'eigene';
    const s = raw.trim().toLowerCase().slice(0, 24);
    if (!/^[a-z0-9-]+$/.test(s)) return 'eigene';
    return s;
}

// GET /api/assets -> eigene Assets des Users
router.get('/', async (req, res) => {
    try {
        const assets = await UserAsset.find({ owner: req.user.id })
            .sort({ updatedAt: -1 })
            .limit(500);
        res.json({ assets });
    } catch (err) {
        console.error('Error listing assets:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

// PUT /api/assets/:id -> Metadata editieren (nur Name/Tags/Kategorie)
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Not found' });
    try {
        const asset = await UserAsset.findById(id);
        if (!asset || String(asset.owner) !== String(req.user.id)) {
            return res.status(404).json({ msg: 'Not found' });
        }
        if (typeof req.body?.name === 'string') {
            const n = req.body.name.trim();
            if (n.length < 1 || n.length > 80) return res.status(400).json({ msg: 'Name required (1-80)' });
            asset.name = n;
        }
        if (req.body?.tags !== undefined) asset.tags = sanitizeTags(req.body.tags);
        if (req.body?.category !== undefined) asset.category = sanitizeCategory(req.body.category);
        await asset.save();
        res.json({ asset });
    } catch (err) {
        console.error('Error updating asset:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

// DELETE /api/assets/:id -> loeschen. Hinweis: die Firebase-Datei bleibt liegen;
// loeschen wir hier nicht aus, weil ggf. noch andere Maps darauf verweisen und
// wir den Zaehler nicht pflegen.
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Not found' });
    try {
        const asset = await UserAsset.findById(id);
        if (!asset || String(asset.owner) !== String(req.user.id)) {
            return res.status(404).json({ msg: 'Not found' });
        }
        await UserAsset.deleteOne({ _id: id });
        res.json({ msg: 'Deleted' });
    } catch (err) {
        console.error('Error deleting asset:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

module.exports = router;
// Fuer Reuse in Tests
module.exports.sanitizeCategory = sanitizeCategory;
module.exports.sanitizeTags = sanitizeTags;
