const express = require('express');
const multer = require('multer');
const { bucket } = require('../../firebaseAdmin');
const FileMetadata = require('../models/FileMetadata');

const router = express.Router();

const upload = multer({ dest: 'uploads/' });

router.post('/upload', upload.single('mp3'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ msg: 'No file uploaded' });
    }

    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ msg: 'Please provide a name for the file' });
    }

    try {
        const filePath = req.file.path; // Path to temporarily stored file
        const fileName = `${Date.now()}-${req.file.originalname}`; // create unique name for the file

        const firebaseFile = bucket.file(fileName);
        const options = {
            metadata: {
                contentType: req.file.mimetype,
            },
            public: true,
        };

        await new Promise((resolve, reject) => {
            require('fs').createReadStream(filePath)
                .pipe(firebaseFile.createWriteStream(options))
                .on('finish', resolve)
                .on('error', reject);
        });

        const fileUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

        const newFileMetadata = new FileMetadata({
            url: fileUrl,
            name: name,
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

        res.status(201).json({
            _id: savedFileMetadata._id,
            url: fileUrl,
            name: savedFileMetadata.name,
        });
    } catch (err) {
        console.error('Error uploading file:', err);
        res.status(500).json({ msg: 'Server error while uploading file' });
    }
});
console.log(process.env.PRIVATE_KEY.length);
router.delete('/delete/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Find the file metadata by ID in MongoDB
        const fileMetadata = await FileMetadata.findById(id);
        if (!fileMetadata) {
            return res.status(404).json({ msg: 'File not found' });
        }

        // Extract the file name from the URL to delete from Firebase Storage
        const fileUrl = fileMetadata.url;
        const fileName = fileUrl.split('/').pop();

        // Delete the file from Firebase Storage
        const firebaseFile = bucket.file(fileName);
        await firebaseFile.delete();

        // Delete the file metadata entry from MongoDB
        await FileMetadata.findByIdAndDelete(id);

        // Broadcast "updatedSoundboard" event with deletion information
        const io = req.app.get('io');
        io.emit('updatedSoundboard', {
            _id: id,
            deleted: true, // This tells clients that the item was deleted
        });

        res.status(200).json({ msg: 'File deleted successfully' });
    } catch (err) {
        console.error('Error deleting file:', err);
        res.status(500).json({ msg: 'Server error while deleting file' });
    }
});

//get all file metadata entries
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
