const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { processMediaFiles } = require('./mediaConverter');
const { resolveDirectory } = require('./videoLibrary');
const { updateSceneCollectionPaths, setOBSProcess, isOBSProcessAlive } = require('./obsManager');
const {
    SCENE_COLLECTION_NAME,
    installSceneCollection,
    selectSceneCollection,
    configureVideoCanvas,
    clearSafeModeSentinel,
    configureWebSocketServer
} = require('./obsConfig');

const DEFAULT_WEBSOCKET_PORT = 4455;
const DEFAULT_WEBSOCKET_PASSWORD = '123456';

// Pull the port out of a ws://host:port address supplied by the UI
function parsePort(address) {
    try {
        const port = parseInt(new URL(address).port, 10);
        return Number.isInteger(port) && port > 0 ? port : DEFAULT_WEBSOCKET_PORT;
    } catch (error) {
        return DEFAULT_WEBSOCKET_PORT;
    }
}

// Guards the whole launch sequence, not just the spawn: two clicks in quick
// succession would otherwise both pass the process check while the first
// conversion pass is still running.
let launchInProgress = false;

// OBS Launch function
async function launchOBS(mainWindow, options = {}) {
    // One OBS at a time: a second portable instance would fight over the same
    // profile, collection and websocket port.
    if (launchInProgress) {
        return { success: false, error: 'An OBS launch is already in progress' };
    }
    if (isOBSProcessAlive()) {
        return { success: false, error: 'OBS is already running. Close it before launching it again.' };
    }

    launchInProgress = true;
    try {
        // The folder the Media Library panel points at, not a hardcoded one
        const partnersVideosPath = resolveDirectory(options.videoPath);

        const sendProgress = (step, message) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-launch-progress', { step, message });
            }
        };

        // Step 1: Check and convert non-MP4 videos to MP4
        sendProgress('checking-videos', 'Checking for non-MP4 videos in PARTNERS_VIDEOS...');

        console.log('=== OBS Launch: Starting media conversion check ===');

        // Process all media files (videos and images)
        await processMediaFiles(partnersVideosPath, mainWindow);

        // Step 2: Prepare OBS launch
        sendProgress('preparing-obs', 'Preparing OBS Studio launch...');

        console.log('=== OBS Launch: Starting OBS preparation ===');
        const obsExePath = path.join(__dirname, '..', 'provider', 'obs', 'bin', '64bit', 'obs64.exe');

        if (!fs.existsSync(obsExePath)) {
            return { success: false, error: 'OBS Studio not found. Please download OBS first.' };
        }

        // Rewrite media paths for the current project location before copying
        console.log('Updating scene collection paths to be dynamic...');
        updateSceneCollectionPaths();

        // Step 3: Install the scene collection and select it. LOOP_IND is
        // rebuilt from the media folder, so OBS opens on the videos that are
        // actually there instead of whatever the template last shipped.
        sendProgress('importing-collection', 'Importing scene collection...');

        const installed = installSceneCollection(partnersVideosPath);
        if (!installed.success) {
            return { success: false, error: installed.error };
        }

        const selected = selectSceneCollection();
        if (!selected.success) {
            return { success: false, error: selected.error };
        }

        // The LED board is 1920x1080; a fresh OBS profile would default its
        // canvas to the monitor's resolution instead. Not fatal on failure:
        // connectToOBS re-enforces it over WebSocket after connecting.
        const canvas = configureVideoCanvas();
        if (!canvas.success) {
            console.log(canvas.error);
        }

        // Step 4: Enable the WebSocket server with the credentials the UI uses
        sendProgress('configuring-websocket', 'Enabling OBS WebSocket server...');

        const port = parsePort(options.address);
        const password = typeof options.password === 'string' && options.password.length
            ? options.password
            : DEFAULT_WEBSOCKET_PASSWORD;

        const websocket = configureWebSocketServer(port, password);
        if (!websocket.success) {
            // Not fatal: the user can still enable it by hand in OBS
            console.log(websocket.error);
        }

        // Step 5: Launch OBS. Clear the crash sentinel first, otherwise OBS
        // opens a safe-mode prompt that also disables its WebSocket server.
        clearSafeModeSentinel();

        sendProgress('launching-obs', 'Launching OBS Studio...');

        const obsArgs = ['--portable', '--collection', SCENE_COLLECTION_NAME];
        const obsExecutableDir = path.join(__dirname, '..', 'provider', 'obs', 'bin', '64bit');

        console.log(`Launching OBS with args: ${obsArgs.join(' ')} from directory: ${obsExecutableDir}`);

        // OBS must run from its own bin directory to find its libraries
        const obsProcess = spawn(obsExePath, obsArgs, {
            detached: false, // Keep attached so we can track it
            stdio: 'ignore',
            cwd: obsExecutableDir
        });

        // Store the process reference
        setOBSProcess(obsProcess);

        // Tell the UI when OBS goes away, however it exits, so the Launch
        // button can re-arm.
        obsProcess.on('exit', (code) => {
            console.log(`OBS process exited (code ${code})`);
            setOBSProcess(null);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-event', { type: 'obs-process-exited' });
            }
        });

        return {
            success: true,
            message: `OBS launched with scene collection "${SCENE_COLLECTION_NAME}". `
                + `WebSocket server enabled on port ${port}.`,
            websocketConfigured: websocket.success
        };
    } catch (error) {
        return { success: false, error: error.message };
    } finally {
        launchInProgress = false;
    }
}

module.exports = {
    launchOBS
};
