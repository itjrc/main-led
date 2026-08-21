const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const OBSWebSocket = require('obs-websocket-js').default;
const { scanDirectory } = require('./videoLibrary');
const { clearSafeModeSentinel } = require('./obsConfig');

let obs = null;
let automationInterval = null;
let obsProcess = null;

// Timers scheduled by the score sequence. Tracked so stopAutomation() can cancel
// them; clearInterval alone left them firing and kept switching scenes.
let pendingTimeouts = [];

function scheduleTimeout(callback, delay) {
    const timeoutId = setTimeout(() => {
        pendingTimeouts = pendingTimeouts.filter(id => id !== timeoutId);
        callback();
    }, delay);
    pendingTimeouts.push(timeoutId);
    return timeoutId;
}

function clearPendingTimeouts() {
    pendingTimeouts.forEach(clearTimeout);
    pendingTimeouts = [];
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
        const sceneCollectionPath = path.join(__dirname, '..', 'data', 'obs-scene-collection.json');
        
        if (!fs.existsSync(sceneCollectionPath)) {
            console.log('Scene collection file not found, skipping path updates');
            return;
        }
        
        // Read the current scene collection
        let sceneCollection = fs.readFileSync(sceneCollectionPath, 'utf8');
        
        // Current project directory paths
        const currentProjectDir = path.join(__dirname, '..').replace(/\\/g, '/');
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

// obs-websocket answers before OBS has finished loading its scene collection,
// and every request in that window fails with "OBS is not ready to perform the
// request". Poll a harmless request until it goes through.
async function waitUntilReady(attempts = 20, delayMs = 750) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await obs.call('GetSceneList');
            if (attempt > 1) {
                console.log(`OBS became ready after ${attempt} attempts`);
            }
            return true;
        } catch (error) {
            if (!/not ready/i.test(error.message || '')) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    console.log('OBS still reports "not ready" after waiting');
    return false;
}

