// Fog-Bit-Maske + Operations.
//
// Die Maske ist eine 1-bit-pro-Zelle Bitmap, row-major, LSB-first:
//   bit at (col x, row y) = bytes[(y*w + x) >> 3] & (1 << ((y*w + x) & 7))
// 1 = abgedeckt (Nebel), 0 = aufgedeckt. Bei neuen Karten ist die Default-
// Erwartung "alles abgedeckt" (GM deckt bewusst auf). Sprich: beim ersten
// Anlegen setzen wir alle Bits auf 1.
//
// Ops, die ueber den Socket reinkommen (vom GM):
//   { kind: 'cover' | 'reveal', shape: 'rect', x, y, w, h }  (Feld-Koordinaten)
//   { kind: 'cover' | 'reveal', shape: 'circle', x, y, r }    (Feld-Koordinaten, Mittelpunkt)
//   { kind: 'cover' | 'reveal', shape: 'poly', points: [[x,y],...] } (ray casting)
//   { kind: 'all', covered: true|false }
//
// Jede Op wird serverseitig geclippt, Koordinaten gerundet und auf
// Floats finite geprueft; am Ende ist das Bitmap gueltig.

const MAX_DIM = 400;
const MAX_LIGHTS = 50;

function clamp(v, lo, hi) {
    v = Number(v);
    if (!Number.isFinite(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

function bytesNeeded(w, h) {
    return Math.ceil((w * h) / 8);
}

function emptyBits(w, h, covered) {
    const n = bytesNeeded(w, h);
    const buf = Buffer.alloc(n, covered ? 0xff : 0x00);
    if (covered && (w * h) % 8 !== 0) {
        // trailing bits in letzter Byte, die nicht zum Raster gehoeren: egal (Spec ignoriert sie).
    }
    return buf.toString('base64');
}

function toBuffer(bits, w, h) {
    const want = bytesNeeded(w, h);
    if (!bits || typeof bits !== 'string') return Buffer.alloc(want, 0xff);
    let buf;
    try {
        buf = Buffer.from(bits, 'base64');
    } catch {
        return Buffer.alloc(want, 0xff);
    }
    if (buf.length !== want) {
        const out = Buffer.alloc(want, 0xff);
        buf.copy(out, 0, 0, Math.min(buf.length, want));
        return out;
    }
    return buf;
}

function setBit(buf, w, x, y, value) {
    const idx = y * w + x;
    const byte = idx >> 3;
    const mask = 1 << (idx & 7);
    if (value) buf[byte] |= mask;
    else buf[byte] &= ~mask;
}

function applyRect(buf, w, h, op) {
    const x0 = clamp(Math.floor(op.x), 0, w);
    const y0 = clamp(Math.floor(op.y), 0, h);
    const x1 = clamp(Math.floor(op.x + op.w), 0, w);
    const y1 = clamp(Math.floor(op.y + op.h), 0, h);
    const v = op.kind === 'cover' ? 1 : 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            setBit(buf, w, x, y, v);
        }
    }
}

function applyCircle(buf, w, h, op) {
    const cx = Number(op.x);
    const cy = Number(op.y);
    const r = Math.max(0, Number(op.r));
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return;
    const v = op.kind === 'cover' ? 1 : 0;
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(w, Math.ceil(cx + r));
    const y1 = Math.min(h, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            // Zellen-Mitte
            const mx = x + 0.5;
            const my = y + 0.5;
            const dx = mx - cx;
            const dy = my - cy;
            if (dx * dx + dy * dy <= r2) setBit(buf, w, x, y, v);
        }
    }
}

// Point-in-Polygon (ray-casting, odd-fill).
function pointInPoly(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect =
            ((yi > py) !== (yj > py)) &&
            (px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function applyPoly(buf, w, h, op) {
    if (!Array.isArray(op.points) || op.points.length < 3) return;
    const poly = op.points
        .map((p) => (Array.isArray(p) && p.length === 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1])
            ? [+p[0], +p[1]] : null))
        .filter(Boolean);
    if (poly.length < 3) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(w, Math.ceil(maxX));
    const y1 = Math.min(h, Math.ceil(maxY));
    const v = op.kind === 'cover' ? 1 : 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            if (pointInPoly(x + 0.5, y + 0.5, poly)) setBit(buf, w, x, y, v);
        }
    }
}

// Haupteingangspunkt: Operationen auf einen MapLighting-Zustand anwenden.
// Veraendert doc in-place; liefert { changed, ops: angewandte Anzahl }.
function applyFogOps(doc, ops) {
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > 200) {
        return { changed: false, applied: 0 };
    }
    // Falls Dimensionen noch nicht gesetzt sind: aus erster Op herleiten geht
    // nicht sicher — der Client muss vorher einmal ensureFog(w,h) aufrufen.
    if (!doc.fogW || !doc.fogH) return { changed: false, applied: 0, msg: 'no fog dimensions' };
    const buf = toBuffer(doc.fogBits, doc.fogW, doc.fogH);
    let applied = 0;
    for (const raw of ops) {
        if (!raw || typeof raw !== 'object') continue;
        if (raw.shape === 'rect' && (raw.kind === 'cover' || raw.kind === 'reveal')) {
            applyRect(buf, doc.fogW, doc.fogH, raw);
            applied++;
        } else if (raw.shape === 'circle' && (raw.kind === 'cover' || raw.kind === 'reveal')) {
            applyCircle(buf, doc.fogW, doc.fogH, raw);
            applied++;
        } else if (raw.shape === 'poly' && (raw.kind === 'cover' || raw.kind === 'reveal')) {
            applyPoly(buf, doc.fogW, doc.fogH, raw);
            applied++;
        } else if (raw.kind === 'all') {
            const fill = raw.covered ? 0xff : 0x00;
            buf.fill(fill);
            applied++;
        }
    }
    if (applied === 0) return { changed: false, applied: 0 };
    doc.fogBits = buf.toString('base64');
    return { changed: true, applied };
}

