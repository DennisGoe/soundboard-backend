const admin = require("firebase-admin");
const path = require("path");
const dotenv = require("dotenv"); // Update this path to match the path of your downloaded JSON file

// Import the service account key JSON that you downloaded from Firebase Console
const serviceAccount = require(path.join(__dirname, './soundboard-84dec-firebase-adminsdk-misee-1c4c3b8361.json'));
dotenv.config();
console.log("retrigger build")
// Initialize the Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

// Initialize Firebase Storage Bucket
const bucket = admin.storage().bucket();

module.exports = { bucket };
