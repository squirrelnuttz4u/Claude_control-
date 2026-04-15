/* ======================================================================
   Claude Control – Mobile Dashboard Client
   ====================================================================== */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  let ws = null;
  let sessions = [];           // [{id, state, ...}]
  let focusedSessionId = null;  // currently focused session id
  let terminals = {};           // sessionId -> Terminal instance
  let fitAddons = {};           // sessionId -> FitAddon instance
  let subscribedIds = new Set();
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  // ── DOM refs ────────────────────────────────────────────────────────
  const gridView = document.getElementById('grid-view');
  const focusedView = document.getElementById('focused-view');
  const sessionGrid = document.getElementById('session-grid');
  const sessionCount = document.getElementById('session-count');
  const btnAddSession = document.getElementById('btn-add-session');
  const modal = document.getElementById('new-session-modal');
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  const btnModalCreate = document.getElementById('btn-modal-create');
  const inputName = document.getElementById('input-session-name');
  const inputCwd = document.getElementById('input-session-cwd');
  const inputCmd = document.getElementById('input-session-cmd');
  const btnBack = document.getElementById('btn-back');
  const focusedTitle = document.getElementById('focused-title');
  const focusedStatus = document.getElementById('focused-status');
  const terminalContainer = document.getElementById('terminal-container');
  const quickActions = document.getElementById('quick-actions');
  const textInput = document.getElementById('text-input');
  const btnSend = document.getElementById('btn-send');

  // ── WebSocket ───────────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      showConnectionStatus(false);
      // Clear terminal content and preview buffers before re-subscribing
      // to avoid duplicate output from buffer replay
      for (const id of subscribedIds) {
        if (terminals[id]) {
          terminals[id].clear();
        }
        previewBuffers[id] = '';
        const previewEl = document.getElementById(`preview-${id}`);
        if (previewEl) previewEl.textContent = '';
      }
      // Re-subscribe to any sessions we were watching
      for (const id of subscribedIds) {
        wsSend({ type: 'subscribe', sessionId: id });
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    };

    ws.onclose = () => {
      showConnectionStatus(true);
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
  }

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ── Message Router ──────────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'session_list':
        sessions = msg.sessions;
        renderGrid();
        break;

      case 'session_created':
        // list will be refreshed via session_list broadcast
        break;

      case 'session_restarted':
        showToast(`Session "${msg.session.id}" restarted`, 'info');
        // Re-focus if this was our pending restart
        if (pendingRestartId === msg.session.id) {
          pendingRestartId = null;
          focusSession(msg.session.id);
        }
        break;

      case 'output':
        if (terminals[msg.sessionId]) {
          terminals[msg.sessionId].write(msg.data);
        }
        updateCardPreview(msg.sessionId, msg.data);
        break;

      case 'buffer_replay':
        if (terminals[msg.sessionId]) {
          terminals[msg.sessionId].write(msg.data);
        }
        updateCardPreview(msg.sessionId, msg.data);
        break;

      case 'session_exited':
        updateSessionState(msg.sessionId, 'exited', msg.exitCode);
        break;

      case 'error':
        console.error('[server]', msg.error);
        showToast(msg.error, 'error');
        break;
    }
  }

  // ── Grid Rendering ──────────────────────────────────────────────────
  function renderGrid() {
    sessionCount.textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;

    if (sessions.length === 0) {
      sessionGrid.innerHTML = `
        <div class="empty-state">
          <div class="icon">&#9000;</div>
          <p>No sessions running</p>
          <span class="hint">Tap "+ New" to launch a Claude CLI session</span>
        </div>`;
      return;
    }

    // Build a map of existing cards by session ID
    const existingCards = new Map();
    for (const el of Array.from(sessionGrid.children)) {
      if (el.dataset.sessionId) {
        existingCards.set(el.dataset.sessionId, el);
      }
    }

    // Clear the grid and rebuild in correct order
    sessionGrid.innerHTML = '';

    sessions.forEach((session, index) => {
      let card = existingCards.get(session.id);
      if (card) {
        // Update existing card metadata
        const numEl = card.querySelector('.card-number');
        if (numEl) numEl.textContent = index + 1;
        const statusEl = card.querySelector('.status-badge');
        if (statusEl) {
          statusEl.textContent = session.state;
          statusEl.className = `status-badge ${session.state}`;
        }
        sessionGrid.appendChild(card);
      } else {
        card = createCard(session, index);
        sessionGrid.appendChild(card);
        // Subscribe to this session for preview data
        subscribedIds.add(session.id);
        wsSend({ type: 'subscribe', sessionId: session.id });
      }
    });
  }

  function createCard(session, index) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = session.id;

    card.innerHTML = `
      <div class="card-header">
        <span class="card-title">${escapeHtml(session.id)}</span>
        <span class="card-number">${index + 1}</span>
      </div>
      <div class="card-preview" id="preview-${session.id}"></div>
      <div class="card-footer">
        <span class="status-badge ${session.state}">${session.state}</span>
        <span class="card-uptime" data-created="${session.createdAt}"></span>
        <button class="btn-destroy" data-destroy="${session.id}" title="Kill session">&times;</button>
      </div>`;

    // Tap card to focus
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-destroy')) return;
      focusSession(session.id);
    });

    // Destroy button
    card.querySelector('.btn-destroy').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Kill session "${session.id}"?`)) {
        wsSend({ type: 'destroy_session', sessionId: session.id });
        subscribedIds.delete(session.id);
        delete previewBuffers[session.id];
        if (terminals[session.id]) {
          terminals[session.id].dispose();
          delete terminals[session.id];
          delete fitAddons[session.id];
        }
      }
    });

    return card;
  }

  // Store last N characters of output per session for card preview
  const previewBuffers = {};

  function updateCardPreview(sessionId, data) {
    if (!previewBuffers[sessionId]) previewBuffers[sessionId] = '';
    previewBuffers[sessionId] += data;
    // Keep last 2000 chars
    if (previewBuffers[sessionId].length > 2000) {
      previewBuffers[sessionId] = previewBuffers[sessionId].slice(-1500);
    }

    const previewEl = document.getElementById(`preview-${sessionId}`);
    if (previewEl) {
      // Show last ~10 lines, strip ANSI for card preview
      const clean = stripAnsi(previewBuffers[sessionId]);
      const lines = clean.split('\n');
      previewEl.textContent = lines.slice(-10).join('\n');
    }
  }

  function updateSessionState(sessionId, state, exitCode) {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      session.state = state;
      session.exitCode = exitCode;
    }

    // Update card
    const card = sessionGrid.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
    if (card) {
      const statusEl = card.querySelector('.status-badge');
      if (statusEl) {
        statusEl.textContent = state;
        statusEl.className = `status-badge ${state}`;
      }
    }

    // Update focused view if looking at this session
    if (focusedSessionId === sessionId) {
      focusedStatus.textContent = state;
      focusedStatus.className = `status-badge ${state}`;
    }
  }

  // ── Focused View ────────────────────────────────────────────────────
  function focusSession(sessionId) {
    focusedSessionId = sessionId;
    const session = sessions.find(s => s.id === sessionId);

    // Update header
    focusedTitle.textContent = sessionId;
    const posIndex = sessions.findIndex(s => s.id === sessionId);
    const posEl = document.getElementById('focused-position');
    posEl.textContent = posIndex >= 0 ? `${posIndex + 1} of ${sessions.length}` : '';
    focusedStatus.textContent = session ? session.state : 'unknown';
    focusedStatus.className = `status-badge ${session ? session.state : ''}`;

    // Show focused view
    gridView.classList.add('hidden');
    focusedView.classList.remove('hidden');

    // Always dispose old terminal and create fresh one to avoid re-open issues
    if (terminals[sessionId]) {
      terminals[sessionId].dispose();
      delete terminals[sessionId];
      delete fitAddons[sessionId];
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(88,166,255,0.3)',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc',
      },
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });

    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);

    try {
      const webLinks = new WebLinksAddon.WebLinksAddon();
      term.loadAddon(webLinks);
    } catch (e) {
      // web links addon is optional
    }

    terminals[sessionId] = term;
    fitAddons[sessionId] = fit;

    // Clear container and mount terminal
    terminalContainer.innerHTML = '';
    term.open(terminalContainer);

    // Fit terminal after a frame so the container has dimensions
    requestAnimationFrame(() => {
      fitTerminal(sessionId);
    });

    // Subscribe to make sure we're getting output
    subscribedIds.add(sessionId);
    wsSend({ type: 'subscribe', sessionId });
  }

  function unfocusSession() {
    // Dispose terminal to stop wasting CPU/memory on invisible output
    if (focusedSessionId && terminals[focusedSessionId]) {
      terminals[focusedSessionId].dispose();
      delete terminals[focusedSessionId];
      delete fitAddons[focusedSessionId];
    }
    focusedSessionId = null;
    focusedView.classList.add('hidden');
    gridView.classList.remove('hidden');
  }

  function fitTerminal(sessionId) {
    const fit = fitAddons[sessionId];
    if (!fit) return;
    try {
      fit.fit();
      const term = terminals[sessionId];
      if (term) {
        wsSend({
          type: 'resize',
          sessionId,
          cols: term.cols,
          rows: term.rows,
        });
      }
    } catch (e) {
      // ignore fit errors (e.g., container not visible)
    }
  }

  // ── Input Handling ──────────────────────────────────────────────────
  function sendInput(data) {
    if (!focusedSessionId) return;
    wsSend({ type: 'input', sessionId: focusedSessionId, data });
    // Haptic feedback on mobile
    if (navigator.vibrate) navigator.vibrate(30);
  }

  function sendTextInput() {
    if (!focusedSessionId) return;
    const text = textInput.value;
    sendInput(text + '\n');
    textInput.value = '';
    textInput.focus();
  }

  // ── Quick Action Buttons ────────────────────────────────────────────
  quickActions.addEventListener('click', (e) => {
    const btn = e.target.closest('.action-btn');
    if (!btn) return;
    const input = btn.dataset.input;
    if (input !== undefined) {
      // Decode escaped chars
      const decoded = input.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\x03/g, '\x03');
      sendInput(decoded);
    }
  });

  btnSend.addEventListener('click', sendTextInput);

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendTextInput();
    }
  });

  // ── Modal ───────────────────────────────────────────────────────────
  btnAddSession.addEventListener('click', () => {
    inputName.value = `session-${sessions.length + 1}`;
    inputCwd.value = '';
    inputCmd.value = '';
    modal.classList.remove('hidden');
    inputName.focus();
  });

  btnModalCancel.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  btnModalCreate.addEventListener('click', () => {
    const name = inputName.value.trim() || `session-${Date.now()}`;
    const cwd = inputCwd.value.trim() || undefined;
    const command = inputCmd.value.trim() || undefined;
    wsSend({
      type: 'create_session',
      id: name,
      cwd,
      command,
      cols: 120,
      rows: 30,
    });
    modal.classList.add('hidden');
  });

  // Close modal on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  // ── Navigation ──────────────────────────────────────────────────────
  btnBack.addEventListener('click', unfocusSession);

  // Restart session button
  let pendingRestartId = null;
  document.getElementById('btn-restart-session').addEventListener('click', () => {
    if (!focusedSessionId) return;
    if (confirm(`Restart session "${focusedSessionId}"?`)) {
      pendingRestartId = focusedSessionId;
      wsSend({ type: 'restart_session', sessionId: focusedSessionId });
    }
  });

  // Prev/Next session navigation in focused view
  document.getElementById('btn-prev-session').addEventListener('click', () => {
    navigateSession(-1);
  });
  document.getElementById('btn-next-session').addEventListener('click', () => {
    navigateSession(1);
  });

  function navigateSession(direction) {
    if (!focusedSessionId || sessions.length < 2) return;
    const currentIndex = sessions.findIndex(s => s.id === focusedSessionId);
    if (currentIndex === -1) return;
    const newIndex = (currentIndex + direction + sessions.length) % sessions.length;
    focusSession(sessions[newIndex].id);
  }

  // Swipe gesture detection in focused view
  let touchStartX = 0;
  let touchStartY = 0;
  terminalContainer.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  terminalContainer.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    // Require minimum 60px horizontal swipe, more horizontal than vertical
    if (absDx > 60 && absDx > absDy * 1.5) {
      navigateSession(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  // ── Resize Handling ─────────────────────────────────────────────────
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (focusedSessionId && fitAddons[focusedSessionId]) {
        fitTerminal(focusedSessionId);
      }
    }, 150);
  });

  // Also handle orientation change
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (focusedSessionId) fitTerminal(focusedSessionId);
    }, 300);
  });

  // ── Connection Status Overlay ───────────────────────────────────────
  let statusEl = null;

  function showConnectionStatus(disconnected) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.id = 'connection-status';
      document.body.appendChild(statusEl);
    }
    if (disconnected) {
      statusEl.textContent = 'Disconnected — reconnecting...';
      statusEl.className = 'disconnected';
    } else {
      statusEl.className = 'connected'; // fades out via CSS
    }
  }

  // ── Utilities ───────────────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'info');
    toast.textContent = message;
    document.body.appendChild(toast);
    // Trigger reflow then add visible class for animation
    toast.offsetHeight;
    toast.classList.add('toast-visible');
    setTimeout(() => {
      toast.classList.remove('toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function stripAnsi(str) {
    // Strip ANSI escape sequences for plain-text preview
    return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
              .replace(/\x1b\][^\x07]*\x07/g, '')
              .replace(/\x1b[()][AB012]/g, '')
              .replace(/\x1b[\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, '');
  }

  // ── Uptime Ticker ────────────────────────────────────────────────────
  function formatUptime(ms) {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}h${remMins > 0 ? remMins + 'm' : ''}`;
  }

  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('.card-uptime[data-created]').forEach((el) => {
      const created = parseInt(el.dataset.created, 10);
      if (created) el.textContent = formatUptime(now - created);
    });
  }, 5000);

  // ── Boot ────────────────────────────────────────────────────────────
  connect();
})();
