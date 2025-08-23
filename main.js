const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const https = require('https');
const AdmZip = require('adm-zip');
const OBSWebSocket = require('obs-websocket-js').default;

let mainWindow;
let obs = null;
let automationInterval = null;
let obsProcess = null;

// Convert PNG/JPG images to MP4 videos
async function convertImageToVideo(imagePath) {
    return new Promise((resolve, reject) => {
        const ext = path.extname(imagePath).toLowerCase();
        if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
            resolve({ success: false, error: 'Not a PNG/JPG file' });
            return;
        }

        const outputPath = imagePath.replace(ext, '.mp4');
        const ffmpegPath = path.join(__dirname, 'provider', 'ffmpeg', 'bin', 'ffmpeg.exe');
        
        if (!fs.existsSync(ffmpegPath)) {
            reject(new Error('FFmpeg not found. Please ensure FFmpeg is installed.'));
            return;
        }

        const args = [
            '-y',
            '-f', 'lavfi',
            '-i', 'color=c=black:s=1920x1080:d=5',
            '-i', imagePath,
            '-filter_complex', '[1:v]scale=1720:-1[fg];[0:v][fg]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            outputPath
        ];

        console.log(`FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

        const ffmpegProcess = spawn(ffmpegPath, args);
        let ffmpegOutput = '';
        let ffmpegError = '';

        ffmpegProcess.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`FFmpeg stdout: ${output.trim()}`);
            ffmpegOutput += output;
        });

        ffmpegProcess.stderr.on('data', (data) => {
            const output = data.toString();
            console.log(`FFmpeg stderr: ${output.trim()}`);
            ffmpegError += output;
        });

        ffmpegProcess.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`FFmpeg process exited with code ${code}. Error: ${ffmpegError}`));
                return;
            }

            // Delete original image file after successful conversion
            try {
                fs.unlinkSync(imagePath);
                resolve({ success: true, outputPath, message: `Converted ${path.basename(imagePath)} to ${path.basename(outputPath)} and deleted original` });
            } catch (deleteError) {
                resolve({ success: true, outputPath, message: `Converted ${path.basename(imagePath)} to ${path.basename(outputPath)} but failed to delete original: ${deleteError.message}` });
            }
        });

        ffmpegProcess.on('error', (error) => {
            reject(error);
        });
    });
}

// Convert all PNG/JPG files in PARTNERS_VIDEOS directory
async function convertAllImagesInPartnersVideos() {
    const partnersVideosPath = path.join(__dirname, 'data', 'PARTNERS_VIDEOS');
    
    if (!fs.existsSync(partnersVideosPath)) {
        return { success: false, error: 'PARTNERS_VIDEOS directory not found' };
    }

    const files = fs.readdirSync(partnersVideosPath);
    const imageFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.png', '.jpg', '.jpeg'].includes(ext);
    });

    if (imageFiles.length === 0) {
        return { success: true, message: 'No PNG/JPG files found to convert' };
    }

    const results = [];
    for (const imageFile of imageFiles) {
        const imagePath = path.join(partnersVideosPath, imageFile);
        try {
            const result = await convertImageToVideo(imagePath);
            results.push({ file: imageFile, ...result });
        } catch (error) {
            results.push({ file: imageFile, success: false, error: error.message });
        }
    }

    return { success: true, results };
}

// Convert non-MP4 videos to MP4
async function convertVideoToMp4(videoPath) {
    return new Promise((resolve, reject) => {
        const ext = path.extname(videoPath).toLowerCase();
        const supportedFormats = ['.mov', '.webm', '.mkv', '.avi', '.wmv'];
        
        if (!supportedFormats.includes(ext)) {
            resolve({ success: false, error: 'Not a supported video format for conversion' });
            return;
        }

        const pathWithoutExt = videoPath.substring(0, videoPath.lastIndexOf('.'));
        const outputPath = pathWithoutExt + '.mp4';
        const ffmpegPath = path.join(__dirname, 'provider', 'ffmpeg', 'bin', 'ffmpeg.exe');
        
        if (!fs.existsSync(ffmpegPath)) {
            reject(new Error('FFmpeg not found. Please ensure FFmpeg is installed.'));
            return;
        }

        // Check if output already exists to avoid conflicts
        if (fs.existsSync(outputPath)) {
            // If both files exist, we need to decide what to do
            try {
                const originalStat = fs.statSync(videoPath);
                const convertedStat = fs.statSync(outputPath);
                
                if (convertedStat.mtime > originalStat.mtime) {
                    // MP4 is newer, just delete the original
                    fs.unlinkSync(videoPath);
                    resolve({ success: true, outputPath, message: `Removed older ${path.basename(videoPath)}, kept existing ${path.basename(outputPath)}` });
                    return;
                }
            } catch (error) {
                // Continue with conversion if we can't compare dates
            }
        }

        const args = [
            '-y',
            '-i', videoPath,
            '-c:v', 'libx264',
            '-profile:v', 'baseline',
            '-level', '4.0',
            '-b:v', '4915k',
            '-r', '30',
            '-g', '30',
            '-refs', '1',
            '-pix_fmt', 'yuv420p',
            '-brand', 'mp42',
            '-an',
            outputPath
        ];

        console.log(`FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

        const ffmpegProcess = spawn(ffmpegPath, args);
        let ffmpegOutput = '';
        let ffmpegError = '';

        ffmpegProcess.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`FFmpeg stdout: ${output.trim()}`);
            ffmpegOutput += output;
        });

        ffmpegProcess.stderr.on('data', (data) => {
            const output = data.toString();
            console.log(`FFmpeg stderr: ${output.trim()}`);
            ffmpegError += output;
        });

        ffmpegProcess.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`FFmpeg process exited with code ${code}. Error: ${ffmpegError}`));
                return;
            }

            // Delete original video file after successful conversion
            try {
                fs.unlinkSync(videoPath);
                resolve({ success: true, outputPath, message: `Converted ${path.basename(videoPath)} to ${path.basename(outputPath)} and deleted original` });
            } catch (deleteError) {
                resolve({ success: true, outputPath, message: `Converted ${path.basename(videoPath)} to ${path.basename(outputPath)} but failed to delete original: ${deleteError.message}` });
            }
        });

        ffmpegProcess.on('error', (error) => {
            reject(error);
        });
    });
}

