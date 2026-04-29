const API_BASE_URL = 'http://localhost:3000';

// ============================================================================
// XSS Prevention: HTML Escape Utility
// ============================================================================

/**
 * Escape HTML special characters to prevent XSS attacks
 * @param {string} text - Untrusted user input
 * @returns {string} - Safe HTML-escaped string
 */
function escapeHtml(text) {
    if (text === null || text === undefined) {
        return '';
    }
    const str = String(text);
    const htmlEscapes = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '/': '&#x2F;'
    };
    return str.replace(/[&<>"'/]/g, char => htmlEscapes[char]);
}

// ============================================================================
// Tool-call chip helpers
// ============================================================================

/**
 * Best-effort one-line summary for a tool result. Shown in the collapsed chip
 * header as a breadcrumb — the expanded body always has the raw JSON.
 */
function summarizeToolResult(result) {
    if (!result || typeof result !== 'object') return '';
    if (typeof result.count === 'number') {
        return `${result.count} result${result.count === 1 ? '' : 's'}`;
    }
    if (result.todo && result.todo.id !== undefined) return `id=${result.todo.id}`;
    if (result.error) return 'error';
    if (result.success === true) return 'ok';
    if (result.success === false) return 'error';
    return '';
}

/**
 * Render one <details> chip for a tool invocation. Collapsed by default.
 * All untrusted strings are escaped before injection (innerHTML).
 */
function renderToolChip(entry) {
    const name = entry && entry.tool ? String(entry.tool) : 'tool';
    const args = entry && entry.arguments !== undefined ? entry.arguments : {};
    const result = entry && entry.result !== undefined ? entry.result : {};
    const summary = summarizeToolResult(result);
    const argsJson = JSON.stringify(args, null, 2);
    const resultJson = JSON.stringify(result, null, 2);
    return `
        <details class="tool-chip">
            <summary>
                <span class="tool-chip-caret" aria-hidden="true"></span>
                <span class="tool-chip-icon" aria-hidden="true">🔧</span>
                <span class="tool-chip-name">${escapeHtml(name)}</span>
                ${summary ? `<span class="tool-chip-summary">· ${escapeHtml(summary)}</span>` : ''}
            </summary>
            <div class="tool-chip-body">
                <div class="tool-chip-section-label">arguments</div>
                <pre class="tool-chip-json">${escapeHtml(argsJson)}</pre>
                <div class="tool-chip-section-label">result</div>
                <pre class="tool-chip-json">${escapeHtml(resultJson)}</pre>
            </div>
        </details>
    `;
}

// ============================================================================
// Marked.js Configuration (Markdown Parser Security)
// ============================================================================

/**
 * Configure marked.js with security options
 * Note: For full XSS protection, consider adding DOMPurify
 */
if (typeof marked !== 'undefined') {
    marked.setOptions({
        breaks: true,      // Convert \n to <br>
        gfm: true,         // GitHub Flavored Markdown
        headerIds: false,  // Disable header IDs (prevents ID-based attacks)
        mangle: false      // Don't mangle email addresses
    });
}

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const chatContainer = document.getElementById('chatContainer');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const loginButton = document.getElementById('loginButton');
const logoutButton = document.getElementById('logoutButton');
const promptLoginButton = document.getElementById('promptLoginButton');
const loginPrompt = document.getElementById('loginPrompt');
const userInfo = document.getElementById('userInfo');
const clearChatButton = document.getElementById('clearChatButton');
const exportChatButton = document.getElementById('exportChatButton');
const tokenPanelToggle = document.getElementById('tokenPanelToggle');
const themeToggle = document.getElementById('themeToggle');
const tokenPanel = document.getElementById('tokenPanel');
const tokenPanelClose = document.getElementById('tokenPanelClose');
const copyTokenButton = document.getElementById('copyTokenButton');
const copyJwtButton = document.getElementById('copyJwtButton');
const connectionsPanelToggle = document.getElementById('connectionsPanelToggle');
const connectionsPanel = document.getElementById('connectionsPanel');
const connectionsPanelBackdrop = document.getElementById('connectionsPanelBackdrop');
const connectionsPanelClose = document.getElementById('connectionsPanelClose');
const connectionsList = document.getElementById('connectionsList');
const connectionsRefreshButton = document.getElementById('connectionsRefreshButton');

let isConnected = false;
let llmEnabled = false;
let typingIndicator = null;
let isAuthenticated = false;
let oktaEnabled = false;
let conversationHistory = [];
let pendingMessage = null; // Stores message to retry after OAuth STS consent

// State Management Constants
const STORAGE_KEYS = {
    CONVERSATION: 'mcp_conversation_history',
    USER_PREFS: 'mcp_user_preferences',
    SESSION_ID: 'mcp_session_id',
    THEME: 'mcp_theme',
};

// ============================================================================
// Theme (light/dark) — applied to <html data-theme>, persisted per-browser
// ============================================================================

function resolveInitialTheme() {
    const saved = localStorage.getItem(STORAGE_KEYS.THEME);
    if (saved === 'light' || saved === 'dark') return saved;
    // Honor the OS preference on first visit.
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('themeToggleIcon');
    if (icon) {
        // Show the icon of what the button *switches to* — moon in light
        // mode (click to go dark), sun in dark mode (click to go light).
        icon.setAttribute('icon', theme === 'light' ? 'lucide:moon' : 'lucide:sun');
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem(STORAGE_KEYS.THEME, next);
}

// Apply theme before anything else paints to avoid a flash of the wrong theme.
applyTheme(resolveInitialTheme());

const MAX_MESSAGES = 100; // Limit stored messages
// Bump when the persisted `data` shape changes — old entries are discarded on
// load. v1.1 introduces the { toolResults } shape for assistant bubbles.
const STORAGE_VERSION = '1.1';

// Initialize session ID
function getOrCreateSessionId() {
    let sessionId = sessionStorage.getItem(STORAGE_KEYS.SESSION_ID);
    if (!sessionId) {
        sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        sessionStorage.setItem(STORAGE_KEYS.SESSION_ID, sessionId);
    }
    return sessionId;
}

// State Management: Save conversation to localStorage
function saveConversationState() {
    try {
        const state = {
            version: STORAGE_VERSION,
            timestamp: Date.now(),
            sessionId: getOrCreateSessionId(),
            userId: window.currentUser?.sub || 'anonymous',
            messages: conversationHistory.slice(-MAX_MESSAGES), // Keep last 100 messages
        };
        localStorage.setItem(STORAGE_KEYS.CONVERSATION, JSON.stringify(state));
        console.log('💾 Conversation saved:', conversationHistory.length, 'messages');
    } catch (error) {
        console.error('Failed to save conversation:', error);
        // Handle quota exceeded
        if (error.name === 'QuotaExceededError') {
            // Clear old data and try again with fewer messages
            conversationHistory = conversationHistory.slice(-50);
            saveConversationState();
        }
    }
}

// State Management: Load conversation from localStorage
function loadConversationState() {
    try {
        const saved = localStorage.getItem(STORAGE_KEYS.CONVERSATION);
        if (saved) {
            const state = JSON.parse(saved);
            
            // Version check
            if (state.version !== STORAGE_VERSION) {
                console.warn('⚠️ Conversation state version mismatch, clearing...');
                clearConversationState();
                return;
            }

            // Check if conversation is from current user (if authenticated)
            if (window.currentUser && state.userId !== window.currentUser.sub) {
                console.log('👤 Different user detected, starting fresh conversation');
                clearConversationState();
                return;
            }

            // Restore messages
            conversationHistory = state.messages || [];
            console.log('📂 Loaded conversation:', conversationHistory.length, 'messages');
            
            // Render restored messages
            conversationHistory.forEach(msg => {
                addMessageToDOM(msg.text, msg.type, msg.data, false); // false = don't save again
            });
        }
    } catch (error) {
        console.error('Failed to load conversation:', error);
        clearConversationState();
    }
}

// State Management: Clear conversation
function clearConversationState() {
    localStorage.removeItem(STORAGE_KEYS.CONVERSATION);
    conversationHistory = [];
    // Clear chat UI except welcome message
    const messages = chatContainer.querySelectorAll('.message');
    messages.forEach((msg, index) => {
        if (index > 0) msg.remove(); // Keep first welcome message
    });
    console.log('🗑️ Conversation cleared');
}

// State Management: Export conversation
function exportConversation() {
    const data = {
        version: STORAGE_VERSION,
        exportDate: new Date().toISOString(),
        user: window.currentUser,
        messages: conversationHistory,
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log('📥 Conversation exported');
}

// Check authentication status
async function checkAuthStatus() {
    try {
        const response = await fetch(`${API_BASE_URL}/auth/status`);
        if (response.ok) {
            const data = await response.json();
            isAuthenticated = data.authenticated;
            
            if (data.authenticated && data.user) {
                const userName = data.user.name || data.user.email || 'User';
                userInfo.textContent = `👤 ${userName}`;
                loginButton.style.display = 'none';
                logoutButton.style.display = 'inline-block';
                tokenPanelToggle.style.display = 'inline-block';
                loginPrompt.style.display = 'none';
                
                // Store user data globally for access
                window.currentUser = data.user;
                window.tokenInfo = data.tokenInfo;
                
                console.log('User authenticated:', data.user);
                console.log('Token info:', data.tokenInfo);
            } else if (oktaEnabled) {
                userInfo.textContent = '';
                loginButton.style.display = 'inline-block';
                logoutButton.style.display = 'none';
                tokenPanelToggle.style.display = 'none';
                loginPrompt.style.display = 'flex';
                
                window.currentUser = null;
                window.tokenInfo = null;
            }
            return data.authenticated;
        }
    } catch (error) {
        console.error('Auth status check failed:', error);
    }
    return false;
}

// Login handler
function handleLogin() {
    window.location.href = `${API_BASE_URL}/login`;
}

// Logout handler
function handleLogout() {
    // Clear conversation on logout
    if (confirm('Logging out will clear your chat history. Continue?')) {
        clearConversationState();
        window.location.href = `${API_BASE_URL}/logout`;
    }
}

// Fetch detailed user information
async function fetchUserDetails() {
    try {
        const response = await fetch(`${API_BASE_URL}/auth/user`, {
            credentials: 'include',
        });
        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                console.log('Full user details:', data.user);
                return data.user;
            }
        }
    } catch (error) {
        console.error('Failed to fetch user details:', error);
    }
    return null;
}

// Token Panel Functions
function openTokenPanel() {
    tokenPanel.classList.add('open');
    loadTokenDetails();
}

function closeTokenPanel() {
    tokenPanel.classList.remove('open');
}

// ============================================================================
// Connections Panel Functions
// ============================================================================

// Section-level descriptors for the three managed-connection categories. These
// render as the top-level "buckets" in the Connections panel; the cards inside
// each section describe instances (the specific AS, ISV app, or MCP server).
const CONNECTION_SECTIONS = [
    {
        kind: 'authorization_server',
        title: 'Authorization Server',
        icon: 'lucide:shield-check',
    },
    {
        kind: 'application',
        title: 'Application',
        icon: 'lucide:app-window',
    },
    {
        kind: 'mcp_server',
        title: 'MCP Server',
        icon: 'local:assets/mcp-icon.svg',
    },
];

/**
 * Best-effort mapping from an OAuth STS Resource Indicator (URL or Okta ORN)
 * to a friendly ISV name + brand icon. Falls back to a generic icon when we
 * can't infer — opaque ORNs don't carry the ISV name, so "connected to …"
 * simply omits the app name in that case.
 */
function inferIsv(resource) {
    if (!resource) return { name: null, icon: 'lucide:app-window' };
    const s = String(resource).toLowerCase();
    if (s.includes('github')) return { name: 'GitHub', icon: 'simple-icons:github' };
    if (s.includes('slack')) return { name: 'Slack', icon: 'simple-icons:slack' };
    if (s.includes('google')) return { name: 'Google', icon: 'simple-icons:google' };
    if (s.includes('microsoft') || s.includes('office365')) {
        return { name: 'Microsoft', icon: 'simple-icons:microsoft' };
    }
    if (s.includes('salesforce')) return { name: 'Salesforce', icon: 'simple-icons:salesforce' };
    return { name: null, icon: 'lucide:app-window' };
}

/**
 * Emit an icon HTML string. Accepts either:
 *   - an Iconify name (e.g. "lucide:plug", "simple-icons:github")
 *   - a "local:<path>" URI referencing an asset under /public (e.g.
 *     "local:assets/mcp-icon.svg"). Local assets render as a span that
 *     uses the SVG as a CSS mask so the icon picks up currentColor.
 */
function iconifyTag(icon, className = 'connection-card-icon') {
    if (typeof icon === 'string' && icon.startsWith('local:')) {
        const src = icon.slice('local:'.length);
        return `<span class="${escapeHtml(className)} local-icon" style="--icon-src: url('${escapeHtml(src)}')" aria-hidden="true"></span>`;
    }
    return `<iconify-icon class="${escapeHtml(className)}" icon="${escapeHtml(icon)}" aria-hidden="true"></iconify-icon>`;
}

let lastFocusedBeforeConnectionsPanel = null;

/** When docked (wide viewport), the panel is always visible; no modal theatrics. */
function isConnectionsDocked() {
    return window.matchMedia('(min-width: 1280px)').matches;
}

function openConnectionsPanel() {
    if (isConnectionsDocked()) {
        loadConnectionStatus();
        return;
    }
    if (connectionsPanel.classList.contains('open')) return;
    lastFocusedBeforeConnectionsPanel = document.activeElement;
    connectionsPanel.classList.add('open');
    connectionsPanel.setAttribute('role', 'dialog');
    connectionsPanel.setAttribute('aria-modal', 'false');
    connectionsPanelBackdrop?.classList.add('visible');
    connectionsPanelToggle?.classList.add('active');
    connectionsPanelToggle?.setAttribute('aria-expanded', 'true');
    loadConnectionStatus();
    setTimeout(() => connectionsPanelClose?.focus(), 50);
}

function closeConnectionsPanel() {
    if (isConnectionsDocked()) return;
    if (!connectionsPanel.classList.contains('open')) return;
    connectionsPanel.classList.remove('open');
    connectionsPanelBackdrop?.classList.remove('visible');
    connectionsPanelToggle?.classList.remove('active');
    connectionsPanelToggle?.setAttribute('aria-expanded', 'false');
    if (lastFocusedBeforeConnectionsPanel instanceof HTMLElement) {
        lastFocusedBeforeConnectionsPanel.focus();
    } else {
        connectionsPanelToggle?.focus();
    }
}

/**
 * Initial setup: when docked, pre-populate and re-hide the toggle button.
 * Fires after DOM + listeners are ready.
 */
function initConnectionsPanelMode() {
    const docked = isConnectionsDocked();
    if (docked) {
        connectionsPanelToggle?.setAttribute('aria-hidden', 'true');
        loadConnectionStatus();
    } else {
        connectionsPanelToggle?.removeAttribute('aria-hidden');
    }
}

async function loadConnectionStatus() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/connections/status`, {
            credentials: 'include',
        });
        if (!response.ok) {
            connectionsList.innerHTML = `<div class="connections-loading">Failed to load (HTTP ${response.status})</div>`;
            return;
        }
        const data = await response.json();
        renderConnectionStatus(data.connections || []);
    } catch (err) {
        console.error('Connections status fetch failed:', err);
        connectionsList.innerHTML = `<div class="connections-loading">Failed to load connections</div>`;
    }
}

/**
 * Derive a single status pill per connection.
 * mcp_server supports a tri-state 'partial' when some (but not all) MCPs are live.
 */
function statusFor(conn) {
    if (conn.disabled) return { state: 'disabled', label: 'Disabled' };
    if (!conn.configured) return { state: 'off', label: 'Off' };

    if (conn.kind === 'mcp_server') {
        const servers = conn.details?.servers || [];
        const live = servers.filter((s) => s.connected).length;
        if (servers.length > 0 && live === servers.length) return { state: 'live', label: 'Live' };
        if (live > 0) return { state: 'partial', label: `Partial ${live}/${servers.length}` };
        return { state: 'idle', label: 'Idle' };
    }

    return conn.connected
        ? { state: 'live', label: 'Live' }
        : { state: 'idle', label: 'Idle' };
}

/**
 * Render a detail value, optionally copy-on-click. For values that look like
 * opaque identifiers (URLs, ORNs, IDs), make them copyable.
 */
function renderValue(value, { copyable = true, hint = null } = {}) {
    const safe = escapeHtml(value);
    if (hint) {
        return `<span class="connection-detail-value"><span>${safe}</span> <span class="connection-detail-hint">${escapeHtml(hint)}</span></span>`;
    }
    if (!copyable) {
        return `<span class="connection-detail-value">${safe}</span>`;
    }
    return `<span class="connection-detail-value copyable" role="button" tabindex="0" title="Click to copy" data-copy="${safe}">${safe}</span>`;
}

function renderDetailRows(conn) {
    const d = conn.details || {};
    const rows = [];

    if (conn.kind === 'authorization_server') {
        if (d.authorizationServer) rows.push(['AS', renderValue(d.authorizationServer)]);
        if (d.agentId) rows.push(['Agent ID', renderValue(d.agentId)]);
    } else if (conn.kind === 'application') {
        if (d.resource) rows.push(['Resource', renderValue(d.resource)]);
    } else if (conn.kind === 'mcp_server') {
        if (d.mcpServerUrl) rows.push(['URL', renderValue(d.mcpServerUrl)]);
        if (d.resourceIndicator && d.resourceIndicator !== d.mcpServerUrl) {
            rows.push(['Resource', renderValue(d.resourceIndicator)]);
        }
        if (d.registeredAtOkta) {
            rows.push(['Registered', renderValue('Yes', { copyable: false })]);
            if (d.oktaMcpServerId) rows.push(['Okta ID', renderValue(d.oktaMcpServerId)]);
        } else {
            rows.push([
                'Registered',
                renderValue('No', { copyable: false, hint: 'register in Okta Admin Console' }),
            ]);
        }
    }

    return rows
        .map(
            ([label, valueHtml]) => `
            <div class="connection-detail-row">
                <span class="connection-detail-label">${escapeHtml(label)}:</span>
                ${valueHtml}
            </div>
        `
        )
        .join('');
}

/** Friendlier label for the auth strategy reported by the backend. */
function strategyLabel(strategy) {
    switch (strategy) {
        case 'id-jag': return 'ID-JAG authed';
        case 'oauth-sts': return 'OAuth STS authed';
        case 'none': return 'Unauthenticated';
        default: return strategy ? `${strategy} authed` : '';
    }
}

/** Build one connection-card row with consistent structure. */
function buildCard({ icon, title, state, statusLabel, subtitle, detailsHtml = '' }) {
    return `
        <div class="connection-card state-${state}">
            <div class="connection-card-header">
                ${icon ? iconifyTag(icon) : ''}
                <span class="connection-card-title">${escapeHtml(title)}</span>
                <span class="status-pill pill-${state}">${escapeHtml(statusLabel)}</span>
            </div>
            ${subtitle ? `<div class="connection-card-subtitle">${escapeHtml(subtitle)}</div>` : ''}
            ${detailsHtml}
        </div>
    `;
}

/**
 * Authorization Server card. Title is the AS hostname when we have it so
 * operators can tell at a glance which Okta org / custom AS is wired.
 */
function renderAuthorizationServerCard(conn) {
    const status = statusFor(conn);
    const as = conn.details?.authorizationServer;
    // Show the AS id (last path segment) or host — URLs are long.
    let title = 'Custom Okta AS';
    if (as) {
        try {
            const u = new URL(as);
            const last = u.pathname.replace(/\/$/, '').split('/').pop();
            title = last ? `Okta AS · ${last}` : u.host;
        } catch {
            title = as;
        }
    }
    return buildCard({
        icon: 'lucide:shield-check',
        title,
        state: status.state,
        statusLabel: status.label,
        subtitle: 'ID-JAG → MCP access token',
        detailsHtml: conn.configured ? renderDetailRows(conn) : '',
    });
}

/**
 * Application (OAuth STS) card. Title names the ISV when we can infer one
 * from the Resource Indicator (URL-style); falls back to the raw resource
 * or a generic label for opaque ORNs.
 */
function renderApplicationCard(conn) {
    const status = statusFor(conn);
    const resource = conn.details?.resource;
    const isv = inferIsv(resource);
    const icon = isv.name ? isv.icon : 'lucide:app-window';
    const title = isv.name || 'OAuth STS Application';
    const subtitle = isv.name
        ? (conn.connected ? `Connected to ${isv.name}` : `Brokered consent to ${isv.name}`)
        : 'Brokered consent via OAuth STS';

    return buildCard({
        icon,
        title,
        state: status.state,
        statusLabel: status.label,
        subtitle,
        detailsHtml: conn.configured ? renderDetailRows(conn) : '',
    });
}

/**
 * MCP server card. One per configured MCP (Todo MCP, GitHub MCP, …).
 * Brand icon when the URL contains a recognizable ISV, generic plug otherwise.
 */
function renderMcpServerCard(server) {
    const name = server.displayName || server.id || 'MCP Server';
    const status = server.connected
        ? { state: 'live', label: 'Live' }
        : { state: 'idle', label: 'Idle' };
    const brand = inferIsv(server.serverUrl);
    // Unbranded MCPs (e.g. Todo0) fall back to the MCP logo so the card still
    // reads as "an MCP server". Branded MCPs (GitHub, etc.) keep their ISV logo.
    const icon = brand.name ? brand.icon : 'local:assets/mcp-icon.svg';

    const rows = [];
    if (server.serverUrl) rows.push(['URL', renderValue(server.serverUrl)]);
    if (server.oktaMcpServerId) {
        rows.push(['Okta ID', renderValue(server.oktaMcpServerId)]);
    } else {
        rows.push([
            'Registered',
            renderValue('No', { copyable: false, hint: 'register in Okta Admin Console' }),
        ]);
    }

    const detailsHtml = rows
        .map(
            ([label, valueHtml]) => `
            <div class="connection-detail-row">
                <span class="connection-detail-label">${escapeHtml(label)}:</span>
                ${valueHtml}
            </div>
        `
        )
        .join('');

    return buildCard({
        icon,
        title: name,
        state: status.state,
        statusLabel: status.label,
        subtitle: strategyLabel(server.strategy) || 'MCP Server',
        detailsHtml,
    });
}

/**
 * Placeholder card when a section has no configured instances — still shown
 * so the "three managed-connection types" story reads even when a slot is
 * unconfigured or disabled.
 */
function renderEmptyCard(kind, note = 'Not configured') {
    const section = CONNECTION_SECTIONS.find((s) => s.kind === kind);
    const title = section ? section.title : kind;
    const icon = section ? section.icon : null;
    return buildCard({
        icon,
        title,
        state: 'off',
        statusLabel: 'Off',
        subtitle: note,
    });
}

/**
 * Collect the cards for a single section. For mcp_server, each configured
 * session becomes its own card; for the other kinds the connection itself
 * is the card. Disabled / unconfigured slots collapse to a placeholder.
 */
function renderSectionBody(conn) {
    if (!conn) return renderEmptyCard('application', 'Not configured');
    if (conn.disabled) return renderEmptyCard(conn.kind, 'Disabled');
    if (!conn.configured) return renderEmptyCard(conn.kind, 'Not configured');

    if (conn.kind === 'authorization_server') return renderAuthorizationServerCard(conn);
    if (conn.kind === 'application') return renderApplicationCard(conn);
    if (conn.kind === 'mcp_server') {
        const servers = Array.isArray(conn.details?.servers) ? conn.details.servers : [];
        if (servers.length === 0) return renderEmptyCard('mcp_server', 'No MCP sessions');
        return servers.map(renderMcpServerCard).join('');
    }
    return '';
}

function renderConnectionStatus(connections) {
    if (!connections.length) {
        connectionsList.innerHTML = `<div class="connections-loading">No connections reported</div>`;
        return;
    }

    // Index incoming connections by kind so we can render the sections in a
    // stable order regardless of backend ordering. Missing kinds show as
    // empty-state placeholders to keep the three-category story intact.
    const byKind = new Map(connections.map((c) => [c.kind, c]));

    const sectionsHtml = CONNECTION_SECTIONS.map((section) => {
        const conn = byKind.get(section.kind);
        const body = renderSectionBody(conn);
        return `
            <section class="connection-section">
                <div class="connection-section-header">
                    ${iconifyTag(section.icon, 'connection-section-icon')}
                    <span class="connection-section-title">${escapeHtml(section.title)}</span>
                </div>
                <div class="connection-section-body">
                    ${body}
                </div>
            </section>
        `;
    }).join('');

    connectionsList.innerHTML = sectionsHtml;
}

// Click-to-copy delegation for any element with .copyable + data-copy
async function handleCopyableClick(target) {
    const el = target.closest('.copyable');
    if (!el) return;
    const value = el.getAttribute('data-copy') || el.textContent || '';
    try {
        await navigator.clipboard.writeText(value);
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 1200);
    } catch (err) {
        console.warn('Clipboard copy failed:', err);
    }
}

if (connectionsList) {
    connectionsList.addEventListener('click', (e) => handleCopyableClick(e.target));
    connectionsList.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('copyable')) {
            e.preventDefault();
            handleCopyableClick(e.target);
        }
    });
}

async function loadTokenDetails() {
    try {
        const userDetails = await fetchUserDetails();
        if (!userDetails) {
            document.getElementById('tokenUserInfo').innerHTML = '<p>Unable to load token details</p>';
            return;
        }

        // Display user information (escaped to prevent XSS)
        const userInfoHtml = `
            <div class="token-info-row">
                <span class="token-info-label">Email:</span>
                <span class="token-info-value">${escapeHtml(userDetails.email) || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Name:</span>
                <span class="token-info-value">${escapeHtml(userDetails.name) || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Given Name:</span>
                <span class="token-info-value">${escapeHtml(userDetails.given_name) || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Family Name:</span>
                <span class="token-info-value">${escapeHtml(userDetails.family_name) || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Subject (sub):</span>
                <span class="token-info-value">${escapeHtml(userDetails.sub) || 'N/A'}</span>
            </div>
        `;
        document.getElementById('tokenUserInfo').innerHTML = userInfoHtml;

        // Display token metadata
        const issuedDate = userDetails.iat ? new Date(userDetails.iat * 1000).toLocaleString() : 'N/A';
        const expiresDate = userDetails.exp ? new Date(userDetails.exp * 1000).toLocaleString() : 'N/A';
        const timeLeft = userDetails.exp ? Math.max(0, Math.floor((userDetails.exp * 1000 - Date.now()) / 1000 / 60)) : 0;
        
        // Token metadata (escaped to prevent XSS)
        const metadataHtml = `
            <div class="token-info-row">
                <span class="token-info-label">Issuer:</span>
                <span class="token-info-value">${escapeHtml(userDetails.iss) || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Audience:</span>
                <span class="token-info-value">${escapeHtml(userDetails.aud) || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Issued At:</span>
                <span class="token-info-value">${escapeHtml(issuedDate)}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Expires At:</span>
                <span class="token-info-value">${escapeHtml(expiresDate)}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Time Remaining:</span>
                <span class="token-info-value">${escapeHtml(timeLeft)} minutes</span>
            </div>
        `;
        document.getElementById('tokenMetadata').innerHTML = metadataHtml;

        // Display full claims
        document.getElementById('tokenClaims').textContent = JSON.stringify(userDetails, null, 2);

        // Display JWT (masked for security)
        const jwtText = window.tokenInfo?.hasIdToken 
            ? '••••••.••••••.••••••\n\n(Token is stored securely on the server and not exposed to the browser for security reasons)' 
            : 'No ID token available';
        document.getElementById('tokenJwt').textContent = jwtText;

    } catch (error) {
        console.error('Error loading token details:', error);
        document.getElementById('tokenUserInfo').innerHTML = '<p style="color: red;">Error loading token details</p>';
    }
}

// Copy functions
async function copyToClipboard(text, button) {
    try {
        await navigator.clipboard.writeText(text);
        const originalText = button.textContent;
        button.textContent = '✅ Copied!';
        button.classList.add('copied');
        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('copied');
        }, 2000);
    } catch (error) {
        console.error('Failed to copy:', error);
        alert('Failed to copy to clipboard');
    }
}

// Global copy function
function copyToClipboard(text, label) {
    navigator.clipboard.writeText(text).then(() => {
        showNotification(`${label} copied to clipboard!`);
    }).catch(err => {
        console.error('Failed to copy:', err);
        showNotification('Failed to copy to clipboard', 'error');
    });
}

// Show notification
function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.classList.add('show');
    }, 10);
    
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Attach event listeners
if (loginButton) loginButton.addEventListener('click', handleLogin);
if (logoutButton) logoutButton.addEventListener('click', handleLogout);
if (promptLoginButton) promptLoginButton.addEventListener('click', handleLogin);
if (clearChatButton) clearChatButton.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear the chat history? This cannot be undone.')) {
        clearConversationState();
        addMessage('Chat history cleared. Start a new conversation!', 'system');
    }
});
if (exportChatButton) exportChatButton.addEventListener('click', exportConversation);
if (tokenPanelToggle) tokenPanelToggle.addEventListener('click', openTokenPanel);
if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
if (tokenPanelClose) tokenPanelClose.addEventListener('click', closeTokenPanel);
if (connectionsPanelToggle) connectionsPanelToggle.addEventListener('click', openConnectionsPanel);
if (connectionsPanelClose) connectionsPanelClose.addEventListener('click', closeConnectionsPanel);
if (connectionsPanelBackdrop) connectionsPanelBackdrop.addEventListener('click', closeConnectionsPanel);
if (connectionsRefreshButton) {
    connectionsRefreshButton.addEventListener('click', () => {
        connectionsRefreshButton.classList.remove('spinning');
        // reflow so the animation restarts each click
        void connectionsRefreshButton.offsetWidth;
        connectionsRefreshButton.classList.add('spinning');
        connectionsRefreshButton.blur();
        loadConnectionStatus();
    });
}

// Esc closes the connections panel (and any other open side panel) when focused inside
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (connectionsPanel?.classList.contains('open') && !isConnectionsDocked()) {
        closeConnectionsPanel();
    } else if (tokenPanel?.classList.contains('open')) {
        closeTokenPanel();
    }
});

// Initial mode + react to viewport changes between docked / slide-out
initConnectionsPanelMode();
const connectionsDockedQuery = window.matchMedia('(min-width: 1280px)');
if (connectionsDockedQuery.addEventListener) {
    connectionsDockedQuery.addEventListener('change', initConnectionsPanelMode);
} else if (connectionsDockedQuery.addListener) {
    // Safari <14 fallback
    connectionsDockedQuery.addListener(initConnectionsPanelMode);
}
if (copyTokenButton) copyTokenButton.addEventListener('click', async () => {
    const claims = document.getElementById('tokenClaims').textContent;
    await copyToClipboard(claims, copyTokenButton);
});
if (copyJwtButton) copyJwtButton.addEventListener('click', async () => {
    const jwt = document.getElementById('tokenJwt').textContent;
    await copyToClipboard(jwt, copyJwtButton);
});

// Show typing indicator
function showTypingIndicator() {
    if (typingIndicator) return; // Already showing
    
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'typing-indicator';
    typingIndicator.innerHTML = '<span></span><span></span><span></span>';
    chatContainer.appendChild(typingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Hide typing indicator
function hideTypingIndicator() {
    if (typingIndicator) {
        typingIndicator.remove();
        typingIndicator = null;
    }
}

// Check server connection
async function checkConnection() {
    try {
        const response = await fetch(`${API_BASE_URL}/health`);
        if (response.ok) {
            const data = await response.json();
            isConnected = true;
            llmEnabled = data.llmEnabled;
            oktaEnabled = data.oktaEnabled || false;
            
            statusEl.className = 'status connected';
            let statusText = `✅ Connected to MCP Client${llmEnabled ? ' (LLM Enabled)' : ''}`;
            if (oktaEnabled) {
                statusText += ' 🔐';
            }
            statusTextEl.textContent = statusText;
            
            // Check authentication if Okta is enabled. GitHub / OAuth STS
            // status is surfaced by the Managed Connections panel (Application
            // card), so no separate top-bar indicator check is needed.
            if (oktaEnabled) {
                await checkAuthStatus();
            }
            
            return true;
        }
    } catch (error) {
        isConnected = false;
        statusEl.className = 'status error';
        statusTextEl.textContent = '❌ Cannot connect to client. Please start the MCP client.';
        return false;
    }
}

// Add message to chat
function addMessage(text, type = 'assistant', data = null) {
    addMessageToDOM(text, type, data, true); // true = save to history
}

// Separate DOM manipulation from state management
function addMessageToDOM(text, type = 'assistant', data = null, saveToHistory = true) {
    // Hide typing indicator when adding a real message
    hideTypingIndicator();

    // Nothing to render — skip mounting an empty bubble.
    const toolResults = data && Array.isArray(data.toolResults) ? data.toolResults : [];
    const hasToolChips = toolResults.length > 0;
    if (!text && !hasToolChips) {
        return;
    }

    // Save to conversation history (after gating, so we don't restore empty bubbles)
    if (saveToHistory && type !== 'system') {
        const messageRecord = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            text,
            type,
            data,
            timestamp: new Date().toISOString(),
        };
        conversationHistory.push(messageRecord);
        saveConversationState();
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // Tool-call chips render above the prose. Collapsed by default.
    if (hasToolChips) {
        const chipsContainer = document.createElement('div');
        chipsContainer.className = 'tool-chips';
        chipsContainer.innerHTML = toolResults.map(renderToolChip).join('');
        contentDiv.appendChild(chipsContainer);
    }

    // Render markdown for text (sanitized to prevent XSS from LLM responses).
    if (text) {
        const proseDiv = document.createElement('div');
        proseDiv.className = 'message-prose';
        try {
            const parser = (typeof marked !== 'undefined' && marked.parse)
                ? marked
                : (typeof window.marked !== 'undefined' && window.marked.parse)
                    ? window.marked
                    : null;
            if (parser) {
                const rawHtml = parser.parse(text);
                proseDiv.innerHTML = typeof DOMPurify !== 'undefined'
                    ? DOMPurify.sanitize(rawHtml)
                    : escapeHtml(rawHtml);
            } else {
                proseDiv.textContent = text;
            }
        } catch (error) {
            console.error('Markdown parsing error:', error);
            proseDiv.textContent = text;
        }
        contentDiv.appendChild(proseDiv);
    }

    messageDiv.appendChild(contentDiv);
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Process message with LLM
async function processMessage(message) {
    try {
        // Show typing indicator
        showTypingIndicator();
        
        if (llmEnabled) {
            // Use LLM endpoint
            const response = await fetch(`${API_BASE_URL}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message }),
                credentials: 'include', // Include cookies for session
            });

            hideTypingIndicator();

            if (response.status === 401) {
                // Unauthorized - show login prompt
                addMessage('🔐 Please login to continue', 'error');
                if (oktaEnabled) {
                    loginPrompt.style.display = 'flex';
                }
                return;
            }

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            
            if (result.success) {
                // Check if OAuth STS interaction is required (legacy single-resource path,
                // used by the OIN GitHub integration).
                if (result.data && result.data.interaction_required) {
                    pendingMessage = message;
                    showConsentPrompt(
                        result.data.interaction_uri,
                        result.message || 'GitHub authorization required.',
                        null // resource unspecified -> legacy OIN handler
                    );
                    return;
                }

                // Multi-MCP path: Agent.connect() reported one or more MCPs with
                // OAuth-STS consent pending. Queue popups sequentially — finish
                // consent N before prompting for N+1. The original message is
                // replayed only after all pendings clear.
                if (result.data && Array.isArray(result.data.pending_consents) && result.data.pending_consents.length > 0) {
                    pendingMessage = message;
                    enqueuePendingConsents(result.data.pending_consents);
                    return;
                }

                // One bubble per turn: prose + (optional) collapsible tool-call chips.
                // The three-bubble pattern (prose + tool cards + data) caused
                // duplication and empty cards for tools whose result shape we
                // didn't recognize. Chips are uniform across all tools.
                const hasText = Boolean(result.message);
                const hasTools = Array.isArray(result.toolResults) && result.toolResults.length > 0;
                if (hasText || hasTools) {
                    addMessage(
                        result.message || '',
                        'assistant',
                        hasTools ? { toolResults: result.toolResults } : null
                    );
                }
            } else {
                addMessage(`❌ ${result.message || 'An error occurred'}`, 'error');
            }
        } else {
            // Fallback to simple NLP without LLM
            await processWithoutLLM(message);
        }
    } catch (error) {
        console.error('Processing error:', error);
        hideTypingIndicator();
        addMessage('❌ An error occurred. Please make sure the client is running.', 'error');
    }
}

