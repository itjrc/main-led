const { app, ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const AdmZip = require('adm-zip');

const PROVIDER_DIR = path.join(__dirname, '..', 'provider');

// Relative marker used to detect a correctly laid out installation. Also used
// to locate the real payload inside archives that wrap everything in a folder.
const APP_MARKERS = {
    obs: path.join('bin', '64bit', 'obs64.exe'),
    ffmpeg: path.join('bin', 'ffmpeg.exe'),
    ffprobe: path.join('bin', 'ffprobe.exe')
};

// Written into provider/<app>/ at install time so the Setup tab can report a
// version without depending on files the app only creates at runtime.
const INSTALLED_VERSION_FILE = '.installed-version';

const DOWNLOAD_SOURCES = {
    obs: {
        url: 'https://github.com/obsproject/obs-studio/releases/download/30.2.3/OBS-Studio-30.2.3-Windows.zip',
        version: '30.2.3'
    },
    ffmpeg: {
        // Rolling release: the version is read back from ffmpeg -version
        url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    }
};

// ffprobe ships inside the ffmpeg archive, so both live in provider/ffmpeg
function providerDirFor(appName) {
    return path.join(PROVIDER_DIR, appName === 'ffprobe' ? 'ffmpeg' : appName);
}

function appExePath(appName) {
    const marker = APP_MARKERS[appName];
    return marker ? path.join(providerDirFor(appName), marker) : null;
}

// Download a file, following HTTP redirects. GitHub releases and gyan.dev both
// answer with a 302, which https.get does not follow on its own.
function downloadFile(url, destPath, onProgress, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('http://') ? http : https;

        const request = client.get(url, { headers: { 'User-Agent': 'obs-main-led' } }, (response) => {
            const { statusCode, headers } = response;

            // Follow redirects
            if (statusCode >= 300 && statusCode < 400 && headers.location) {
                response.resume(); // discard body
                if (redirectsLeft === 0) {
                    reject(new Error(`Too many redirects while downloading ${url}`));
                    return;
                }
                const nextUrl = new URL(headers.location, url).toString();
                downloadFile(nextUrl, destPath, onProgress, redirectsLeft - 1).then(resolve, reject);
                return;
            }

            if (statusCode !== 200) {
                response.resume();
                reject(new Error(`Server responded with HTTP ${statusCode} for ${url}`));
                return;
            }

            const totalBytes = parseInt(headers['content-length'], 10) || 0;
            let downloadedBytes = 0;
            let lastReportedPercent = -1;

            const file = fs.createWriteStream(destPath);

            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (totalBytes && onProgress) {
                    const percent = Math.floor((downloadedBytes / totalBytes) * 100);
                    if (percent !== lastReportedPercent) {
                        lastReportedPercent = percent;
                        onProgress(percent);
                    }
                }
            });

            response.pipe(file);

            file.on('finish', () => file.close((closeError) => {
                if (closeError) {
                    reject(closeError);
                } else if (totalBytes && downloadedBytes !== totalBytes) {
                    reject(new Error(`Incomplete download: got ${downloadedBytes} of ${totalBytes} bytes`));
                } else {
                    resolve();
                }
            }));

            file.on('error', (error) => {
                fs.unlink(destPath, () => {});
                reject(new Error(`Write failed: ${error.message}`));
            });
        });

        request.on('error', (error) => {
            fs.unlink(destPath, () => {});
            reject(new Error(`Request failed: ${error.message}`));
        });
    });
}

// Extract entry by entry so the UI can show progress, yielding to the event loop
// on every percent so the main process stays responsive. extractAllTo() would
// block for the whole archive (OBS ships several thousand files) with no feedback.
async function extractWithProgress(zip, extractPath, onProgress) {
    const entries = zip.getEntries();
    const total = entries.length;
    let extracted = 0;
    let lastReportedPercent = -1;

    for (const entry of entries) {
        if (entry.isDirectory) {
            fs.mkdirSync(path.join(extractPath, entry.entryName), { recursive: true });
        } else {
            zip.extractEntryTo(entry, extractPath, true, true);
        }

        extracted++;
        const percent = Math.floor((extracted / total) * 100);
        if (percent !== lastReportedPercent) {
            lastReportedPercent = percent;
            if (onProgress) {
                onProgress(percent);
            }
            await new Promise(resolve => setImmediate(resolve));
        }
    }
}

