// Global variables
let downloadInProgress = {};
let obsManager = null;
// The tab auto-switches to LED Control once per session when every dependency
// is installed; afterwards the user's tab choice is left alone.
let autoSwitchedToLedControl = false;

// Check if electronAPI is available (it should be exposed by preload.js)
if (!window.electronAPI) {
    console.error('electronAPI not available. Make sure preload.js is loaded correctly.');
}

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

async function showAppVersion() {
    const badge = document.getElementById('app-version');
    if (!badge) return;

    try {
        const info = await window.electronAPI.ipcRenderer.invoke('get-app-info');
        badge.textContent = `v${info.version}`;
        badge.title = `OBS Main LED v${info.version}\n`
            + `Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}\n`
            + `${info.platform}${info.packaged ? '' : ' · development'}`;
    } catch (error) {
        badge.textContent = 'v?';
        console.error('Error reading app version:', error);
    }
}

// Informational only: Node ships inside Electron, so there is nothing to install
// and nothing to gate on. See checkAllSystemsReady().
async function checkNodeVersion() {
    const versionElement = document.getElementById('node-version');
    const statusElement = document.getElementById('node-status');
    const indicatorElement = document.getElementById('node-indicator');

    try {
        const result = await window.electronAPI.ipcRenderer.invoke('get-node-version');
        versionElement.textContent = `Version: ${result.version} (bundled)`;
        statusElement.textContent = 'Bundled';
        indicatorElement.className = 'status-indicator installed';
    } catch (error) {
        console.error('Error reading Node version:', error);
        versionElement.textContent = 'Bundled with Electron';
        statusElement.textContent = 'Bundled';
        indicatorElement.className = 'status-indicator installed';
    }
}

async function checkAppStatus(appName) {
    try {
        const exists = await window.electronAPI.ipcRenderer.invoke('check-app-exists', appName);
        const versionResult = await window.electronAPI.ipcRenderer.invoke('get-app-version', appName);
        
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
        const result = await window.electronAPI.ipcRenderer.invoke('download-app', appName);
        
        if (result.success) {
            progressElement.innerHTML = '<div class="progress-message">✅ Download completed successfully!</div>';
            setTimeout(async () => {
                progressElement.style.display = 'none';
                // Await the status refreshes: checkAllSystemsReady reads the
                // indicators they update, and deciding on stale ones would
                // keep LED Control locked after the last install.
                await checkAppStatus(appName);
                if (appName === 'ffmpeg') {
                    await checkAppStatus('ffprobe');
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
    await window.electronAPI.ipcRenderer.invoke('open-folder', folderPath);
}

async function refreshAll() {
    await checkNodeVersion();
    await checkAppStatus('obs');
    await checkAppStatus('ffmpeg');
    await checkAppStatus('ffprobe');
    checkAllSystemsReady();
}

function checkAllSystemsReady() {
    const obsIndicator = document.getElementById('obs-indicator');
    const ffmpegIndicator = document.getElementById('ffmpeg-indicator');
    const ffprobeIndicator = document.getElementById('ffprobe-indicator');
    const ledControlTab = document.getElementById('led-control-tab');

    // Node is not part of the gate: it comes with Electron, so it is always
    // present. Requiring it here left LED Control disabled on any machine
    // without a standalone Node install.
    const allReady = obsIndicator.classList.contains('installed') && 
                     ffmpegIndicator.classList.contains('installed') && 
                     ffprobeIndicator.classList.contains('installed');
    
    if (allReady) {
        ledControlTab.disabled = false;
        ledControlTab.style.opacity = '1';
        ledControlTab.style.cursor = 'pointer';

        // Everything is installed: go straight to the control board instead of
        // leaving the user on a Setup tab with nothing left to set up.
        if (!autoSwitchedToLedControl) {
            autoSwitchedToLedControl = true;
            switchTab('led-control');
        }
    } else {
        ledControlTab.disabled = true;
        ledControlTab.style.opacity = '0.5';
        ledControlTab.style.cursor = 'not-allowed';
    }
}

window.electronAPI.ipcRenderer.on('download-progress', (data) => {
    const progressElement = document.getElementById(`${data.app}-progress`);
    if (progressElement) {
        let message = '';
        switch (data.status) {
            case 'downloading':
                message = typeof data.percent === 'number'
                    ? `📥 Downloading... ${data.percent}%`
                    : '📥 Downloading...';
                break;
            case 'extracting':
                message = typeof data.percent === 'number'
                    ? `📦 Extracting files... ${data.percent}%`
                    : '📦 Extracting files...';
                break;
            case 'completed':
                message = '✅ Installation completed!';
                break;
            case 'failed':
                message = '❌ Installation failed';
                break;
            default:
                message = data.status;
        }
        progressElement.innerHTML = `<div class="progress-message">${message}</div>`;
    }
});

window.addEventListener('DOMContentLoaded', () => {
    showAppVersion();
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