// Content script - DOM traversal, translation insertion, and bilingual display

const BLOCK_TAGS = new Set([
  'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'TD', 'TH', 'DD', 'DT',
  'FIGCAPTION', 'BLOCKQUOTE', 'PRE',
  'ARTICLE', 'SECTION', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV',
  'LABEL', 'SUMMARY', 'DETAILS', 'CAPTION'
]);

const INLINE_TAGS = new Set([
  'A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'SUB', 'SUP',
  'ABBR', 'CITE', 'Q', 'TIME', 'MARK'
]);

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
  'BUTTON', 'CODE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH',
  'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
  'BR', 'HR', 'WBR'
]);

const MIN_TEXT_LENGTH = 2;
const MAX_CHILDREN = 100;
const LAZY_ROOT_MARGIN = '320px 0px';
const LAZY_BATCH_DELAY = 120;
let isTranslated = false;
let translatedElements = [];
let selectionBubble = null;
let selectedTextForBubble = '';
let selectionTranslateEnabled = true;
let selectionBubbleDragging = false;
let selectionBubbleDragTarget = null;
let selectionBubbleDragOffset = { x: 0, y: 0 };
let currentTranslateSettings = null;
let lazyObserver = null;
let lazySettings = null;
let lazyQueue = [];
let lazyQueueTimer = null;
let lazyBusy = false;
let lazyRunId = 0;

// Prevent duplicate injection
if (!window.__qtContentScriptLoaded) {
  window.__qtContentScriptLoaded = true;
  initSelectionTranslate();

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ pong: true });
      return false;
    }

    if (msg.type === 'translate') {
      doTranslate(msg.provider, msg.targetLang, msg.apiKey, msg.translateMode)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (msg.type === 'restore') {
      doRestore();
      sendResponse({ success: true });
      return false;
    }

    if (msg.type === 'getStatus') {
      sendResponse({ translated: isTranslated });
      return false;
    }
  });
}

// Main translation flow
async function doTranslate(provider, targetLang, apiKey, translateMode) {
  const sitePolicy = await getSitePolicy();
  if (!sitePolicy.allowed) {
    return { success: false, error: `当前站点已被规则禁用：${sitePolicy.reason}` };
  }

  if (isTranslated) {
    doRestore();
  }
  disconnectLazyObserver();
  const savedSettings = await getTranslationSettings();
  currentTranslateSettings = {
    ...savedSettings,
    provider,
    targetLang,
    apiKey,
    translateMode: translateMode || savedSettings.translateMode || 'lazy'
  };

  let segments;
  try {
    segments = collectSegments();
  } catch (e) {
    return { success: false, error: 'Failed to collect text: ' + e.message };
  }

  if (segments.length === 0) {
    return { success: false, error: 'No translatable content found on this page' };
  }

  const mode = currentTranslateSettings.translateMode;
  const useLazy = mode === 'lazy' && 'IntersectionObserver' in window;
  const initialSegments = useLazy
    ? segments.filter(segment => isElementNearViewport(segment.element))
    : segments;
  const pendingSegments = useLazy
    ? segments.filter(segment => !isElementNearViewport(segment.element))
    : [];

  let inserted = 0;

  if (initialSegments.length > 0) {
    const response = await requestTranslations(initialSegments, currentTranslateSettings);

    if (!response || !response.success) {
      return response || { success: false, error: 'No response from background' };
    }

    try {
      inserted = insertTranslations(initialSegments, response.translations);
    } catch (e) {
      return { success: false, error: 'Failed to insert translations: ' + e.message };
    }
  }

  if (pendingSegments.length > 0) {
    setupLazyTranslation(pendingSegments, currentTranslateSettings);
  }

  isTranslated = true;
  return {
    success: true,
    count: inserted,
    pending: pendingSegments.length,
    mode
  };
}

function requestTranslations(segments, settings) {
  return chrome.runtime.sendMessage({
    type: 'translate',
    segments: segments.map((s, i) => ({ id: i, text: s.text })),
    provider: settings.provider,
    targetLang: settings.targetLang,
    apiKey: settings.apiKey,
    glossary: settings.glossary,
    customStyle: settings.customStyle
  });
}

