const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_VIDEO_DIR = path.join('data', 'PARTNERS_VIDEOS');

// Formats that go straight into OBS
const PLAYABLE_EXTENSIONS = ['.mp4'];
// Formats mediaConverter.js turns into MP4
const CONVERTIBLE_VIDEO_EXTENSIONS = ['.mov', '.webm', '.mkv', '.avi', '.wmv'];
const CONVERTIBLE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

const FFPROBE_PATH = path.join(PROJECT_ROOT, 'provider', 'ffmpeg', 'bin', 'ffprobe.exe');

// Accept either an absolute path or one relative to the project root, so the
// directory field keeps working with its "data/PARTNERS_VIDEOS/" default.
function resolveDirectory(directory) {
    const value = (directory || DEFAULT_VIDEO_DIR).trim();
    return path.resolve(PROJECT_ROOT, value);
}

function classify(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (PLAYABLE_EXTENSIONS.includes(ext)) return 'playable';
    if (CONVERTIBLE_VIDEO_EXTENSIONS.includes(ext)) return 'video-to-convert';
    if (CONVERTIBLE_IMAGE_EXTENSIONS.includes(ext)) return 'image-to-convert';
    return 'ignored';
}

// File names arrive from downloads, USB sticks and macOS copies with characters
// that break the pipeline further down: decomposed accents (é stored as e + ◌́)
// that make visually identical names compare different, non-breaking spaces,
// curly quotes, a % sign that ffmpeg's image2 demuxer reads as a frame pattern
// and fails on, and characters Windows forbids when the folder sits on a
// network share. Returns the cleaned name; accents themselves are kept.
function sanitizeFileName(fileName) {
    const ext = path.extname(fileName);
    let base = path.basename(fileName, ext);

    base = base
        .normalize('NFC')
        .replace(/[‘’‚ʼ]/g, "'")
        .replace(/[“”„]/g, "'")
        .replace(/[<>:"/\\|?*%\u0000-\u001F\u007F]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.]+|[\s.]+$/g, '');

    if (!base) {
        base = 'media';
    }

    return base + ext.normalize('NFC').toLowerCase();
}

// Rename every media file in the directory to its sanitized name, on disk,
// before anything reads the folder - the cleaned name is what OBS displays and
// what the collection stores. A file OBS still holds open fails to rename; it
// is reported and retried at the next sync.
function sanitizeMediaFileNames(directory) {
    const dir = resolveDirectory(directory);
    const renamed = [];
    const failed = [];

    if (!fs.existsSync(dir)) {
        return { renamed, failed };
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || classify(entry.name) === 'ignored') continue;

        const clean = sanitizeFileName(entry.name);
        if (clean === entry.name) continue;

        const from = path.join(dir, entry.name);
        const cleanExt = path.extname(clean);
        const stem = path.basename(clean, cleanExt);
        let target = path.join(dir, clean);

        // NTFS resolves case-insensitively, so a case-only rename finds the
        // source itself: that is a rename onto the same file, not a collision.
        let attempt = 2;
        while (fs.existsSync(target) && target.toLowerCase() !== from.toLowerCase()) {
            target = path.join(dir, `${stem} (${attempt})${cleanExt}`);
            attempt++;
        }

        try {
            fs.renameSync(from, target);
            renamed.push({ from: entry.name, to: path.basename(target) });
        } catch (error) {
            failed.push({ name: entry.name, error: error.message });
        }
    }

    return { renamed, failed };
}

// List what the directory holds, without touching ffprobe
function scanDirectory(directory) {
    const dir = resolveDirectory(directory);

    if (!fs.existsSync(dir)) {
        return { exists: false, directory: dir, playable: [], pending: [], ignored: [] };
    }

    const result = { exists: true, directory: dir, playable: [], pending: [], ignored: [] };

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;

        const fullPath = path.join(dir, entry.name);
        let size = 0;
        try {
            size = fs.statSync(fullPath).size;
        } catch (error) {
            continue; // file vanished mid-scan
        }

        const file = { name: entry.name, path: fullPath, size };
        const kind = classify(entry.name);

        if (kind === 'playable') result.playable.push(file);
        else if (kind === 'ignored') result.ignored.push(file);
        else result.pending.push({ ...file, kind });
    }

    result.playable.sort((a, b) => a.name.localeCompare(b.name));
    result.pending.sort((a, b) => a.name.localeCompare(b.name));

    return result;
}

