// OBS Management Module
class OBSManager {
    constructor() {
        this.isConnected = false;
        this.isAutomationRunning = false;
        this.scoresItems = {};
        this.loopItems = {};
        this.connectionStatus = null;
        this.logContainer = null;
        this.init();
    }

    init() {
        this.connectionStatus = document.getElementById('connection-status');
        this.logContainer = document.getElementById('log-output');
        this.setupEventListeners();
        this.addLog('OBS Manager initialized', 'info');
    }

    setupEventListeners() {
        // Listen for IPC events from main process
        if (window.electronAPI && window.electronAPI.ipcRenderer) {
            window.electronAPI.ipcRenderer.on('obs-event', (data) => {
                this.handleOBSEvent(data);
            });
            
            window.electronAPI.ipcRenderer.on('obs-launch-progress', (data) => {
                this.handleLaunchProgress(data);
            });
        }
    }

    handleOBSEvent(data) {
        switch (data.type) {
            case 'scene-changed':
                this.addLog(`Scene changed to: ${data.sceneName}`, 'info');
                break;
            case 'automation-progress':
                this.addLog(data.message, 'info');
                break;
            case 'automation-error':
                this.addLog(data.message, 'error');
                break;
            case 'connection-closed':
                this.updateConnectionStatus('disconnected', 'Connection lost');
                this.addLog('Connection to OBS lost', 'error');
                if (this.isAutomationRunning) {
                    this.stopAutomation();
                }
                break;
        }
    }

    handleLaunchProgress(data) {
        // Update progress dialog
        this.updateLaunchProgress(data.step, data.message);
        
        // Add to log
        this.addLog(data.message, 'info');
    }

    async launchOBS() {
        try {
            // Show progress dialog
            this.showLaunchProgress();
            
            this.addLog('Launching OBS Studio...', 'info');

            // Hand the launcher our connection settings so it can enable the
            // WebSocket server with matching credentials
            const config = this.getConfig();
            const result = await window.electronAPI.ipcRenderer.invoke('launch-obs', {
                address: config.obsAddress,
                password: config.obsPassword
            });
            
            // Hide progress dialog
            this.hideLaunchProgress();
            
            if (result.success) {
                this.addLog('OBS Studio launched successfully', 'success');
                if (result.message) {
                    this.addLog(result.message, 'warning');
                }
                this.addLog('Waiting for OBS to initialize...', 'info');
                
                // Wait a bit for OBS to start, then try to connect
                setTimeout(() => {
                    this.addLog('Attempting automatic connection...', 'info');
                    this.connectToOBS();
                }, 8000);
            } else {
                this.addLog(`Failed to launch OBS: ${result.error}`, 'error');
            }
        } catch (error) {
            this.hideLaunchProgress();
            this.addLog(`Error launching OBS: ${error.message}`, 'error');
        }
    }

    async connectToOBS() {
        const config = this.getConfig();
        this.updateConnectionStatus('connecting', 'Connecting to OBS...');
        this.addLog('Attempting to connect to OBS...', 'info');
        
        try {
            const result = await window.electronAPI.ipcRenderer.invoke('obs-connect', config.obsAddress, config.obsPassword);
            
            if (result.success) {
                this.isConnected = true;
                this.updateConnectionStatus('connected', 'Connected to OBS');
                this.addLog('Successfully connected to OBS', 'success');
                await this.refreshScenes();
                await this.initializeScenes();
            } else {
                this.isConnected = false;
                this.updateConnectionStatus('disconnected', 'Connection failed');
                this.addLog(`Connection failed: ${result.error}`, 'error');
                await this.showWebSocketSetupDialog();
            }
        } catch (error) {
            this.isConnected = false;
            this.updateConnectionStatus('disconnected', 'Connection error');
            this.addLog(`Connection error: ${error.message}`, 'error');
            await this.showWebSocketSetupDialog();
        }
    }

    async disconnectFromOBS() {
        try {
            await window.electronAPI.ipcRenderer.invoke('obs-disconnect');
            this.isConnected = false;
            this.updateConnectionStatus('disconnected', 'Disconnected from OBS');
            this.addLog('Disconnected from OBS', 'info');
            
            if (this.isAutomationRunning) {
                this.stopAutomation();
            }
        } catch (error) {
            this.addLog(`Disconnect error: ${error.message}`, 'error');
        }
    }

    async refreshScenes() {
        try {
            const result = await window.electronAPI.ipcRenderer.invoke('obs-get-scenes');
            if (result.success) {
                this.updateSceneList(result.scenes, result.currentScene);
                this.addLog(`Loaded ${result.scenes.length} scenes`, 'success');
            } else {
                this.addLog(`Failed to get scenes: ${result.error}`, 'error');
            }
        } catch (error) {
            this.addLog(`Error getting scenes: ${error.message}`, 'error');
        }
    }

