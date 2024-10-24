const mongoose = require('mongoose');

const fileMetadataSchema = new mongoose.Schema({
    url: {
        type: String,
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = mongoose.model('FileMetadata', fileMetadataSchema);
