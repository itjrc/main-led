const { BrowserWindow } = require('electron');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_LOGO_DIR = path.join('data', 'PARTNERS_LOGO');

// The partners page is a Vue app: its HTML ships template placeholders
// (`generateLogoUrl(partner)`), not the logo list. The real list lives in the
// script below, which the page loads and renders client-side.
const PARTNERS_PAGE_URL = 'https://itjr.ca/fr/tournoi/partenaires';
const PARTNERS_SCRIPT_FALLBACK = 'https://itjr.ca/themes/itjr/assets/js/partners.min.js';

// Logos dropped from the site are moved here rather than deleted, matching how
// mediaConverter archives the sources it converts.
const ARCHIVE_FOLDER = 'REMOVED';

// Records which files this sync downloaded, so a later run can tell a logo it
// owns from one the user dropped in by hand.
const MANIFEST_FILE = '.partners-manifest.json';

// OBS' slideshow source reads bmp/tga/png/jpeg/gif/psd/webp - never SVG.
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.tga', '.psd'];

// Site PNGs top out at 1024px on their long edge, so SVGs are rasterized to
// match instead of guessing a size of their own.
const SVG_LONG_EDGE = 1024;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OBS-Main-LED';

// Accept either an absolute path or one relative to the project root, so the
// directory field keeps working with its "data/PARTNERS_LOGO/" default.
function resolveDirectory(directory) {
    const value = (directory || DEFAULT_LOGO_DIR).trim();
    return path.resolve(PROJECT_ROOT, value);
}

function isImage(fileName) {
    return IMAGE_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}

// --- HTTP ------------------------------------------------------------------

// Download into memory, following redirects the way systemHandlers does for the
// dependency archives. Logos are a few dozen KB each, so nothing streams to disk.
function httpGet(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('http://') ? http : https;

        const request = client.get(url, { headers: { 'User-Agent': USER_AGENT } }, (response) => {
            const status = response.statusCode;

            if (status >= 300 && status < 400 && response.headers.location) {
                response.resume();
                if (redirectsLeft === 0) {
                    reject(new Error(`Too many redirects while fetching ${url}`));
                    return;
                }
                const nextUrl = new URL(response.headers.location, url).toString();
                httpGet(nextUrl, redirectsLeft - 1).then(resolve, reject);
                return;
            }

            if (status !== 200) {
                response.resume();
                reject(new Error(`HTTP ${status} for ${url}`));
                return;
            }

            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                buffer: Buffer.concat(chunks),
                contentType: response.headers['content-type'] || '',
                url
            }));
            response.on('error', reject);
        });

        request.on('error', reject);
        request.setTimeout(30000, () => {
            request.destroy(new Error(`Timed out fetching ${url}`));
        });
    });
}

// --- Partner list ----------------------------------------------------------