// Collect translatable text segments from the page
function collectSegments() {
  const segments = [];
  const processed = new Set();

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const text = node.textContent;
        if (!text || !String(text).trim()) return NodeFilter.FILTER_SKIP;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        // Skip unwanted tags
        let el = parent;
        while (el && el !== document.body) {
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }

        // Skip our own UI and translation elements
        if (parent.closest && parent.closest('.qt-translation, .qt-selection-bubble')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const textNodes = [];
  let node;
  while (node = walker.nextNode()) {
    textNodes.push(node);
  }

  // Group text nodes by their nearest meaningful block ancestor
  for (const textNode of textNodes) {
    const target = findTranslatableAncestor(textNode);
    if (!target || processed.has(target)) continue;

    // Use textContent as fallback (innerText is undefined on non-HTMLElement)
    const rawText = target.innerText !== undefined ? target.innerText : target.textContent;
    const text = (rawText || '').trim();
    if (text.length < MIN_TEXT_LENGTH) continue;

    processed.add(target);
    segments.push({ element: target, text });
  }

  return segments;
}

// Find the nearest ancestor element suitable for translation
function findTranslatableAncestor(textNode) {
  let el = textNode.parentElement;
  let bestMatch = null;

  while (el && el !== document.body && el !== document.documentElement) {
    if (SKIP_TAGS.has(el.tagName)) return null;

    // Skip ARIA hidden elements
    if (el.getAttribute('aria-hidden') === 'true') return null;

    // Stop at a meaningful block boundary
    if (BLOCK_TAGS.has(el.tagName)) {
      bestMatch = el;
      break;
    }

    try {
      const display = getComputedStyle(el).display;
      if (display === 'block' || display === 'list-item' || display === 'flex' || display === 'grid') {
        bestMatch = el;
        break;
      }
    } catch (e) {
      // getComputedStyle can fail on detached elements
      break;
    }

    el = el.parentElement;
  }

  // If no block ancestor found, use the direct parent unless it is inline.
  if (!bestMatch && textNode.parentElement && textNode.parentElement !== document.body) {
    bestMatch = INLINE_TAGS.has(textNode.parentElement.tagName)
      ? textNode.parentElement.closest('p, li, td, th, dd, dt, figcaption, blockquote, label')
      : textNode.parentElement;
  }

  if (!bestMatch) return null;

  // Must be an HTMLElement to have innerText
  if (!(bestMatch instanceof HTMLElement)) return null;

  // Skip elements that are too large (likely containers with many children)
  try {
    const childCount = bestMatch.querySelectorAll('*').length;
    if (childCount > MAX_CHILDREN) {
      // Try to find a more specific ancestor
      let specificEl = textNode.parentElement;
      while (specificEl && specificEl !== bestMatch) {
        if (specificEl instanceof HTMLElement) {
          const display = getComputedStyle(specificEl).display;
          if (BLOCK_TAGS.has(specificEl.tagName) ||
              display === 'block' || display === 'list-item' || display === 'flex' || display === 'grid') {
            return specificEl;
          }
        }
        specificEl = specificEl.parentElement;
      }
      // If still too broad, skip
      if (childCount > MAX_CHILDREN * 3) {
        return null;
      }
    }
  } catch (e) {
    return null;
  }

  return bestMatch;
}

// Insert bilingual translations into the DOM
// Returns the number of successfully inserted translations
function insertTranslations(segments, translations, options = {}) {
  if (options.reset !== false) {
    translatedElements = [];
  }
  let inserted = 0;

  for (let i = 0; i < segments.length; i++) {
    const { element } = segments[i];
    const translated = translations[i];

    try {
      if (element.querySelector(':scope > .qt-translation')) continue;

      const isError = !translated ||
        translated.startsWith('[Translation failed') ||
        translated.startsWith('[DeepSeek error');
      const translationEl = createTranslationElement(
        segments[i],
        translated || '翻译失败',
        i,
        isError,
        options.settings || currentTranslateSettings
      );
      const style = options.settings?.translationStyle ||
        currentTranslateSettings?.translationStyle ||
        'replace';

      const originalWrap = style === 'replace' ? wrapOriginalContent(element) : null;
      element.classList.toggle('qt-replace-mode', style === 'replace');
      element.appendChild(translationEl);

      element.classList.add('qt-original');
      element.classList.add('qt-inner');
      element.setAttribute('data-qt-style', style);

      translatedElements.push({ original: element, translation: translationEl, originalWrap });
      inserted++;
    } catch (e) {
      // Skip if insertion fails (e.g., detached node)
    }
  }

  return inserted;
}

function createTranslationElement(segment, translated, index, isError, settings) {
  const translationEl = document.createElement('span');
  const style = settings?.translationStyle || 'replace';
  translationEl.className = `qt-translation qt-style-${style}`;
  if (isError) translationEl.classList.add('qt-translation-error');
  translationEl.setAttribute('data-qt-index', index);

  const textEl = document.createElement('span');
  textEl.className = 'qt-translation-text';
  textEl.textContent = normalizeTranslationText(translated);
  translationEl.appendChild(textEl);

  if (isError) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'qt-retry-button';
    retry.textContent = '重试';
    retry.addEventListener('click', () => retrySegment(segment, translationEl));
    translationEl.appendChild(retry);
  }

  return translationEl;
}

