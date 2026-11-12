// Upload fuer Charakter-Token-Bilder in den Firebase-Bucket.
// Lazy-loaded (siehe app.js includeFileUploads=false im Test).
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const mongoose = require('mongoose');
const { bucket } = require('../../firebaseAdmin');
const Character = require('../models/Character');
const { authMiddleware } = require('../authMiddleware');

const router = express.Router();
router.use(authMiddleware);

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB (Tokens sind klein)

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

function isValidId(id) {
    return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

// POST /api/characters/:id/token  (multipart)  image
// -> laedt Bild in Firebase und setzt character.tokenUrl. Nur Owner.
router.post('/:id/token', (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(404).json({ msg: 'Not found' });
    upload.single('image')(req, res, async (err) => {
        if (err) {
            if (err.message === 'UNSUPPORTED_TYPE') {
                return res.status(400).json({ msg: 'Only png, jpeg or webp allowed' });
            }
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ msg: 'Image too large (max 5 MB)' });
            }
            console.error('Multer error:', err);
            return res.status(400).json({ msg: 'Upload failed' });
        }
        if (!req.file) return res.status(400).json({ msg: 'No file uploaded' });
        try {
            const c = await Character.findById(id);
            if (!c || String(c.owner) !== String(req.user.id)) {
                try { fs.unlinkSync(req.file.path); } catch {}
                return res.status(404).json({ msg: 'Not found' });
            }
            const safeOriginal = String(req.file.originalname || 'token')
                .replace(/[^a-zA-Z0-9._-]/g, '_');
            const fileName = `tokens/${Date.now()}-${safeOriginal}`;
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
            c.tokenUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
            await c.save();
            res.json({ character: c });
        } catch (e) {
            console.error('Error uploading token:', e);
            try { fs.unlinkSync(req.file.path); } catch {}
            res.status(500).json({ msg: 'Server error while uploading token' });
        }
    });
});

module.exports = router;
