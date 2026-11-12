// Upload-Route fuer eigene Assets. Firebase-Bucket (wie fileUpload.js).
// Lazy geladen in app.js nur mit Firebase-Env.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { bucket } = require('../../firebaseAdmin');
const UserAsset = require('../models/UserAsset');
const { authMiddleware } = require('../authMiddleware');
const { sanitizeCategory, sanitizeTags } = require('./assets');

const router = express.Router();
router.use(authMiddleware);

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB pro Asset — ausreichend fuer Top-Down-Icons
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: MAX_BYTES },
    fileFilter: (req, file, cb) => {
        const ok = ['image/png', 'image/jpeg', 'image/webp'].includes(String(file.mimetype));
        if (!ok) return cb(new Error('UNSUPPORTED_TYPE'));
        cb(null, true);
    },
});

function sanitizeName(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (s.length < 1 || s.length > 80) return null;
    return s;
}
function parseFieldDim(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0.3, Math.min(8, n));
}

// POST /api/assets/upload (multipart: image, name, category?, tags?, width?, height?)
router.post('/upload', (req, res) => {
    upload.single('image')(req, res, async (err) => {
        if (err) {
            if (err.message === 'UNSUPPORTED_TYPE') return res.status(400).json({ msg: 'Only png, jpeg or webp allowed' });
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ msg: 'Image too large (max 3 MB)' });
            console.error('Multer error:', err);
            return res.status(400).json({ msg: 'Upload failed' });
        }
        if (!req.file) return res.status(400).json({ msg: 'No file uploaded' });
        const name = sanitizeName(req.body?.name);
        if (!name) {
            try { fs.unlinkSync(req.file.path); } catch {}
            return res.status(400).json({ msg: 'Name required (1-80 chars)' });
        }
        const category = sanitizeCategory(req.body?.category);
        const tags = sanitizeTags(Array.isArray(req.body?.tags) ? req.body.tags :
            typeof req.body?.tags === 'string' ? req.body.tags.split(',') : []);
        const width = parseFieldDim(req.body?.width, 1);
        const height = parseFieldDim(req.body?.height, 1);
        try {
            const safeOriginal = String(req.file.originalname || 'asset').replace(/[^a-zA-Z0-9._-]/g, '_');
            const fileName = `assets/${req.user.id}/${Date.now()}-${safeOriginal}`;
            const firebaseFile = bucket.file(fileName);
            await new Promise((resolve, reject) => {
                fs.createReadStream(req.file.path)
                    .pipe(firebaseFile.createWriteStream({
                        metadata: { contentType: req.file.mimetype },
                        public: true,
                    }))
                    .on('finish', resolve)
                    .on('error', reject);
            });
            try { fs.unlinkSync(req.file.path); } catch {}
            const imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
            const asset = await UserAsset.create({
                owner: req.user.id, name, category, tags, imageUrl, width, height,
            });
            res.status(201).json({ asset });
        } catch (e) {
            console.error('Error uploading asset:', e);
            try { fs.unlinkSync(req.file.path); } catch {}
            res.status(500).json({ msg: 'Server error while uploading asset' });
        }
    });
});

module.exports = router;
