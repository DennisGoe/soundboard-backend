const express = require('express');
const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
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
    // Deduplizieren, Format pruefen.
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
    // Nur Maps, die dem User gehoeren oder Beispiele sind, zaehlen.
    const allowed = await Map.find({
        _id: { $in: cleaned },
        $or: [{ owner: userId }, { isExample: true }],
    }).select('_id');
    const allowedSet = new Set(allowed.map((m) => String(m._id)));
    if (allowedSet.size !== cleaned.length) {
        return { ok: false, badReason: 'mapIds contains unknown or forbidden map' };
    }
    // Reihenfolge der Eingabe beibehalten.
    return { ok: true, ids: cleaned.map((id) => new mongoose.Types.ObjectId(id)) };
}

// GET /api/campaigns -> eigene Kampagnen, sortiert nach updatedAt desc.
// Enthaelt mapIds als String-Array (Frontend braucht Count fuer Badge).
router.get('/', async (req, res) => {
    try {
        const userId = req.user.id;
        const campaigns = await Campaign.find({ owner: userId })
            .select('name description owner mapIds createdAt updatedAt')
            .sort({ updatedAt: -1 });
        res.json({ campaigns });
    } catch (err) {
        console.error('Error listing campaigns:', err);
        res.status(500).json({ msg: 'Server error while listing campaigns' });
    }
});

// GET /api/campaigns/:id -> einzelne Kampagne (nur Owner).
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Campaign not found' });
    try {
        const userId = req.user.id;
        const campaign = await Campaign.findOne({ _id: id, owner: userId });
        if (!campaign) return res.status(404).json({ msg: 'Campaign not found' });
        res.json({ campaign });
    } catch (err) {
        console.error('Error fetching campaign:', err);
        res.status(500).json({ msg: 'Server error while fetching campaign' });
    }
});

// POST /api/campaigns -> { name, description?, mapIds? }. Owner = JWT.
router.post('/', async (req, res) => {
    try {
        const name = sanitizeName(req.body?.name);
        if (!name) return res.status(400).json({ msg: 'Name required (1-120 chars)' });
        const description = sanitizeDescription(req.body?.description);
        if (description === null) return res.status(400).json({ msg: 'Description too long (max 4000 chars)' });
        const check = await validateMapIds(req.body?.mapIds, req.user.id);
        if (!check.ok) return res.status(400).json({ msg: check.badReason });
        const campaign = await Campaign.create({
            name,
            description,
            owner: req.user.id,
            mapIds: check.ids,
        });
        res.status(201).json({ campaign });
    } catch (err) {
        console.error('Error creating campaign:', err);
        res.status(500).json({ msg: 'Server error while creating campaign' });
    }
});

// PUT /api/campaigns/:id -> { name?, description?, mapIds? }. Nur Owner.
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
        if (Object.keys(patch).length === 0) return res.json({ campaign });
        Object.assign(campaign, patch);
        await campaign.save();
        res.json({ campaign });
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
        res.json({ msg: 'Campaign deleted' });
    } catch (err) {
        console.error('Error deleting campaign:', err);
        res.status(500).json({ msg: 'Server error while deleting campaign' });
    }
});

module.exports = router;
