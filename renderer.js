const { ipcRenderer } = require('electron');

let downloadInProgress = {};

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
    const ledSection = document.getElementById('led-management-section');
    
    const allReady = nodeIndicator.classList.contains('installed') && 
                     obsIndicator.classList.contains('installed') && 
                     ffmpegIndicator.classList.contains('installed') && 
                     ffprobeIndicator.classList.contains('installed');
    
    if (allReady) {
        ledSection.style.display = 'block';
    } else {
        ledSection.style.display = 'none';
    }
}

async function openLedManagement() {
    await ipcRenderer.invoke('open-led-management');
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
});

window.downloadApp = downloadApp;
window.openFolder = openFolder;
window.refreshAll = refreshAll;
window.openLedManagement = openLedManagement;