// The script is versioned with a cache-busting query (partners.min.js?v=2), so
// the page is read first to pick up whatever version is live today.
function findPartnersScript(html, pageUrl) {
    const pattern = /<script[^>]+src=["']([^"']*partners[^"']*\.js[^"']*)["']/i;
    const match = pattern.exec(html);
    if (!match) return null;
    return new URL(match[1], pageUrl).toString();
}

// Pull the partner objects out of the Vue data block. Reading the source of
// truth beats scraping the page: it carries the display order and the ratio,
// and it leaves out the dignitary headshots that sit in the same asset folder.
function parsePartners(script) {
    const baseMatch = /logoBasePath\s*:\s*["']([^"']+)["']/.exec(script);
    const logoBasePath = baseMatch ? baseMatch[1] : '/themes/itjr/assets/img/logos/partners';

    const partners = [];
    const objectPattern = /\{([^{}]*?logoPath\s*:[^{}]*?)\}/g;
    let match;

    while ((match = objectPattern.exec(script)) !== null) {
        const body = match[1];

        const read = (key) => {
            const found = new RegExp(`${key}\\s*:\\s*["']([^"']*)["']`).exec(body);
            return found ? found[1] : null;
        };

        const logoPath = read('logoPath');
        if (!logoPath) continue;

        // `logo: false` marks a partner shown as a name only
        if (/\blogo\s*:\s*false\b/.test(body)) continue;

        partners.push({
            name: read('name') || path.basename(logoPath, path.extname(logoPath)),
            url: read('url'),
            logoPath,
            ratio: read('logoRatio') || 'landscape',
            order: partners.length + 1
        });
    }

    return { logoBasePath, partners };
}

// Fetch the live partner list. Resolves to absolute logo URLs.
async function fetchPartnerList() {
    let scriptUrl = PARTNERS_SCRIPT_FALLBACK;

    try {
        const page = await httpGet(PARTNERS_PAGE_URL);
        const discovered = findPartnersScript(page.buffer.toString('utf8'), PARTNERS_PAGE_URL);
        if (discovered) {
            scriptUrl = discovered;
        }
    } catch (error) {
        // The page itself is only used to locate the script; a failure here is
        // survivable as long as the known URL still answers.
        console.log(`Could not read the partners page (${error.message}), using ${scriptUrl}`);
    }

    const script = await httpGet(scriptUrl);
    const { logoBasePath, partners } = parsePartners(script.buffer.toString('utf8'));

    if (!partners.length) {
        throw new Error('No partners found in the partners script - the site layout may have changed');
    }

    return partners.map(partner => ({
        ...partner,
        sourceUrl: new URL(`${logoBasePath}/${partner.logoPath}`, scriptUrl).toString(),
        fileName: targetFileName(partner.logoPath)
    }));
}

// Keep the site's own slug so file names stay stable between syncs, and force
// the extension OBS can actually read.
function targetFileName(logoPath) {
    const raw = path.basename(logoPath);
    const ext = path.extname(raw).toLowerCase();
    // The characters videoLibrary strips too: the ones Windows forbids, plus
    // the % that ffmpeg's image2 demuxer reads as a frame pattern. Hyphens are
    // kept, so the name stays the site's own slug and is stable between syncs.
    const base = path.basename(raw, path.extname(raw))
        .normalize('NFC')
        .replace(/[<>:"/\\|?*%\u0000-\u001F\u007F]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.]+|[\s.]+$/g, '');

    return `${base || 'logo'}${ext === '.svg' ? '.png' : ext}`;
}

// --- SVG rasterization -----------------------------------------------------

// SVGs from the site declare `width="100%"` or no size at all, so drawing them
// straight into a canvas would rasterize at Chromium's 300x150 default. The
// root tag is rewritten with pixel dimensions taken from the viewBox first.
function sizeSvg(svgText, longEdge) {
    const rootMatch = /<svg\b[^>]*>/i.exec(svgText);
    if (!rootMatch) {
        throw new Error('No <svg> root element');
    }

    const tag = rootMatch[0];
    const viewBox = /viewBox\s*=\s*["']\s*([-\d.eE]+)[,\s]+([-\d.eE]+)[,\s]+([-\d.eE]+)[,\s]+([-\d.eE]+)/i.exec(tag);
    const toPixels = (value) => {
        if (!value || /%\s*$/.test(value)) return null;
        const number = parseFloat(value);
        return Number.isFinite(number) && number > 0 ? number : null;
    };

    const widthAttr = /\swidth\s*=\s*["']([^"']+)["']/i.exec(tag);
    const heightAttr = /\sheight\s*=\s*["']([^"']+)["']/i.exec(tag);

    let width = widthAttr ? toPixels(widthAttr[1]) : null;
    let height = heightAttr ? toPixels(heightAttr[1]) : null;

    if ((!width || !height) && viewBox) {
        width = parseFloat(viewBox[3]);
        height = parseFloat(viewBox[4]);
    }

    if (!width || !height) {
        throw new Error('SVG declares neither usable dimensions nor a viewBox');
    }

    const scale = longEdge / Math.max(width, height);
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));

    let newTag = tag.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '');
    if (!/viewBox/i.test(newTag)) {
        newTag = newTag.replace(/^<svg/i, `<svg viewBox="0 0 ${width} ${height}"`);
    }
    newTag = newTag.replace(/^<svg/i, `<svg width="${outWidth}" height="${outHeight}"`);

    const sized = svgText.slice(0, rootMatch.index) + newTag + svgText.slice(rootMatch.index + tag.length);
    return { svg: sized, width: outWidth, height: outHeight };
}

let rasterWindow = null;
let rasterWindowReady = null;

// One hidden window is reused for the whole sync. It never paints - the canvas
// rasterizes in software - so it does not need to be shown. The pending promise
// is what gets cached, not the window: several download workers reach this at
// once, and handing them a window whose about:blank has not loaded yet would
// run their scripts against a document that does not exist.
function getRasterWindow() {
    if (rasterWindowReady && rasterWindow && !rasterWindow.isDestroyed()) {
        return rasterWindowReady;
    }

    rasterWindow = new BrowserWindow({
        show: false,
        width: 64,
        height: 64,
        webPreferences: { offscreen: false, nodeIntegration: false, contextIsolation: true }
    });

    const window = rasterWindow;
    rasterWindowReady = window.loadURL('about:blank').then(() => window);
    return rasterWindowReady;
}

function closeRasterWindow() {
    if (rasterWindow && !rasterWindow.isDestroyed()) {
        rasterWindow.destroy();
    }
    rasterWindow = null;
    rasterWindowReady = null;
}

// Rasterize an SVG to a transparent PNG buffer through Chromium. An image
// loaded from a data: URL carries no origin, so the canvas stays untainted and
// toDataURL() can be read back.
async function rasterizeSvg(svgBuffer) {
    const { svg, width, height } = sizeSvg(svgBuffer.toString('utf8'), SVG_LONG_EDGE);
    const window = await getRasterWindow();

    const dataUrl = await window.webContents.executeJavaScript(`(async () => {
        const svg = ${JSON.stringify(svg)};
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Chromium could not decode the SVG'));
            image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        });
        const canvas = document.createElement('canvas');
        canvas.width = ${width};
        canvas.height = ${height};
        canvas.getContext('2d').drawImage(image, 0, 0, ${width}, ${height});
        return canvas.toDataURL('image/png');
    })()`, true);

    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error('Rasterization returned no PNG data');
    }

    return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
}