function wrapOriginalContent(element) {
  const wrap = document.createElement('span');
  wrap.className = 'qt-original-wrap';

  while (element.firstChild) {
    wrap.appendChild(element.firstChild);
  }

  element.appendChild(wrap);
  return wrap;
}

async function retrySegment(segment, translationEl) {
  const settings = currentTranslateSettings || await getTranslationSettings();
  translationEl.classList.remove('qt-translation-error');
  translationEl.innerHTML = '';

  const loading = document.createElement('span');
  loading.className = 'qt-translation-text';
  loading.textContent = '正在重试...';
  translationEl.appendChild(loading);

  try {
    const response = await requestTranslations([segment], settings);
    const translated = response?.translations?.[0];
    const failed = !response?.success ||
      !translated ||
      translated.startsWith('[Translation failed') ||
      translated.startsWith('[DeepSeek error');

    if (failed) {
      const replacement = createTranslationElement(segment, translated || response?.error || '翻译失败', 0, true, settings);
      translationEl.replaceWith(replacement);
      updateTranslatedElement(segment.element, replacement);
      return;
    }

    translationEl.className = `qt-translation qt-style-${settings.translationStyle || 'replace'}`;
    translationEl.textContent = normalizeTranslationText(translated);
  } catch (err) {
    const replacement = createTranslationElement(segment, err.message || '翻译失败', 0, true, settings);
    translationEl.replaceWith(replacement);
    updateTranslatedElement(segment.element, replacement);
  }
}

function updateTranslatedElement(original, translation) {
  const item = translatedElements.find(entry => entry.original === original);
  if (item) item.translation = translation;
}

// Restore original page (remove translations)
function doRestore() {
  disconnectLazyObserver();
  for (const { original, translation, originalWrap } of translatedElements) {
    try {
      translation.remove();
      if (originalWrap && originalWrap.isConnected) {
        while (originalWrap.firstChild) {
          original.insertBefore(originalWrap.firstChild, originalWrap);
        }
        originalWrap.remove();
      }
      original.classList.remove('qt-original');
      original.classList.remove('qt-inner');
      original.classList.remove('qt-replace-mode');
      original.removeAttribute('data-qt-style');
    } catch (e) {
      // Element may have been removed by page
    }
  }

  translatedElements = [];
  isTranslated = false;
  currentTranslateSettings = null;
}