// Some archives (FFmpeg from gyan.dev) wrap their payload in a single top level
// folder such as 'ffmpeg-7.1-essentials_build'. Move that payload up one level
// so the expected marker path resolves.
function flattenExtractedArchive(extractPath, marker) {
    if (fs.existsSync(path.join(extractPath, marker))) {
        return; // already laid out correctly
    }

    const entries = fs.readdirSync(extractPath, { withFileTypes: true });
    const wrapper = entries.find(entry =>
        entry.isDirectory() && fs.existsSync(path.join(extractPath, entry.name, marker))
    );

    if (!wrapper) {
        return; // nothing we can do; the caller reports the missing marker
    }

    const wrapperPath = path.join(extractPath, wrapper.name);
    console.log(`Flattening archive wrapper folder: ${wrapper.name}`);

    for (const child of fs.readdirSync(wrapperPath)) {
        const source = path.join(wrapperPath, child);
        const destination = path.join(extractPath, child);
        if (fs.existsSync(destination)) {
            fs.rmSync(destination, { recursive: true, force: true });
        }
        fs.renameSync(source, destination);
    }

    fs.rmSync(wrapperPath, { recursive: true, force: true });
}

// Run an executable and capture its output. Unlike exec() this does not go
// through cmd.exe, and it never sets a cwd that may not exist - both of which
// surfaced as 'spawn C:\WINDOWS\system32\cmd.exe ENOENT'.
function runExecutable(exePath, args) {
    return new Promise((resolve) => {
        execFile(exePath, args, { windowsHide: true }, (error, stdout, stderr) => {
            if (error && !stdout && !stderr) {
                resolve({ error: error.message });
            } else {
                resolve({ output: stdout || stderr });
            }
        });
    });
}

// Read the version straight from our own package.json. app.getVersion() falls
// back to Electron's own version when it cannot resolve the app manifest, which
// silently displays 28.3.3 instead of failing.
function appVersion() {
    try {
        return require(path.join(__dirname, '..', 'package.json')).version;
    } catch (error) {
        console.log(`Could not read version from package.json: ${error.message}`);
        return app.getVersion();
    }
}