// Convert all non-MP4 videos in PARTNERS_VIDEOS directory
async function convertAllVideosInPartnersVideos() {
    const partnersVideosPath = path.join(__dirname, 'data', 'PARTNERS_VIDEOS');
    
    if (!fs.existsSync(partnersVideosPath)) {
        return { success: false, error: 'PARTNERS_VIDEOS directory not found' };
    }

    const files = fs.readdirSync(partnersVideosPath);
    const videoFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.mov', '.webm', '.mkv', '.avi', '.wmv'].includes(ext);
    });

    if (videoFiles.length === 0) {
        return { success: true, message: 'No non-MP4 video files found to convert' };
    }

    const results = [];
    for (const videoFile of videoFiles) {
        const videoPath = path.join(partnersVideosPath, videoFile);
        try {
            const result = await convertVideoToMp4(videoPath);
            results.push({ file: videoFile, ...result });
        } catch (error) {
            results.push({ file: videoFile, success: false, error: error.message });
        }
    }

    return { success: true, results };
}

// Enable fullscreen projection on second monitor
async function enableFullscreenProjection() {
    try {
        if (!obs || !obs.identified) {
            console.log('OBS not connected, skipping fullscreen projection setup');
            return;
        }
        
        // Get available monitors
        const monitorsResponse = await obs.call('GetMonitorList');
        console.log('Available monitors:', monitorsResponse.monitors);
        
        // Check if we have at least 2 monitors
        if (!monitorsResponse.monitors || monitorsResponse.monitors.length < 2) {
            console.log('Second monitor not found, skipping fullscreen projection');
            return;
        }
        
        // Get the second monitor (index 1)
        const secondMonitor = monitorsResponse.monitors[1];
        console.log('Setting up fullscreen projection on second monitor:', secondMonitor.monitorName);
        
        // Open fullscreen projector on second monitor
        await obs.call('OpenVideoMixProjector', {
            videoMixType: 'OBS_WEBSOCKET_VIDEO_MIX_TYPE_PROGRAM',
            monitorIndex: 1,  // Second monitor (0-indexed)
            projectorGeometry: null  // Fullscreen
        });
        
        console.log('Fullscreen projection enabled successfully on second monitor');
        
    } catch (error) {
        console.log(`Error enabling fullscreen projection: ${error.message}`);
        // Don't throw error, just log it so OBS connection doesn't fail
    }
}

// Update OBS scene collection with dynamic paths based on current project directory
function updateSceneCollectionPaths() {
    try {
        const sceneCollectionPath = path.join(__dirname, 'data', 'obs-scene-collection.json');
        
        if (!fs.existsSync(sceneCollectionPath)) {
            console.log('Scene collection file not found, skipping path updates');
            return;
        }

        // Read the current scene collection
        let sceneCollection = fs.readFileSync(sceneCollectionPath, 'utf8');
        
        // Current project directory paths
        const currentProjectDir = __dirname.replace(/\\/g, '/');
        const partnersLogoPath = `${currentProjectDir}/data/PARTNERS_LOGO`;
        const partnersVideosPath = `${currentProjectDir}/data/PARTNERS_VIDEOS`;
        const itjrImagePath = `${currentProjectDir}/data/itjr.jpg`;
        
        // Replace all hardcoded paths with current project paths
        sceneCollection = sceneCollection.replace(
            /"file":\s*"[^"]*\/data\/itjr\.jpg"/g,
            `"file": "${itjrImagePath}"`
        );
        
        // Update Partners Logo slideshow path
        sceneCollection = sceneCollection.replace(
            /"value":\s*"[^"]*(?:Partners?\s*Logos?|PARTNERS_LOGO)"/gi,
            `"value": "${partnersLogoPath}"`
        );
        
        // Update all video file paths in PARTNERS_VIDEOS
        sceneCollection = sceneCollection.replace(
            /"local_file":\s*"[^"]*\/data\/PARTNERS_VIDEOS\/([^"]+)"/g,
            `"local_file": "${partnersVideosPath}/$1"`
        );
        
        // Write the updated scene collection back
        fs.writeFileSync(sceneCollectionPath, sceneCollection, 'utf8');
        console.log('Scene collection updated successfully with current project paths');
        
    } catch (error) {
        console.log(`Error updating scene collection: ${error.message}`);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'assets', 'icon.ico')
    });

    mainWindow.loadFile('index.html');
    
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
}

