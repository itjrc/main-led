# PowerShell script to check for, download, and extract a specific version of Node.js.
param(
    # The exact version of Node.js to ensure is installed.
    [string]$NodeVersion = "22.18.0",
    # The system architecture for the Node.js download.
    [string]$Architecture = "x64"
)

# Ensure that any command that generates an error will stop script execution.
$ErrorActionPreference = "Stop"

# Function to check if the correct version of Node.js is already present.
function Test-NodeVersion {
    param(
        [string]$RequiredVersion
    )

    $nodeExePath = ".\provider\node\node.exe"
    if (Test-Path $nodeExePath) {
        try {
            # Execute node.exe to get its version string.
            $currentVersion = & $nodeExePath --version 2>$null
            if ($currentVersion) {
                # The output includes a 'v' prefix (e.g., "v22.18.0"), which we remove for comparison.
                $currentVersion = $currentVersion.TrimStart('v')
                Write-Host "   Found existing Node.js version: $currentVersion" -ForegroundColor DarkGray

                # Perform an exact match against the required version.
                if ($currentVersion -eq $RequiredVersion) {
                    return $true
                }
            }
        }
        catch {
            # This might happen if node.exe is corrupted.
            Write-Host "   [WARNING] Could not determine version of existing node.exe. $_" -ForegroundColor Yellow
        }
    }
    return $false
}

# Function to download and extract the specified Node.js version.
function Download-Node {
    param(
        [string]$Version,
        [string]$Arch
    )

    # Construct the download URL and local file paths dynamically from the parameters.
    $fileName = "node-v$($Version)-win-$($Arch)"
    $zipFileName = "$($fileName).zip"
    $nodeUrl = "https://nodejs.org/dist/v$($Version)/$($zipFileName)"
    $zipPath = ".\$($zipFileName)"
    $providerDir = ".\provider"
    $nodeDir = Join-Path $providerDir "node"

    Write-Host "Downloading Node.js $Version ($Arch)..." -ForegroundColor Yellow

    try {
        # Ensure the parent directory for our local Node installation exists.
        if (-not (Test-Path $providerDir)) {
            New-Item -ItemType Directory -Path $providerDir | Out-Null
        }

        # Clean up any previous installation to ensure a fresh state.
        if (Test-Path $nodeDir) {
            Write-Host "   Removing previous Node.js installation..." -ForegroundColor DarkGray
            Remove-Item $nodeDir -Recurse -Force
        }
        New-Item -ItemType Directory -Path $nodeDir | Out-Null

        # Download the Node.js zip archive.
        Write-Host "   Downloading from: $nodeUrl" -ForegroundColor DarkGray
        Invoke-WebRequest -Uri $nodeUrl -OutFile $zipPath

        Write-Host "   Download complete. Extracting..." -ForegroundColor DarkGray

        # Extract the archive. The contents will be inside a folder (e.g., 'node-v22.18.0-win-x64').
        $tempExtractDir = ".\temp-node-extract"
        Expand-Archive -Path $zipPath -DestinationPath $tempExtractDir -Force

        # Define the path to the single folder inside the extracted archive.
        $sourceFolder = Join-Path $tempExtractDir $fileName

        # Move the contents from the extracted subfolder into our target 'provider\node' directory.
        Get-ChildItem -Path $sourceFolder | Move-Item -Destination $nodeDir -Force

        Write-Host "   Extraction and move complete." -ForegroundColor DarkGray

        # Final verification to ensure the executable is where we expect it.
        if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
            throw "node.exe not found after extraction. The archive structure may have changed."
        }

        Write-Host "[SUCCESS] Node.js $Version installed successfully!" -ForegroundColor Green
        return $true

    } catch {
        Write-Host "[ERROR] Error during Node.js download/install: $_" -ForegroundColor Red
        return $false
    } finally {
        # Cleanup: Always remove the downloaded zip and temporary extraction folder.
        if (Test-Path $zipPath) { Remove-Item $zipPath -Force -ErrorAction SilentlyContinue }
        if (Test-Path $tempExtractDir) { Remove-Item $tempExtractDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

# --- Main Execution ---
Write-Host "Checking for Node.js v$NodeVersion..."

if (Test-NodeVersion -RequiredVersion $NodeVersion) {
    Write-Host "[OK] Correct Node.js version is already installed." -ForegroundColor Green
} else {
    Write-Host "Node.js v$NodeVersion not found or version mismatch." -ForegroundColor Yellow
    if (-not (Download-Node -Version $NodeVersion -Arch $Architecture)) {
        Write-Host "[FAIL] Node.js setup failed. Aborting." -ForegroundColor Red
        exit 1 # Exit with a non-zero status code to signal failure to the calling script.
    }
}

Write-Host "[SUCCESS] Node.js setup complete." -ForegroundColor Green
