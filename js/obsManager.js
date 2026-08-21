const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const OBSWebSocket = require('obs-websocket-js').default;

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

// Clean up OBS resources
function cleanupOBS() {
    if (automationInterval) {
        clearInterval(automationInterval);
        automationInterval = null;
    }
    clearPendingTimeouts();

    if (obsProcess && !obsProcess.killed) {
        obsProcess.kill();
        obsProcess = null;
    }
    
    if (obs && obs.identified) {
        obs.disconnect().catch(console.error);
    }
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
    cleanupOBS,
    updateSceneCollectionPaths,
    enableFullscreenProjection,
    setOBSProcess,
    getOBSProcess
};