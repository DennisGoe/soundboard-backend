// Upload fuer 2D-Karten-Bilder. Eigene Route, damit sie (wie fileUpload.js)
// lazy geladen werden kann: in Tests ohne Firebase-Env wird sie weggelassen.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { bucket } = require('../../firebaseAdmin');
const Map = require('../models/Map');
const { authMiddleware } = require('../authMiddleware');

const router = express.Router();
router.use(authMiddleware);

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

// Multer mit Disk-Storage (wie fileUpload.js). MIME wird zusaetzlich
// serverseitig gegen Whitelist geprueft (Client-Header allein ist nicht
// vertrauenswuerdig, Multer leitet ihn nur durch; hier blocken wir alles
// Non-Image hart).
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: MAX_BYTES },
    fileFilter: (req, file, cb) => {
        const ok = ['image/png', 'image/jpeg', 'image/webp'].includes(
            String(file.mimetype)
        );
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

// POST /api/maps/upload-2d  (multipart) { image, name }
// -> legt Map { kind:'2d-image', imageUrl, owner } an.
router.post('/upload-2d', (req, res) => {
    upload.single('image')(req, res, async (err) => {
        if (err) {
            if (err.message === 'UNSUPPORTED_TYPE') {
                return res.status(400).json({ msg: 'Only png, jpeg or webp allowed' });
            }
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ msg: 'Image too large (max 15 MB)' });
            }
            console.error('Multer error:', err);
            return res.status(400).json({ msg: 'Upload failed' });
        }
        if (!req.file) return res.status(400).json({ msg: 'No file uploaded' });
        const name = sanitizeName(req.body?.name);
        if (!name) {
            try { fs.unlinkSync(req.file.path); } catch {}
            return res.status(400).json({ msg: 'Name required (1-80 chars)' });
        }
        try {
            const safeOriginal = String(req.file.originalname || 'map')
                .replace(/[^a-zA-Z0-9._-]/g, '_');
            const fileName = `maps/${Date.now()}-${safeOriginal}`;
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
            const map = await Map.create({
                name,
                owner: req.user.id,
                kind: '2d-image',
                imageUrl,
                doc: {},
                isExample: false,
            });
            res.status(201).json({ map });
        } catch (e) {
            console.error('Error uploading 2d map:', e);
            try { fs.unlinkSync(req.file.path); } catch {}
            res.status(500).json({ msg: 'Server error while uploading map' });
        }
    });
});

module.exports = router;
