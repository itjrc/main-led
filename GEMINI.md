# Project: OBS Main LED - Application Manager

## Project Overview

This project is a desktop application built with Electron for managing installations of Node.js, OBS Studio, FFmpeg, and FFprobe. It provides a graphical user interface to check for, download, and manage these dependencies. The application also features a control system for OBS scenes, likely for an LED display, which can be managed through a separate tab in the UI. The application is designed to be run on Windows and uses PowerShell scripts for setup and startup.

**Main Technologies:**

*   **Framework:** Electron
*   **Language:** JavaScript (Node.js)
*   **Dependencies:**
    *   `adm-zip`: For extracting downloaded ZIP archives.
    *   `obs-websocket-js`: For communicating with OBS Studio via its WebSocket server.
*   **UI:** HTML, CSS, and vanilla JavaScript.

**Architecture:**

*   **`main.js`**: The main Electron process, responsible for creating the browser window and handling all backend logic, including file system operations, process execution, and communication with OBS Studio.
*   **`index.html` / `renderer.js`**: The main UI for the application, responsible for displaying the status of dependencies and handling user interactions for downloading and managing them.
*   **`led-management.html` / `led-renderer.js`**: A secondary UI, presented as a tab, for controlling OBS scenes. This UI allows connecting to OBS, managing scenes, and automating scene switching.
*   **`provider/`**: A directory where the application downloads and stores the managed applications (Node.js, OBS, FFmpeg).
*   **`data/`**: Contains data used by the application, such as OBS scene collections and media for the LED display.

## Building and Running

The project is intended to be run directly from the source using PowerShell scripts.

**To run the application:**

```powershell
.\start.ps1
```

**To run in development mode (with DevTools open):**

```powershell
.\start.ps1 -Dev
```

**Manual setup and execution:**

1.  **Setup Node.js:**
    ```powershell
    .\setup-node.ps1
    ```
2.  **Install dependencies:**
    ```powershell
    .\provider\node\npm.cmd install
    ```
3.  **Start the application:**
    ```powershell
    .\provider\node\npm.cmd start
    ```

## Development Conventions

*   **Code Style:** The JavaScript code follows a standard Node.js style, with `require` for module imports. The code is not using modern ES6 modules.
*   **UI:** The UI is built with vanilla JavaScript and HTML, with some custom components in `src/components/ui`. The styling is done with CSS and seems to be inspired by Shadcn UI, using CSS variables for theming.
*   **Error Handling:** Error handling is done with `try...catch` blocks and by checking for error properties in the results of IPC calls.
*   **IPC Communication:** The renderer process communicates with the main process using `ipcRenderer.invoke` for asynchronous operations.
*   **OBS Integration:** The application integrates with OBS Studio using the `obs-websocket-js` library. It can launch OBS, connect to its WebSocket server, and control scenes.
