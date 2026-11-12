const mongoose = require('mongoose');

// Initiative-Tracker pro Kampagne. Genau ein Dokument pro Campaign.
//
// Ein "Entry" ist entweder ein Spieler-/GM-Charakter oder ein NSC/Monster.
// Wenn kein Wurf vorhanden ist, ist `roll` = null (Entry ist "angemeldet",
// steht aber noch nicht in der Reihenfolge). Einmal gewuerfelt, sortieren
// wir global absteigend nach `(roll + bonus, bonus, order)`.
//
// `active`:   Kampf laeuft? Falls false, ignoriert FE Rundenzaehler/Pfeil.
// `round`:    aktuelle Runde (1..)
// `turnIndex`: wer ist dran (Index in der sortierten Reihenfolge, 0-basiert).
// `entries[].order`: monotone Reihenfolge der Wuerfe (Tiebreak, wenn Roll+Bonus gleich).
const EntrySchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        // Ein Entry gehoert entweder zu einem Char (=> userId + characterId gesetzt)
        // oder ist ein NSC vom GM (=> userId=null, characterId=null, isNpc=true).
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        characterId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Character',
            default: null,
        },
        isNpc: { type: Boolean, default: false },
        // Snapshot fuer Panel-Darstellung (Namensaenderungen danach egal).
        name: { type: String, required: true, maxlength: 80 },
        tokenUrl: { type: String, default: null },
        // d20-Wurf (1..20) oder null = noch nicht gewuerfelt.
        roll: { type: Number, default: null, min: 1, max: 20 },
        bonus: { type: Number, default: 0, min: -10, max: 30 },
        order: { type: Number, default: 0 },
    },
    { _id: false }
);

const InitiativeSchema = new mongoose.Schema(
    {
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign',
            required: true,
            unique: true,
            index: true,
        },
        active: { type: Boolean, default: false },
        round: { type: Number, default: 1, min: 1 },
        turnIndex: { type: Number, default: 0, min: 0 },
        entries: { type: [EntrySchema], default: [] },
        orderCounter: { type: Number, default: 0 },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Initiative', InitiativeSchema);
