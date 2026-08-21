const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const obsManager = require('./obsManager');
const { launchOBS } = require('./obsLauncher');
const { setupSystemHandlers } = require('./systemHandlers');
const { processMediaFiles } = require('./mediaConverter');
const videoLibrary = require('./videoLibrary');

// Guards the watcher pipeline: a burst of file events must not start several
// conversion + sync passes at once.
let mediaSyncInProgress = false;

// Convert anything that is not MP4 yet, then mirror the folder into LOOP_IND.
async function runMediaSync(directory, mainWindow, reason) {
    if (mediaSyncInProgress) {
        return { success: false, error: 'A media sync is already running' };
    }

    mediaSyncInProgress = true;

    const notify = (type, message) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-event', { type, message });
        }
    };

    try {
        const resolved = videoLibrary.resolveDirectory(directory);
        notify('media-sync-progress', `Media sync started (${reason})`);

        const conversion = await processMediaFiles(resolved, mainWindow);
        const converted = (conversion.results || []).filter(r => r.success);
        if (converted.length) {
            notify('media-sync-progress', `Converted ${converted.length} file(s) to MP4`);
        }

        const sync = await obsManager.syncLoopScene(resolved);

        if (!sync.success && /not connected/i.test(sync.error || '')) {
            // Converting without OBS running is a normal case (folder load), so
            // the caller must not see it as a failure.
            notify('media-sync-progress', 'OBS not connected, LOOP_IND sync skipped');

            // The folder still changed, so the stats panel must refresh
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-event', { type: 'media-library-changed', directory: resolved });
            }

            return { success: true, syncSkipped: true, added: [], removed: [], kept: 0, converted: converted.length };
        }

        if (!sync.success) {
            notify('media-sync-error', `Scene sync failed: ${sync.error}`);
        } else if (sync.added.length || sync.removed.length) {
            notify('media-sync-progress',
                `LOOP_IND updated: ${sync.added.length} added, ${sync.removed.length} removed`);
        } else {
            notify('media-sync-progress', 'LOOP_IND already up to date');
        }

        // Let the renderer refresh its stats panel and scene item ids
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-event', { type: 'media-library-changed', directory: resolved });
        }

        return sync;
    } catch (error) {
        notify('media-sync-error', `Media sync failed: ${error.message}`);
        return { success: false, error: error.message };
    } finally {
        mediaSyncInProgress = false;
    }
}

function setupIpcHandlers(mainWindow) {
    // Setup system/setup related handlers
    setupSystemHandlers(mainWindow);
    // OBS Connection handlers
    ipcMain.handle('obs-connect', async (event, address, password) => {
        return await obsManager.connectToOBS(address, password, mainWindow);
    });

    ipcMain.handle('obs-disconnect', async () => {
        return await obsManager.disconnectFromOBS();
    });

    // OBS Scene handlers
    ipcMain.handle('obs-get-scenes', async () => {
        return await obsManager.getOBSScenes();
    });

    ipcMain.handle('obs-set-scene', async (event, sceneName) => {
        return await obsManager.setOBSScene(sceneName);
    });

    ipcMain.handle('obs-initialize-scenes', async () => {
        return await obsManager.initializeOBSScenes();
    });

    // OBS Automation handlers
    ipcMain.handle('obs-show-scores', async (event, data) => {
        return await obsManager.showScores(data, mainWindow);
    });

    ipcMain.handle('obs-start-automation', async (event, data) => {
        return await obsManager.startAutomation(data, mainWindow);
    });

    ipcMain.handle('obs-stop-automation', async () => {
        return await obsManager.stopAutomation();
    });

    // OBS Launch handler. Receives the connection settings from the UI so the
    // WebSocket server is pre-configured with the exact credentials the app
    // will use to connect.
    ipcMain.handle('launch-obs', async (event, options) => {
        return await launchOBS(mainWindow, options);
    });

    // --- Media library ---------------------------------------------------

    // Native folder picker
    ipcMain.handle('select-video-directory', async (event, currentDirectory) => {
        if (!mainWindow) return { canceled: true };

        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Select the partner videos folder',
            defaultPath: videoLibrary.resolveDirectory(currentDirectory),
            properties: ['openDirectory', 'createDirectory']
        });

        if (result.canceled || !result.filePaths.length) {
            return { canceled: true };
        }

        return { canceled: false, directory: result.filePaths[0] };
    });

    ipcMain.handle('get-video-stats', async (event, directory, options) => {
        try {
            return { success: true, stats: await videoLibrary.getLibraryStats(directory, options) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('open-video-directory', async (event, directory) => {
        try {
            const resolved = videoLibrary.resolveDirectory(directory);
            fs.mkdirSync(resolved, { recursive: true });
            await shell.openPath(resolved);
            return { success: true, directory: resolved };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Convert pending media then mirror the folder into LOOP_IND
    ipcMain.handle('sync-media-library', async (event, directory) => {
        return await runMediaSync(directory, mainWindow, 'manual');
    });

    // Watchdog: re-run the sync whenever the folder changes
    ipcMain.handle('watch-video-directory', async (event, directory, enabled) => {
        if (!enabled) {
            videoLibrary.stopWatching();
            return { success: true, watching: false };
        }

        const result = videoLibrary.startWatching(directory, (change) => {
            console.log(`Media directory changed (${change.eventType}: ${change.fileName})`);
            runMediaSync(change.directory, mainWindow, `watchdog: ${change.fileName || 'change'}`);
        });

        return { ...result, watching: result.success };
    });

    // Show WebSocket setup dialog
    ipcMain.handle('show-websocket-dialog', async () => {
        if (!mainWindow) return;
        
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
            cancelId: 0
        });
        
        return result;
    });
}

module.exports = {
    setupIpcHandlers
};