function setupLazyTranslation(segments, settings) {
  if (!('IntersectionObserver' in window)) return;

  disconnectLazyObserver();
  lazySettings = settings;
  lazyQueue = [];
  lazyBusy = false;
  lazyRunId++;

  lazyObserver = new IntersectionObserver((entries) => {
    const visibleSegments = [];
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;

      const segment = entry.target.__qtLazySegment;
      if (!segment) continue;

      delete entry.target.__qtLazySegment;
      entry.target.removeAttribute('data-qt-lazy');
      lazyObserver.unobserve(entry.target);
      visibleSegments.push(segment);
    }

    if (visibleSegments.length > 0) {
      enqueueLazySegments(visibleSegments);
    }
  }, {
    root: null,
    rootMargin: LAZY_ROOT_MARGIN,
    threshold: 0.01
  });

  for (const segment of segments) {
    segment.element.__qtLazySegment = segment;
    segment.element.setAttribute('data-qt-lazy', 'true');
    lazyObserver.observe(segment.element);
  }
}

function enqueueLazySegments(segments) {
  lazyQueue.push(...segments);
  if (lazyQueueTimer) return;

  lazyQueueTimer = setTimeout(() => {
    lazyQueueTimer = null;
    processLazyQueue();
  }, LAZY_BATCH_DELAY);
}

async function processLazyQueue() {
  if (lazyBusy || lazyQueue.length === 0 || !lazySettings) return;

  lazyBusy = true;
  const runId = lazyRunId;
  const batch = lazyQueue.splice(0, 12)
    .filter(segment => segment.element.isConnected && !segment.element.querySelector(':scope > .qt-translation'));

  try {
    if (batch.length > 0) {
      const response = await requestTranslations(batch, lazySettings);

      if (response?.success && runId === lazyRunId) {
        insertTranslations(batch, response.translations, { reset: false, settings: lazySettings });
      }
    }
  } catch (e) {
    // Lazy translation should not interrupt page use.
  } finally {
    lazyBusy = false;
    if (runId === lazyRunId && lazyQueue.length > 0) {
      processLazyQueue();
    }
  }
}

function disconnectLazyObserver() {
  if (lazyObserver) {
    lazyObserver.disconnect();
    lazyObserver = null;
  }

  if (lazyQueueTimer) {
    clearTimeout(lazyQueueTimer);
    lazyQueueTimer = null;
  }

  lazyQueue = [];
  lazySettings = null;
  lazyBusy = false;
  lazyRunId++;

  document.querySelectorAll('[data-qt-lazy]').forEach(element => {
    delete element.__qtLazySegment;
    element.removeAttribute('data-qt-lazy');
  });
}

function isElementNearViewport(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  const margin = 320;
  return rect.bottom >= -margin &&
    rect.top <= window.innerHeight + margin &&
    rect.right >= 0 &&
    rect.left <= window.innerWidth;
}

function normalizeTranslationText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function initSelectionTranslate() {
  loadSelectionTranslateSetting();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.selectionTranslateEnabled) return;
    selectionTranslateEnabled = changes.selectionTranslateEnabled.newValue !== false;
    if (!selectionTranslateEnabled) hideSelectionBubble(true);
  });

  document.addEventListener('mouseup', (event) => {
    if (event.target?.closest?.('.qt-selection-bubble')) return;
    setTimeout(showSelectionBubble, 0);
  });

  document.addEventListener('keyup', (event) => {
    if (event.key === 'Escape') {
      hideSelectionBubble(true);
      return;
    }
    showSelectionBubble();
  });

  document.addEventListener('scroll', (event) => {
    if (selectionBubble?.contains(event.target)) return;
    hideSelectionBubble();
  }, true);
  window.addEventListener('resize', () => {
    hideSelectionBubble();
  });
  document.addEventListener('mousemove', dragSelectionBubble);
  document.addEventListener('mouseup', stopDraggingSelectionBubble);
}

async function showSelectionBubble() {
  if (!selectionTranslateEnabled) {
    hideSelectionBubble(true);
    return;
  }

  const sitePolicy = await getSitePolicy();
  if (!sitePolicy.allowed) {
    hideSelectionBubble(true);
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    hideSelectionBubble();
    return;
  }

  const text = selection.toString().trim();
  if (text.length < MIN_TEXT_LENGTH || text.length > 3000) {
    hideSelectionBubble();
    return;
  }

  const anchor = selection.anchorNode?.parentElement;
  if (anchor && anchor.closest('.qt-translation, .qt-selection-bubble')) {
    hideSelectionBubble();
    return;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    hideSelectionBubble();
    return;
  }

  selectedTextForBubble = text;

  if (!selectionBubble) {
    selectionBubble = createSelectionBubble();
    document.documentElement.appendChild(selectionBubble);
  }

  selectionBubble.classList.remove('qt-selection-bubble-result', 'qt-selection-bubble-error');
  selectionBubble.innerHTML = '';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'qt-selection-action';
  button.textContent = '翻译';
  button.addEventListener('click', translateSelectedText);
  selectionBubble.appendChild(button);

  positionSelectionBubble(rect);
  selectionBubble.hidden = false;
}

