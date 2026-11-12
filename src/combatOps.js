// Gemeinsame Helfer fuer Initiative + Inventar. Keine DB-Zugriffe hier —
// die Routen/Socket-Handler laden das Dokument, rufen diese Helfer, speichern.

const CHAT_CAMPAIGN_SYSTEM = 'System';

// Sortiert Entries absteigend nach total (roll+bonus), bei Gleichstand:
// hoeherer Bonus gewinnt; bei weiterem Gleichstand entscheidet `order`
// (Reihenfolge des Wuerfelns). Entries ohne Wurf (roll=null) wandern ans
// Ende (stabil nach order).
function sortEntries(entries) {
    const dup = entries.slice();
    dup.sort((a, b) => {
        const aRolled = a.roll != null;
        const bRolled = b.roll != null;
        if (aRolled && !bRolled) return -1;
        if (!aRolled && bRolled) return 1;
        if (!aRolled && !bRolled) return (a.order || 0) - (b.order || 0);
        const at = (a.roll || 0) + (a.bonus || 0);
        const bt = (b.roll || 0) + (b.bonus || 0);
        if (bt !== at) return bt - at;
        if ((b.bonus || 0) !== (a.bonus || 0)) return (b.bonus || 0) - (a.bonus || 0);
        return (a.order || 0) - (b.order || 0);
    });
    return dup;
}

// Gibt die bereinigten Entries + neuen turnIndex zurueck.
// Behaelt den aktuellen "an der Reihe"-Entry (via id), damit die Markierung
// nicht springt, wenn ein Wurf nachgereicht wird.
function applySort(doc) {
    const prevId = doc.entries[doc.turnIndex]?.id || null;
    const sorted = sortEntries(doc.entries);
    doc.entries = sorted;
    if (prevId) {
        const idx = doc.entries.findIndex((e) => e.id === prevId);
        doc.turnIndex = idx >= 0 ? idx : 0;
    } else {
        doc.turnIndex = 0;
    }
}

function rollD20() {
    // crypto wuerde auch gehen, aber Math.random reicht fuer D&D-Zwecke.
    return 1 + Math.floor(Math.random() * 20);
}

function newEntryId() {
    return `ini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Sanitize einer GM-Patch-Update (korrigiere Wurf, Bonus, Name).
function sanitizeEntryPatch(patch) {
    const out = {};
    if (patch && typeof patch === 'object') {
        if (patch.name !== undefined && typeof patch.name === 'string') {
            const n = patch.name.trim();
            if (n.length > 0 && n.length <= 80) out.name = n;
        }
        if (patch.roll !== undefined) {
            if (patch.roll === null) out.roll = null;
            else {
                const r = Number(patch.roll);
                if (Number.isFinite(r) && r >= 1 && r <= 20) out.roll = Math.round(r);
            }
        }
        if (patch.bonus !== undefined) {
            const b = Number(patch.bonus);
            if (Number.isFinite(b) && b >= -10 && b <= 30) out.bonus = Math.round(b);
        }
    }
    return out;
}

// Items sanieren (String-Grenzen etc.).
function sanitizeItemInput(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > 120) return null;
    const qtyNum = Number(raw.qty);
    const qty = Number.isFinite(qtyNum) && qtyNum >= 1 && qtyNum <= 99999
        ? Math.round(qtyNum) : 1;
    const description = typeof raw.description === 'string'
        ? raw.description.slice(0, 2000) : '';
    return { name, qty, description };
}

function newItemId() {
    return `itm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

module.exports = {
    CHAT_CAMPAIGN_SYSTEM,
    sortEntries,
    applySort,
    rollD20,
    newEntryId,
    sanitizeEntryPatch,
    sanitizeItemInput,
    newItemId,
};
