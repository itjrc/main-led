const { ipcMain, dialog } = require('electron');
const obsManager = require('./obsManager');
const { launchOBS } = require('./obsLauncher');
const { setupSystemHandlers } = require('./systemHandlers');

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

    // OBS Launch handler
    ipcMain.handle('launch-obs', async () => {
        return await launchOBS(mainWindow);
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