const mongoose = require('mongoose');

// Kampagnen des D&D-Builders. Eine Kampagne gehoert genau einem User (dem GM)
// und referenziert eine Liste von Maps. Beim Zuweisen pruefen die Routen, dass
// jede Map dem User gehoert oder eine Beispiel-Map ist.
const CampaignSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 120,
        },
        description: {
            type: String,
            trim: true,
            maxlength: 4000,
            default: '',
        },
        owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        // Spieler duerfen die Kampagne lesen + den Spielraum betreten,
        // aber NICHT bearbeiten oder Maps zuweisen. Nur GM pflegt die Liste.
        players: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
            default: [],
            index: true,
        },
        mapIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Map' }],
            default: [],
        },
        // Aktuell im Spielraum angezeigte Karte. Nur GM setzt sie; der Server
        // pusht die Aenderung per socket an alle im Raum.
        activeMapId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Map',
            default: null,
        },
        // Pro Spieler (und GM!) der gerade gewaehlte Charakter. Map<userId, characterId>.
        // Nur eine Zuordnung pro User; Spieler kann sie jederzeit aendern.
        characterSelections: {
            type: Map,
            of: { type: mongoose.Schema.Types.ObjectId, ref: 'Character' },
            default: () => new Map(),
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Campaign', CampaignSchema);