// Simple NLP to parse user intent (fallback without LLM)
async function processWithoutLLM(message) {
    const lowerMsg = message.toLowerCase().trim();
    
    try {
        // Create todo
        if (lowerMsg.startsWith('create') || lowerMsg.startsWith('add') || lowerMsg.includes('new todo')) {
            const content = message.replace(/^(create|add|new)\s*(todo)?\s*/i, '').trim();
            if (!content) {
                addMessage('Please specify what todo to create.', 'error');
                return;
            }
            
            addMessage('Creating todo...', 'system');
            const result = await callTool('create-todo', { content });
            
            if (result.success) {
                addMessage(`✅ Todo created successfully!`, 'assistant');
            } else {
                addMessage(`❌ ${result.error}: ${result.message}`, 'error');
            }
            return;
        }

        // List todos
        if (lowerMsg === 'list' || lowerMsg === 'show todos' || lowerMsg === 'todos' || lowerMsg.includes('show') || lowerMsg.includes('list')) {
            addMessage('Fetching todos...', 'system');
            const result = await callTool('get-todos');

            if (result.success) {
                const todos = Array.isArray(result.todos) ? result.todos : [];
                const body = todos.length
                    ? todos.map(t => `- ${t.completed ? '✅' : '⬜'} **${t.title}** _(id: ${t.id})_`).join('\n')
                    : '_No todos yet._';
                addMessage(`**Found ${result.count ?? todos.length} todo(s):**\n\n${body}`, 'assistant');
            } else {
                addMessage(`❌ ${result.error}: ${result.message}`, 'error');
            }
            return;
        }

        // Update todo
        if (lowerMsg.startsWith('update') || lowerMsg.startsWith('edit')) {
            const match = message.match(/update|edit\s+(?:todo\s+)?(\w+)\s+to\s+(.+)/i);
            if (match) {
                const [, id, title] = match;
                addMessage('Updating todo...', 'system');
                const result = await callTool('update-todo', { id, title });

                if (result.success) {
                    addMessage(`✅ Todo updated successfully!`, 'assistant');
                } else {
                    addMessage(`❌ ${result.error}: ${result.message}`, 'error');
                }
            } else {
                addMessage('Please use format: "update todo <id> to <new title>"', 'error');
            }
            return;
        }

        // Toggle todo
        if (lowerMsg.startsWith('toggle') || lowerMsg.startsWith('complete') || lowerMsg.startsWith('mark')) {
            const match = message.match(/(?:toggle|complete|mark)\s+(?:todo\s+)?(\w+)/i);
            if (match) {
                const id = match[1];
                addMessage('Toggling todo...', 'system');
                const result = await callTool('toggle-todo', { id });

                if (result.success) {
                    addMessage(`✅ Todo toggled successfully!`, 'assistant');
                } else {
                    addMessage(`❌ ${result.error}: ${result.message}`, 'error');
                }
            } else {
                addMessage('Please specify the todo ID: "toggle <id>"', 'error');
            }
            return;
        }

        // Delete todo
        if (lowerMsg.startsWith('delete') || lowerMsg.startsWith('remove')) {
            const match = message.match(/(?:delete|remove)\s+(?:todo\s+)?(\w+)/i);
            if (match) {
                const id = match[1];
                addMessage('Deleting todo...', 'system');
                const result = await callTool('delete-todo', { id });

                if (result.success) {
                    addMessage(`✅ Todo deleted successfully!`, 'assistant');
                } else {
                    addMessage(`❌ ${result.error}: ${result.message}`, 'error');
                }
            } else {
                addMessage('Please specify the todo ID: "delete <id>"', 'error');
            }
            return;
        }
        
        // Help
        if (lowerMsg === 'help' || lowerMsg === '?') {
            addMessage(`Available commands:
• Create: "create todo Buy groceries"
• List: "list" or "show todos"
• Update: "update todo <id> to New Title"
• Toggle: "toggle todo <id>"
• Delete: "delete todo <id>"`, 'assistant');
            return;
        }
        
        // Default response
        addMessage('I didn\'t understand that. Type "help" for available commands.', 'assistant');
        
    } catch (error) {
        console.error('Processing error:', error);
        addMessage('❌ An error occurred. Please make sure the client is running.', 'error');
    }
}