function loadSelectionTranslateSetting() {
  chrome.storage.local.get(['selectionTranslateEnabled'], data => {
    selectionTranslateEnabled = data.selectionTranslateEnabled !== false;
  });
}

function createSelectionBubble() {
  const bubble = document.createElement('div');
  bubble.className = 'qt-selection-bubble';
  bubble.hidden = true;
  bubble.addEventListener('mousedown', event => {
    if (event.target.closest('button')) return;
    event.preventDefault();
  });
  return bubble;
}

function positionSelectionBubble(rect) {
  const bubbleWidth = Math.min(360, window.innerWidth - 24);
  const top = Math.max(8, rect.top + window.scrollY - 44);
  const left = Math.min(
    window.scrollX + window.innerWidth - bubbleWidth - 12,
    Math.max(12 + window.scrollX, rect.left + window.scrollX + rect.width / 2 - bubbleWidth / 2)
  );

  selectionBubble.style.width = `${bubbleWidth}px`;
  selectionBubble.style.left = `${left}px`;
  selectionBubble.style.top = `${top}px`;
}

async function translateSelectedText() {
  if (!selectionBubble || !selectedTextForBubble) return;

  renderSelectionBubbleState('正在翻译...');

  try {
    const sitePolicy = await getSitePolicy();
    if (!sitePolicy.allowed) {
      renderSelectionBubbleState(`当前站点已禁用划译：${sitePolicy.reason}`, true);
      return;
    }

    const settings = await getTranslationSettings();
    if (settings.provider === 'deepseek' && !settings.apiKey) {
      renderSelectionBubbleState('请先在插件设置中填写 DeepSeek API Key', true);
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: 'translate',
      segments: [{ id: 0, text: selectedTextForBubble }],
      provider: settings.provider,
      targetLang: settings.targetLang,
      apiKey: settings.apiKey,
      glossary: settings.glossary,
      customStyle: settings.customStyle
    });

    if (!response || !response.success) {
      renderSelectionBubbleState(response?.error || '翻译失败', true);
      return;
    }

    const translated = normalizeTranslationText(response.translations?.[0] || '');
    renderSelectionBubbleState(translated || '没有返回翻译结果');
  } catch (err) {
    renderSelectionBubbleState(err.message || '翻译失败', true);
  }
}

function renderSelectionBubbleState(text, isError = false) {
  selectionBubble.innerHTML = '';
  selectionBubble.classList.add('qt-selection-bubble-result');
  selectionBubble.classList.toggle('qt-selection-bubble-error', isError);

  const content = document.createElement('div');
  content.className = 'qt-selection-result';
  content.textContent = text;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'qt-selection-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭划译结果');
  close.addEventListener('click', () => hideSelectionBubble(true));

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'qt-selection-copy';
  copy.textContent = '复制';
  copy.addEventListener('click', () => copySelectionResult(text, copy));

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'qt-selection-pin';
  pin.textContent = '固定';
  pin.addEventListener('click', () => pinSelectionBubble(text, isError));

  selectionBubble.append(content, copy, pin, close);
}

async function copySelectionResult(text, button) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }
    button.textContent = '已复制';
    setTimeout(() => {
      button.textContent = '复制';
    }, 1200);
  } catch (e) {
    button.textContent = '复制失败';
  }
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function pinSelectionBubble(text, isError) {
  if (!selectionBubble) return;

  const pinned = createPinnedSelectionCard(text, isError);
  const rect = selectionBubble.getBoundingClientRect();
  pinned.style.width = `${selectionBubble.offsetWidth}px`;
  pinned.style.left = `${rect.left + window.scrollX}px`;
  pinned.style.top = `${rect.top + window.scrollY}px`;
  document.documentElement.appendChild(pinned);
  hideSelectionBubble(true);
}

