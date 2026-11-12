const mongoose = require('mongoose');

// Inventar pro (Campaign, User). Spieler sieht + bearbeitet nur sein eigenes.
// GM sieht alle Inventare der Kampagne (inklusive sein eigenes) und kann
// Gegenstaende auch zwischen Spielern verschieben (auch Teilmengen).
const ItemSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        name: { type: String, required: true, trim: true, maxlength: 120 },
        qty: { type: Number, required: true, min: 1, max: 99999, default: 1 },
        description: { type: String, default: '', maxlength: 2000 },
    },
    { _id: false }
);

const InventorySchema = new mongoose.Schema(
    {
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign',
            required: true,
            index: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        notes: { type: String, default: '', maxlength: 8000 },
        items: { type: [ItemSchema], default: [] },
    },
    { timestamps: true }
);

InventorySchema.index({ campaignId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Inventory', InventorySchema);