// --- Manifest --------------------------------------------------------------

function readManifest(dir) {
    try {
        const raw = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.files === 'object' ? parsed : { files: {} };
    } catch (error) {
        return { files: {} };
    }
}

function writeManifest(dir, manifest) {
    try {
        fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
    } catch (error) {
        console.log(`Could not write the logo manifest: ${error.message}`);
    }
}

function hash(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
}

// Move a dropped logo into <folder>/REMOVED/, keeping both if a file of that
// name is already archived.
function archiveFile(dir, fileName) {
    const archiveDir = path.join(dir, ARCHIVE_FOLDER);
    fs.mkdirSync(archiveDir, { recursive: true });

    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);

    let target = path.join(archiveDir, fileName);
    let attempt = 2;
    while (fs.existsSync(target)) {
        target = path.join(archiveDir, `${base} (${attempt})${ext}`);
        attempt++;
    }

    fs.renameSync(path.join(dir, fileName), target);
    return target;
}

// --- Sync ------------------------------------------------------------------

// Download every partner logo into the folder, rasterizing the SVGs, and
// archive the ones the site no longer lists. Files this sync never downloaded
// are left untouched: they were added by hand and are not the site's to drop.
async function syncLogos(directory, { onProgress } = {}) {
    const dir = resolveDirectory(directory);
    const report = (message) => { if (onProgress) onProgress(message); };

    fs.mkdirSync(dir, { recursive: true });

    report('Reading the partner list from itjr.ca…');
    const partners = await fetchPartnerList();
    report(`${partners.length} partner logo(s) listed on the site`);

    const previous = readManifest(dir);
    const files = {};
    const downloaded = [];
    const updated = [];
    const unchanged = [];
    const failed = [];

    let done = 0;
    let cursor = 0;

    const processOne = async (partner) => {
        const targetPath = path.join(dir, partner.fileName);
        const known = previous.files[partner.fileName];

        try {
            const response = await httpGet(partner.sourceUrl);
            const sourceHash = hash(response.buffer);
            const isSvg = path.extname(partner.logoPath).toLowerCase() === '.svg';

            // The hash is of the file as the site serves it, so an unchanged SVG
            // never pays for a second rasterization.
            if (known && known.sourceHash === sourceHash && fs.existsSync(targetPath)) {
                unchanged.push(partner.fileName);
                files[partner.fileName] = { ...known, name: partner.name, order: partner.order, ratio: partner.ratio };
                return;
            }

            const output = isSvg ? await rasterizeSvg(response.buffer) : response.buffer;
            fs.writeFileSync(targetPath, output);

            (known ? updated : downloaded).push(partner.fileName);
            files[partner.fileName] = {
                name: partner.name,
                sourceUrl: partner.sourceUrl,
                sourceHash,
                ratio: partner.ratio,
                order: partner.order,
                rasterized: isSvg,
                bytes: output.length
            };
        } catch (error) {
            failed.push({ name: partner.name, file: partner.fileName, error: error.message });

            // Keep the previous good copy listed so a transient failure does not
            // make the file look like one the site dropped.
            if (known && fs.existsSync(targetPath)) {
                files[partner.fileName] = known;
            }
        } finally {
            done++;
            report(`Fetching logos (${done}/${partners.length})…`);
        }
    };

    // SVG rasterization shares one hidden window, so a small pool keeps the
    // downloads overlapping without racing on it.
    const workers = Array.from({ length: Math.min(6, partners.length) }, async () => {
        while (cursor < partners.length) {
            await processOne(partners[cursor++]);
        }
    });

    try {
        await Promise.all(workers);
    } finally {
        closeRasterWindow();
    }

    // Mirror the site: anything this sync used to own and the site no longer
    // lists gets archived.
    const removed = [];
    for (const fileName of Object.keys(previous.files)) {
        if (files[fileName]) continue;
        if (!fs.existsSync(path.join(dir, fileName))) continue;

        try {
            archiveFile(dir, fileName);
            removed.push(fileName);
        } catch (error) {
            failed.push({ name: fileName, file: fileName, error: `Could not archive: ${error.message}` });
            files[fileName] = previous.files[fileName];
        }
    }

    writeManifest(dir, {
        version: 1,
        syncedAt: new Date().toISOString(),
        source: PARTNERS_PAGE_URL,
        files
    });

    return {
        success: failed.length < partners.length,
        directory: dir,
        total: partners.length,
        downloaded,
        updated,
        unchanged,
        removed,
        failed
    };
}

