const mongoose = require('mongoose');

// Token-Zustand pro (Campaign, Map). Wird separat gespeichert, weil derselbe
// Kartenbestand in mehreren Kampagnen unterschiedlich belegt sein kann.
//
// Tokens: entweder ein Charakter-Token (characterId gesetzt, ownerUserId = Char-Owner)
// oder ein freies GM-Token (characterId=null, label+color gesetzt).
// Gruppen sind lose Container (nur groupId-Zuordnung am Token).
const TokenSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        characterId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Character',
            default: null,
        },
        // Wer darf das Token bewegen (User-Id). Bei Char-Tokens = Owner des Chars,
        // bei GM-Tokens = null (nur GM).
        ownerUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        // Fuer GM-Tokens: Label + Farbe.
        label: { type: String, default: '' },
        color: { type: String, default: '#9b2a1e' },
        // Position in Feldkoordinaten (float, Feldmitte liegt auf .5).
        x: { type: Number, required: true },
        y: { type: Number, required: true },
        // Groesse in Feldern (1 = Medium, 2 = Large, 0.5 = Tiny usw).
        size: { type: Number, default: 1, min: 0.25, max: 10 },
        groupId: { type: String, default: null },
        locked: { type: Boolean, default: false },
    },
    { _id: false }
);

const GroupSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        name: { type: String, default: '' },
        locked: { type: Boolean, default: false },
    },
    { _id: false }
);

const MapTokensSchema = new mongoose.Schema(
    {
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign',
            required: true,
            index: true,
        },
        mapId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Map',
            required: true,
            index: true,
        },
        tokens: { type: [TokenSchema], default: [] },
        groups: { type: [GroupSchema], default: [] },
    },
    { timestamps: true }
);

MapTokensSchema.index({ campaignId: 1, mapId: 1 }, { unique: true });

module.exports = mongoose.model('MapTokens', MapTokensSchema);