// OBS connection functions
async function connectToOBS(address, password, mainWindow) {
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

        // Do not issue requests until OBS has finished loading
        await waitUntilReady();

        // Automatically enable fullscreen projection on second monitor after connection
        await enableFullscreenProjection();
        
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function disconnectFromOBS() {
    try {
        if (obs && obs.identified) {
            await obs.disconnect();
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function getOBSScenes() {
    try {
        const scenes = await obs.call('GetSceneList');
        const currentScene = await obs.call('GetCurrentProgramScene');
        
        return {
            success: true,
            scenes: scenes.scenes,
            currentScene: currentScene.currentProgramSceneName
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function setOBSScene(sceneName) {
    try {
        await obs.call('SetCurrentProgramScene', { sceneName });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function initializeOBSScenes() {
    try {
        const scoresItems = {};
        const loopItems = {};
        
        // Get SCORES scene items
        const scoresScene = await obs.call('GetSceneItemList', { sceneName: 'SCORES' });
        scoresScene.sceneItems.forEach(item => {
            if (item.sourceName && item.sourceName.includes('SCORE')) {
                scoresItems[item.sourceName] = item.sceneItemId;
            }
        });
        
        // Get LOOP_IND scene items
        const loopScene = await obs.call('GetSceneItemList', { sceneName: 'LOOP_IND' });
        loopScene.sceneItems.forEach(item => {
            loopItems[item.sourceName] = item.sceneItemId;
        });
        
        return {
            success: true,
            scoresItems,
            loopItems
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Mirror the media directory into the LOOP_IND scene: add an ffmpeg_source for
// every new MP4, drop the items whose file is gone. Matches the shape of the
// items shipped in data/obs-scene-collection.json (scale-inner 1920x1080,
// hidden until the automation enables them).
async function syncLoopScene(directory) {
    try {
        if (!obs || !obs.identified) {
            return { success: false, error: 'Not connected to OBS' };
        }

        const scan = scanDirectory(directory);
        if (!scan.exists) {
            return { success: false, error: `Directory not found: ${scan.directory}` };
        }

        const sceneItems = (await obs.call('GetSceneItemList', { sceneName: 'LOOP_IND' })).sceneItems;

        // Map each existing item to the file it plays
        const itemsByFile = new Map();
        const untracked = [];

        for (const item of sceneItems) {
            let localFile = null;
            try {
                const settings = await obs.call('GetInputSettings', { inputName: item.sourceName });
                localFile = settings.inputSettings && settings.inputSettings.local_file;
            } catch (error) {
                // Not an input (a group or a scene): leave it alone
                untracked.push(item.sourceName);
                continue;
            }

            if (!localFile) {
                untracked.push(item.sourceName);
                continue;
            }

            itemsByFile.set(path.resolve(localFile), {
                sceneItemId: item.sceneItemId,
                sourceName: item.sourceName
            });

            // Without this, OBS keeps a handle on every clip and Windows refuses
            // to delete a partner video while OBS is running.
            try {
                await obs.call('SetInputSettings', {
                    inputName: item.sourceName,
                    inputSettings: { close_when_inactive: true },
                    overlay: true
                });
            } catch (error) {
                console.log(`Could not set close_when_inactive on ${item.sourceName}: ${error.message}`);
            }
        }

        const onDisk = new Set(scan.playable.map(file => path.resolve(file.path)));

        // Remove items whose file disappeared from the directory
        const removed = [];
        for (const [filePath, item] of itemsByFile) {
            if (onDisk.has(filePath)) continue;
            try {
                await obs.call('RemoveInput', { inputName: item.sourceName });
                removed.push(item.sourceName);
            } catch (error) {
                console.log(`Could not remove ${item.sourceName}: ${error.message}`);
            }
        }

        // Add the files that have no source yet
        const added = [];
        const failed = [];

        for (const file of scan.playable) {
            if (itemsByFile.has(path.resolve(file.path))) continue;

            try {
                const created = await obs.call('CreateInput', {
                    sceneName: 'LOOP_IND',
                    inputName: file.name,
                    inputKind: 'ffmpeg_source',
                    inputSettings: {
                        local_file: file.path.replace(/\\/g, '/'),
                        // Release the file handle while the clip is not showing
                        close_when_inactive: true
                    },
                    sceneItemEnabled: false
                });

                // Fit to the 1920x1080 canvas like the shipped items do
                await obs.call('SetSceneItemTransform', {
                    sceneName: 'LOOP_IND',
                    sceneItemId: created.sceneItemId,
                    sceneItemTransform: {
                        positionX: 0,
                        positionY: 0,
                        alignment: 5,
                        boundsType: 'OBS_BOUNDS_SCALE_INNER',
                        boundsAlignment: 0,
                        boundsWidth: 1920,
                        boundsHeight: 1080
                    }
                });

                added.push(file.name);
            } catch (error) {
                console.log(`Could not add ${file.name}: ${error.message}`);
                failed.push({ name: file.name, error: error.message });
            }
        }

        const kept = scan.playable.length - added.length;
        console.log(`LOOP_IND sync: +${added.length} -${removed.length} (${kept} unchanged)`);

        return { success: true, added, removed, failed, kept, untracked };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function showScores(data, mainWindow) {
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

            scheduleTimeout(async () => {
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

        scheduleTimeout(async () => {
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
}

async function startAutomation(data, mainWindow) {
    try {
        const { scoresItems, loopItems, config } = data;
        
        if (automationInterval) {
            clearInterval(automationInterval);
        }
        clearPendingTimeouts();

        const videoDuration = config.videoDuration > 0 ? config.videoDuration : 15000;

        let currentVideoIndex = 0;
        const videoItems = Object.entries(loopItems);
        
        if (videoItems.length === 0) {
            throw new Error('No video items found in LOOP_IND scene');
        }

        // Go to LOOP_IND scene
        await obs.call('SetCurrentProgramScene', { sceneName: 'LOOP_IND' });
        
        // Disable all items initially
        for (const [name, id] of videoItems) {
            await obs.call('SetSceneItemEnabled', {
                sceneName: 'LOOP_IND',
                sceneItemId: id,
                sceneItemEnabled: false
            });
        }
        
        // Start the automation loop
        automationInterval = setInterval(async () => {
            try {
                // Disable current video
                if (currentVideoIndex > 0 || videoItems.length > 1) {
                    const prevIndex = currentVideoIndex === 0 ? videoItems.length - 1 : currentVideoIndex - 1;
                    await obs.call('SetSceneItemEnabled', {
                        sceneName: 'LOOP_IND',
                        sceneItemId: videoItems[prevIndex][1],
                        sceneItemEnabled: false
                    });
                }
                
                // Enable current video
                await obs.call('SetSceneItemEnabled', {
                    sceneName: 'LOOP_IND',
                    sceneItemId: videoItems[currentVideoIndex][1],
                    sceneItemEnabled: true
                });
                
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'automation-progress',
                        message: `Playing video: ${videoItems[currentVideoIndex][0]}`
                    });
                }
                
                currentVideoIndex = (currentVideoIndex + 1) % videoItems.length;
                
                // Show scores every adsCount videos
                if (config.showScores && currentVideoIndex % config.adsCount === 0) {
                    scheduleTimeout(async () => {
                        try {
                            await showScores({ scoresItems, interval: config.scoreInterval }, mainWindow);
                        } catch (error) {
                            console.log(`Error showing scores: ${error.message}`);
                        }
                    }, config.transitionTime);
                }
                
            } catch (error) {
                console.log(`Error in automation loop: ${error.message}`);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'automation-error',
                        message: `Automation error: ${error.message}`
                    });
                }
            }
        }, videoDuration);

        console.log(`Automation started: ${videoDuration}ms per video, scores ${config.showScores ? `every ${config.adsCount} videos` : 'disabled'}`);

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function stopAutomation() {
    try {
        if (automationInterval) {
            clearInterval(automationInterval);
            automationInterval = null;
        }
        // Cancel the score sequence too, otherwise it keeps switching scenes
        // after the user pressed Stop.
        clearPendingTimeouts();
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Close OBS the way a user would. process.kill() maps to TerminateProcess on
// Windows, which OBS cannot distinguish from a crash: it leaves its safe_mode
// sentinel behind and the next launch opens a prompt that disables WebSockets.
// taskkill without /F posts WM_CLOSE instead, so OBS shuts down cleanly.
// Resolve powershell.exe by absolute path: PATH is not guaranteed for a process
// launched from Explorer.
function powerShellPath() {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const absolute = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fs.existsSync(absolute) ? absolute : 'powershell';
}

function isProcessRunning(pid) {
    try {
        const output = String(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
            windowsHide: true
        }));
        return output.includes(String(pid));
    } catch (error) {
        return false;
    }
}

// Block without spinning the CPU; cleanupOBS runs on the quit path and cannot
// await.
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shutdownOBSProcess(graceMs = 8000) {
    if (!obsProcess || obsProcess.killed || obsProcess.exitCode !== null) {
        obsProcess = null;
        clearSafeModeSentinel();
        return;
    }

    const pid = obsProcess.pid;

    // CloseMainWindow posts WM_CLOSE, which is what clicking the window's X
    // does. `taskkill` without /F is not an option: OBS spawns a helper child
    // process that refuses a graceful close, and taskkill /T then aborts the
    // whole request, leaving OBS running.
    try {
        execFileSync(powerShellPath(), [
            '-NoProfile', '-NonInteractive', '-Command',
            `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`
            + ` if ($p) { $p.CloseMainWindow() | Out-Null }`
        ], { windowsHide: true, stdio: 'ignore' });
        console.log(`Asked OBS (pid ${pid}) to close`);
    } catch (error) {
        console.log(`Could not post a close request to OBS: ${error.message}`);
    }

    // Let OBS save its scene collection and clear its scene data. It reaches
    // that point about a second after WM_CLOSE, then obs-websocket's
    // obs_module_unload hangs and the process never exits on its own - an
    // OBS-side issue. Terminating after the save costs nothing.
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isProcessRunning(pid)) {
        sleepSync(250);
    }

    if (isProcessRunning(pid)) {
        console.log(`OBS (pid ${pid}) saved and stopped responding, terminating`);
        try {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } catch (error) {
            console.log(`Could not terminate OBS: ${error.message}`);
        }
    } else {
        console.log('OBS closed');
    }

    obsProcess = null;

    // We asked for this shutdown, so a leftover sentinel is not a crash report.
    // Clearing it keeps the safe-mode prompt away even from a manual OBS launch.
    clearSafeModeSentinel();
}

// Clean up OBS resources
function cleanupOBS() {
    if (automationInterval) {
        clearInterval(automationInterval);
        automationInterval = null;
    }
    clearPendingTimeouts();

    // Close our WebSocket first. obs-websocket's module unload waits on every
    // connected client during shutdown, so an open connection stalls OBS well
    // past its closing handshake timeout and it never finishes exiting.
    if (obs) {
        try {
            obs.disconnect().catch(() => {});
        } catch (error) {
            console.log(`Error disconnecting from OBS: ${error.message}`);
        }
        obs = null;
        sleepSync(750); // let the close frame reach OBS
    }

    shutdownOBSProcess();
}

// Launch OBS (will be moved to a separate launcher module)
function setOBSProcess(process) {
    obsProcess = process;
}

function getOBSProcess() {
    return obsProcess;
}

module.exports = {
    connectToOBS,
    disconnectFromOBS,
    getOBSScenes,
    setOBSScene,
    initializeOBSScenes,
    showScores,
    startAutomation,
    stopAutomation,
    syncLoopScene,
    cleanupOBS,
    updateSceneCollectionPaths,
    enableFullscreenProjection,
    setOBSProcess,
    getOBSProcess
};