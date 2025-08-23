# Start script for OBS Main LED Application
# This script orchestrates the setup and launch of the Node.js application.
param(
    # Switch to run the application in development mode (e.g., with hot-reloading)
    [switch]$Dev
)

# Set strict error handling to stop the script on any error.
$ErrorActionPreference = "Stop"

Write-Host ">> Starting OBS Main LED Application..." -ForegroundColor Cyan

# --- Step 1: Setup Node.js Environment ---
Write-Host "`n[SETUP] Setting up Node.js environment..." -ForegroundColor Yellow
try {
    # Execute the setup script. We will not rely on its exit code, as console
    # character encoding issues can cause it to report failure incorrectly.
    & ".\setup-node.ps1" -ErrorAction SilentlyContinue

    # Instead of checking the exit code, we will verify the outcome directly
    # by checking if the node executable exists in the expected location.
    $nodeExePath = Join-Path (Get-Location) "provider\node\node.exe"
    if (-not (Test-Path $nodeExePath)) {
        throw "Node.js setup script ran, but node.exe was not found. Please check the setup script's output for errors."
    }
    Write-Host "   Node.js executable successfully verified." -ForegroundColor DarkGray

} catch {
    Write-Host "[ERROR] An error occurred during the Node.js setup step: $_" -ForegroundColor Red
    exit 1
}

# --- Step 2: Update PATH and Verify Environment ---
Write-Host "`n[CONFIG] Configuring environment..." -ForegroundColor Yellow
try {
    # Add the local Node.js installation to the PATH for this PowerShell session.
    # This allows us to call 'node' and 'npm' directly without specifying the full path.
    $nodePath = Join-Path (Get-Location) "provider\node"
    $env:PATH = "$nodePath;$env:PATH"
    Write-Host "   Local Node.js added to session PATH." -ForegroundColor DarkGray

    # Verify that npm is now available through the updated PATH.
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm command is not available after setup. Please check the installation."
    }
    Write-Host "   npm command verified successfully." -ForegroundColor DarkGray
} catch {
    Write-Host "[ERROR] Failed to configure the environment: $_" -ForegroundColor Red
    exit 1
}

# --- Step 3: Install npm Dependencies ---
Write-Host "`n[INSTALL] Installing dependencies..." -ForegroundColor Yellow
try {
    # Explicitly define the path to npm.cmd to avoid ambiguity from Get-Command,
    # which can incorrectly resolve to npm.ps1.
    $npmCmdPath = Join-Path (Get-Location) "provider\node\npm.cmd"
    if (-not (Test-Path $npmCmdPath)) {
        throw "npm.cmd not found at the expected path: $npmCmdPath"
    }

    Write-Host "   Executing: $npmCmdPath install" -ForegroundColor DarkGray

    # Run 'npm install' using the full, unambiguous path.
    & $npmCmdPath install
    if ($LASTEXITCODE -ne 0) {
        throw "'npm install' command failed with exit code $LASTEXITCODE."
    }
} catch {
    Write-Host "[ERROR] Failed to install dependencies: $_" -ForegroundColor Red
    exit 1
}

# --- Step 4: Start the Electron Application ---
Write-Host "`n[LAUNCH] Starting Electron application..." -ForegroundColor Green

# Determine which npm script to run based on the -Dev switch.
$startCommand = if ($Dev) { "dev" } else { "start" }
try {
    # Use the same explicit path for npm to run the start command.
    $npmCmdPath = Join-Path (Get-Location) "provider\node\npm.cmd"
    if (-not (Test-Path $npmCmdPath)) {
        throw "npm.cmd not found at the expected path: $npmCmdPath"
    }

    Write-Host "   Executing: $npmCmdPath run $startCommand" -ForegroundColor DarkGray

    # Execute the start or dev script defined in package.json.
    & $npmCmdPath run $startCommand
} catch {
    Write-Host "[ERROR] An error occurred while starting the application: $_" -ForegroundColor Red
    exit 1
}

Write-Host "`n[SUCCESS] Application closed." -ForegroundColor Green
