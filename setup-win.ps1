# ─────────────────────────────────────────────────────
# Claude Control - Windows Network Setup
# Run as Administrator to allow phone connections
# Usage: Right-click PowerShell > Run as Administrator
#        Then: .\setup-win.ps1
# ─────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Claude Control - Windows Network Setup ===" -ForegroundColor Cyan
Write-Host ""

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $isAdmin) {
    Write-Host "ERROR: Run this script as Administrator." -ForegroundColor Red
    Write-Host "Right-click PowerShell > 'Run as Administrator', then run this script again."
    Write-Host ""
    exit 1
}

# Find node.exe
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Host "ERROR: Node.js not found in PATH." -ForegroundColor Red
    exit 1
}
Write-Host "Node.js found: $nodePath" -ForegroundColor Green

# Remove old rules if they exist
$existingRules = Get-NetFirewallRule -DisplayName "Claude Control*" -ErrorAction SilentlyContinue
if ($existingRules) {
    Write-Host "Removing old firewall rules..."
    Remove-NetFirewallRule -DisplayName "Claude Control*" -ErrorAction SilentlyContinue
}

# Add inbound rule for Node.js on port 3200
Write-Host "Adding firewall rule to allow connections on port 3200..."
New-NetFirewallRule -DisplayName "Claude Control - Node.js" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 3200 `
    -Action Allow `
    -Program $nodePath `
    -Description "Allow phone to connect to Claude Control dashboard" | Out-Null

Write-Host ""
Write-Host "Done! Firewall rule added." -ForegroundColor Green
Write-Host ""

# Get IP
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notmatch "^169" } | Select-Object -First 1).IPAddress
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Make sure your PC and phone are on the same Wi-Fi"
Write-Host "  2. Start the dashboard:  npm start"
Write-Host "  3. Open on your phone:   http://${ip}:3200"
Write-Host ""
