const express = require('express');
const multer = require('multer');
const { bucket } = require('../../firebaseAdmin');
const FileMetadata = require('../models/FileMetadata');

const router = express.Router();

// Set up multer for temporary storage
const upload = multer({ dest: 'uploads/' });

// File Upload Endpoint
router.post('/upload', upload.single('mp3'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ msg: 'No file uploaded' });
    }

    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ msg: 'Please provide a name for the file' });
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
            name: name, // Store the custom name provided by the user
        });

        const savedFileMetadata = await newFileMetadata.save();

        // Clean up temporary local file
        require('fs').unlinkSync(filePath);

        // Get the io instance from req.app
        const io = req.app.get('io');

        // Broadcast "updatedSoundboard" event to all clients
        io.emit('updatedSoundboard', {
            _id: savedFileMetadata._id,
            url: fileUrl,
            name: savedFileMetadata.name,
        });

        // Send response to the client with the metadata
        res.status(201).json({
            _id: savedFileMetadata._id,
            url: fileUrl,
            name: savedFileMetadata.name, // Include the name in the response
        });
    } catch (err) {
        console.error('Error uploading file:', err);
        res.status(500).json({ msg: 'Server error while uploading file' });
    }
});

// Route to get all file metadata entries
router.get('/all', async (req, res) => {
    try {
        const files = await FileMetadata.find();
        res.status(200).json(files);
    } catch (err) {
        console.error('Error fetching file metadata:', err);
        res.status(500).json({ msg: 'Server error while fetching file metadata' });
    }
});

module.exports = router;
