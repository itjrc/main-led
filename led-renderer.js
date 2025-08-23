const { ipcRenderer } = require('electron');

// LED Management state
let obsConnection = null;
let automationRunning = false;
let automationInterval = null;
let scoresItemsNameIds = {};
let loopIndItems = {};

// DOM Elements
const connectionStatus = document.getElementById('connection-status');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const sceneList = document.getElementById('scene-list');
const logOutput = document.getElementById('log-output');

// Configuration getters
const getConfig = () => ({
    obsAddress: document.getElementById('obs-address').value,
    obsPassword: document.getElementById('obs-password').value,
    showScores: document.getElementById('show-scores').checked,
    scoreInterval: parseInt(document.getElementById('score-interval').value),
    transitionTime: parseInt(document.getElementById('transition-time').value),
    adsCount: parseInt(document.getElementById('ads-count').value),
    videoPath: document.getElementById('video-path').value
});

// Utility functions
function addLog(message, type = 'info') {
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${type}`;
    logEntry.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
    
    // Insert at the top instead of appending to bottom
    if (logOutput.firstChild) {
        logOutput.insertBefore(logEntry, logOutput.firstChild);
    } else {
        logOutput.appendChild(logEntry);
    }
    
    // Keep only the latest 50 log entries to prevent memory issues
    const logEntries = logOutput.querySelectorAll('.log-entry');
    if (logEntries.length > 50) {
        logOutput.removeChild(logEntries[logEntries.length - 1]);
    }
}

function updateConnectionStatus(status, message) {
    connectionStatus.className = `connection-status ${status}`;
    connectionStatus.textContent = message;
    
    const isConnected = status === 'connected';
    connectBtn.disabled = isConnected;
    disconnectBtn.disabled = !isConnected;
    
    // Enable/disable other buttons based on connection
    const controlButtons = ['refresh-scenes-btn', 'goto-scores-btn', 'goto-loop-btn', 
                           'show-scores-btn', 'init-scenes-btn', 'start-automation-btn'];
    controlButtons.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = !isConnected;
    });
}

function updateSceneList(scenes, currentScene) {
    sceneList.innerHTML = '';
    
    if (!scenes || scenes.length === 0) {
        sceneList.innerHTML = '<div style="padding: 20px; text-align: center; color: #6c757d;">No scenes found</div>';
        return;
    }
    
    scenes.forEach(scene => {
        const sceneItem = document.createElement('div');
        sceneItem.className = `scene-item ${scene.sceneName === currentScene ? 'active' : ''}`;
        sceneItem.innerHTML = `
            <span>${scene.sceneName}</span>
            <button class="btn btn-primary" style="padding: 5px 10px; margin: 0;" 
                    onclick="goToScene('${scene.sceneName}')">Switch</button>
        `;
        sceneList.appendChild(sceneItem);
    });
}

// OBS Launch and Connection functions
async function launchOBS() {
    try {
        addLog('Launching OBS Studio...', 'info');
        const result = await ipcRenderer.invoke('launch-obs');
        
        if (result.success) {
            addLog('OBS Studio launched successfully', 'success');
            if (result.message) {
                addLog(result.message, 'warning');
            }
            addLog('Waiting for OBS to initialize...', 'info');
            
            // Wait a bit for OBS to start, then try to connect
            setTimeout(() => {
                addLog('Attempting automatic connection...', 'info');
                connectToOBS();
            }, 8000);
        } else {
            addLog(`Failed to launch OBS: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`Error launching OBS: ${error.message}`, 'error');
    }
}

async function connectToOBS() {
    const config = getConfig();
    updateConnectionStatus('connecting', 'Connecting to OBS...');
    addLog('Attempting to connect to OBS...', 'info');
    
    try {
        const result = await ipcRenderer.invoke('obs-connect', config.obsAddress, config.obsPassword);
        
        if (result.success) {
            updateConnectionStatus('connected', 'Connected to OBS');
            addLog('Successfully connected to OBS', 'success');
            await refreshScenes();
            await initializeScenes();
        } else {
            updateConnectionStatus('disconnected', 'Connection failed');
            addLog(`Connection failed: ${result.error}`, 'error');
            
            // Show WebSocket setup dialog on connection failure
            await showWebSocketSetupDialog();
        }
    } catch (error) {
        updateConnectionStatus('disconnected', 'Connection error');
        addLog(`Connection error: ${error.message}`, 'error');
        
        // Show WebSocket setup dialog on connection error
        await showWebSocketSetupDialog();
    }
}

async function showWebSocketSetupDialog() {
    try {
        const result = await ipcRenderer.invoke('show-websocket-dialog');
        
        if (result.buttonIndex === 1) {
            // User clicked "Launch OBS"
            await launchOBS();
        }
    } catch (error) {
        addLog(`Error showing dialog: ${error.message}`, 'error');
    }
}

async function disconnectFromOBS() {
    try {
        await ipcRenderer.invoke('obs-disconnect');
        updateConnectionStatus('disconnected', 'Disconnected from OBS');
        addLog('Disconnected from OBS', 'info');
        sceneList.innerHTML = '<div style="padding: 20px; text-align: center; color: #6c757d;">Connect to OBS to view scenes</div>';
        
        if (automationRunning) {
            stopAutomation();
        }
    } catch (error) {
        addLog(`Disconnect error: ${error.message}`, 'error');
    }
}

