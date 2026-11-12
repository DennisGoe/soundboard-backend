const mongoose = require('mongoose');

// Charaktere eines Users (kampagnenuebergreifend).
// Spieler legt einen Char an, laedt ein Token-Bild hoch (optional).
// Pro Kampagne waehlt der Spieler, mit welchem Char er gerade spielt
// -> gespeichert in Campaign.characterSelections (Map<userId, characterId>).
const CharacterSchema = new mongoose.Schema(
    {
        owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 80,
        },
        // Firebase-Storage-URL (optional, kann null/leer sein).
        tokenUrl: {
            type: String,
            default: null,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Character', CharacterSchema);
