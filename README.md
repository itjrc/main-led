# OBS Main LED - Application Manager

A desktop application to manage Node.js, OBS Studio, FFmpeg, and FFprobe installations.

## Features

- **Node.js 22 Management**: Automatically downloads and installs Node.js 22 if not present
- **OBS Studio**: Check version and download latest OBS Studio
- **FFmpeg & FFprobe**: Download and manage FFmpeg binaries
- **Clean Interface**: Modern Electron-based GUI for easy management
- **Provider System**: Organized external app storage in `provider/` folder

## Quick Start

### Option 1: PowerShell Script (Recommended)
```powershell
# Run the application
.\start.ps1

# Run in development mode
.\start.ps1 -Dev
```

### Option 2: Manual Setup
```powershell
# 1. Setup Node.js 22
.\setup-node.ps1

# 2. Install dependencies
.\node\npm.cmd install

# 3. Start the application
.\node\npm.cmd start
```

## File Structure

```
OBS-MAIN-LED/
├── setup-node.ps1      # Node.js 22 setup script
├── start.ps1           # Main startup script
├── package.json        # NPM configuration
├── main.js             # Electron main process
├── index.html          # Application UI
├── renderer.js         # UI logic
├── node/               # Node.js installation (auto-created)
└── provider/           # External applications
    ├── obs/            # OBS Studio (auto-downloaded)
    └── ffmpeg/         # FFmpeg binaries (auto-downloaded)
```

## Usage

1. **Launch the app** using `.\start.ps1`
2. **Check Node.js** version (should show the installed Node 22)
3. **Download OBS** using the download button if not present
4. **Download FFmpeg** using the download button if not present
5. **View versions** of all installed applications
6. **Open folders** using the folder buttons to access installations

## Requirements

- Windows 10/11
- PowerShell execution policy allowing script execution
- Internet connection for downloads

## Development

```powershell
# Run in development mode (opens DevTools)
.\start.ps1 -Dev
```