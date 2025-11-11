const API_BASE_URL = 'http://localhost:3000';
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
const tokenPanel = document.getElementById('tokenPanel');
const tokenPanelClose = document.getElementById('tokenPanelClose');
const copyTokenButton = document.getElementById('copyTokenButton');
const copyJwtButton = document.getElementById('copyJwtButton');

let isConnected = false;
let llmEnabled = false;
let typingIndicator = null;
let isAuthenticated = false;
let oktaEnabled = false;
let conversationHistory = [];

// State Management Constants
const STORAGE_KEYS = {
    CONVERSATION: 'mcp_conversation_history',
    USER_PREFS: 'mcp_user_preferences',
    SESSION_ID: 'mcp_session_id'
};

const MAX_MESSAGES = 100; // Limit stored messages
const STORAGE_VERSION = '1.0';

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

async function loadTokenDetails() {
    try {
        const userDetails = await fetchUserDetails();
        if (!userDetails) {
            document.getElementById('tokenUserInfo').innerHTML = '<p>Unable to load token details</p>';
            return;
        }

        // Display user information
        const userInfoHtml = `
            <div class="token-info-row">
                <span class="token-info-label">Email:</span>
                <span class="token-info-value">${userDetails.email || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Name:</span>
                <span class="token-info-value">${userDetails.name || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Given Name:</span>
                <span class="token-info-value">${userDetails.given_name || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Family Name:</span>
                <span class="token-info-value">${userDetails.family_name || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Subject (sub):</span>
                <span class="token-info-value">${userDetails.sub || 'N/A'}</span>
            </div>
        `;
        document.getElementById('tokenUserInfo').innerHTML = userInfoHtml;

        // Display token metadata
        const issuedDate = userDetails.iat ? new Date(userDetails.iat * 1000).toLocaleString() : 'N/A';
        const expiresDate = userDetails.exp ? new Date(userDetails.exp * 1000).toLocaleString() : 'N/A';
        const timeLeft = userDetails.exp ? Math.max(0, Math.floor((userDetails.exp * 1000 - Date.now()) / 1000 / 60)) : 0;
        
        const metadataHtml = `
            <div class="token-info-row">
                <span class="token-info-label">Issuer:</span>
                <span class="token-info-value">${userDetails.iss || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Audience:</span>
                <span class="token-info-value">${userDetails.aud || 'N/A'}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Issued At:</span>
                <span class="token-info-value">${issuedDate}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Expires At:</span>
                <span class="token-info-value">${expiresDate}</span>
            </div>
            <div class="token-info-row">
                <span class="token-info-label">Time Remaining:</span>
                <span class="token-info-value">${timeLeft} minutes</span>
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
if (tokenPanelClose) tokenPanelClose.addEventListener('click', closeTokenPanel);
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
            
            // Check authentication if Okta is enabled
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
    
    // Save to conversation history
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
    
    // Check if data contains MCP UI resources
    if (data && data.resources) {
        // Render MCP UI resources
        let html = '<div class="mcp-ui-container">';
        html += '<div class="mcp-ui-label">📦 MCP Resources:</div>';
        data.resources.forEach((resource, index) => {
            html += `<ui-resource-renderer id="renderer-${Date.now()}-${index}"></ui-resource-renderer>`;
        });
        html += '</div>';
        contentDiv.innerHTML = html;
        
        // After adding to DOM, set the resource properties
        messageDiv.appendChild(contentDiv);
        chatContainer.appendChild(messageDiv);
        
        // Set resource data on each renderer
        setTimeout(() => {
            data.resources.forEach((resource, index) => {
                const renderer = document.getElementById(`renderer-${Date.now()}-${index}`);
                if (renderer) {
                    renderer.resource = resource;
                    renderer.addEventListener('onUIAction', (event) => {
                        console.log('UI Action:', event.detail);
                        handleUIAction(event.detail);
                    });
                }
            });
        }, 0);
        
        chatContainer.scrollTop = chatContainer.scrollHeight;
        return;
    }
    
    if (data && data.todos) {
        // Format todos nicely
        let html = `<strong>Found ${data.count} todo(s):</strong><br><br>`;
        data.todos.forEach((todo, index) => {
            const status = todo.completed ? '✅' : '⬜';
            html += `<div class="todo-item ${todo.completed ? 'completed' : ''}">`;
            html += `${status} <strong>${todo.title}</strong><br>`;
            html += `<small>ID: ${todo.id}</small>`;
            html += `</div>`;
        });
        contentDiv.innerHTML = html;
    } else if (data && data.todo) {
        // Format single todo
        const todo = data.todo;
        const status = todo.completed ? '✅' : '⬜';
        let html = `<div class="todo-item ${todo.completed ? 'completed' : ''}">`;
        html += `${status} <strong>${todo.title}</strong><br>`;
        html += `<small>ID: ${todo.id}</small>`;
        html += `</div>`;
        if (data.message) {
            html += `<br>${data.message}`;
        }
        contentDiv.innerHTML = html;
    } else if (data && data.toolResults) {
        // Format tool results from LLM
        let html = '';
        data.toolResults.forEach(tr => {
            if (tr.result.todos) {
                html += `<strong>Found ${tr.result.count} todo(s):</strong><br><br>`;
                tr.result.todos.forEach((todo) => {
                    const status = todo.completed ? '✅' : '⬜';
                    html += `<div class="todo-item ${todo.completed ? 'completed' : ''}">`;
                    html += `${status} <strong>${todo.title}</strong><br>`;
                    html += `<small>ID: ${todo.id}</small>`;
                    html += `</div>`;
                });
            } else if (tr.result.todo) {
                const todo = tr.result.todo;
                const status = todo.completed ? '✅' : '⬜';
                html += `<div class="todo-item ${todo.completed ? 'completed' : ''}">`;
                html += `${status} <strong>${todo.title}</strong><br>`;
                html += `<small>ID: ${todo.id}</small>`;
                html += `</div>`;
            }
        });
        contentDiv.innerHTML = html;
    } else {
        // Render markdown for text messages
        if (text) {
            try {
                // Check if marked is available and use it
                if (typeof marked !== 'undefined' && marked.parse) {
                    contentDiv.innerHTML = marked.parse(text);
                } else if (typeof window.marked !== 'undefined' && window.marked.parse) {
                    contentDiv.innerHTML = window.marked.parse(text);
                } else {
                    // Fallback to plain text
                    contentDiv.textContent = text;
                }
            } catch (error) {
                console.error('Markdown parsing error:', error);
                contentDiv.textContent = text;
            }
        } else {
            contentDiv.textContent = text;
        }
    }
    
    messageDiv.appendChild(contentDiv);
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Handle UI actions from MCP UI components
function handleUIAction(action) {
    console.log('Received UI action:', action);
    
    // Display the action as a user message and process it
    if (action.type === 'submit' || action.type === 'button_click') {
        const actionMessage = action.value || action.label || 'Action triggered';
        addMessage(`🎯 Action: ${actionMessage}`, 'user');
        
        // Process the action as if it were a user message
        if (action.value) {
            processMessage(action.value);
        }
    }
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
                // Show assistant message
                if (result.message) {
                    addMessage(result.message, 'assistant');
                }
                
                // Show tool results if any
                if (result.toolResults && result.toolResults.length > 0) {
                    addMessage('', 'assistant', result);
                }
                
                // Show data if available
                if (result.data) {
                    addMessage('', 'assistant', result.data);
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
                addMessage(`✅ Todo created successfully!`, 'assistant', result);
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
                addMessage('', 'assistant', result);
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
                    addMessage(`✅ Todo updated successfully!`, 'assistant', result);
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
                    addMessage(`✅ Todo toggled successfully!`, 'assistant', result);
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
                    addMessage(`✅ Todo deleted successfully!`, 'assistant', result);
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
