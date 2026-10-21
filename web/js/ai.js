// AutoGlow 2 - AI Copilot (Google Gemini BYOK) Module

// =============================================================================
// AI COPILOT & ASSISTANT (GOOGLE GEMINI BYOK)
// =============================================================================

let aiChatHistory = [];
let isAiGenerating = false;

function toggleAiDrawer() {
  const drawer = document.getElementById('aiChatDrawer');
  const backdrop = document.getElementById('aiDrawerBackdrop');
  if (!drawer) return;

  const isOpen = drawer.classList.contains('open');
  if (isOpen) {
    closeAiDrawer();
  } else {
    drawer.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
    checkAiKeyStatus();
    setTimeout(() => {
      const input = document.getElementById('aiChatInput');
      if (input) input.focus();
    }, 200);
  }
}

function closeAiDrawer() {
  const drawer = document.getElementById('aiChatDrawer');
  const backdrop = document.getElementById('aiDrawerBackdrop');
  if (drawer) drawer.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
}

function toggleAiKeySettings() {
  const panel = document.getElementById('aiKeySettingsPanel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

async function checkAiKeyStatus() {
  try {
    const data = await (window.api ? window.api.getAiStatus() : (await fetch('/api/ai/status')).json());
    const panel = document.getElementById('aiKeySettingsPanel');
    const input = document.getElementById('geminiApiKeyInput');
    
    if (data.status === 'ok') {
      if (!data.has_key) {
        if (panel) panel.style.display = 'flex';
      } else {
        if (input && data.masked_key) {
          input.placeholder = `Configured (${data.masked_key})`;
        }
      }
    }
  } catch (err) {
    console.warn("Failed to check AI key status:", err);
  }
}

async function saveGeminiApiKey() {
  const input = document.getElementById('geminiApiKeyInput');
  if (!input) return;
  const key = input.value.trim();

  if (!key) {
    showToast("Please enter a valid Gemini API key.", "error");
    return;
  }

  try {
    const data = await (window.api ? window.api.saveAiKey(key) : (await fetch('/api/ai/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key })
    })).json());
    if (data.status === 'ok') {
      showToast("✓ Gemini API key saved successfully.", "success");
      input.value = "";
      input.placeholder = `Configured (${key.slice(0,6)}...${key.slice(-4)})`;
      const panel = document.getElementById('aiKeySettingsPanel');
      if (panel) panel.style.display = 'none';
    }
  } catch (err) {
    showToast(`Error saving key: ${err.message || err}`, 'error');
  }
}

function handleAiInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendAiChatMessage();
  }
}

function sendSuggestionChip(text) {
  const input = document.getElementById('aiChatInput');
  if (input) {
    input.value = text;
    sendAiChatMessage();
  }
}

function formatMarkdown(text) {
  if (!text) return '';
  let formatted = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks
  formatted = formatted.replace(/```([a-z]*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Headers
  formatted = formatted.replace(/^### (.*$)/gim, '<strong style="color: var(--accent-primary); display:block; margin-top:8px;">$1</strong>');
  formatted = formatted.replace(/^## (.*$)/gim, '<strong style="color: var(--accent-primary); font-size:13px; display:block; margin-top:10px;">$1</strong>');
  // Bullet lists
  formatted = formatted.replace(/^\s*[-*]\s+(.*$)/gim, '<li>$1</li>');
  formatted = formatted.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  // Paragraphs
  formatted = formatted.split('\n\n').map(p => {
    if (p.startsWith('<pre>') || p.startsWith('<ul>') || p.startsWith('<strong')) return p;
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return formatted;
}

async function sendAiChatMessage() {
  if (isAiGenerating) return;
  const input = document.getElementById('aiChatInput');
  const messagesContainer = document.getElementById('aiChatMessages');
  const sendBtn = document.getElementById('btnSendAiMessage');
  if (!input || !messagesContainer) return;

  const query = input.value.trim();
  if (!query) return;

  // Clear input
  input.value = '';

  // Append user bubble
  const userMsgElem = document.createElement('div');
  userMsgElem.className = 'ai-msg user';
  userMsgElem.innerHTML = `<div class="ai-msg-bubble">${formatMarkdown(query)}</div>`;
  messagesContainer.appendChild(userMsgElem);

  // Append loading assistant bubble
  const loadingElem = document.createElement('div');
  loadingElem.className = 'ai-msg assistant';
  loadingElem.innerHTML = `
    <div class="ai-msg-bubble" style="display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-style: italic;">
      <span class="pulse-dot" style="background-color: var(--accent-primary);"></span>
      <span>Thinking with Gemini...</span>
    </div>
  `;
  messagesContainer.appendChild(loadingElem);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  isAiGenerating = true;
  if (sendBtn) sendBtn.disabled = true;

  try {
    const data = await (window.api ? window.api.sendAiChat(query, aiChatHistory) : (await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: query,
        history: aiChatHistory
      })
    })).json());

    if (data.status === 'ok' && data.reply) {
      loadingElem.innerHTML = `<div class="ai-msg-bubble">${formatMarkdown(data.reply)}</div>`;
      aiChatHistory.push({ role: 'user', text: query });
      aiChatHistory.push({ role: 'model', text: data.reply });
    } else {
      loadingElem.innerHTML = `
        <div class="ai-msg-bubble" style="border-left: 3px solid var(--status-danger);">
          <p style="color: var(--status-danger); font-weight: 600;">${data.message || 'Unknown error'}</p>
          ${data.message && data.message.includes('No Google Gemini API key') ? `
            <p style="margin-top: 6px;">
              <button class="btn-ide btn-ide-primary" onclick="toggleAiKeySettings()" style="font-size: 11px; padding: 4px 10px;">Enter API Key</button>
            </p>
          ` : ''}
        </div>
      `;
    }
  } catch (err) {
    loadingElem.innerHTML = `<div class="ai-msg-bubble" style="color: var(--status-danger);">Network error: ${err.message}</div>`;
  } finally {
    isAiGenerating = false;
    if (sendBtn) sendBtn.disabled = false;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

if (typeof window !== "undefined") {
  window.toggleAiDrawer = toggleAiDrawer;
  window.closeAiDrawer = closeAiDrawer;
  window.toggleAiKeySettings = toggleAiKeySettings;
  window.checkAiKeyStatus = checkAiKeyStatus;
  window.saveGeminiApiKey = saveGeminiApiKey;
  window.handleAiInputKeydown = handleAiInputKeydown;
  window.sendSuggestionChip = sendSuggestionChip;
  window.sendAiChatMessage = sendAiChatMessage;
}



