const mongoose = require('mongoose');

// Nebel + Dunkelheit + Lichter pro (Campaign, Map).
//
// Fog-Maske:
//   w, h  : Feld-Dimensionen (Kacheln). Fuer 2d-editor kommt das direkt aus
//           dem Editor-Doc (width/height); fuer 2d-image bestimmt der GM via
//           Raster-Kalibrierung, wie viele Felder horizontal/vertikal rein-
//           passen (imgW/cellPx gerundet).
//   bits  : Base64-codierte Bit-Matrix (row-major, LSB-first). 1 = abgedeckt,
//           0 = aufgedeckt. Länge in Bytes = ceil(w*h / 8).
//
// Dunkelheit = ganze Karte ist von Haus aus schwarz. Dann sehen Spieler nur,
// was Lichter erhellen (GM sieht die Karte weiterhin abgedunkelt aber lesbar).
//
// Lichter:
//   kind='static' : statische Lichtquelle auf (x,y) in Feldkoordinaten.
//   kind='token'  : haengt am Token tokenId — Position wird LIVE vom FE aus
//                   dem Token-Zustand gelesen, nicht aus x/y hier.
//   bright/dim    : in FUSS (5 ft = 1 Feld; FE rechnet in Feldmass um).
//   color         : Farbton (fuer leichte Tönung).
//   enabled       : an/aus.
//   label         : freier Label (zB "Fackel", "Lagerfeuer").
const LightSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        kind: { type: String, enum: ['static', 'token'], required: true },
        tokenId: { type: String, default: null },
        x: { type: Number, default: 0 },
        y: { type: Number, default: 0 },
        bright: { type: Number, default: 20, min: 0, max: 200 },
        dim: { type: Number, default: 20, min: 0, max: 200 },
        color: { type: String, default: '#ffcf80' },
        label: { type: String, default: '' },
        enabled: { type: Boolean, default: true },
    },
    { _id: false }
);

const MapLightingSchema = new mongoose.Schema(
    {
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign',
            required: true,
            index: true,
        },
        mapId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Map',
            required: true,
            index: true,
        },
        fogW: { type: Number, default: 0, min: 0, max: 400 },
        fogH: { type: Number, default: 0, min: 0, max: 400 },
        fogBits: { type: String, default: '' }, // Base64
        darkness: { type: Boolean, default: false },
        // Deckkraft fuer die Spieler-Sicht (0..1).
        //   darknessOpacity: wie schwarz ist Dunkelheit fuer Spieler (1 = komplett schwarz,
        //                    0 = gar nicht). Default 1 = vorher-Verhalten.
        //   fogOpacity:      wie dicht ist der Nebel fuer Spieler. Default 1 = voll deckend.
        // GM hat weiterhin eigene (nur-visuelle) Slider gmDarkAlpha/gmFogAlpha im FE.
        darknessOpacity: { type: Number, default: 1, min: 0, max: 1 },
        fogOpacity: { type: Number, default: 1, min: 0, max: 1 },
        lights: { type: [LightSchema], default: [] },
    },
    { timestamps: true }
);

MapLightingSchema.index({ campaignId: 1, mapId: 1 }, { unique: true });

module.exports = mongoose.model('MapLighting', MapLightingSchema);
