const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const OBSWebSocket = require('obs-websocket-js').default;
const { scanDirectory, getLibraryStats } = require('./videoLibrary');
const { clearSafeModeSentinel } = require('./obsConfig');

let obs = null;
let automationInterval = null;
let obsProcess = null;

// The LED board canvas. Every transform in the shipped collection assumes this
// exact size, so the OBS canvas must match it (see ensureCanvasResolution).
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

// OBS "Adapter à l'écran" (fit to screen): scale-inner bounds covering the
// whole canvas, anchored top-left.
const FIT_TO_CANVAS_TRANSFORM = {
    positionX: 0,
    positionY: 0,
    alignment: 5,
    boundsType: 'OBS_BOUNDS_SCALE_INNER',
    boundsAlignment: 0,
    boundsWidth: CANVAS_WIDTH,
    boundsHeight: CANVAS_HEIGHT
};

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

// OBS defaults a fresh profile's canvas to the monitor's resolution, while
// every transform in the collection assumes 1920x1080. Enforced on every
// connection so a manually launched OBS complies too.
async function ensureCanvasResolution() {
    try {
        const video = await obs.call('GetVideoSettings');
        if (video.baseWidth === CANVAS_WIDTH && video.baseHeight === CANVAS_HEIGHT
            && video.outputWidth === CANVAS_WIDTH && video.outputHeight === CANVAS_HEIGHT) {
            return;
        }

        await obs.call('SetVideoSettings', {
            baseWidth: CANVAS_WIDTH,
            baseHeight: CANVAS_HEIGHT,
            outputWidth: CANVAS_WIDTH,
            outputHeight: CANVAS_HEIGHT
        });
        console.log(`OBS canvas set to ${CANVAS_WIDTH}x${CANVAS_HEIGHT} `
            + `(was ${video.baseWidth}x${video.baseHeight}, output ${video.outputWidth}x${video.outputHeight})`);
    } catch (error) {
        // Refused while an output (stream/record) is active; the profile's
        // basic.ini written at launch still carries the right size.
        console.log(`Could not set the OBS canvas to ${CANVAS_WIDTH}x${CANVAS_HEIGHT}: ${error.message}`);
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

        // Do not issue requests until OBS has finished loading
        await waitUntilReady();

        // The board is 1920x1080; fix the canvas before anything renders on it
        await ensureCanvasResolution();

        // Studio Mode is not used. Disabling it actively matters: OBS persists
        // the toggle across runs, so an instance that still carries it from an
        // older version (or a manual toggle) would otherwise keep it forever.
        try {
            await obs.call('SetStudioModeEnabled', { studioModeEnabled: false });
        } catch (error) {
            console.log(`Could not disable Studio Mode: ${error.message}`);
        }

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

// Fisher-Yates, in place
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Split clips into batches of at most `size`, keeping the total duration of
// each batch as even as possible: clips longest-first, each into the batch
// with the smallest running total that still has a free slot (LPT greedy).
// Clips play in full, so without this, "5 videos then scores" could mean a
// 40-second block one time and a two-minute block the next.
function buildBalancedBatches(clips, size) {
    const batchCount = Math.max(1, Math.ceil(clips.length / size));
    const batches = Array.from({ length: batchCount }, () => ({ items: [], total: 0 }));

    const sorted = clips.slice().sort((a, b) => b.duration - a.duration);
    for (const clip of sorted) {
        let target = null;
        for (const batch of batches) {
            if (batch.items.length >= size) continue;
            if (!target || batch.total < target.total) target = batch;
        }
        target.items.push(clip);
        target.total += clip.duration;
    }
    return batches;
}

async function initializeOBSScenes() {
    try {
        const scoresItems = {};
        const loopItems = {};

        // Only the score WEBPAGES rotate: the live-scoring displays are
        // browser_source inputs. Everything else in the SCORES scene - the
        // rain-delay text banners the operator toggles by hand, overlays -
        // keeps whatever visibility was set manually. (Filtering on the source
        // name does not work: the displays are named SINGLE-MEN, DOUBLE-WOMAN,
        // ... with no common marker.)
        const scoresScene = await obs.call('GetSceneItemList', { sceneName: 'SCORES' });
        scoresScene.sceneItems.forEach(item => {
            if (item.inputKind === 'browser_source') {
                scoresItems[item.sourceName] = item.sceneItemId;
            }
        });

        // Get LOOP_IND scene items, in a fresh random rotation order. This map
        // is rebuilt at connection, after every folder change (manual sync or
        // watchdog) and on Initialize, so the shuffle re-rolls at those points.
        const loopScene = await obs.call('GetSceneItemList', { sceneName: 'LOOP_IND' });
        shuffle(loopScene.sceneItems.slice()).forEach(item => {
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

        // "Adapter à l'écran" for every clip that stays, not only the new
        // ones: an item moved or resized by hand in OBS drifts off the LED
        // canvas and would otherwise keep its broken transform forever.
        for (const [filePath, item] of itemsByFile) {
            if (!onDisk.has(filePath)) continue;
            try {
                await obs.call('SetSceneItemTransform', {
                    sceneName: 'LOOP_IND',
                    sceneItemId: item.sceneItemId,
                    sceneItemTransform: FIT_TO_CANVAS_TRANSFORM
                });
            } catch (error) {
                console.log(`Could not fit ${item.sourceName} to the canvas: ${error.message}`);
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

                // Fit to the canvas like the shipped items do
                await obs.call('SetSceneItemTransform', {
                    sceneName: 'LOOP_IND',
                    sceneItemId: created.sceneItemId,
                    sceneItemTransform: FIT_TO_CANVAS_TRANSFORM
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

// Point the partner logo slideshow at the folder and make OBS re-read it.
// A slideshow configured with a directory only scans it when its settings are
// applied, so freshly downloaded logos stay invisible until the settings are
// written back - which is what this does, even when the path is unchanged.
async function refreshPartnersLogoSlideshow(directory) {
    try {
        if (!obs || !obs.identified) {
            return { success: false, error: 'Not connected to OBS' };
        }

        const folder = path.resolve(directory).replace(/\\/g, '/');

        const { inputs } = await obs.call('GetInputList');
        const slideshows = inputs.filter(input =>
            input.inputKind === 'slideshow' || input.unversionedInputKind === 'slideshow');

        if (!slideshows.length) {
            return { success: false, error: 'No slideshow source found in the collection' };
        }

        // Prefer the source that already points at this folder, then the one
        // shipped in the collection, so a renamed source still gets found.
        let target = null;
        for (const input of slideshows) {
            try {
                const { inputSettings } = await obs.call('GetInputSettings', { inputName: input.inputName });
                const files = inputSettings.files || [];
                if (files.some(f => String(f.value || '').replace(/\\/g, '/').toLowerCase() === folder.toLowerCase())) {
                    target = input.inputName;
                    break;
                }
            } catch (error) {
                // Not readable: fall through to the name match
            }
        }

        if (!target) {
            const byName = slideshows.find(i => /partners?\s*logos?/i.test(i.inputName));
            target = (byName || slideshows[0]).inputName;
        }

        await obs.call('SetInputSettings', {
            inputName: target,
            inputSettings: { files: [{ value: folder, selected: false, hidden: false }] },
            overlay: true
        });

        console.log(`Partner logo slideshow "${target}" reloaded from ${folder}`);
        return { success: true, inputName: target, directory: folder };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// onComplete, when provided, runs once the sequence has handed the program
// back to LOOP_IND - the automation uses it to resume the paused video loop.
async function showScores(data, mainWindow, onComplete) {
    try {
        const { scoresItems, interval } = data;

        // Nothing to rotate: stay on the current scene. Without this guard the
        // "return to LOOP_IND" step fires at interval * 0 = immediately, which
        // looks like the scores being skipped.
        if (!scoresItems || !Object.keys(scoresItems).length) {
            console.log('No score displays found in the SCORES scene, skipping');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-event', {
                    type: 'automation-error',
                    message: 'No score displays found in the SCORES scene'
                });
            }
            return { success: false, error: 'No score displays found in the SCORES scene' };
        }

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
            if (onComplete) {
                onComplete();
            }
        }, interval * idx);

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function startAutomation(data, mainWindow) {
    try {
        const { scoresItems, loopItems, config, videoPath } = data;

        if (automationInterval) {
            clearInterval(automationInterval);
            automationInterval = null;
        }
        clearPendingTimeouts();

        // Fallback for clips whose real length cannot be read (ffprobe absent
        // or unreadable file) - clips otherwise play their full duration.
        const fallbackDuration = config.videoDuration > 0 ? config.videoDuration : 15000;
        const adsCount = config.adsCount > 0 ? config.adsCount : 5;
        const scoreCount = Object.keys(scoresItems || {}).length;
        const videoItems = Object.entries(loopItems);

        if (videoItems.length === 0) {
            throw new Error('No video items found in LOOP_IND scene');
        }

        // Real clip lengths, so the rotation advances when a clip ends instead
        // of cutting it on a fixed timer.
        const durationsByName = new Map();
        try {
            const stats = await getLibraryStats(videoPath, { probe: true });
            (stats.files || []).forEach(file => {
                if (Number.isFinite(file.duration)) {
                    durationsByName.set(file.name, Math.max(1000, Math.round(file.duration * 1000)));
                }
            });
        } catch (error) {
            console.log(`Could not probe clip durations: ${error.message}`);
        }

        const clips = videoItems.map(([name, id]) => ({
            name,
            id,
            duration: durationsByName.get(name) || fallbackDuration,
            probed: durationsByName.has(name)
        }));

        // Batches of adsCount clips, balanced so every batch runs close to the
        // same total time, in a fresh random order at every start.
        const batches = buildBalancedBatches(clips, adsCount);
        batches.forEach(batch => shuffle(batch.items));
        shuffle(batches);

        // Show the plan in the UI: which clips play together, for how long,
        // and where the score blocks land.
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-event', {
                type: 'automation-plan',
                batches: batches.map(batch => ({
                    total: batch.items.reduce((sum, clip) => sum + clip.duration, 0),
                    items: batch.items.map(clip => ({
                        name: clip.name,
                        duration: clip.duration,
                        probed: clip.probed
                    }))
                })),
                scoresBetween: Boolean(config.showScores && scoreCount)
            });
        }

        // Go to LOOP_IND scene
        await obs.call('SetCurrentProgramScene', { sceneName: 'LOOP_IND' });

        // Disable all items initially
        for (const clip of clips) {
            await obs.call('SetSceneItemEnabled', {
                sceneName: 'LOOP_IND',
                sceneItemId: clip.id,
                sceneItemEnabled: false
            });
        }

        let batchIndex = 0;
        let posInBatch = 0;
        let lastShownId = null;

        // Chained timeouts instead of a fixed interval: each clip schedules
        // the next switch at its own real duration, so clips play in full.
        // Everything goes through scheduleTimeout, so Stop cancels it all.
        const playCurrent = async () => {
            const clip = batches[batchIndex].items[posInBatch];
            try {
                // Hide the previous clip; when it is the same clip (single
                // video), the off/on cycle restarts it from the beginning.
                if (lastShownId !== null) {
                    await obs.call('SetSceneItemEnabled', {
                        sceneName: 'LOOP_IND',
                        sceneItemId: lastShownId,
                        sceneItemEnabled: false
                    });
                }

                await obs.call('SetSceneItemEnabled', {
                    sceneName: 'LOOP_IND',
                    sceneItemId: clip.id,
                    sceneItemEnabled: true
                });
                lastShownId = clip.id;

                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('obs-event', {
                        type: 'automation-progress',
                        message: `Playing video: ${clip.name} `
                            + `(${(clip.duration / 1000).toFixed(1)} s, batch ${batchIndex + 1}/${batches.length})`
                    });
                    // Moves the 🔴 marker in the plan panel
                    mainWindow.webContents.send('obs-event', {
                        type: 'automation-now-playing',
                        kind: 'clip',
                        batchIndex,
                        posInBatch,
                        name: clip.name
                    });
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

            // Full clip length, then move on - scheduled even after an error
            // so one failed OBS call does not stall the whole rotation.
            scheduleTimeout(advance, clip.duration);
        };

        const advance = () => {
            posInBatch++;
            if (posInBatch < batches[batchIndex].items.length) {
                playCurrent();
                return;
            }

            // Batch finished: scores take over, videos stay paused until the
            // sequence hands the program back.
            const finishedBatch = batchIndex;
            posInBatch = 0;
            batchIndex = (batchIndex + 1) % batches.length;
            if (config.showScores && scoreCount) {
                scheduleTimeout(() => runScoreSequence(finishedBatch), config.transitionTime);
            } else {
                playCurrent();
            }
        };

        const runScoreSequence = async (finishedBatch) => {
            // Park the plan's 🔴 marker on this batch's scores block
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-event', {
                    type: 'automation-now-playing',
                    kind: 'scores',
                    afterBatchIndex: finishedBatch
                });
            }
            try {
                const shown = await showScores(
                    { scoresItems, interval: config.scoreInterval }, mainWindow, playCurrent);
                if (!shown.success) {
                    playCurrent();
                }
            } catch (error) {
                console.log(`Error showing scores: ${error.message}`);
                playCurrent();
            }
        };

        await playCurrent();

        const totals = batches.map(batch =>
            Math.round(batch.items.reduce((sum, clip) => sum + clip.duration, 0) / 1000));
        console.log(`Automation started: ${clips.length} clip(s) in ${batches.length} batch(es) `
            + `of ~[${totals.join(', ')}] s, scores ${config.showScores && scoreCount ? 'between batches' : 'disabled'}`);

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

// Whether the OBS instance the app launched is still up. Exit is observed by
// the 'exit' listener obsLauncher attaches; killed/exitCode cover the window
// before that listener runs.
function isOBSProcessAlive() {
    return Boolean(obsProcess && !obsProcess.killed && obsProcess.exitCode === null);
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
    refreshPartnersLogoSlideshow,
    cleanupOBS,
    updateSceneCollectionPaths,
    enableFullscreenProjection,
    setOBSProcess,
    getOBSProcess,
    isOBSProcessAlive,
    buildBalancedBatches
};