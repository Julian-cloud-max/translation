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
let isTranslated = false;
let translatedElements = [];
let selectionBubble = null;
let selectedTextForBubble = '';

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
      doTranslate(msg.provider, msg.targetLang, msg.apiKey)
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
async function doTranslate(provider, targetLang, apiKey) {
  if (isTranslated) {
    doRestore();
  }

  let segments;
  try {
    segments = collectSegments();
  } catch (e) {
    return { success: false, error: 'Failed to collect text: ' + e.message };
  }

  if (segments.length === 0) {
    return { success: false, error: 'No translatable content found on this page' };
  }

  // Send segments to background for translation
  const response = await chrome.runtime.sendMessage({
    type: 'translate',
    segments: segments.map((s, i) => ({ id: i, text: s.text })),
    provider,
    targetLang,
    apiKey
  });

  if (!response || !response.success) {
    return response || { success: false, error: 'No response from background' };
  }

  // Insert translations into the DOM
  let inserted;
  try {
    inserted = insertTranslations(segments, response.translations);
  } catch (e) {
    return { success: false, error: 'Failed to insert translations: ' + e.message };
  }

  isTranslated = true;
  return { success: true, count: inserted };
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
function insertTranslations(segments, translations) {
  translatedElements = [];
  let inserted = 0;

  for (let i = 0; i < segments.length; i++) {
    const { element } = segments[i];
    const translated = translations[i];

    if (!translated || translated.startsWith('[Translation failed') || translated.startsWith('[DeepSeek error')) {
      continue;
    }

    try {
      const translationEl = document.createElement('span');
      translationEl.className = 'qt-translation';
      translationEl.setAttribute('data-qt-index', i);
      translationEl.textContent = normalizeTranslationText(translated);

      // Keep translations inside the original block so flex/grid/list/table layouts
      // do not receive extra sibling nodes that can disturb the page structure.
      element.appendChild(translationEl);

      element.classList.add('qt-original');
      element.classList.add('qt-inner');

      translatedElements.push({ original: element, translation: translationEl });
      inserted++;
    } catch (e) {
      // Skip if insertion fails (e.g., detached node)
    }
  }

  return inserted;
}

// Restore original page (remove translations)
function doRestore() {
  for (const { original, translation } of translatedElements) {
    try {
      translation.remove();
      original.classList.remove('qt-original');
      original.classList.remove('qt-inner');
    } catch (e) {
      // Element may have been removed by page
    }
  }

  translatedElements = [];
  isTranslated = false;
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
  document.addEventListener('mouseup', (event) => {
    if (event.target?.closest?.('.qt-selection-bubble')) return;
    setTimeout(showSelectionBubble, 0);
  });

  document.addEventListener('keyup', (event) => {
    if (event.key === 'Escape') {
      hideSelectionBubble();
      return;
    }
    showSelectionBubble();
  });

  document.addEventListener('scroll', (event) => {
    if (selectionBubble?.contains(event.target)) return;
    hideSelectionBubble();
  }, true);
  window.addEventListener('resize', hideSelectionBubble);
}

function showSelectionBubble() {
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

function createSelectionBubble() {
  const bubble = document.createElement('div');
  bubble.className = 'qt-selection-bubble';
  bubble.hidden = true;
  bubble.addEventListener('mousedown', event => event.preventDefault());
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
      apiKey: settings.apiKey
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
  close.addEventListener('click', hideSelectionBubble);

  selectionBubble.append(content, close);
}

function hideSelectionBubble() {
  if (selectionBubble) {
    selectionBubble.hidden = true;
  }
}

function getTranslationSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['provider', 'targetLang', 'apiKey'], data => {
      resolve({
        provider: data.provider || 'google',
        targetLang: data.targetLang || 'zh-CN',
        apiKey: data.apiKey || ''
      });
    });
  });
}
