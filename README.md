# Claude Control

Remote dashboard to control multiple Claude Code CLI sessions from your phone.

## What It Does

Run 4-8 Claude Code CLI sessions on your laptop and control them all from your phone's browser over your local network. You get:

- **Grid view** showing live previews of all terminal sessions
- **Tap to focus** any session for full-screen interaction
- **Accept/Deny buttons** to approve or reject tool calls with one tap
- **Text input** to type arbitrary messages to any CLI session
- **Ctrl+C / Enter** quick-action buttons
- **Real-time streaming** of terminal output via WebSocket
- **Auto-reconnect** if the connection drops

## Quick Start

```bash
# Install dependencies
npm install

# Start the dashboard server
npm start
```

The server prints two URLs on startup:

```
╔══════════════════════════════════════════════════╗
║       Claude Control - Remote CLI Dashboard      ║
╠══════════════════════════════════════════════════╣
║  Local:   http://localhost:3200                  ║
║  Network: http://192.168.1.42:3200              ║
║                                                  ║
║  Open the Network URL on your phone to connect   ║
╚══════════════════════════════════════════════════╝
```

Open the **Network** URL on your phone (both devices must be on the same WiFi network).

## Usage

1. **Open the dashboard** on your phone's browser
2. **Tap "+ New"** to create a Claude CLI session
3. **Give it a name** and optionally set a working directory
4. **Tap the session card** in the grid to focus it full-screen
5. **Use the toolbar buttons**:
   - Green **Accept** button sends `y` + Enter to approve tool calls
   - Red **Deny** button sends `n` + Enter to reject tool calls
   - **Ctrl+C** to interrupt
   - **Enter** to send a blank line
   - **Text input** to type any message and send it
6. **Tap "Grid"** to go back to the overview

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3200` | Server port |

## Architecture

```
Phone Browser                  Laptop
┌─────────────┐    WebSocket   ┌──────────────────────┐
│  xterm.js   │◄──────────────►│  Node.js Server      │
│  Grid View  │                │  ├─ Express (static)  │
│  Focus View │                │  ├─ WebSocket (ws)    │
│  Toolbar    │                │  └─ SessionManager    │
└─────────────┘                │     ├─ PTY 1 (claude) │
                               │     ├─ PTY 2 (claude) │
                               │     ├─ PTY 3 (claude) │
                               │     └─ PTY N (claude) │
                               └──────────────────────┘
```

- **server/index.js** - Express HTTP server + WebSocket server
- **server/SessionManager.js** - Manages PTY processes (spawn, I/O, resize, kill)
- **public/index.html** - Mobile-first SPA shell
- **public/style.css** - Dark theme, responsive grid, action bar
- **public/app.js** - WebSocket client, xterm.js terminals, UI logic

## Requirements

- Node.js 18+
- `claude` CLI installed and authenticated on the laptop
- Phone and laptop on the same local network
