const fs = require('fs');
const path = require('path');
const Map = require('./models/Map');

// Idempotenter Seed: legt beim Start genau EINE Beispiel-Karte an
// ("Beispiel: Dorf") — wenn sie schon existiert, passiert nichts.
// Die Karte ist read-only (isExample=true, owner=null). Clients duerfen sie
// als Kopie uebernehmen, aber nicht aendern.
const EXAMPLE_NAME = 'Beispiel: Dorf';

async function seedExampleMap() {
    try {
        const existing = await Map.findOne({ name: EXAMPLE_NAME, isExample: true });
        if (existing) return;
        const docPath = path.join(__dirname, 'data', 'exampleMap.json');
        const raw = fs.readFileSync(docPath, 'utf8');
        const doc = JSON.parse(raw);
        await Map.create({
            name: EXAMPLE_NAME,
            owner: null,
            doc,
            isExample: true,
        });
        console.log(`Seeded example map: ${EXAMPLE_NAME}`);
    } catch (err) {
        console.error('Could not seed example map:', err);
    }
}

module.exports = { seedExampleMap, EXAMPLE_NAME };
