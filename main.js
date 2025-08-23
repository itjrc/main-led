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

app.whenReady().then(createWindow);

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
            
            mainWindow.webContents.send('download-progress', { app: appName, status: 'downloading' });
            
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
                    
                    mainWindow.webContents.send('download-progress', { app: appName, status: 'extracting' });
                    
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
                        
                        mainWindow.webContents.send('download-progress', { app: appName, status: 'completed' });
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
                if (mainWindow) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'connection-closed'
                    });
                }
            });

            obs.on('CurrentProgramSceneChanged', (data) => {
                if (mainWindow) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'scene-changed',
                        sceneName: data.sceneName
                    });
                }
            });
        }

        await obs.connect(address, password);
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

                if (mainWindow) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'automation-progress',
                        message: `Showing score: ${name}`
                    });
                }
            }, interval * idx);
            idx++;
        }

        setTimeout(async () => {
            await obs.call('SetCurrentProgramScene', { sceneName: 'LOOP_IND' });
            if (ledManagementWindow) {
                ledManagementWindow.webContents.send('obs-event', {
                    type: 'automation-progress',
                    message: 'Finished showing scores, returning to LOOP_IND'
                });
            }
        }, interval * idx);

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Function to fix paths in scene collection
function fixSceneCollectionPaths(sceneCollectionPath) {
    try {
        const content = fs.readFileSync(sceneCollectionPath, 'utf8');
        const currentProjectDir = __dirname.replace(/\\/g, '/');
        
        // Replace various possible hardcoded path formats with current project directory
        let updatedContent = content;
        
        // Replace the specific hardcoded path found
        updatedContent = updatedContent.replace(
            /C:\/Users\/Gilbert\/Documents\/Project\/OBS-MAIN-LED/g,
            currentProjectDir
        );
        
        // Also replace any other variations that might exist
        updatedContent = updatedContent.replace(
            /C:\\Users\\Gilbert\\Documents\\Project\\OBS-MAIN-LED/g,
            currentProjectDir
        );
        
        // Log the changes being made
        if (updatedContent !== content) {
            console.log(`Fixed hardcoded paths in scene collection, replacing with: ${currentProjectDir}`);
        }
        
        // Create a temporary scene collection with corrected paths
        const tempSceneCollectionPath = path.join(__dirname, 'data', 'obs-scene-collection-temp.json');
        fs.writeFileSync(tempSceneCollectionPath, updatedContent, 'utf8');
        
        return tempSceneCollectionPath;
    } catch (error) {
        console.error('Error fixing scene collection paths:', error);
        return sceneCollectionPath; // Return original if fixing fails
    }
}

// OBS Launch function
ipcMain.handle('launch-obs', async () => {
    try {
        const obsExePath = path.join(__dirname, 'provider', 'obs', 'bin', '64bit', 'obs64.exe');
        const obsDir = path.join(__dirname, 'provider', 'obs');
        const sceneCollectionPath = path.join(__dirname, 'data', 'obs-scene-collection.json');
        
        if (!fs.existsSync(obsExePath)) {
            return { success: false, error: 'OBS Studio not found. Please download OBS first.' };
        }
        
        // Launch OBS with scene collection import if available
        const obsArgs = [];
        let sceneMessage = '';
        
        if (fs.existsSync(sceneCollectionPath)) {
            // Fix paths in scene collection before importing
            const fixedSceneCollectionPath = fixSceneCollectionPaths(sceneCollectionPath);
            
            // Add scene collection import argument with fixed paths
            obsArgs.push('--collection', path.resolve(fixedSceneCollectionPath));
            sceneMessage = '\nScene collection will be imported with corrected paths.';
        }

        const obsExecutableDir = path.join(__dirname, 'provider', 'obs', 'bin', '64bit');
        
        console.log(`Launching OBS with args: ${obsArgs.join(' ')} from directory: ${obsExecutableDir} using executable: ${obsExePath}`);

        // Launch OBS with scene collection import from the correct directory
        obsProcess = spawn(obsExePath, obsArgs, {
            detached: false, // Keep attached so we can track it
            stdio: 'ignore',
            cwd: obsExecutableDir
        });
        
        // Clean up temporary scene collection file after a delay
        if (sceneMessage.includes('corrected paths')) {
            setTimeout(() => {
                const tempPath = path.join(__dirname, 'data', 'obs-scene-collection-temp.json');
                if (fs.existsSync(tempPath)) {
                    try {
                        fs.unlinkSync(tempPath);
                        console.log('Cleaned up temporary scene collection file');
                    } catch (cleanupError) {
                        console.error('Error cleaning up temp file:', cleanupError);
                    }
                }
            }, 10000); // Clean up after 10 seconds
        }
        
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
                        await obs.call('SetSceneItemEnabled', {
                            sceneName: 'LOOP_IND',
                            sceneItemId: sceneItemId,
                            sceneItemEnabled: true
                        });
                        
                        if (mainWindow) {
                            mainWindow.webContents.send('obs-event', {
                                type: 'automation-progress',
                                message: `Showing: ${item.name} for ${item.duration}s`
                            });
                        }
                        
                        // Hide after duration
                        setTimeout(async () => {
                            await obs.call('SetSceneItemEnabled', {
                                sceneName: 'LOOP_IND',
                                sceneItemId: sceneItemId,
                                sceneItemEnabled: false
                            });
                        }, item.duration * 1000);
                        
                    }, totalDuration * 1000);
                    
                    totalDuration += item.duration;
                    videoCount++;
                    
                    // Show scores if enabled and reached ad count
                    if (config.showScores && videoCount % config.adsCount === 0 && Object.keys(scoresItems).length > 0) {
                        setTimeout(async () => {
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
                                    
                                    if (ledManagementWindow) {
                                        ledManagementWindow.webContents.send('obs-event', {
                                            type: 'automation-progress',
                                            message: `Showing score: ${name}`
                                        });
                                    }
                                }, config.scoreInterval * scoreIdx);
                                scoreIdx++;
                            }
                            
                            // Return to LOOP_IND after scores
                            setTimeout(async () => {
                                await obs.call('SetCurrentProgramScene', { sceneName: 'LOOP_IND' });
                                if (ledManagementWindow) {
                                    ledManagementWindow.webContents.send('obs-event', {
                                        type: 'automation-progress',
                                        message: 'Returned to partner videos'
                                    });
                                }
                            }, config.scoreInterval * scoreIdx);
                            
                            totalDuration += (Object.keys(scoresItems).length * (config.scoreInterval / 1000)) + (config.transitionTime / 1000);
                            
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