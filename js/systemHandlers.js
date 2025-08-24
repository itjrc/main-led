const { ipcMain, shell } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');

function setupSystemHandlers(mainWindow) {
    // Get Node.js version
    ipcMain.handle('get-node-version', async () => {
        return new Promise((resolve) => {
            exec('node --version', (error, stdout, stderr) => {
                if (error) {
                    resolve({ error: error.message });
                } else {
                    resolve({ version: stdout.trim() });
                }
            });
        });
    });

    // Check if app exists
    ipcMain.handle('check-app-exists', async (event, appName) => {
        const appPaths = {
            obs: path.join(__dirname, '..', 'provider', 'obs', 'bin', '64bit', 'obs64.exe'),
            ffmpeg: path.join(__dirname, '..', 'provider', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            ffprobe: path.join(__dirname, '..', 'provider', 'ffmpeg', 'bin', 'ffprobe.exe')
        };

        const appPath = appPaths[appName];
        return appPath ? fs.existsSync(appPath) : false;
    });

    // Get app version
    ipcMain.handle('get-app-version', async (event, appName) => {
        return new Promise((resolve) => {
            if (appName === 'obs') {
                // For OBS, read version from manifest.json file
                const manifestPath = path.join(__dirname, '..', 'provider', 'obs', 'config', 'obs-studio', 'updates', 'manifest.json');
                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifestData = fs.readFileSync(manifestPath, 'utf8');
                        const manifest = JSON.parse(manifestData);
                        
                        // Extract version from notes field (format: "OBS Studio X.X.X")
                        if (manifest.notes) {
                            const match = manifest.notes.match(/OBS Studio (\d+\.\d+(?:\.\d+)?)/i);
                            if (match) {
                                resolve({ version: match[1] });
                                return;
                            }
                        }
                        resolve({ version: 'Unknown' });
                    } catch (error) {
                        resolve({ error: `Failed to parse OBS manifest: ${error.message}` });
                    }
                } else {
                    resolve({ error: 'OBS manifest not found' });
                }
            } else if (appName === 'ffmpeg' || appName === 'ffprobe') {
                // For FFmpeg/FFprobe, use the -version command
                const exePath = path.join(__dirname, '..', 'provider', 'ffmpeg', 'bin', `${appName}.exe`);
                const command = `"${exePath}" -version`;

                exec(command, { cwd: path.dirname(exePath) }, (error, stdout, stderr) => {
                    if (error) {
                        resolve({ error: error.message });
                    } else {
                        // Extract version from output (format: "ffmpeg version N-120818-gf62d878911-20250822")
                        const output = stdout || stderr;
                        const match = output.match(/version\s+(N-\d+-g[a-f0-9]+-\d+|\d+\.\d+(?:\.\d+)?)/i);
                        if (match) {
                            resolve({ version: match[1] });
                        } else {
                            resolve({ version: 'Unknown' });
                        }
                    }
                });
            } else {
                resolve({ error: 'Unknown app' });
            }
        });
    });

    // Download app
    ipcMain.handle('download-app', async (event, appName) => {
        return new Promise((resolve) => {
            const downloadUrls = {
                obs: 'https://github.com/obsproject/obs-studio/releases/download/30.2.3/OBS-Studio-30.2.3-Windows.zip',
                ffmpeg: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
            };

            const url = downloadUrls[appName];
            if (!url) {
                resolve({ success: false, error: 'Unknown app' });
                return;
            }

            const tempPath = path.join(__dirname, '..', 'temp');
            const zipPath = path.join(tempPath, `${appName}.zip`);
            const extractPath = path.join(__dirname, '..', 'provider', appName);

            // Create temp directory
            if (!fs.existsSync(tempPath)) {
                fs.mkdirSync(tempPath, { recursive: true });
            }

            // Create extract directory
            if (!fs.existsSync(extractPath)) {
                fs.mkdirSync(extractPath, { recursive: true });
            }

            // Send progress update
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', {
                    app: appName,
                    status: 'downloading'
                });
            }

            // Download the file
            const file = fs.createWriteStream(zipPath);
            https.get(url, (response) => {
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    
                    // Send extraction progress
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('download-progress', {
                            app: appName,
                            status: 'extracting'
                        });
                    }

                    try {
                        // Extract the zip file
                        const zip = new AdmZip(zipPath);
                        zip.extractAllTo(extractPath, true);

                        // Send completion progress
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('download-progress', {
                                app: appName,
                                status: 'completed'
                            });
                        }

                        // Clean up temp file
                        fs.unlinkSync(zipPath);

                        resolve({ success: true });
                    } catch (extractError) {
                        resolve({ success: false, error: `Extraction failed: ${extractError.message}` });
                    }
                });

                file.on('error', (error) => {
                    fs.unlink(zipPath, () => {}); // Delete the file async
                    resolve({ success: false, error: `Download failed: ${error.message}` });
                });
            }).on('error', (error) => {
                resolve({ success: false, error: `Request failed: ${error.message}` });
            });
        });
    });

    // Open folder
    ipcMain.handle('open-folder', async (event, folderPath) => {
        try {
            const fullPath = path.join(__dirname, '..', folderPath);
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