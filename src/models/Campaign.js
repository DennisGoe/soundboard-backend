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
        mapIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Map' }],
            default: [],
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Campaign', CampaignSchema);