// Call MCP tool via API (for fallback mode)
async function callTool(toolName, args = {}) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/tool`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ toolName, arguments: args }),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Tool call error:', error);
        throw error;
    }
}

// ============================================================================
// OAuth STS Consent Flow
// ============================================================================

// Queue of pending consents from the last chat response. Each entry is
// {mcpId, resource, interactionUri, message}. Drained sequentially — the
// current popup must finish before we prompt for the next resource.
let pendingConsentQueue = [];

function enqueuePendingConsents(entries) {
    pendingConsentQueue = entries.slice();
    dequeueNextConsent();
}

function dequeueNextConsent() {
    if (pendingConsentQueue.length === 0) {
        // All consents cleared — replay the original chat message.
        if (pendingMessage) {
            const msg = pendingMessage;
            pendingMessage = null;
            processMessage(msg);
        }
        return;
    }
    const entry = pendingConsentQueue.shift();
    showConsentPrompt(
        entry.interactionUri,
        entry.message || `Authorization required for ${entry.resource}.`,
        entry.resource
    );
}

function showConsentPrompt(interactionUri, message, resource) {
    hideTypingIndicator();

    const consentDiv = document.createElement('div');
    consentDiv.className = 'message assistant consent-message';
    // Stash resource on the DOM node so retry/backoff can thread it.
    if (resource) consentDiv.dataset.resource = resource;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    contentDiv.innerHTML = `
        <div class="consent-prompt">
            <p><strong>🔗 ${escapeHtml(message)}</strong></p>
            <p>A popup will open for authorization. After you authorize, the agent will automatically continue.</p>
            <button class="consent-retry-button" onclick="openConsentPopup('${escapeHtml(interactionUri)}', this)">Authorize Access</button>
            <span class="consent-status"></span>
        </div>
    `;

    consentDiv.appendChild(contentDiv);
    chatContainer.appendChild(consentDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    // Auto-open the consent popup
    openConsentPopup(interactionUri, consentDiv.querySelector('.consent-retry-button'));
}

let consentPollTimer = null;

function openConsentPopup(interactionUri, button) {
    // Open consent URI in a popup window
    const popup = window.open(interactionUri, 'github_consent', 'width=600,height=700,popup=yes');

    if (!popup) {
        // Popup was blocked — fall back to manual link
        const statusEl = button.closest('.consent-prompt').querySelector('.consent-status');
        statusEl.textContent = 'Popup blocked. ';
        const link = document.createElement('a');
        link.href = interactionUri;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Click here to authorize manually';
        link.className = 'consent-link';
        statusEl.appendChild(link);
        button.textContent = 'Retry Connection';
        button.onclick = () => retryOAuthStsExchange(button);
        return;
    }

    button.disabled = true;
    button.textContent = 'Waiting for authorization...';

    // Poll: check if popup closed, then try the exchange with retries
    if (consentPollTimer) clearInterval(consentPollTimer);
    consentPollTimer = setInterval(async () => {
        if (popup.closed) {
            clearInterval(consentPollTimer);
            consentPollTimer = null;
            button.textContent = 'Completing...';
            // Give Okta time to process the callback before retrying
            await retryOAuthStsWithBackoff(button);
        }
    }, 1000);
}

async function retryOAuthStsWithBackoff(button) {
    const maxAttempts = 5;
    const delays = [2000, 3000, 4000, 5000, 5000]; // ms between attempts

    // Replace consent prompt with a progress indicator
    const consentMsg = button.closest('.consent-message');
    const contentDiv = consentMsg ? consentMsg.querySelector('.message-content') : null;
    // Multi-MCP: target the specific resource stashed on the consent-message node.
    // Absent -> backend uses the legacy OIN handler.
    const resource = consentMsg && consentMsg.dataset.resource ? consentMsg.dataset.resource : null;
    if (contentDiv) {
        contentDiv.innerHTML = `
            <div class="consent-progress">
                <div class="consent-spinner"></div>
                <p class="consent-progress-text">Connecting to GitHub...</p>
            </div>
        `;
    }
    const progressText = contentDiv ? contentDiv.querySelector('.consent-progress-text') : null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const steps = [
            'Connecting to GitHub...',
            'Waiting for authorization to complete...',
            'Exchanging tokens...',
            'Almost there...',
            'Finalizing connection...',
        ];
        if (progressText) progressText.textContent = steps[attempt];

        // Wait before each attempt to let Okta process the callback
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));

        try {
            const response = await fetch(`${API_BASE_URL}/api/oauth-sts/exchange`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(resource ? { resource } : {}),
            });

            const result = await response.json();

            if (result.status === 'success') {
                // Show success briefly before removing
                if (contentDiv) {
                    contentDiv.innerHTML = `
                        <div class="consent-progress">
                            <span style="font-size: 1.5rem;">&#x2705;</span>
                            <p class="consent-progress-text">Connected!</p>
                        </div>
                    `;
                }

                // Brief pause to show success state, then clean up and continue
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (consentMsg) consentMsg.remove();

                addMessage(resource ? `Connected to ${resource}.` : 'GitHub connected successfully!', 'system');

                // Refresh the Managed Connections panel so the Application
                // (OAuth STS) card flips from Idle → Live.
                loadConnectionStatus();

                // Multi-MCP queue: if there are more pending consents, prompt
                // for the next one. Otherwise replay the original chat message.
                if (pendingConsentQueue.length > 0) {
                    dequeueNextConsent();
                } else if (pendingMessage) {
                    const msg = pendingMessage;
                    pendingMessage = null;
                    await processMessage(msg);
                }
                return;
            }

            if (result.status !== 'interaction_required') {
                // Real error, stop retrying
                if (contentDiv) {
                    contentDiv.innerHTML = `
                        <div class="consent-progress">
                            <span style="font-size: 1.5rem;">&#x274C;</span>
                            <p class="consent-progress-text">Authorization failed: ${escapeHtml(result.error_description || result.error || 'Unknown error')}</p>
                            <button class="consent-retry-button" onclick="retryOAuthStsExchange(this)">Retry</button>
                        </div>
                    `;
                }
                return;
            }

            // interaction_required — Okta hasn't processed yet, keep retrying
            console.log(`OAuth STS attempt ${attempt + 1}: still interaction_required, retrying...`);
        } catch (error) {
            console.error('OAuth STS retry error:', error);
        }
    }

    // Exhausted all attempts
    if (contentDiv) {
        contentDiv.innerHTML = `
            <div class="consent-progress">
                <span style="font-size: 1.5rem;">&#x23F3;</span>
                <p class="consent-progress-text">Authorization is taking longer than expected.</p>
                <button class="consent-retry-button" onclick="retryOAuthStsExchange(this)">Retry Connection</button>
            </div>
        `;
    }
}

async function retryOAuthStsExchange(button) {
    button.disabled = true;
    button.textContent = 'Retrying...';
    const consentMsg = button.closest('.consent-message');
    const resource = consentMsg && consentMsg.dataset.resource ? consentMsg.dataset.resource : null;

    try {
        const response = await fetch(`${API_BASE_URL}/api/oauth-sts/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(resource ? { resource } : {}),
        });

        const result = await response.json();

        if (result.status === 'success') {
            // Remove the consent prompt
            if (consentMsg) consentMsg.remove();

            addMessage(resource ? `Connected to ${resource}.` : 'GitHub connected successfully!', 'system');

            // Refresh the Managed Connections panel so the Application
            // (OAuth STS) card flips from Idle → Live.
            loadConnectionStatus();

            // Drain any remaining queued consents first; otherwise replay the
            // original chat message.
            if (pendingConsentQueue.length > 0) {
                dequeueNextConsent();
            } else if (pendingMessage) {
                const msg = pendingMessage;
                pendingMessage = null;
                await processMessage(msg);
            }
        } else if (result.status === 'interaction_required') {
            button.disabled = false;
            button.textContent = 'Retry Connection';
            addMessage('Authorization not yet completed. Please complete the authorization in the opened tab, then click Retry again.', 'system');
        } else {
            button.disabled = false;
            button.textContent = 'Retry Connection';
            addMessage(`Authorization failed: ${result.error_description || result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error('OAuth STS retry error:', error);
        button.disabled = false;
        button.textContent = 'Retry Connection';
        addMessage('Failed to connect. Please try again.', 'error');
    }
}

// Send message
async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;
    
    if (!isConnected) {
        addMessage('❌ Not connected to client. Please start the MCP client first.', 'error');
        return;
    }
    
    // Add user message
    addMessage(message, 'user');
    messageInput.value = '';
    
    // Disable input while processing
    sendButton.disabled = true;
    messageInput.disabled = true;
    
    // Process message
    await processMessage(message);
    
    // Re-enable input
    sendButton.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
}

// Event listeners
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

// Initialize app
async function initializeApp() {
    console.log('🚀 Initializing MCP Chat Client...');
    
    // Check connection
    await checkConnection();
    
    // Load saved conversation (after auth check)
    setTimeout(() => {
        loadConversationState();
    }, 500);
    
    // Set up periodic connection check
    setInterval(checkConnection, 5000);
    
    console.log('✅ App initialized');
}

// Start the app
initializeApp();