    async goToScene(sceneName) {
        try {
            const result = await window.electronAPI.ipcRenderer.invoke('obs-set-scene', sceneName);
            if (result.success) {
                this.addLog(`Switched to scene: ${sceneName}`, 'success');
                await this.refreshScenes();
            } else {
                this.addLog(`Failed to switch to ${sceneName}: ${result.error}`, 'error');
            }
        } catch (error) {
            this.addLog(`Error switching scene: ${error.message}`, 'error');
        }
    }

    async initializeScenes() {
        try {
            this.addLog('Initializing scene items...', 'info');
            
            const result = await window.electronAPI.ipcRenderer.invoke('obs-initialize-scenes');
            if (result.success) {
                this.scoresItems = result.scoresItems || {};
                this.loopItems = result.loopItems || {};
                
                this.addLog(`Initialized ${Object.keys(this.scoresItems).length} score items`, 'success');
                this.addLog(`Initialized ${Object.keys(this.loopItems).length} loop items`, 'success');
            } else {
                this.addLog(`Initialization failed: ${result.error}`, 'error');
            }
        } catch (error) {
            this.addLog(`Initialization error: ${error.message}`, 'error');
        }
    }

    async showScores() {
        try {
            const config = this.getConfig();
            this.addLog('Starting score display sequence...', 'info');
            
            const result = await window.electronAPI.ipcRenderer.invoke('obs-show-scores', {
                scoresItems: this.scoresItems,
                interval: config.scoreInterval
            });
            
            if (result.success) {
                this.addLog('Score display sequence started', 'success');
            } else {
                this.addLog(`Score display failed: ${result.error}`, 'error');
            }
        } catch (error) {
            this.addLog(`Error showing scores: ${error.message}`, 'error');
        }
    }

    async startAutomation() {
        if (this.isAutomationRunning) {
            this.addLog('Automation is already running', 'warning');
            return;
        }
        
        try {
            const config = this.getConfig();
            this.addLog('Starting LED automation...', 'info');
            
            const result = await window.electronAPI.ipcRenderer.invoke('obs-start-automation', {
                scoresItems: this.scoresItems,
                loopItems: this.loopItems,
                config: config
            });
            
            if (result.success) {
                this.isAutomationRunning = true;
                this.updateAutomationButtons(true);
                this.addLog('LED automation started successfully', 'success');
            } else {
                this.addLog(`Automation failed to start: ${result.error}`, 'error');
            }
        } catch (error) {
            this.addLog(`Error starting automation: ${error.message}`, 'error');
        }
    }

    async stopAutomation() {
        try {
            await window.electronAPI.ipcRenderer.invoke('obs-stop-automation');
            this.isAutomationRunning = false;
            this.updateAutomationButtons(false);
            this.addLog('LED automation stopped', 'info');
        } catch (error) {
            this.addLog(`Error stopping automation: ${error.message}`, 'error');
        }
    }

    updateConnectionStatus(status, message) {
        if (this.connectionStatus) {
            this.connectionStatus.className = `connection-status ${status}`;
            this.connectionStatus.textContent = message;
        }
        
        // Enable/disable buttons based on connection
        this.updateButtonStates();
    }

