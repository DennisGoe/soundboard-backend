const express = require('express');
const User = require('../models/User');
const { authMiddleware } = require('../authMiddleware');

const router = express.Router();

router.use(authMiddleware);

// GET /api/users?q=... -> leichtgewichtige User-Suche fuer den
// "Spieler hinzufuegen"-Dialog. Gibt NUR _id + username zurueck,
// nie Passwort-Hash oder Favoriten. Bei leerem q: erste 25 User
// alphabetisch (praktikabel bei kleiner Nutzerbasis).
router.get('/', async (req, res) => {
    try {
        const raw = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
        const query = {};
        if (raw.length > 0) {
            // Case-insensitive Substring-Suche. Spezialzeichen escapen, damit
            // kein User per .* etc. Mongo-Regex-Angriffe fahren kann.
            const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.username = { $regex: esc, $options: 'i' };
        }
        const users = await User.find(query)
            .select('_id username')
            .sort({ username: 1 })
            .limit(25);
        res.json({
            users: users.map((u) => ({ _id: u._id, username: u.username })),
        });
    } catch (err) {
        console.error('Error searching users:', err);
        res.status(500).json({ msg: 'Server error' });
    }
});

module.exports = router;
