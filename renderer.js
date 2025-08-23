const { ipcRenderer } = require('electron');

// Global variables
let downloadInProgress = {};
let obsManager = null;

// Expose electron API for modules
window.electronAPI = {
    invoke: ipcRenderer.invoke.bind(ipcRenderer),
    ipcRenderer: ipcRenderer
};

// Tab switching functionality
function switchTab(tabName) {
    // Remove active class from all tabs and contents
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    // Add active class to selected tab and content
    if (tabName === 'setup') {
        document.querySelector('[onclick="switchTab(\'setup\')"]').classList.add('active');
        document.getElementById('setup-tab').classList.add('active');
    } else if (tabName === 'led-control') {
        document.querySelector('[onclick="switchTab(\'led-control\')"]').classList.add('active');
        document.getElementById('led-control-tab-content').classList.add('active');
        
        // Initialize OBS Manager if not already done
        if (!obsManager) {
            obsManager = new OBSManager();
            window.obsManager = obsManager;
        }
    }
}

// Make switchTab global
window.switchTab = switchTab;

// Toggle score settings functionality
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
    } else {
        scoreIntervalSetting.style.opacity = '0.5';
        adsCountSetting.style.opacity = '0.5';
        document.getElementById('score-interval').disabled = true;
        document.getElementById('ads-count').disabled = true;
        if (showScoresBtn) showScoresBtn.disabled = true;
    }
}

async function checkNodeVersion() {
    try {
        const result = await ipcRenderer.invoke('get-node-version');
        const versionElement = document.getElementById('node-version');
        const statusElement = document.getElementById('node-status');
        const indicatorElement = document.getElementById('node-indicator');
        
        if (result.version) {
            versionElement.textContent = `Version: ${result.version}`;
            statusElement.textContent = 'Installed';
            indicatorElement.className = 'status-indicator installed';
        } else {
            versionElement.textContent = result.error || 'Not found';
            statusElement.textContent = 'Not Found';
            indicatorElement.className = 'status-indicator missing';
        }
    } catch (error) {
        console.error('Error checking Node version:', error);
    }
}

async function checkAppStatus(appName) {
    try {
        const exists = await ipcRenderer.invoke('check-app-exists', appName);
        const versionResult = await ipcRenderer.invoke('get-app-version', appName);
        
        const versionElement = document.getElementById(`${appName}-version`);
        const indicatorElement = document.getElementById(`${appName}-indicator`);
        const btnElement = document.getElementById(`${appName}-btn`);
        
        if (exists && versionResult.version) {
            versionElement.textContent = `Version: ${versionResult.version}`;
            indicatorElement.className = 'status-indicator installed';
            if (btnElement) {
                btnElement.textContent = 'Reinstall';
                btnElement.className = 'btn btn-secondary';
                btnElement.disabled = false;
            }
        } else {
            versionElement.textContent = versionResult.error || 'Not found';
            indicatorElement.className = 'status-indicator missing';
            if (btnElement) {
                btnElement.textContent = 'Download';
                btnElement.className = 'btn btn-primary';
                btnElement.disabled = false;
            }
        }
    } catch (error) {
        console.error(`Error checking ${appName} status:`, error);
        const versionElement = document.getElementById(`${appName}-version`);
        versionElement.textContent = 'Error checking status';
    }
}

async function downloadApp(appName) {
    if (downloadInProgress[appName]) return;
    
    downloadInProgress[appName] = true;
    
    const btnElement = document.getElementById(`${appName}-btn`);
    const progressElement = document.getElementById(`${appName}-progress`);
    const indicatorElement = document.getElementById(`${appName}-indicator`);
    
    btnElement.disabled = true;
    btnElement.textContent = 'Downloading...';
    indicatorElement.className = 'status-indicator downloading';
    progressElement.style.display = 'block';
    progressElement.innerHTML = '<div class="progress-message">Preparing download...</div>';
    
    try {
        const result = await ipcRenderer.invoke('download-app', appName);
        
        if (result.success) {
            progressElement.innerHTML = '<div class="progress-message">✅ Download completed successfully!</div>';
            setTimeout(() => {
                progressElement.style.display = 'none';
                checkAppStatus(appName);
                if (appName === 'ffmpeg') {
                    checkAppStatus('ffprobe');
                }
                checkAllSystemsReady();
            }, 2000);
        } else {
            progressElement.innerHTML = `<div class="progress-message">❌ Error: ${result.error}</div>`;
            btnElement.disabled = false;
            btnElement.textContent = 'Download';
            indicatorElement.className = 'status-indicator missing';
        }
    } catch (error) {
        progressElement.innerHTML = `<div class="progress-message">❌ Error: ${error.message}</div>`;
        btnElement.disabled = false;
        btnElement.textContent = 'Download';
        indicatorElement.className = 'status-indicator missing';
    } finally {
        downloadInProgress[appName] = false;
    }
}

async function openFolder(folderPath) {
    await ipcRenderer.invoke('open-folder', folderPath);
}

async function refreshAll() {
    await checkNodeVersion();
    await checkAppStatus('obs');
    await checkAppStatus('ffmpeg');
    await checkAppStatus('ffprobe');
    checkAllSystemsReady();
}

function checkAllSystemsReady() {
    const nodeIndicator = document.getElementById('node-indicator');
    const obsIndicator = document.getElementById('obs-indicator');
    const ffmpegIndicator = document.getElementById('ffmpeg-indicator');
    const ffprobeIndicator = document.getElementById('ffprobe-indicator');
    const ledControlTab = document.getElementById('led-control-tab');
    
    const allReady = nodeIndicator.classList.contains('installed') && 
                     obsIndicator.classList.contains('installed') && 
                     ffmpegIndicator.classList.contains('installed') && 
                     ffprobeIndicator.classList.contains('installed');
    
    if (allReady) {
        ledControlTab.disabled = false;
        ledControlTab.style.opacity = '1';
        ledControlTab.style.cursor = 'pointer';
    } else {
        ledControlTab.disabled = true;
        ledControlTab.style.opacity = '0.5';
        ledControlTab.style.cursor = 'not-allowed';
    }
}

ipcRenderer.on('download-progress', (event, data) => {
    const progressElement = document.getElementById(`${data.app}-progress`);
    if (progressElement) {
        let message = '';
        switch (data.status) {
            case 'downloading':
                message = '📥 Downloading...';
                break;
            case 'extracting':
                message = '📦 Extracting files...';
                break;
            case 'completed':
                message = '✅ Installation completed!';
                break;
            default:
                message = data.status;
        }
        progressElement.innerHTML = `<div class="progress-message">${message}</div>`;
    }
});

window.addEventListener('DOMContentLoaded', () => {
    refreshAll();
    
    // Initialize UI components
    Button.create('.btn');
    Card.create('.card');
    
    // Set up toggle event listeners
    const showScoresCheckbox = document.getElementById('show-scores');
    if (showScoresCheckbox) {
        showScoresCheckbox.addEventListener('change', toggleScoreSettings);
        toggleScoreSettings(); // Set initial state
    }
    
    // Set up tab switching for disabled tabs
    const ledControlTab = document.getElementById('led-control-tab');
    if (ledControlTab) {
        ledControlTab.addEventListener('click', (e) => {
            if (ledControlTab.disabled) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
    }
});

// Global function exports
window.downloadApp = downloadApp;
window.openFolder = openFolder;
window.refreshAll = refreshAll;
window.toggleScoreSettings = toggleScoreSettings;