    updateButtonStates() {
        const controlButtons = [
            'connect-btn', 'disconnect-btn', 'refresh-scenes-btn', 
            'goto-scores-btn', 'goto-loop-btn', 'show-scores-btn', 
            'init-scenes-btn', 'start-automation-btn'
        ];
        
        controlButtons.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                if (id === 'connect-btn') {
                    btn.disabled = this.isConnected;
                } else if (id === 'disconnect-btn') {
                    btn.disabled = !this.isConnected;
                } else {
                    btn.disabled = !this.isConnected;
                }
            }
        });
    }

    updateAutomationButtons(running) {
        const startBtn = document.getElementById('start-automation-btn');
        const stopBtn = document.getElementById('stop-automation-btn');
        
        if (startBtn) startBtn.disabled = running;
        if (stopBtn) stopBtn.disabled = !running;
    }

    updateSceneList(scenes, currentScene) {
        const sceneList = document.getElementById('scene-list');
        if (!sceneList) return;
        
        sceneList.innerHTML = '';
        
        if (!scenes || scenes.length === 0) {
            sceneList.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280;">No scenes found</div>';
            return;
        }
        
        scenes.forEach(scene => {
            const sceneItem = document.createElement('div');
            sceneItem.className = `scene-item ${scene.sceneName === currentScene ? 'active' : ''}`;
            sceneItem.innerHTML = `
                <span>${scene.sceneName}</span>
                <button class="btn btn-primary btn-sm" onclick="window.obsManager.goToScene('${scene.sceneName}')">Switch</button>
            `;
            sceneList.appendChild(sceneItem);
        });
    }

    addLog(message, type = 'info') {
        if (!this.logContainer) return;
        
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
        
        // Insert at the top instead of appending to bottom
        if (this.logContainer.firstChild) {
            this.logContainer.insertBefore(logEntry, this.logContainer.firstChild);
        } else {
            this.logContainer.appendChild(logEntry);
        }
        
        // Keep only the latest 50 log entries
        const logEntries = this.logContainer.querySelectorAll('.log-entry');
        if (logEntries.length > 50) {
            this.logContainer.removeChild(logEntries[logEntries.length - 1]);
        }
    }

    async showWebSocketSetupDialog() {
        try {
            const result = await window.electronAPI.ipcRenderer.invoke('show-websocket-dialog');

            // dialog.showMessageBox resolves with { response, checkboxChecked }
            if (result && result.response === 1) {
                // User clicked "Launch OBS"
                await this.launchOBS();
            }
        } catch (error) {
            this.addLog(`Error showing dialog: ${error.message}`, 'error');
        }
    }

    getConfig() {
        return {
            obsAddress: document.getElementById('obs-address')?.value || 'ws://127.0.0.1:4455',
            obsPassword: document.getElementById('obs-password')?.value || '123456',
            // `?? true` and not `|| true`: an unchecked box is `false`, which
            // `||` would silently turn back into `true`.
            showScores: document.getElementById('show-scores')?.checked ?? true,
            scoreInterval: parseInt(document.getElementById('score-interval')?.value) || 20000,
            transitionTime: parseInt(document.getElementById('transition-time')?.value) || 300,
            adsCount: parseInt(document.getElementById('ads-count')?.value) || 5,
            videoDuration: parseInt(document.getElementById('video-duration')?.value) || 15000,
            videoPath: document.getElementById('video-path')?.value || 'data/PARTNERS_VIDEOS/'
        };
    }

    showLaunchProgress() {
        // Create progress dialog
        const dialog = document.createElement('div');
        dialog.id = 'launch-progress-dialog';
        dialog.className = 'progress-dialog-overlay';
        dialog.innerHTML = `
            <div class="progress-dialog">
                <div class="progress-header">
                    <h3>🚀 Launching OBS Studio</h3>
                </div>
                <div class="progress-content">
                    <div class="progress-step" id="progress-step">Initializing...</div>
                    <div class="progress-message" id="progress-message">Preparing to launch OBS...</div>
                    <div class="progress-spinner">
                        <div class="spinner"></div>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        // Add CSS styles if not already added
        if (!document.getElementById('progress-dialog-styles')) {
            const styles = document.createElement('style');
            styles.id = 'progress-dialog-styles';
            styles.textContent = `
                .progress-dialog-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                    backdrop-filter: blur(4px);
                }
                
                .progress-dialog {
                    background: hsl(var(--background));
                    border: 1px solid hsl(var(--border));
                    border-radius: var(--radius);
                    padding: 2rem;
                    min-width: 400px;
                    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
                }
                
                .progress-header h3 {
                    margin: 0 0 1.5rem 0;
                    color: hsl(var(--foreground));
                    font-size: 1.25rem;
                    font-weight: 600;
                    text-align: center;
                }
                
                .progress-content {
                    text-align: center;
                }
                
                .progress-step {
                    font-weight: 500;
                    color: hsl(var(--primary));
                    margin-bottom: 0.5rem;
                    font-size: 0.875rem;
                }
                
                .progress-message {
                    color: hsl(var(--muted-foreground));
                    margin-bottom: 2rem;
                    font-size: 0.875rem;
                }
                
                .progress-spinner {
                    display: flex;
                    justify-content: center;
                }
                
                .spinner {
                    width: 2rem;
                    height: 2rem;
                    border: 2px solid hsl(var(--muted));
                    border-top: 2px solid hsl(var(--primary));
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            `;
            document.head.appendChild(styles);
        }
    }

    updateLaunchProgress(step, message) {
        const stepEl = document.getElementById('progress-step');
        const messageEl = document.getElementById('progress-message');
        
        if (stepEl && messageEl) {
            const stepLabels = {
                'checking-videos': '🎬 Checking Videos',
                'converting-videos': '🔄 Converting Videos',
                'checking-images': '📷 Checking Images',
                'converting-images': '🔄 Converting Images',
                'preparing-obs': '⚙️ Preparing OBS',
                'importing-collection': '🎞️ Importing Scenes',
                'configuring-websocket': '🔌 Enabling WebSocket',
                'launching-obs': '🚀 Launching OBS'
            };
            
            stepEl.textContent = stepLabels[step] || step;
            messageEl.textContent = message;
        }
    }

    hideLaunchProgress() {
        const dialog = document.getElementById('launch-progress-dialog');
        if (dialog) {
            dialog.remove();
        }
    }
}

// Export for use
window.OBSManager = OBSManager;