const { app, BrowserWindow } = require('electron');
const path = require('path');
const { setupIpcHandlers } = require('./js/ipcHandlers');
const { cleanupOBS, updateSceneCollectionPaths } = require('./js/obsManager');

let mainWindow;

// Create the main application window
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    mainWindow.loadFile('index.html');

    // Setup IPC handlers with reference to mainWindow
    setupIpcHandlers(mainWindow);

    // Open DevTools in development. `npm run dev` passes --dev; NODE_ENV is
    // supported too for anyone launching electron directly.
    const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// App event handlers
app.whenReady().then(() => {
    // Update scene collection paths on startup
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

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Handle app quit
app.on('before-quit', () => {
    cleanupOBS();
});

// Export mainWindow for use in other modules
module.exports = { mainWindow };