async function refreshScenes() {
    try {
        const result = await ipcRenderer.invoke('obs-get-scenes');
        if (result.success) {
            updateSceneList(result.scenes, result.currentScene);
            addLog(`Loaded ${result.scenes.length} scenes`, 'success');
        } else {
            addLog(`Failed to get scenes: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`Error getting scenes: ${error.message}`, 'error');
    }
}

async function goToScene(sceneName) {
    try {
        const result = await ipcRenderer.invoke('obs-set-scene', sceneName);
        if (result.success) {
            addLog(`Switched to scene: ${sceneName}`, 'success');
            await refreshScenes(); // Refresh to update active scene
        } else {
            addLog(`Failed to switch to ${sceneName}: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`Error switching scene: ${error.message}`, 'error');
    }
}

async function initializeScenes() {
    try {
        addLog('Initializing scene items...', 'info');
        
        const result = await ipcRenderer.invoke('obs-initialize-scenes');
        if (result.success) {
            scoresItemsNameIds = result.scoresItems || {};
            loopIndItems = result.loopItems || {};
            
            addLog(`Initialized ${Object.keys(scoresItemsNameIds).length} score items`, 'success');
            addLog(`Initialized ${Object.keys(loopIndItems).length} loop items`, 'success');
        } else {
            addLog(`Initialization failed: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`Initialization error: ${error.message}`, 'error');
    }
}

async function showScores() {
    try {
        const config = getConfig();
        addLog('Starting score display sequence...', 'info');
        
        const result = await ipcRenderer.invoke('obs-show-scores', {
            scoresItems: scoresItemsNameIds,
            interval: config.scoreInterval
        });
        
        if (result.success) {
            addLog('Score display sequence started', 'success');
        } else {
            addLog(`Score display failed: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`Error showing scores: ${error.message}`, 'error');
    }
}

async function startAutomation() {
    if (automationRunning) {
        addLog('Automation is already running', 'warning');
        return;
    }
    
    try {
        const config = getConfig();
        addLog('Starting LED automation...', 'info');
        
        const result = await ipcRenderer.invoke('obs-start-automation', {
            scoresItems: scoresItemsNameIds,
            loopItems: loopIndItems,
            config: config
        });
        
        if (result.success) {
            automationRunning = true;
            document.getElementById('start-automation-btn').disabled = true;
            document.getElementById('stop-automation-btn').disabled = false;
            addLog('LED automation started successfully', 'success');
        } else {
            addLog(`Automation failed to start: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`Error starting automation: ${error.message}`, 'error');
    }
}

async function stopAutomation() {
    try {
        await ipcRenderer.invoke('obs-stop-automation');
        automationRunning = false;
        document.getElementById('start-automation-btn').disabled = false;
        document.getElementById('stop-automation-btn').disabled = true;
        addLog('LED automation stopped', 'info');
    } catch (error) {
        addLog(`Error stopping automation: ${error.message}`, 'error');
    }
}

function goBack() {
    window.close();
}

// Toggle score settings based on checkbox
function toggleScoreSettings() {
    const showScores = document.getElementById('show-scores').checked;
    const scoreIntervalSetting = document.getElementById('score-interval-setting');
    const adsCountSetting = document.getElementById('ads-count-setting');
    const showScoresBtn = document.getElementById('show-scores-btn');
    
    if (showScores) {
        scoreIntervalSetting.style.opacity = '1';
        adsCountSetting.style.opacity = '1';
        document.getElementById('score-interval').disabled = false;
        document.getElementById('ads-count').disabled = false;
        if (showScoresBtn) showScoresBtn.disabled = false;
        addLog('Score display enabled in automation', 'info');
    } else {
        scoreIntervalSetting.style.opacity = '0.5';
        adsCountSetting.style.opacity = '0.5';
        document.getElementById('score-interval').disabled = true;
        document.getElementById('ads-count').disabled = true;
        if (showScoresBtn) showScoresBtn.disabled = true;
        addLog('Score display disabled - partners only mode', 'info');
    }
}

// Initialize the interface
document.addEventListener('DOMContentLoaded', () => {
    addLog('LED Management interface ready', 'success');
    
    // Set up score toggle event listener
    const showScoresCheckbox = document.getElementById('show-scores');
    if (showScoresCheckbox) {
        showScoresCheckbox.addEventListener('change', toggleScoreSettings);
        toggleScoreSettings(); // Set initial state
    }
});

// Listen for OBS events
ipcRenderer.on('obs-event', (event, data) => {
    switch (data.type) {
        case 'scene-changed':
            addLog(`Scene changed to: ${data.sceneName}`, 'info');
            refreshScenes();
            break;
        case 'automation-progress':
            addLog(data.message, 'info');
            break;
        case 'automation-error':
            addLog(data.message, 'error');
            break;
        case 'connection-closed':
            updateConnectionStatus('disconnected', 'Connection lost');
            addLog('Connection to OBS lost', 'error');
            if (automationRunning) {
                stopAutomation();
            }
            break;
    }
});