// --- Stats -----------------------------------------------------------------

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

// Everything the UI shows about the logo folder
function getLogoStats(directory) {
    const dir = resolveDirectory(directory);

    if (!fs.existsSync(dir)) {
        return { exists: false, directory: dir, count: 0, fromSite: 0, local: 0, totalBytes: 0, totalBytesLabel: '0 B' };
    }

    const manifest = readManifest(dir);
    let count = 0;
    let fromSite = 0;
    let local = 0;
    let totalBytes = 0;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !isImage(entry.name)) continue;

        count++;
        if (manifest.files[entry.name]) fromSite++;
        else local++;

        try {
            totalBytes += fs.statSync(path.join(dir, entry.name)).size;
        } catch (error) {
            // vanished mid-scan
        }
    }

    return {
        exists: true,
        directory: dir,
        count,
        fromSite,
        local,
        totalBytes,
        totalBytesLabel: formatBytes(totalBytes),
        syncedAt: manifest.syncedAt || null,
        source: manifest.source || PARTNERS_PAGE_URL
    };
}

module.exports = {
    DEFAULT_LOGO_DIR,
    PARTNERS_PAGE_URL,
    ARCHIVE_FOLDER,
    MANIFEST_FILE,
    resolveDirectory,
    parsePartners,
    findPartnersScript,
    targetFileName,
    sizeSvg,
    fetchPartnerList,
    syncLogos,
    getLogoStats,
    formatBytes
};