// Read a media file's duration in seconds. Resolves to null rather than
// rejecting: a probe failure must not sink the whole stats call.
function probeDuration(filePath) {
    return new Promise((resolve) => {
        if (!fs.existsSync(FFPROBE_PATH)) {
            resolve(null);
            return;
        }

        const args = [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ];

        execFile(FFPROBE_PATH, args, { windowsHide: true }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            const seconds = parseFloat(String(stdout).trim());
            resolve(Number.isFinite(seconds) ? seconds : null);
        });
    });
}

// Probe in small batches: 25 sequential ffprobe calls would take a few seconds.
async function probeAll(files, concurrency = 6) {
    const durations = new Array(files.length).fill(null);
    let cursor = 0;

    const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
        while (cursor < files.length) {
            const index = cursor++;
            durations[index] = await probeDuration(files[index].path);
        }
    });

    await Promise.all(workers);
    return durations;
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return minutes ? `${minutes} min ${String(remainder).padStart(2, '0')} s` : `${remainder} s`;
}

// Everything the UI shows about the media folder
async function getLibraryStats(directory, { probe = true } = {}) {
    const scan = scanDirectory(directory);

    if (!scan.exists) {
        return {
            exists: false,
            directory: scan.directory,
            playableCount: 0,
            pendingCount: 0,
            ignoredCount: 0
        };
    }

    const totalBytes = scan.playable.reduce((sum, file) => sum + file.size, 0);

    let totalDuration = null;
    let averageDuration = null;
    let unprobed = 0;
    let files = scan.playable.map(file => ({ name: file.name, size: file.size, duration: null }));

    if (probe && scan.playable.length) {
        const durations = await probeAll(scan.playable);
        const known = durations.filter(d => d !== null);
        unprobed = durations.length - known.length;

        if (known.length) {
            totalDuration = known.reduce((sum, d) => sum + d, 0);
            averageDuration = totalDuration / known.length;
        }

        files = scan.playable.map((file, index) => ({
            name: file.name,
            size: file.size,
            duration: durations[index]
        }));
    }

    return {
        exists: true,
        directory: scan.directory,
        playableCount: scan.playable.length,
        pendingCount: scan.pending.length,
        ignoredCount: scan.ignored.length,
        pending: scan.pending.map(f => ({ name: f.name, kind: f.kind })),
        totalBytes,
        totalBytesLabel: formatBytes(totalBytes),
        totalDuration,
        totalDurationLabel: formatDuration(totalDuration),
        averageDuration,
        averageDurationLabel: formatDuration(averageDuration),
        unprobed,
        files
    };
}

// --- Directory watcher -----------------------------------------------------

let watcher = null;
let watchedDirectory = null;
let debounceTimer = null;

// fs.watch fires several times for a single copy (create, then each write), so
// changes are coalesced before the caller is told anything happened.
function startWatching(directory, onChange, debounceMs = 2000) {
    stopWatching();

    const dir = resolveDirectory(directory);
    if (!fs.existsSync(dir)) {
        return { success: false, error: `Directory not found: ${dir}` };
    }

    try {
        watcher = fs.watch(dir, { persistent: false }, (eventType, fileName) => {
            if (fileName && classify(fileName) === 'ignored') {
                return; // .tmp, .txt and friends never reach OBS
            }

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                onChange({ directory: dir, eventType, fileName });
            }, debounceMs);
        });

        watcher.on('error', (error) => {
            console.log(`Directory watcher error: ${error.message}`);
            stopWatching();
        });

        watchedDirectory = dir;
        console.log(`Watching media directory: ${dir}`);
        return { success: true, directory: dir };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function stopWatching() {
    clearTimeout(debounceTimer);
    debounceTimer = null;

    if (watcher) {
        watcher.close();
        watcher = null;
        console.log(`Stopped watching ${watchedDirectory}`);
    }
    watchedDirectory = null;
}

function getWatchedDirectory() {
    return watchedDirectory;
}

module.exports = {
    DEFAULT_VIDEO_DIR,
    PLAYABLE_EXTENSIONS,
    resolveDirectory,
    sanitizeFileName,
    sanitizeMediaFileNames,
    scanDirectory,
    getLibraryStats,
    formatBytes,
    formatDuration,
    startWatching,
    stopWatching,
    getWatchedDirectory
};