const crypto = require('crypto');

function updateSceneCollection() {
    const sceneCollectionPath = path.join(__dirname, 'data', 'obs-scene-collection.json');
    const videosPath = path.join(__dirname, 'data', 'PARTNERS_VIDEOS');

    if (!fs.existsSync(sceneCollectionPath)) {
        console.log('Scene collection not found, skipping update.');
        return;
    }

    try {
        const config = JSON.parse(fs.readFileSync(sceneCollectionPath, 'utf-8'));
        const loopIndScene = config.sources.find(s => s.name === 'LOOP_IND');

        if (!loopIndScene) {
            console.log('LOOP_IND scene not found, skipping update.');
            return;
        }

        const sourceUuidsToRemove = new Set(loopIndScene.settings.items.map(item => item.source_uuid));
        loopIndScene.settings.items = [];
        config.sources = config.sources.filter(s => !sourceUuidsToRemove.has(s.uuid));

        const videoFiles = fs.readdirSync(videosPath).filter(f => f.endsWith('.mp4') || f.endsWith('.mov'));

        videoFiles.forEach((videoFile, index) => {
            const sourceUuid = crypto.randomUUID();
            const videoPath = path.join(videosPath, videoFile).replace(/\\/g, '/');

            const newSource = {
                prev_ver: 520159234,
                name: videoFile,
                uuid: sourceUuid,
                id: 'ffmpeg_source',
                versioned_id: 'ffmpeg_source',
                settings: { local_file: videoPath },
                mixers: 255,
                sync: 0,
                flags: 0,
                volume: 1.0,
                balance: 0.5,
                enabled: true,
                muted: false,
                'push-to-mute': false,
                'push-to-mute-delay': 0,
                'push-to-talk': false,
                'push-to-talk-delay': 0,
                hotkeys: {},
                deinterlace_mode: 0,
                deinterlace_field_order: 0,
                monitoring_type: 0,
                private_settings: {}
            };
            config.sources.push(newSource);

            const newSceneItem = {
                name: videoFile,
                source_uuid: sourceUuid,
                visible: false,
                locked: false,
                rot: 0.0,
                align: 5,
                bounds_type: 2,
                bounds_align: 0,
                bounds_crop: false,
                crop_left: 0,
                crop_top: 0,
                crop_right: 0,
                crop_bottom: 0,
                id: index + 2,
                group_item_backup: false,
                pos: { x: 0.0, y: 0.0 },
                scale: { x: 1.0, y: 1.0 },
                bounds: { x: 1920.0, y: 1080.0 },
                scale_filter: 'disable',
                blend_method: 'default',
                blend_type: 'normal',
                show_transition: { duration: 0 },
                hide_transition: { duration: 0 },
                private_settings: {}
            };
            loopIndScene.settings.items.push(newSceneItem);
        });

        fs.writeFileSync(sceneCollectionPath, JSON.stringify(config, null, 4), 'utf-8');
        console.log('Scene collection updated successfully.');
    } catch (error) {
        console.error('Error updating scene collection:', error);
    }
}

app.whenReady().then(() => {
    updateSceneCollection();
    updateSceneCollectionPaths();
    createWindow();
});