// Fog-Dimensionen setzen/anpassen. Falls bestehende Daten vorhanden sind und
// die neue Dimension groesser ist, bleiben alte Bits erhalten (left-top); neue
// Felder werden mit "covered" gefuellt. Kleiner -> abschneiden.
function ensureFogDims(doc, w, h) {
    w = clamp(Math.round(w), 0, MAX_DIM);
    h = clamp(Math.round(h), 0, MAX_DIM);
    if (w <= 0 || h <= 0) return false;
    if (doc.fogW === w && doc.fogH === h && doc.fogBits && doc.fogBits.length > 0) return false;
    const oldW = doc.fogW || 0;
    const oldH = doc.fogH || 0;
    const oldBuf = oldW > 0 && oldH > 0 ? toBuffer(doc.fogBits, oldW, oldH) : null;
    const newBuf = Buffer.alloc(bytesNeeded(w, h), 0xff); // default: alles covered
    if (oldBuf) {
        const cw = Math.min(w, oldW);
        const ch = Math.min(h, oldH);
        for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
                const oldIdx = y * oldW + x;
                const oldBit = (oldBuf[oldIdx >> 3] >> (oldIdx & 7)) & 1;
                const newIdx = y * w + x;
                if (oldBit) newBuf[newIdx >> 3] |= (1 << (newIdx & 7));
                else newBuf[newIdx >> 3] &= ~(1 << (newIdx & 7));
            }
        }
    }
    doc.fogW = w;
    doc.fogH = h;
    doc.fogBits = newBuf.toString('base64');
    return true;
}

// Lichter sanitizen. Rueckgabe null => ungueltig.
function sanitizeLight(raw, currentCount) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = raw.kind === 'token' ? 'token' : 'static';
    const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64
        ? raw.id
        : `lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const bright = clamp(raw.bright, 0, 200);
    const dim = clamp(raw.dim, 0, 200);
    const color = typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)
        ? raw.color : '#ffcf80';
    const label = typeof raw.label === 'string' ? raw.label.slice(0, 64) : '';
    const enabled = raw.enabled === undefined ? true : !!raw.enabled;
    if (kind === 'token') {
        const tokenId = typeof raw.tokenId === 'string' && raw.tokenId.length > 0 && raw.tokenId.length <= 64
            ? raw.tokenId : null;
        if (!tokenId) return null;
        return { id, kind, tokenId, x: 0, y: 0, bright, dim, color, label, enabled };
    }
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { id, kind, tokenId: null, x, y, bright, dim, color, label, enabled };
}

// Deckkraft-Validator fuer Spieler-Overlays (0..1). Ungueltig -> null.
// Nutzt strict Number-Check: Strings, NaN, Infinity werden abgelehnt.
function clampOpacity(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n < 0) return 0;
    if (n > 1) return 1;
    // 2 Nachkommastellen reichen, damit Sliderspam nicht die DB aufblaeht.
    return Math.round(n * 100) / 100;
}

// Idempotente Migration der alten Fackel-Preset-Werte (20/20) auf die neue
// Fackel (5 ft total = 2.5 bright + 2.5 dim). Kriterium bewusst strikt:
// label beginnt mit "Fackel" UND bright===20 UND dim===20 (nur die alten Werte
// werden angefasst, individuelle 20/20-Lampen mit anderem Label bleiben).
// Rueckgabe: Anzahl geaenderter Lichter in doc.
function migrateFackelLight(light) {
    if (!light || typeof light !== 'object') return false;
    if (light.bright !== 20 || light.dim !== 20) return false;
    const lbl = typeof light.label === 'string' ? light.label : '';
    if (!/^Fackel\b/.test(lbl)) return false;
    light.bright = 2.5;
    light.dim = 2.5;
    return true;
}

function migrateFackelLightsInDoc(doc) {
    if (!doc || !Array.isArray(doc.lights)) return 0;
    let n = 0;
    for (const l of doc.lights) {
        if (migrateFackelLight(l)) n++;
    }
    return n;
}

// Laeuft einmal nach Mongo-Connect. Idempotent: nach dem Lauf matcht das
// Kriterium (bright=20, dim=20, label=/^Fackel/) auf diese Docs nicht mehr.
async function runFackelMigration(MapLightingModel) {
    try {
        const docs = await MapLightingModel.find({
            'lights.bright': 20, 'lights.dim': 20, 'lights.label': /^Fackel/,
        });
        let changed = 0;
        for (const d of docs) {
            const n = migrateFackelLightsInDoc(d);
            if (n > 0) {
                d.markModified('lights');
                await d.save();
                changed += n;
            }
        }
        if (changed > 0) {
            console.log(`[migration] Fackel 20/20 -> 2.5/2.5 bei ${changed} Lichtern aktualisiert.`);
        }
    } catch (e) {
        console.error('[migration] Fackel-Migration fehlgeschlagen:', e);
    }
}

module.exports = {
    MAX_DIM,
    MAX_LIGHTS,
    emptyBits,
    toBuffer,
    bytesNeeded,
    applyFogOps,
    ensureFogDims,
    sanitizeLight,
    clampOpacity,
    migrateFackelLight,
    migrateFackelLightsInDoc,
    runFackelMigration,
};
