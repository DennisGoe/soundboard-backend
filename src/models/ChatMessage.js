const mongoose = require('mongoose');

// Persistente Chat-Nachrichten pro Kampagne. Beim Betreten des Spielraums
// laedt der Server die letzten ~100, neue werden per socket verteilt UND in
// Mongo geschrieben (damit sie Reloads ueberleben).
const ChatMessageSchema = new mongoose.Schema(
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
        },
        // Snapshot des Usernamens zum Zeitpunkt der Nachricht — damit
        // Namensaenderungen alte Logs nicht umschreiben.
        username: {
            type: String,
            required: true,
        },
        text: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 2000,
        },
    },
    { timestamps: true }
);

ChatMessageSchema.index({ campaignId: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
