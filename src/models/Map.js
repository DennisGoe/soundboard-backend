const mongoose = require('mongoose');

// Karten des D&D-Builders. Owner=null + isExample=true markiert eine
// read-only Beispiel-Karte, die jeder sieht und als Kopie uebernehmen kann.
const MapSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 80,
        },
        owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },
        // 3d        = sceneDoc des D&D-Builders (doc befuellt, imageUrl leer)
        // 2d-image  = hochgeladenes Bild (imageUrl befuellt, doc leer)
        // 2d-editor = im Browser gebaute Battlemap (doc im Editor-Format
        //             {width,height,floor[],walls[],objects[],labels[]}, siehe
        //             FE/src/mapEditor/engine.ts). Validierung in routes/maps.js.
        // Bestehende Dokumente ohne das Feld werden als 3d behandelt (Default).
        kind: {
            type: String,
            enum: ['3d', '2d-image', '2d-editor'],
            default: '3d',
            index: true,
        },
        // Nur fuer kind='2d-image': Firebase-Storage-URL.
        imageUrl: {
            type: String,
            default: null,
        },
        // Freiform sceneDoc (siehe FE bilder/src/editor/sceneDoc.js). Terrain
        // und Paint sind Base64-Strings, daher muss das JSON-Limit entsprechend
        // hoch sein (siehe index.js express.json({ limit }) fuer /api/maps).
        doc: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
            default: () => ({}),
        },
        isExample: {
            type: Boolean,
            default: false,
            index: true,
        },
        // Nur fuer kind='2d-image': Raster-Overlay (Feldgroesse in Bildpixeln,
        // Versatz, Sichtbarkeit, Farbe, Deckkraft). cellPx=null -> nichts gesetzt,
        // Client zeigt Schaetzwert und bittet GM ums Kalibrieren.
        grid: {
            cellPx: { type: Number, default: null },
            offsetX: { type: Number, default: 0 },
            offsetY: { type: Number, default: 0 },
            show: { type: Boolean, default: true },
            color: { type: String, default: '#000000' },
            opacity: { type: Number, default: 0.4, min: 0, max: 1 },
        },
    },
    { timestamps: true, minimize: false }
);

module.exports = mongoose.model('Map', MapSchema);