app.on('window-all-closed', () => {
    // Clean up OBS process when closing the app
    cleanupOBS();
    
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    // Also clean up when the app is about to quit
    cleanupOBS();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Function to clean up OBS process and connections
function cleanupOBS() {
    // Disconnect WebSocket
    if (obs && obs.identified) {
        try {
            obs.disconnect();
            console.log('Disconnected OBS WebSocket');
        } catch (error) {
            console.error('Error disconnecting OBS WebSocket:', error);
        }
    }
    
    // Stop automation
    if (automationInterval) {
        clearInterval(automationInterval);
        automationInterval = null;
        console.log('Stopped automation interval');
    }
    
    // Kill OBS process if it's running
    if (obsProcess && !obsProcess.killed) {
        try {
            obsProcess.kill();
            console.log('Terminated OBS process');
        } catch (error) {
            console.error('Error terminating OBS process:', error);
            // Try force kill on Windows
            if (process.platform === 'win32') {
                try {
                    exec('taskkill /f /im obs64.exe', (error) => {
                        if (error) {
                            console.error('Error force killing OBS:', error);
                        } else {
                            console.log('Force killed OBS process');
                        }
                    });
                } catch (forceKillError) {
                    console.error('Error with force kill command:', forceKillError);
                }
            }
        }
        obsProcess = null;
    }
}

ipcMain.handle('get-node-version', async () => {
    return new Promise((resolve) => {
        const nodePath = path.join(__dirname, 'provider', 'node', 'node.exe');
        if (fs.existsSync(nodePath)) {
            exec(`"${nodePath}" --version`, (error, stdout) => {
                if (error) {
                    resolve({ version: null, error: error.message });
                } else {
                    resolve({ version: stdout.trim(), error: null });
                }
            });
        } else {
            resolve({ version: null, error: 'Node.js not found' });
        }
    });
});

ipcMain.handle('check-app-exists', async (event, appName) => {
    let checkPath;
    
    switch (appName) {
        case 'ffprobe':
            checkPath = path.join(__dirname, 'provider', 'ffmpeg', 'bin', 'ffprobe.exe');
            break;
        default:
            checkPath = path.join(__dirname, 'provider', appName);
            break;
    }
    
    return fs.existsSync(checkPath);
});

ipcMain.handle('get-app-version', async (event, appName) => {
    return new Promise((resolve) => {
        let exePath, versionArg;
        
        switch (appName) {
            case 'obs':
                exePath = path.join(__dirname, 'provider', 'obs', 'bin', '64bit', 'obs64.exe');
                versionArg = '--version';
                break;
            case 'ffmpeg':
                exePath = path.join(__dirname, 'provider', 'ffmpeg', 'bin', 'ffmpeg.exe');
                versionArg = '-version';
                break;
            case 'ffprobe':
                exePath = path.join(__dirname, 'provider', 'ffmpeg', 'bin', 'ffprobe.exe');
                versionArg = '-version';
                break;
            default:
                resolve({ version: null, error: 'Unknown application' });
                return;
        }

        if (fs.existsSync(exePath)) {
            exec(`"${exePath}" ${versionArg}`, { timeout: 5000 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ version: null, error: error.message });
                } else {
                    const output = stdout || stderr;
                    let version = 'Unknown';
                    
                    if (appName === 'obs') {
                        const match = output.match(/OBS Studio (\d+\.\d+\.\d+)/);
                        version = match ? match[1] : 'Unknown';
                    } else if (appName === 'ffmpeg' || appName === 'ffprobe') {
                        const match = output.match(/version (\d+\.\d+\.\d+)/);
                        version = match ? match[1] : 'Unknown';
                    }
                    
                    resolve({ version, error: null });
                }
            });
        } else {
            resolve({ version: null, error: `${appName} not found` });
        }
    });
});

ipcMain.handle('download-app', async (event, appName) => {
    return new Promise(async (resolve) => {
        try {
            const providerDir = path.join(__dirname, 'provider');
            if (!fs.existsSync(providerDir)) {
                fs.mkdirSync(providerDir, { recursive: true });
            }

            let downloadUrl, fileName, extractPath;
            
            switch (appName) {
                case 'obs':
                    downloadUrl = 'https://cdn-fastly.obsproject.com/downloads/OBS-Studio-31.1.2-Windows-x64.zip';
                    fileName = 'obs-studio.zip';
                    extractPath = path.join(providerDir, 'obs');
                    break;
                case 'ffmpeg':
                    downloadUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
                    fileName = 'ffmpeg.zip';
                    extractPath = path.join(providerDir, 'ffmpeg');
                    break;
                default:
                    resolve({ success: false, error: 'Unknown application' });
                    return;
            }

            const zipPath = path.join(__dirname, fileName);
            
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', { app: appName, status: 'downloading' });
            }
            
            const downloadFile = (url, attempt = 1) => {
                const file = fs.createWriteStream(zipPath);
                const request = https.get(url, (response) => {
                    // Handle redirects
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        if (attempt > 5) {
                            resolve({ success: false, error: 'Too many redirects' });
                            return;
                        }
                        file.close();
                        fs.unlink(zipPath, () => {}); // Clean up partial file
                        downloadFile(response.headers.location, attempt + 1);
                        return;
                    }
                    
                    // Check if response is successful
                    if (response.statusCode !== 200) {
                        resolve({ success: false, error: `Download failed: HTTP ${response.statusCode}` });
                        return;
                    }
                    
                    response.pipe(file);
                    
                    file.on('finish', () => {
                    file.close();
                    
                    // Verify file exists and has content
                    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
                        resolve({ success: false, error: 'Downloaded file is empty or missing' });
                        return;
                    }
                    
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('download-progress', { app: appName, status: 'extracting' });
                    }
                    
                    try {
                        // Validate ZIP file before extracting
                        const zip = new AdmZip(zipPath);
                        const entries = zip.getEntries();
                        
                        if (entries.length === 0) {
                            throw new Error('ZIP file appears to be empty or corrupted');
                        }
                        
                        if (fs.existsSync(extractPath)) {
                            fs.rmSync(extractPath, { recursive: true, force: true });
                        }
                        
                        zip.extractAllTo(extractPath, true);
                        
                        if (appName === 'ffmpeg') {
                            const extractedFolders = fs.readdirSync(extractPath);
                            const ffmpegFolder = extractedFolders.find(folder => folder.startsWith('ffmpeg-'));
                            if (ffmpegFolder) {
                                const sourcePath = path.join(extractPath, ffmpegFolder);
                                const files = fs.readdirSync(sourcePath);
                                files.forEach(file => {
                                    fs.renameSync(path.join(sourcePath, file), path.join(extractPath, file));
                                });
                                fs.rmSync(sourcePath, { recursive: true, force: true });
                            }
                        }
                        
                        fs.unlinkSync(zipPath);
                        
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('download-progress', { app: appName, status: 'completed' });
                        }
                        resolve({ success: true, error: null });
                    } catch (extractError) {
                        // Clean up failed download
                        try {
                            if (fs.existsSync(zipPath)) {
                                fs.unlinkSync(zipPath);
                            }
                        } catch (cleanupError) {
                            // Ignore cleanup errors
                        }
                        resolve({ success: false, error: `ZIP extraction failed: ${extractError.message}` });
                    }
                });
            });

                request.on('error', (error) => {
                    resolve({ success: false, error: error.message });
                });
            };
            
            downloadFile(downloadUrl);
            
        } catch (error) {
            resolve({ success: false, error: error.message });
        }
    });
});

