const express = require('express');
const multer = require('multer');
const { bucket } = require('../../firebaseAdmin'); // Adjusted path to reach firebaseAdmin.js
const FileMetadata = require('../models/FileMetadata'); // Import the MongoDB model

const router = express.Router();

// Set up multer for temporary storage
const upload = multer({ dest: 'uploads/' });

// File Upload Endpoint
router.post('/upload', upload.single('mp3'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ msg: 'No file uploaded' });
    }

    try {
        const filePath = req.file.path; // Path to the temporarily stored file
        const fileName = `${Date.now()}-${req.file.originalname}`; // Create a unique name for the file

        // Firebase Storage upload
        const firebaseFile = bucket.file(fileName);
        const options = {
            metadata: {
                contentType: req.file.mimetype,
            },
            public: true, // Make the file publicly accessible
        };

        // Upload to Firebase Storage
        await new Promise((resolve, reject) => {
            require('fs').createReadStream(filePath)
                .pipe(firebaseFile.createWriteStream(options))
                .on('finish', resolve)
                .on('error', reject);
        });

        // Get the public URL for the uploaded file
        const fileUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

        // Save file metadata to MongoDB
        const newFileMetadata = new FileMetadata({
            url: fileUrl,
        });

        const savedFileMetadata = await newFileMetadata.save();

        // Clean up temporary local file
        require('fs').unlinkSync(filePath);

        // Send response to the client with the metadata
        res.status(201).json({
            _id: savedFileMetadata._id,
            url: fileUrl,
        });
    } catch (err) {
        console.error('Error uploading file:', err);
        res.status(500).json({ msg: 'Server error while uploading file' });
    }
});

module.exports = router;
