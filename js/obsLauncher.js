const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { processMediaFiles } = require('./mediaConverter');
const { updateSceneCollectionPaths, setOBSProcess } = require('./obsManager');

// OBS Launch function
async function launchOBS(mainWindow) {
    try {
        const partnersVideosPath = path.join(__dirname, '..', 'data', 'PARTNERS_VIDEOS');

        // Step 1: Check and convert non-MP4 videos to MP4
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-launch-progress', {
                step: 'checking-videos',
                message: 'Checking for non-MP4 videos in PARTNERS_VIDEOS...'
            });
        }

        console.log('=== OBS Launch: Starting media conversion check ===');
        
        // Process all media files (videos and images)
        await processMediaFiles(partnersVideosPath, mainWindow);

        // Step 2: Prepare OBS launch
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-launch-progress', {
                step: 'preparing-obs',
                message: 'Preparing OBS Studio launch...'
            });
        }

        console.log('=== OBS Launch: Starting OBS preparation ===');
        const obsExePath = path.join(__dirname, '..', 'provider', 'obs', 'bin', '64bit', 'obs64.exe');
        const obsDir = path.join(__dirname, '..', 'provider', 'obs');
        const sceneCollectionName = 'obs-scene-collection';
        const sceneCollectionSourcePath = path.join(__dirname, '..', 'data', 'obs-scene-collection.json');
        const sceneCollectionDestDir = path.join(__dirname, '..', 'provider', 'obs', 'config', 'obs-studio', 'basic', 'scenes');
        const sceneCollectionDestPath = path.join(sceneCollectionDestDir, `${sceneCollectionName}.json`);

        if (!fs.existsSync(obsExePath)) {
            return { success: false, error: 'OBS Studio not found. Please download OBS first.' };
        }

        // Create the destination directory if it doesn't exist
        if (!fs.existsSync(sceneCollectionDestDir)) {
            fs.mkdirSync(sceneCollectionDestDir, { recursive: true });
        }

        // Copy the scene collection file
        if (fs.existsSync(sceneCollectionSourcePath)) {
            fs.copyFileSync(sceneCollectionSourcePath, sceneCollectionDestPath);
            
            // Update paths in the copied scene collection to be dynamic
            console.log('Updating scene collection paths to be dynamic...');
            updateSceneCollectionPaths();
        }

        // Launch OBS with scene collection import if available
        const obsArgs = ['--portable', '--collection', sceneCollectionName];
        let sceneMessage = '\\nScene collection will be loaded.';

        const obsExecutableDir = path.join(__dirname, '..', 'provider', 'obs', 'bin', '64bit');

        // Step 3: Launch OBS
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('obs-launch-progress', {
                step: 'launching-obs',
                message: 'Launching OBS Studio...'
            });
        }

        console.log(`Launching OBS with args: ${obsArgs.join(' ')} from directory: ${obsExecutableDir} using executable: ${obsExePath}`);

        // Launch OBS with scene collection import from the correct directory
        const obsProcess = spawn(obsExePath, obsArgs, {
            detached: false, // Keep attached so we can track it
            stdio: 'ignore',
            cwd: obsExecutableDir
        });
        
        // Store the process reference
        setOBSProcess(obsProcess);
        
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
}

module.exports = {
    launchOBS
};