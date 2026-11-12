// REST-Routen fuer Spieler-Charaktere. Jeder User hat eigene Charaktere
// (kampagnenuebergreifend). CRUD + "ist der Char gerade in einer Kampagne
// gewaehlt?" hilft bei Loeschen.
const express = require('express');
const mongoose = require('mongoose');
const Character = require('../models/Character');
const Campaign = require('../models/Campaign');
const { authMiddleware } = require('../authMiddleware');

const router = express.Router();
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

// GET /api/characters -> eigene Charaktere, neueste zuerst.
router.get('/', async (req, res) => {
    try {
        const list = await Character.find({ owner: req.user.id })
            .sort({ updatedAt: -1 });
        res.json({ characters: list });
    } catch (err) {
        console.error('Error listing characters:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

function sanitizeBonus(raw) {
    if (raw === undefined || raw === null) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const i = Math.round(n);
    if (i < -10 || i > 30) return null;
    return i;
}

// POST /api/characters  { name, initiativeBonus? } -> neu, ohne Token-Bild.
router.post('/', async (req, res) => {
    try {
        const name = sanitizeName(req.body?.name);
        if (!name) return res.status(400).json({ msg: 'Name required (1-80 chars)' });
        const payload = { owner: req.user.id, name, tokenUrl: null };
        if (req.body?.initiativeBonus !== undefined) {
            const b = sanitizeBonus(req.body.initiativeBonus);
            if (b === null) return res.status(400).json({ msg: 'initiativeBonus invalid (-10..30)' });
            if (b !== undefined) payload.initiativeBonus = b;
        }
        const c = await Character.create(payload);
        res.status(201).json({ character: c });
    } catch (err) {
        console.error('Error creating character:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

// PUT /api/characters/:id  { name?, initiativeBonus? } -> nur Owner.
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Not found' });
    try {
        const c = await Character.findById(id);
        if (!c || String(c.owner) !== String(req.user.id)) {
            return res.status(404).json({ msg: 'Not found' });
        }
        if (req.body?.name !== undefined) {
            const name = sanitizeName(req.body.name);
            if (!name) return res.status(400).json({ msg: 'Name required (1-80 chars)' });
            c.name = name;
        }
        if (req.body?.initiativeBonus !== undefined) {
            const b = sanitizeBonus(req.body.initiativeBonus);
            if (b === null) return res.status(400).json({ msg: 'initiativeBonus invalid (-10..30)' });
            if (b !== undefined) c.initiativeBonus = b;
        }
        await c.save();
        res.json({ character: c });
    } catch (err) {
        console.error('Error updating character:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

// DELETE /api/characters/:id -> nur Owner. Nebenwirkung: raeumt die Auswahl
// in allen Kampagnen auf, in denen dieser Char ausgewaehlt war.
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Not found' });
    try {
        const c = await Character.findById(id);
        if (!c || String(c.owner) !== String(req.user.id)) {
            return res.status(404).json({ msg: 'Not found' });
        }
        await Character.deleteOne({ _id: id });
        // In allen Kampagnen, wo dieser Char (meines Users) gewaehlt war, raus.
        const myId = String(req.user.id);
        const campaigns = await Campaign.find({
            $or: [{ owner: req.user.id }, { players: req.user.id }],
        });
        for (const camp of campaigns) {
            if (camp.characterSelections && camp.characterSelections.get) {
                const sel = camp.characterSelections.get(myId);
                if (sel && String(sel) === String(id)) {
                    camp.characterSelections.delete(myId);
                    await camp.save();
                }
            }
        }
        res.json({ msg: 'Character deleted' });
    } catch (err) {
        console.error('Error deleting character:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

module.exports = router;
