# OBS Main LED - Automated LED Management System

🎬 **Professional LED display management system for OBS Studio with automated video rotation, score displays, and fullscreen projection.**

## 🌟 Features

### 🎯 Core Functionality
- **Automated Video Rotation** - Seamlessly cycles through partner videos in PARTNERS_VIDEOS directory
- **Score Display Integration** - Automatically shows scores at configurable intervals
- **Fullscreen Projection** - Auto-projects to second monitor when OBS launches
- **Media Conversion** - Converts PNG/JPG images and non-MP4 videos to MP4 format
- **Partner Logo Sync** - Downloads every partner logo from the tournament site into PARTNERS_LOGO, fetching automatically when the folder is empty
- **Dynamic Path Management** - Automatically updates OBS scene paths based on project location

### 🎨 User Interface
- **Setup Tab** - System requirements checker and dependency installer
- **LED Control Tab** - Live automation controls and manual scene switching
- **Real-time Logging** - Activity monitoring with timestamped entries
- **Modern UI** - Clean, professional interface with status indicators

### 🔧 Technical Features
- **WebSocket Integration** - Real-time communication with OBS Studio
- **Scene Collection Management** - Automated scene setup and item initialization
- **Media Processing Pipeline** - Batch conversion of images and videos
- **Progress Tracking** - Real-time feedback during OBS launch and conversions
- **Error Recovery** - Robust error handling with detailed logging

## 📋 System Requirements

### Required Software
- **OBS Studio** - Video recording and streaming software
- **FFmpeg** - Media processing toolkit
- **FFprobe** - Media analysis tool

Node.js is **not** a runtime requirement: the app runs on the Node runtime embedded
in Electron and never invokes `node` as a command. A standalone Node is only needed
to build or launch the app from source on Windows, which `start.bat` handles by
downloading a portable copy into `provider/node/`.

### Hardware Requirements
- **Dual Monitor Setup** - For fullscreen projection functionality
- **Windows 10/11** - Primary supported platform
- **4GB+ RAM** - For smooth video processing
- **GPU** - Recommended for hardware acceleration

## 🚀 Quick Start

### 1. Initial Setup
```bash
# Clone or download the project
cd OBS-MAIN-LED

# Run the application
start.bat
# or
.\start.ps1
```

### 2. System Setup
1. **Launch the application**
2. **Go to Setup tab**
3. **Check system status** - Green indicators show installed components
4. **Download missing components** - Click "Download" for any missing software
5. **Wait for completion** - All components must be installed before proceeding