function setupSystemHandlers(mainWindow) {
    // Version and runtime info, shown in the header and useful in bug reports.
    ipcMain.handle('get-app-info', async () => ({
        version: appVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        platform: `${process.platform}-${process.arch}`,
        packaged: app.isPackaged
    }));

    const sendProgress = (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', payload);
        }
    };

    // Report the Node runtime the app actually runs on: the one embedded in
    // Electron. The app never shells out to `node`, so probing provider/node or
    // the system PATH only produced a false 'Not Found' on machines without a
    // standalone Node install - which then kept the LED Control tab disabled.
    ipcMain.handle('get-node-version', async () => ({
        version: `v${process.versions.node}`,
        bundled: true
    }));

    // Check if app exists
    ipcMain.handle('check-app-exists', async (event, appName) => {
        const exePath = appExePath(appName);
        return exePath ? fs.existsSync(exePath) : false;
    });

    // Get app version
    ipcMain.handle('get-app-version', async (event, appName) => {
        if (appName === 'obs') {
            if (!fs.existsSync(appExePath('obs'))) {
                return { error: 'Not found' };
            }

            // Version marker written by our own installer
            const versionMarker = path.join(PROVIDER_DIR, 'obs', INSTALLED_VERSION_FILE);
            if (fs.existsSync(versionMarker)) {
                const marked = fs.readFileSync(versionMarker, 'utf8').trim();
                if (marked) {
                    return { version: marked };
                }
            }

            // manifest.json only appears once OBS has run its updater at least
            // once, so it cannot be the sole source of truth on a fresh install.
            const manifestPath = path.join(PROVIDER_DIR, 'obs', 'config', 'obs-studio', 'updates', 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

                    // Extract version from notes field (format: "OBS Studio X.X.X")
                    if (manifest.notes) {
                        const match = manifest.notes.match(/OBS Studio (\d+\.\d+(?:\.\d+)?)/i);
                        if (match) {
                            return { version: match[1] };
                        }
                    }
                } catch (error) {
                    console.log(`Warning: could not parse OBS manifest: ${error.message}`);
                }
            }

            // obs64.exe is present, so OBS is usable even without a version string
            return { version: 'Unknown' };
        }

        if (appName === 'ffmpeg' || appName === 'ffprobe') {
            const exePath = appExePath(appName);

            // Guard before spawning: a missing executable used to fail with a
            // confusing 'spawn cmd.exe ENOENT' instead of a useful message.
            if (!fs.existsSync(exePath)) {
                return { error: 'Not found' };
            }

            const result = await runExecutable(exePath, ['-version']);
            if (result.error) {
                return { error: result.error };
            }

            // Extract version from output (format: "ffmpeg version N-120818-gf62d878911-20250822")
            const match = result.output.match(/version\s+(N-\d+-g[a-f0-9]+-\d+|\d+\.\d+(?:\.\d+)?)/i);
            return { version: match ? match[1] : 'Unknown' };
        }

        return { error: 'Unknown app' };
    });

    // Download app
    ipcMain.handle('download-app', async (event, appName) => {
        const source = DOWNLOAD_SOURCES[appName];
        if (!source) {
            return { success: false, error: 'Unknown app' };
        }

        const url = source.url;

        const tempPath = path.join(__dirname, '..', 'temp');
        const zipPath = path.join(tempPath, `${appName}.zip`);
        const extractPath = providerDirFor(appName);

        fs.mkdirSync(tempPath, { recursive: true });
        fs.mkdirSync(extractPath, { recursive: true });

        try {
            sendProgress({ app: appName, status: 'downloading', percent: 0 });

            await downloadFile(url, zipPath, (percent) => {
                sendProgress({ app: appName, status: 'downloading', percent });
            });

            sendProgress({ app: appName, status: 'extracting' });

            let zip;
            try {
                zip = new AdmZip(zipPath);
            } catch (error) {
                // A redirect page or an error page saved as .zip lands here
                const size = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
                throw new Error(`Downloaded file is not a valid zip archive (${size} bytes): ${error.message}`);
            }

            await extractWithProgress(zip, extractPath, (percent) => {
                sendProgress({ app: appName, status: 'extracting', percent });
            });

            flattenExtractedArchive(extractPath, APP_MARKERS[appName]);

            // Verify the install actually landed where the app expects it
            const exePath = appExePath(appName);
            if (!fs.existsSync(exePath)) {
                throw new Error(`Extraction completed but ${path.basename(exePath)} was not found in ${extractPath}`);
            }

            // Record the version we just installed. OBS only writes its own
            // manifest.json after running its updater, so without this marker a
            // fresh install would report no version and stay flagged as missing.
            if (source.version) {
                fs.writeFileSync(path.join(extractPath, INSTALLED_VERSION_FILE), source.version, 'utf8');
            }

            sendProgress({ app: appName, status: 'completed' });
            return { success: true };
        } catch (error) {
            sendProgress({ app: appName, status: 'failed' });
            return { success: false, error: error.message };
        } finally {
            if (fs.existsSync(zipPath)) {
                try {
                    fs.unlinkSync(zipPath);
                } catch (cleanupError) {
                    console.log(`Warning: could not delete ${zipPath}: ${cleanupError.message}`);
                }
            }
        }
    });

    // Open folder
    ipcMain.handle('open-folder', async (event, folderPath) => {
        try {
            const fullPath = path.join(__dirname, '..', folderPath);
            fs.mkdirSync(fullPath, { recursive: true });
            await shell.openPath(fullPath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    setupSystemHandlers
};