ipcMain.handle('open-folder', async (event, folderPath) => {
    const { shell } = require('electron');
    const fullPath = path.join(__dirname, folderPath);
    if (fs.existsSync(fullPath)) {
        shell.openPath(fullPath);
    }
});

// Remove the separate LED Management window handler since it's now integrated
// The functionality is now handled through the main window tabs

// OBS WebSocket handlers
ipcMain.handle('obs-connect', async (event, address, password) => {
    try {
        if (!obs) {
            obs = new OBSWebSocket();
            
            obs.on('ConnectionClosed', () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'connection-closed'
                    });
                }
            });

            obs.on('CurrentProgramSceneChanged', (data) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'scene-changed',
                        sceneName: data.sceneName
                    });
                }
            });
        }

        await obs.connect(address, password);
        
        // Automatically enable fullscreen projection on second monitor after connection
        await enableFullscreenProjection();
        
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('obs-disconnect', async () => {
    try {
        if (obs && obs.identified) {
            await obs.disconnect();
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('obs-get-scenes', async () => {
    try {
        const sceneList = await obs.call('GetSceneList');
        const currentScene = await obs.call('GetCurrentProgramScene');
        
        return {
            success: true,
            scenes: sceneList.scenes,
            currentScene: currentScene.currentProgramSceneName
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('obs-set-scene', async (event, sceneName) => {
    try {
        await obs.call('SetCurrentProgramScene', { sceneName });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('obs-initialize-scenes', async () => {
    try {
        let scoresItems = {};
        let loopItems = {};

        // Get SCORES scene items
        try {
            const scoresData = await obs.call('GetSceneItemList', { sceneName: 'SCORES' });
            scoresData.sceneItems.forEach((item) => {
                if (item.inputKind === 'browser_source') {
                    scoresItems[item.sourceName] = item.sceneItemId;
                }
            });
        } catch (error) {
            console.log('SCORES scene not found or error:', error.message);
        }

        // Get LOOP_IND scene items and their durations
        try {
            const loopData = await obs.call('GetSceneItemList', { sceneName: 'LOOP_IND' });
            for (const item of loopData.sceneItems) {
                if (item.inputKind === 'ffmpeg_source') {
                    try {
                        const duration = await getVideoDuration(item.sourceName);
                        loopItems[item.sceneItemId] = {
                            name: item.sourceName,
                            duration: duration
                        };
                    } catch (durationError) {
                        console.log(`Could not get duration for ${item.sourceName}:`, durationError);
                        loopItems[item.sceneItemId] = {
                            name: item.sourceName,
                            duration: 30 // Default duration
                        };
                    }
                }
            }
        } catch (error) {
            console.log('LOOP_IND scene not found or error:', error.message);
        }

        return {
            success: true,
            scoresItems,
            loopItems
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('obs-show-scores', async (event, data) => {
    try {
        const { scoresItems, interval } = data;
        
        // Go to SCORES scene
        await obs.call('SetCurrentProgramScene', { sceneName: 'SCORES' });
        
        let idx = 0;
        let lastSceneId = null;

        for (const [name, id] of Object.entries(scoresItems)) {
            // Disable all score items first
            await obs.call('SetSceneItemEnabled', {
                sceneName: 'SCORES',
                sceneItemId: id,
                sceneItemEnabled: false
            });

            setTimeout(async () => {
                try {
                    if (lastSceneId !== null) {
                        await obs.call('SetSceneItemEnabled', {
                            sceneName: 'SCORES',
                            sceneItemId: lastSceneId,
                            sceneItemEnabled: false
                        });
                    }

                    await obs.call('SetSceneItemEnabled', {
                        sceneName: 'SCORES',
                        sceneItemId: id,
                        sceneItemEnabled: true
                    });

                    lastSceneId = id;

                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('obs-event', {
                            type: 'automation-progress',
                            message: `Showing score: ${name}`
                        });
                    }
                } catch (error) {
                    console.log(`Error in show scores automation for ${name}: ${error.message}`);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('obs-event', {
                            type: 'automation-error',
                            message: `Failed to show score ${name}: ${error.message}`
                        });
                    }
                }
            }, interval * idx);
            idx++;
        }

        setTimeout(async () => {
            try {
                await obs.call('SetCurrentProgramScene', { sceneName: 'LOOP_IND' });
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'automation-progress',
                        message: 'Finished showing scores, returning to LOOP_IND'
                    });
                }
            } catch (error) {
                console.log(`Error returning to LOOP_IND after scores: ${error.message}`);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'automation-error',
                        message: `Failed to return to partner videos after scores: ${error.message}`
                    });
                }
            }
        }, interval * idx);

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});



// OBS Launch function
ipcMain.handle('launch-obs', async () => {
    try {
        const partnersVideosPath = path.join(__dirname, 'data', 'PARTNERS_VIDEOS');

        // Step 1: Check and convert non-MP4 videos to MP4
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-launch-progress', {
                step: 'checking-videos',
                message: 'Checking for non-MP4 videos in PARTNERS_VIDEOS...'
            });
        }

        console.log('=== OBS Launch: Starting video conversion check ===');
        
        if (fs.existsSync(partnersVideosPath)) {
            const files = fs.readdirSync(partnersVideosPath);
            const videoFiles = files.filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.mov', '.webm', '.mkv', '.avi', '.wmv'].includes(ext);
            });

            if (videoFiles.length > 0) {
                console.log(`Found ${videoFiles.length} non-MP4 video file(s) to convert: ${videoFiles.join(', ')}`);
                
                console.log('=== Video Conversion Results ===');
                for (let i = 0; i < videoFiles.length; i++) {
                    const videoFile = videoFiles[i];
                    const videoPath = path.join(partnersVideosPath, videoFile);
                    
                    // Show current file being converted
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('obs-launch-progress', {
                            step: 'converting-videos',
                            message: `Converting ${videoFile} (${i + 1}/${videoFiles.length})...`
                        });
                    }
                    
                    console.log(`Converting ${videoFile} (${i + 1}/${videoFiles.length})...`);
                    
                    try {
                        const result = await convertVideoToMp4(videoPath);
                        if (result.success) {
                            console.log(`✓ ${result.file || videoFile} → ${path.basename(result.outputPath)} (original deleted)`);
                        } else {
                            console.log(`✗ ${videoFile} failed: ${result.error}`);
                        }
                    } catch (error) {
                        console.log(`✗ ${videoFile} failed: ${error.message}`);
                    }
                }
            } else {
                console.log('No non-MP4 videos found in PARTNERS_VIDEOS directory');
            }
        } else {
            console.log('PARTNERS_VIDEOS directory not found');
        }

        // Step 2: Check and convert PNG/JPG images to MP4
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-launch-progress', {
                step: 'checking-images',
                message: 'Checking for PNG/JPG images in PARTNERS_VIDEOS...'
            });
        }

        console.log('=== OBS Launch: Starting image conversion check ===');
        
        if (fs.existsSync(partnersVideosPath)) {
            const files = fs.readdirSync(partnersVideosPath);
            const imageFiles = files.filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.png', '.jpg', '.jpeg'].includes(ext);
            });

            if (imageFiles.length > 0) {
                console.log(`Found ${imageFiles.length} image file(s) to convert: ${imageFiles.join(', ')}`);
                
                console.log('=== Image Conversion Results ===');
                for (let i = 0; i < imageFiles.length; i++) {
                    const imageFile = imageFiles[i];
                    const imagePath = path.join(partnersVideosPath, imageFile);
                    
                    // Show current file being converted
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('obs-launch-progress', {
                            step: 'converting-images',
                            message: `Converting ${imageFile} (${i + 1}/${imageFiles.length})...`
                        });
                    }
                    
                    console.log(`Converting ${imageFile} (${i + 1}/${imageFiles.length})...`);
                    
                    try {
                        const result = await convertImageToVideo(imagePath);
                        if (result.success) {
                            console.log(`✓ ${result.file || imageFile} → ${path.basename(result.outputPath)} (original deleted)`);
                        } else {
                            console.log(`✗ ${imageFile} failed: ${result.error}`);
                        }
                    } catch (error) {
                        console.log(`✗ ${imageFile} failed: ${error.message}`);
                    }
                }
            } else {
                console.log('No PNG/JPG images found in PARTNERS_VIDEOS directory');
            }
        } else {
            console.log('PARTNERS_VIDEOS directory not found');
        }

        // Step 3: Prepare OBS launch
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-launch-progress', {
                step: 'preparing-obs',
                message: 'Preparing OBS Studio launch...'
            });
        }

        console.log('=== OBS Launch: Starting OBS preparation ===');
        const obsExePath = path.join(__dirname, 'provider', 'obs', 'bin', '64bit', 'obs64.exe');
        const obsDir = path.join(__dirname, 'provider', 'obs');
        const sceneCollectionName = 'obs-scene-collection';
        const sceneCollectionSourcePath = path.join(__dirname, 'data', 'obs-scene-collection.json');
        const sceneCollectionDestDir = path.join(__dirname, 'provider', 'obs', 'config', 'obs-studio', 'basic', 'scenes');
        const sceneCollectionDestPath = path.join(sceneCollectionDestDir, `${sceneCollectionName}.json`);

        if (!fs.existsSync(obsExePath)) {
            return { success: false, error: 'OBS Studio not found. Please download OBS first.' };
        }

        // Create the destination directory if it doesn't exist
        if (!fs.existsSync(sceneCollectionDestDir)) {
            fs.mkdirSync(sceneCollectionDestDir, { recursive: true });
        }

        // Copy the scene collection file
        if (fs.existsSync(sceneCollectionSourcePath)) {
            fs.copyFileSync(sceneCollectionSourcePath, sceneCollectionDestPath);
            
            // Update paths in the copied scene collection to be dynamic
            console.log('Updating scene collection paths to be dynamic...');
            updateSceneCollectionPaths();
        }

        // Launch OBS with scene collection import if available
        const obsArgs = ['--portable', '--collection', sceneCollectionName];
        let sceneMessage = '\nScene collection will be loaded.';

        const obsExecutableDir = path.join(__dirname, 'provider', 'obs', 'bin', '64bit');
        
        // Step 4: Launch OBS
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-launch-progress', {
                step: 'launching-obs',
                message: 'Launching OBS Studio...'
            });
        }

        console.log(`Launching OBS with args: ${obsArgs.join(' ')} from directory: ${obsExecutableDir} using executable: ${obsExePath}`);

        // Launch OBS with scene collection import from the correct directory
        obsProcess = spawn(obsExePath, obsArgs, {
            detached: false, // Keep attached so we can track it
            stdio: 'ignore',
            cwd: obsExecutableDir
        });
        
        return {
            success: true,
            message: `OBS launched successfully!${sceneMessage}
            
Please configure WebSocket:
1. Go to Tools → WebSocket Server Settings
2. Enable Server
3. Set Port: 4455
4. Set Password: 123456
5. Click Apply/OK`
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Show WebSocket setup dialog
ipcMain.handle('show-websocket-dialog', async () => {
    if (!mainWindow) return;
    
    const { dialog } = require('electron');
    
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'WebSocket Setup Required',
        message: 'Cannot connect to OBS WebSocket',
        detail: `Please configure WebSocket in OBS:

1. In OBS, go to Tools → WebSocket Server Settings
2. Check "Enable WebSocket server"
3. Set Server Port: 4455
4. Set Server Password: 123456
5. Click "Apply" then "OK"
6. Try connecting again from LED Management

Note: Make sure OBS is running and the WebSocket plugin is installed.`,
        buttons: ['OK', 'Launch OBS'],
        defaultId: 0,
        icon: null
    });
    
    return { buttonIndex: result.response };
});