function createPinnedSelectionCard(text, isError) {
  const pinned = document.createElement('div');
  pinned.className = 'qt-selection-bubble qt-selection-bubble-result qt-selection-pinned';
  pinned.classList.toggle('qt-selection-bubble-error', isError);

  const content = document.createElement('div');
  content.className = 'qt-selection-result';
  content.textContent = text;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'qt-selection-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭固定划译结果');
  close.addEventListener('click', () => pinned.remove());

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'qt-selection-copy';
  copy.textContent = '复制';
  copy.addEventListener('click', () => copySelectionResult(text, copy));

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'qt-selection-pin';
  pin.textContent = '已固定';
  pin.addEventListener('click', () => pinned.remove());

  pinned.addEventListener('mousedown', event => {
    if (event.target.closest('button')) return;
    event.preventDefault();
    startDraggingSelectionBubble(event, pinned);
  });

  pinned.append(content, copy, pin, close);
  return pinned;
}

function startDraggingSelectionBubble(event, bubble = selectionBubble) {
  if (!bubble) return;
  selectionBubbleDragging = true;
  selectionBubbleDragTarget = bubble;
  const rect = bubble.getBoundingClientRect();
  selectionBubbleDragOffset = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
  bubble.classList.add('qt-selection-dragging');
}

function dragSelectionBubble(event) {
  if (!selectionBubbleDragging || !selectionBubbleDragTarget) return;
  const width = selectionBubbleDragTarget.offsetWidth;
  const height = selectionBubbleDragTarget.offsetHeight;
  const left = Math.min(
    window.scrollX + window.innerWidth - width - 8,
    Math.max(window.scrollX + 8, event.clientX + window.scrollX - selectionBubbleDragOffset.x)
  );
  const top = Math.min(
    window.scrollY + window.innerHeight - height - 8,
    Math.max(window.scrollY + 8, event.clientY + window.scrollY - selectionBubbleDragOffset.y)
  );
  selectionBubbleDragTarget.style.left = `${left}px`;
  selectionBubbleDragTarget.style.top = `${top}px`;
}

function stopDraggingSelectionBubble() {
  if (!selectionBubbleDragging) return;
  selectionBubbleDragging = false;
  selectionBubbleDragTarget?.classList.remove('qt-selection-dragging');
  selectionBubbleDragTarget = null;
}

function hideSelectionBubble(force = false) {
  if (selectionBubble) {
    selectionBubble.hidden = true;
  }
  if (force) {
    selectionBubbleDragging = false;
    selectionBubbleDragTarget = null;
    selectionBubble?.classList.remove('qt-selection-dragging');
  }
}

function getTranslationSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get([
      'provider',
      'targetLang',
      'apiKey',
      'translationStyle',
      'translateMode',
      'glossary',
      'customStyle',
      'siteRuleMode',
      'siteRules'
    ], data => {
      resolve({
        provider: data.provider || 'google',
        targetLang: data.targetLang || 'zh-CN',
        apiKey: data.apiKey || '',
        translationStyle: data.translationStyle || 'replace',
        translateMode: data.translateMode || 'lazy',
        glossary: data.glossary || '',
        customStyle: data.customStyle || '',
        siteRuleMode: data.siteRuleMode || 'blacklist',
        siteRules: data.siteRules || ''
      });
    });
  });
}

async function getSitePolicy() {
  const settings = await getTranslationSettings();
  const host = location.hostname.toLowerCase();
  const rules = parseSiteRules(settings.siteRules);
  const matched = rules.some(rule => host === rule || host.endsWith(`.${rule}`));

  if (settings.siteRuleMode === 'whitelist') {
    return {
      allowed: rules.length === 0 || matched,
      reason: rules.length === 0 ? '' : '不在白名单中'
    };
  }

  return {
    allowed: !matched,
    reason: matched ? '命中黑名单' : ''
  };
}

function parseSiteRules(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map(item => item.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
}
