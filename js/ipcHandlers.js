const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const obsManager = require('./obsManager');
const { installSceneCollection } = require('./obsConfig');
const { launchOBS } = require('./obsLauncher');
const { setupSystemHandlers } = require('./systemHandlers');
const { processMediaFiles } = require('./mediaConverter');
const videoLibrary = require('./videoLibrary');
const partnerLogos = require('./partnerLogos');

// Guards the watcher pipeline: a burst of file events must not start several
// conversion + sync passes at once.
let mediaSyncInProgress = false;

// The logo sync is re-entrant from two directions - the manual button and the
// auto-fetch that fires on an empty folder - so it is guarded the same way.
let logoSyncInProgress = false;

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
        if ((conversion.renamed || []).length) {
            notify('media-sync-progress', `Cleaned ${conversion.renamed.length} file name(s)`);
        }
        const converted = (conversion.results || []).filter(r => r.success);
        if (converted.length) {
            notify('media-sync-progress', `Converted ${converted.length} file(s) to MP4`);
        }

        const sync = await obsManager.syncLoopScene(resolved);

        if (!sync.success && /not connected/i.test(sync.error || '')) {
            // OBS is not connected: sync the collection file on disk instead,
            // so the next OBS launch already mirrors the folder.
            const offline = installSceneCollection(resolved);

            if (!offline.success) {
                notify('media-sync-error', `Offline collection sync failed: ${offline.error}`);
                return { success: false, error: offline.error };
            }

            notify('media-sync-progress',
                offline.added.length || offline.removed.length
                    ? `OBS offline: collection file updated (${offline.added.length} added, `
                        + `${offline.removed.length} removed), loads at next OBS launch`
                    : 'OBS offline: collection file already in sync with the folder');

            // The folder still changed, so the stats panel must refresh
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-event', { type: 'media-library-changed', directory: resolved });
            }

            return {
                success: true,
                offline: true,
                added: offline.added,
                removed: offline.removed,
                kept: offline.kept,
                failed: [],
                converted: converted.length
            };
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

// Download the partner logos from itjr.ca into PARTNERS_LOGO, then make OBS
// re-read the slideshow so the new files are on the board without a restart.
async function runLogoSync(directory, mainWindow, reason) {
    if (logoSyncInProgress) {
        return { success: false, error: 'A logo sync is already running' };
    }

    logoSyncInProgress = true;

    const notify = (type, message) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-event', { type, message });
        }
    };

    try {
        notify('logo-sync-progress', `Partner logo sync started (${reason})`);

        const result = await partnerLogos.syncLogos(directory, {
            onProgress: (message) => notify('logo-sync-progress', message)
        });

        const { downloaded, updated, unchanged, removed, failed } = result;
        notify('logo-sync-progress',
            `Logos: ${downloaded.length} new, ${updated.length} updated, `
            + `${unchanged.length} unchanged, ${removed.length} archived`);

        failed.forEach(f => notify('logo-sync-error', `${f.name}: ${f.error}`));

        // Only a folder that actually changed is worth reloading in OBS
        if (downloaded.length || updated.length || removed.length) {
            const refresh = await obsManager.refreshPartnersLogoSlideshow(result.directory);
            if (refresh.success) {
                notify('logo-sync-progress', `Slideshow "${refresh.inputName}" reloaded`);
            } else if (!/not connected/i.test(refresh.error || '')) {
                notify('logo-sync-error', `Could not reload the slideshow: ${refresh.error}`);
            }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-event', { type: 'logo-library-changed', directory: result.directory });
        }

        return result;
    } catch (error) {
        notify('logo-sync-error', `Logo sync failed: ${error.message}`);
        return { success: false, error: error.message };
    } finally {
        logoSyncInProgress = false;
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

    // --- Partner logos ---------------------------------------------------

    ipcMain.handle('get-logo-stats', async (event, directory) => {
        try {
            return { success: true, stats: partnerLogos.getLogoStats(directory) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('sync-partner-logos', async (event, directory, reason) => {
        return await runLogoSync(directory, mainWindow, reason || 'manual');
    });

    ipcMain.handle('open-logo-directory', async (event, directory) => {
        try {
            const resolved = partnerLogos.resolveDirectory(directory);
            fs.mkdirSync(resolved, { recursive: true });
            await shell.openPath(resolved);
            return { success: true, directory: resolved };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('select-logo-directory', async (event, currentDirectory) => {
        if (!mainWindow) return { canceled: true };

        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Select the partner logos folder',
            defaultPath: partnerLogos.resolveDirectory(currentDirectory),
            properties: ['openDirectory', 'createDirectory']
        });

        if (result.canceled || !result.filePaths.length) {
            return { canceled: true };
        }

        return { canceled: false, directory: result.filePaths[0] };
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