const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { processMediaFiles } = require('./mediaConverter');
const { updateSceneCollectionPaths, setOBSProcess } = require('./obsManager');
const {
    SCENE_COLLECTION_NAME,
    installSceneCollection,
    selectSceneCollection,
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

// OBS Launch function
async function launchOBS(mainWindow, options = {}) {
    try {
        const partnersVideosPath = path.join(__dirname, '..', 'data', 'PARTNERS_VIDEOS');

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

        // Step 3: Install the scene collection and select it
        sendProgress('importing-collection', 'Importing scene collection...');

        const installed = installSceneCollection();
        if (!installed.success) {
            return { success: false, error: installed.error };
        }

        const selected = selectSceneCollection();
        if (!selected.success) {
            return { success: false, error: selected.error };
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

        // Step 5: Launch OBS
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

        return {
            success: true,
            message: `OBS launched with scene collection "${SCENE_COLLECTION_NAME}". `
                + `WebSocket server enabled on port ${port}.`,
            websocketConfigured: websocket.success
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = {
    launchOBS
};
