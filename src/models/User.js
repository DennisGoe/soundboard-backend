const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    favourites: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'FileMetadata'
    }]
});

module.exports = mongoose.model('User', UserSchema);
