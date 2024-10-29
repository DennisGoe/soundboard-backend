const express = require('express');
const User = require('../models/User');
const { authMiddleware } = require('../authMiddleware');

const router = express.Router();

// Toggle favorite sound
router.post('/changeFavourite/:id', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const { id: soundId } = req.params;

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        const favouriteIndex = user.favourites.indexOf(soundId);

        if (favouriteIndex > -1) {
            user.favourites.splice(favouriteIndex, 1); // Remove from favorites
        } else {
            user.favourites.push(soundId); // Add to favorites
        }

        await user.save();

        res.status(200).json({ favourites: user.favourites });
    } catch (err) {
        console.error('Error toggling favourite sound:', err);
        res.status(500).json({ msg: 'Server error while toggling favourite sound' });
    }
});

router.get('/getFavourites', authMiddleware, async (req, res) => {
    const userId = req.user.id;

    try {
        const user = await User.findById(userId).populate('favourites');
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        res.status(200).json({ favourites: user.favourites });
    } catch (err) {
        console.error('Error fetching favourite sounds:', err);
        res.status(500).json({ msg: 'Server error while fetching favourite sounds' });
    }
});

module.exports = router;
