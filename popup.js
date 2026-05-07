document.addEventListener('DOMContentLoaded', () => {
  const btnTranslate = document.getElementById('btnTranslate');
  const btnRestore = document.getElementById('btnRestore');
  const providerSelect = document.getElementById('provider');
  const targetLangSelect = document.getElementById('targetLang');
  const translateModeSelect = document.getElementById('translateMode');
  const selectionTranslateEnabledInput = document.getElementById('selectionTranslateEnabled');
  const autoTranslateInput = document.getElementById('autoTranslate');
  const apiKeyInput = document.getElementById('apiKey');
  const deepseekConfig = document.getElementById('deepseekConfig');
  const statusText = document.getElementById('statusText');
  const progressText = document.getElementById('progressText');
  const btnOptions = document.getElementById('btnOptions');

  // Load saved settings
  chrome.storage.local.get([
    'provider',
    'targetLang',
    'translateMode',
    'selectionTranslateEnabled',
    'apiKey',
    'autoTranslate'
  ], (data) => {
    if (data.provider) providerSelect.value = data.provider;
    if (data.targetLang) targetLangSelect.value = data.targetLang;
    if (data.translateMode) translateModeSelect.value = data.translateMode;
    selectionTranslateEnabledInput.checked = data.selectionTranslateEnabled !== false;
    if (data.apiKey) apiKeyInput.value = data.apiKey;
    autoTranslateInput.checked = data.autoTranslate === true;
    toggleDeepseekConfig();
  });

  // Save settings on change
  providerSelect.addEventListener('change', () => {
    chrome.storage.local.set({ provider: providerSelect.value });
    toggleDeepseekConfig();
  });

  targetLangSelect.addEventListener('change', () => {
    chrome.storage.local.set({ targetLang: targetLangSelect.value });
  });

  translateModeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ translateMode: translateModeSelect.value });
  });

  selectionTranslateEnabledInput.addEventListener('change', () => {
    chrome.storage.local.set({ selectionTranslateEnabled: selectionTranslateEnabledInput.checked });
  });

  autoTranslateInput.addEventListener('change', () => {
    chrome.storage.local.set({ autoTranslate: autoTranslateInput.checked });
  });

  apiKeyInput.addEventListener('change', () => {
    chrome.storage.local.set({ apiKey: apiKeyInput.value });
  });

  function toggleDeepseekConfig() {
    deepseekConfig.style.display = providerSelect.value === 'deepseek' ? 'block' : 'none';
  }

  // Dynamically inject content script if not already loaded
  async function ensureContentScript(tabId, tabUrl) {
    // Skip restricted pages
    if (!tabUrl || tabUrl.startsWith('chrome://') || tabUrl.startsWith('edge://') ||
        tabUrl.startsWith('about:') || tabUrl.startsWith('chrome-extension://')) {
      return false;
    }

    // Try to ping existing content script
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (response && response.pong) return true;
    } catch (e) {
      // Content script not loaded, will inject below
    }

    // Inject content script dynamically
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      return true;
    } catch (e) {
      console.error('Failed to inject content script:', e);
      return false;
    }
  }

  // Check current tab state
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (!tabs[0]) return;
    const tab = tabs[0];

    // Skip restricted pages
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://'))) {
      statusText.textContent = '此页面不支持翻译';
      btnTranslate.disabled = true;
      return;
    }

    // Make sure content script is loaded, then check status
    const ready = await ensureContentScript(tab.id, tab.url);
    if (!ready) return;

    chrome.tabs.sendMessage(tab.id, { type: 'getStatus' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.translated) {
        btnRestore.disabled = false;
        btnTranslate.textContent = '重新翻译';
        statusText.textContent = res.autoTranslated ? '已自动翻译' : '已翻译';
      }
    });
  });

  // Translate button
  btnTranslate.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const targetLang = targetLangSelect.value;
    const translateMode = translateModeSelect.value;
    const apiKey = apiKeyInput.value;

    if (provider === 'deepseek' && !apiKey.trim()) {
      statusText.textContent = '请先填写 DeepSeek API Key';
      return;
    }

    document.body.classList.add('loading');
    btnTranslate.disabled = true;
    statusText.textContent = '正在翻译...';
    progressText.textContent = '';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      document.body.classList.remove('loading');
      btnTranslate.disabled = false;
      return;
    }

    // Ensure content script is loaded
    const ready = await ensureContentScript(tab.id, tab.url);
    if (!ready) {
      document.body.classList.remove('loading');
      btnTranslate.disabled = false;
      statusText.textContent = '无法在此页面使用翻译（可能是浏览器内部页面）';
      return;
    }

    chrome.tabs.sendMessage(tab.id, {
      type: 'translate',
      provider,
      targetLang,
      translateMode,
      apiKey
    }, (response) => {
      document.body.classList.remove('loading');
      btnTranslate.disabled = false;

      if (chrome.runtime.lastError) {
        statusText.textContent = '错误: ' + chrome.runtime.lastError.message;
        return;
      }

      if (response && response.success) {
        const lazyText = response.pending ? `，剩余 ${response.pending} 段滚动时翻译` : '';
        statusText.textContent = `翻译完成 (${response.count} 段${lazyText})`;
        btnRestore.disabled = false;
      } else if (response && response.error) {
        statusText.textContent = '错误: ' + response.error;
      }
    });
  });

  // Restore button
  btnRestore.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.tabs.sendMessage(tab.id, { type: 'restore' }, (response) => {
      if (response && response.success) {
        statusText.textContent = '已恢复原文';
        btnRestore.disabled = true;
        btnTranslate.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1"/><path d="M13 14l4 6 5-10"/></svg> 翻译网页`;
      }
    });
  });

  // Options button
  btnOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Listen for progress updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      progressText.textContent = msg.text;
    }
  });
});