### 3. LED Control Setup
1. **Switch to LED Control tab** (enabled after setup completion)
2. **Launch OBS** - Click "Launch OBS" button
3. **Connect to OBS** - Use default settings (ws://127.0.0.1:4455, password: 123456)
4. **Initialize Scenes** - Click "Initialize" to set up scene items
5. **Start Automation** - Begin automated LED management

## 🖼️ Partner Logos

The `Partners Logo` slideshow in the OBS collection reads whatever images sit in
`data/PARTNERS_LOGO/`. The **Partner Logos** panel in LED Control keeps that
folder in step with the tournament site.

- **Automatic on an empty folder.** The first time the panel opens with nothing
  in the folder, it fetches all partner logos on its own - no button needed.
- **Manual sync.** *Sync from itjr.ca* re-reads the partner list at any time and
  picks up whatever the tournament has added, changed, or dropped.
- **Source of truth.** The partners page renders client-side, so its HTML holds
  no logos. The list is read from the site's own partner data instead, which
  also carries the display order and keeps the dignitary headshots stored in the
  same asset folder out of the sync.
- **SVG is rasterized.** An OBS slideshow cannot read SVG, so SVG logos are
  rendered to 1024px PNG - the same long edge the site's own PNGs use.
- **Nothing is deleted.** A logo the site drops is moved to a `REMOVED/`
  subfolder, the way converted media is archived under `ORIGINAL/`. Files you
  put in the folder yourself are never touched and are reported separately in
  the panel.
- **Live reload.** When OBS is connected, the slideshow is re-pointed at the
  folder after a sync so new logos appear without restarting OBS. With OBS off,
  the files simply wait on disk for the next launch.

A `.partners-manifest.json` in the folder records which files came from the
site, so a later sync can tell them from your own additions and skip
re-downloading anything that has not changed.

## 📁 Project Structure

```
OBS-MAIN-LED/
├── 📁 js/                          # Modular JavaScript files
│   ├── obsManager.js               # OBS WebSocket management
│   ├── mediaConverter.js           # Video/image conversion
│   ├── partnerLogos.js             # Partner logo download and sync
│   ├── obsLauncher.js              # OBS launch process
│   ├── ipcHandlers.js              # IPC communication handlers
│   └── systemHandlers.js           # System setup handlers
├── 📁 src/                         # Frontend source files
│   ├── 📁 components/ui/           # UI components
│   ├── 📁 modules/                 # Frontend modules
│   └── 📁 styles/                  # CSS stylesheets
├── 📁 data/                        # Configuration and media
│   ├── obs-scene-collection.json   # OBS scene configuration
│   ├── 📁 PARTNERS_VIDEOS/         # Video files for rotation
│   └── 📁 PARTNERS_LOGO/           # Logo slideshow images, synced from itjr.ca
├── 📁 provider/                    # Third-party software
│   ├── 📁 obs/                     # OBS Studio installation
│   └── 📁 ffmpeg/                  # FFmpeg tools
├── main.js                         # Main Electron process
├── renderer.js                     # Renderer process
├── preload.js                      # Secure IPC bridge
├── index.html                      # Main application window
├── package.json                    # Node.js dependencies
├── start.bat                       # Windows batch launcher
├── start.ps1                       # PowerShell startup script
└── setup-node.ps1                  # Node.js setup script
```

## ⚙️ Configuration

### OBS WebSocket Settings
```
Server: 127.0.0.1
Port: 4455
Password: 123456
```

### Automation Settings
- **Score Interval**: Time between score displays (default: 20 seconds)
- **Transition Time**: Delay before animations (default: 300ms)
- **Ads Count**: Videos shown before scores (default: 5)
- **Video Directory**: Location of partner videos

### Scene Configuration
The application expects these OBS scenes:
- **LOGO-ITJR** - Main logo display
- **COURT-TENNIS** - Court view
- **SCORES** - Score overlay scenes
- **LOOP_IND** - Video rotation scene

## 🎬 Media Guidelines

### Video Requirements
- **Format**: MP4 (auto-converted from MOV, WEBM, MKV, AVI, WMV)
- **Codec**: H.264 high profile, CRF 18 (near-source quality, original frame rate kept)
- **Resolution**: 1920x1080 recommended
- **Duration**: 15 seconds optimal for rotation

### Image Requirements  
- **Format**: PNG, JPG, JPEG (auto-converted to MP4)
- **Resolution**: Any (scaled to 1720px width, centered on 1920x1080 black background)
- **Duration**: 5 seconds when converted to video

### File Management
- Place videos in `data/PARTNERS_VIDEOS/` directory
- Application automatically converts non-MP4 formats
- Original files are deleted after successful conversion
- Converted files maintain original naming

## 🔧 Troubleshooting

### Common Issues

#### OBS Connection Failed
```
❌ Connection failed: Connection refused
```
**Solution**: 
1. Ensure OBS is running
2. Enable WebSocket server in OBS: Tools → WebSocket Server Settings
3. Check port 4455 is not blocked by firewall

#### Media Conversion Errors
```
❌ FFmpeg conversion failed
```
**Solution**:
1. Verify FFmpeg is installed (Setup tab)
2. Check file permissions
3. Ensure sufficient disk space

#### Scene Initialization Failed
```
❌ Initialization failed: Scene not found
```
**Solution**:
1. Import the provided scene collection
2. Verify scene names match configuration
3. Check scene items exist

### Performance Optimization
- **Close unused applications** during video processing
- **Use SSD storage** for faster file operations  
- **Enable hardware acceleration** in OBS
- **Limit simultaneous conversions** for older systems

## 🔄 Automation Workflow

### 1. Launch Sequence
```
📱 Launch OBS → 🔄 Convert Media → ⚙️ Update Paths → 🚀 Start OBS → 📺 Project to Monitor
```

### 2. Video Rotation
```
🎬 Load Video → ⏱️ Display (15s) → 🔄 Next Video → 📊 Show Scores (every 5 videos)
```

### 3. Score Display
```
📊 Switch to SCORES → 🎯 Cycle Score Items → ⏱️ Display Each (20s) → 🔄 Return to Videos
```

## 🐛 Debug Mode

Enable detailed logging:
```powershell
# Run in development mode
.\start.ps1 -Dev
```

This enables:
- **Developer Tools** in Electron
- **Verbose logging** to console
- **Error stack traces**
- **Performance monitoring**

## 🤝 Development

### Development Setup
```powershell
# Setup Node.js (if needed)
.\setup-node.ps1

# Install dependencies
npm install

# Run in development mode
.\start.ps1 -Dev
```

### Code Structure
- **Main Process**: `main.js` - Electron main process
- **Renderer**: `renderer.js` - Frontend JavaScript
- **Modules**: `js/` - Modular backend functionality
- **UI Components**: `src/components/` - Reusable UI elements

## 📄 License

This project is proprietary software developed for LED management automation.

## 🆘 Support

For technical support or feature requests:
1. **Check logs** in the Activity Log panel
2. **Verify setup** requirements are met
3. **Restart application** if issues persist
4. **Check file permissions** for media directories

---

**🎬 Ready to automate your LED displays? Launch the application and follow the setup guide!**