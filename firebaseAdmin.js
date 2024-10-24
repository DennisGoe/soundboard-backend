const admin = require("firebase-admin");
const path = require("path");

// Import the service account key JSON that you downloaded from Firebase Console
const serviceAccount = require(path.join(__dirname, './config/soundboard-84dec-firebase-adminsdk-misee-1c4c3b8361.json')); // Update this path to match the path of your downloaded JSON file

// Initialize the Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'YOUR_STORAGE_BUCKET_URL'
});

// Initialize Firebase Storage Bucket
const bucket = admin.storage().bucket();

module.exports = { bucket };