// Helper function to get video duration
function getVideoDuration(filename) {
    return new Promise((resolve, reject) => {
        const ffprobePath = path.join(__dirname, 'provider', 'ffmpeg', 'bin', 'ffprobe.exe');
        const videoPath = path.join(__dirname, 'data', 'PARTNERS_VIDEOS', filename);
        
        if (!fs.existsSync(ffprobePath)) {
            reject(new Error('FFprobe not found'));
            return;
        }
        
        if (!fs.existsSync(videoPath)) {
            reject(new Error(`Video file not found: ${videoPath}`));
            return;
        }

        exec(`"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`Error getting video duration: ${stderr}`));
            } else {
                resolve(parseFloat(stdout.trim()));
            }
        });
    });
}

ipcMain.handle('obs-start-automation', async (event, data) => {
    try {
        const { scoresItems, loopItems, config } = data;
        
        if (automationInterval) {
            clearInterval(automationInterval);
        }
        
        // Start the main automation loop
        const startMainLoop = async () => {
            try {
                await obs.call('SetCurrentProgramScene', { sceneName: 'LOOP_IND' });
                
                let totalDuration = 0;
                let videoCount = 0;
                
                // Process each loop item
                for (const [id, item] of Object.entries(loopItems)) {
                    const sceneItemId = parseInt(id);
                    
                    // Hide all items first
                    await obs.call('SetSceneItemEnabled', {
                        sceneName: 'LOOP_IND',
                        sceneItemId: sceneItemId,
                        sceneItemEnabled: false
                    });
                    
                    // Show item after delay
                    setTimeout(async () => {
                        try {
                            await obs.call('SetSceneItemEnabled', {
                                sceneName: 'LOOP_IND',
                                sceneItemId: sceneItemId,
                                sceneItemEnabled: true
                            });
                            
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('obs-event', {
                                    type: 'automation-progress',
                                    message: `Showing: ${item.name} for ${item.duration}s`
                                });
                            }
                        } catch (error) {
                            console.log(`Error showing item ${item.name}: ${error.message}`);
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('obs-event', {
                                    type: 'automation-error',
                                    message: `Failed to show ${item.name}: ${error.message}`
                                });
                            }
                        }
                        
                        // Hide after duration
                        setTimeout(async () => {
                            try {
                                await obs.call('SetSceneItemEnabled', {
                                    sceneName: 'LOOP_IND',
                                    sceneItemId: sceneItemId,
                                    sceneItemEnabled: false
                                });
                            } catch (error) {
                                console.log(`Error hiding item ${item.name}: ${error.message}`);
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send('obs-event', {
                                        type: 'automation-error',
                                        message: `Failed to hide ${item.name}: ${error.message}`
                                    });
                                }
                            }
                        }, item.duration * 1000);
                        
                    }, totalDuration * 1000);
                    
                    totalDuration += item.duration;
                    videoCount++;
                    
                    // Show scores if enabled and reached ad count
                    if (config.showScores && videoCount % config.adsCount === 0 && Object.keys(scoresItems).length > 0) {
                        setTimeout(async () => {
                            try {
                                // Show scores sequence
                                await obs.call('SetCurrentProgramScene', { sceneName: 'SCORES' });
                                
                                let scoreIdx = 0;
                                let lastScoreId = null;
                                
                                for (const [name, scoreId] of Object.entries(scoresItems)) {
                                    // Disable all score items first
                                    await obs.call('SetSceneItemEnabled', {
                                        sceneName: 'SCORES',
                                        sceneItemId: scoreId,
                                        sceneItemEnabled: false
                                    });
                                
                                setTimeout(async () => {
                                    try {
                                        if (lastScoreId !== null) {
                                            await obs.call('SetSceneItemEnabled', {
                                                sceneName: 'SCORES',
                                                sceneItemId: lastScoreId,
                                                sceneItemEnabled: false
                                            });
                                        }
                                        
                                        await obs.call('SetSceneItemEnabled', {
                                            sceneName: 'SCORES',
                                            sceneItemId: scoreId,
                                            sceneItemEnabled: true
                                        });
                                        
                                        lastScoreId = scoreId;
                                        
                                        if (mainWindow && !mainWindow.isDestroyed()) {
                                            mainWindow.webContents.send('obs-event', {
                                                type: 'automation-progress',
                                                message: `Showing score: ${name}`
                                            });
                                        }
                                    } catch (error) {
                                        console.log(`Error in score automation for ${name}: ${error.message}`);
                                        if (mainWindow && !mainWindow.isDestroyed()) {
                                            mainWindow.webContents.send('obs-event', {
                                                type: 'automation-error',
                                                message: `Failed to show score ${name}: ${error.message}`
                                            });
                                        }
                                    }
                                }, config.scoreInterval * scoreIdx);
                                scoreIdx++;
                            }
                            
                            // Return to LOOP_IND after scores
                            setTimeout(async () => {
                                try {
                                    await obs.call('SetCurrentProgramScene', { sceneName: 'LOOP_IND' });
                                    if (mainWindow && !mainWindow.isDestroyed()) {
                                        mainWindow.webContents.send('obs-event', {
                                            type: 'automation-progress',
                                            message: 'Returned to partner videos'
                                        });
                                    }
                                } catch (error) {
                                    console.log(`Error returning to LOOP_IND scene: ${error.message}`);
                                    if (mainWindow && !mainWindow.isDestroyed()) {
                                        mainWindow.webContents.send('obs-event', {
                                            type: 'automation-error',
                                            message: `Failed to return to partner videos: ${error.message}`
                                        });
                                    }
                                }
                            }, config.scoreInterval * scoreIdx);
                            
                                totalDuration += (Object.keys(scoresItems).length * (config.scoreInterval / 1000)) + (config.transitionTime / 1000);
                            } catch (error) {
                                console.log(`Error in scores automation sequence: ${error.message}`);
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send('obs-event', {
                                        type: 'automation-error',
                                        message: `Failed in scores automation: ${error.message}`
                                    });
                                }
                            }
                        }, (totalDuration + (config.transitionTime / 1000)) * 1000);
                    }
                }
                
                return totalDuration * 1000; // Return duration in milliseconds
            } catch (error) {
                if (ledManagementWindow) {
                    ledManagementWindow.webContents.send('obs-event', {
                        type: 'automation-error',
                        message: `Automation error: ${error.message}`
                    });
                }
                return 0;
            }
        };
        
        // Start first loop
        const loopDuration = await startMainLoop();
        
        // Set up continuous looping
        if (loopDuration > 0) {
            automationInterval = setInterval(async () => {
                await startMainLoop();
            }, loopDuration);
        }
        
        return { 
            success: true, 
            message: config.showScores ? 
                'Full automation started (partners + scores)' : 
                'Partners-only automation started (no scores)'
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('obs-stop-automation', async () => {
    try {
        if (automationInterval) {
            clearInterval(automationInterval);
            automationInterval = null;
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Convert PNG/JPG images to MP4 in PARTNERS_VIDEOS directory
ipcMain.handle('convert-images-to-videos', async () => {
    try {
        const result = await convertAllImagesInPartnersVideos();
        return result;
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Convert non-MP4 videos to MP4 in PARTNERS_VIDEOS directory
ipcMain.handle('convert-videos-to-mp4', async () => {
    try {
        const result = await convertAllVideosInPartnersVideos();
        return result;
    } catch (error) {
        return { success: false, error: error.message };
    }
});