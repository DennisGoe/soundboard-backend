// Gemeinsame Express-App-Konfiguration fuer Produktion (src/index.js) und
// Tests (test/maps.test.js). Zentralisiert die Middleware-Reihenfolge,
// damit Tests nicht an der Produktion vorbei ihr eigenes Setup aufbauen
// und dadurch Bugs wie den 413-Payload-Limit-Fehler verdecken.
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const favoritesRoutes = require('./routes/favorites');
const mapsRoutes = require('./routes/maps');
const campaignsRoutes = require('./routes/campaigns');

/**
 * Baut die Express-App inkl. Middleware + Routen.
 * @param {object} [opts]
 * @param {boolean} [opts.includeFileUploads=true] Firebase-abhaengige Route
 *   (/api/files) einhaengen. Tests setzen das auf false, damit beim Require
 *   von routes/fileUpload nicht firebaseAdmin.js initialisiert wird (braucht
 *   PRIVATE_KEY in env).
 */
function createApp({ includeFileUploads = true } = {}) {
    const app = express();
    app.use(cors());

    // /api/maps MUSS vor dem globalen json-Parser gemountet werden, damit das
    // 10-MB-Limit wirklich greift. Der globale express.json() unten hat das
    // Default-Limit von 100 kB und wuerde bei groesseren Maps 413 zurueckgeben
    // noch bevor die Maps-Middleware-Kette erreicht wird.
    app.use('/api/maps', express.json({ limit: '10mb' }), mapsRoutes);

    // Default-Parser fuer alle anderen Routen.
    app.use(express.json());

    app.use('/api/auth', authRoutes);
    if (includeFileUploads) {
        // Lazy require, weil routes/fileUpload beim Modulladen firebaseAdmin.js
        // initialisiert (braucht PRIVATE_KEY etc. in der env).
        const fileUploadRoutes = require('./routes/fileUpload');
        app.use('/api/files', fileUploadRoutes);
    }
    app.use('/api/favorites', favoritesRoutes);
    app.use('/api/campaigns', campaignsRoutes);

    return app;
}

module.exports = { createApp };
