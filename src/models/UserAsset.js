const mongoose = require('mongoose');

// Vom GM hochgeladenes Asset fuer den 2D-Editor.
// In Firebase gespeichert, nur die URL + Metadata im DB-Dokument.
const UserAssetSchema = new mongoose.Schema(
    {
        owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        name: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
        // Frei definierbare Kategorie-Buchstaben-Kombi. UI zeigt Assets in "Meine Assets".
        // Keine Mongoose-Enum, damit der GM eigene Unterkategorien nennen kann (geprueft via Regex).
        category: { type: String, default: 'eigene', maxlength: 24 },
        tags: [{ type: String, maxlength: 32 }],
        imageUrl: { type: String, required: true, maxlength: 500 },
        width: { type: Number, default: 1 },    // in Feldern (default 1x1)
        height: { type: Number, default: 1 },
    },
    { timestamps: true }
);

module.exports = mongoose.model('UserAsset', UserAssetSchema);
