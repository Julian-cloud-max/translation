// Background service worker - handles translation API calls

const GOOGLE_BATCH_SIZE = 5;
const GOOGLE_CONCURRENCY = 2;
const GOOGLE_DELAY_MS = 300;
const GOOGLE_MAX_RETRIES = 3;
const GOOGLE_BASE_DELAY_MS = 1000;
const DEEPSEEK_BATCH_SIZE = 15;
const CACHE_PREFIX = 'qt_cache:';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 600;

// Translation dispatch
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'translate') {
    handleTranslate(msg, sender)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (msg.type === 'clearCache') {
    clearTranslationCache()
      .then(count => sendResponse({ success: true, count }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleTranslate(msg, sender) {
  const { segments, provider, targetLang, apiKey, glossary = '', customStyle = '' } = msg;

  if (!segments || segments.length === 0) {
    return { success: false, error: 'No translatable content found' };
  }

  try {
    if (provider !== 'google' && provider !== 'deepseek') {
      return { success: false, error: 'Unknown provider' };
    }

    const translations = await translateWithCache(
      segments,
      provider,
      targetLang,
      apiKey,
      sender,
      { glossary, customStyle }
    );
    return { success: true, translations };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function translateWithCache(segments, provider, targetLang, apiKey, sender, options = {}) {
  const results = new Array(segments.length);
  const misses = [];
  const missIndexes = [];

  const cacheKeys = segments.map(seg => buildCacheKey(provider, targetLang, seg.text, options));
  const cached = await chrome.storage.local.get(cacheKeys);

  for (let i = 0; i < segments.length; i++) {
    const item = cached[cacheKeys[i]];
    if (item && Date.now() - item.ts < CACHE_TTL && item.value) {
      results[i] = item.value;
    } else {
      misses.push(segments[i]);
      missIndexes.push(i);
    }
  }

  if (misses.length === 0) {
    sendProgress(sender, `${segments.length}/${segments.length} (缓存)`);
    return results;
  }

  if (results.some(Boolean)) {
    sendProgress(sender, `${results.filter(Boolean).length}/${segments.length} (缓存)`);
  }

  const fresh = provider === 'google'
    ? await translateGoogle(misses, targetLang, sender)
    : await translateDeepseek(misses, targetLang, apiKey, sender, options);

  const cacheUpdates = {};
  for (let i = 0; i < misses.length; i++) {
    const originalIndex = missIndexes[i];
    const translated = fresh[i];
    results[originalIndex] = translated;

    if (isCacheableTranslation(translated)) {
      cacheUpdates[cacheKeys[originalIndex]] = {
        value: translated,
        ts: Date.now()
      };
    }
  }

  if (Object.keys(cacheUpdates).length > 0) {
    await chrome.storage.local.set(cacheUpdates);
    cleanupCache().catch(() => {});
  }

  return results;
}

function isCacheableTranslation(text) {
  return text &&
    !text.startsWith('[Translation failed') &&
    !text.startsWith('[DeepSeek error');
}

function buildCacheKey(provider, targetLang, text, options = {}) {
  const optionKey = provider === 'deepseek'
    ? hashText(`${options.glossary || ''}\n${options.customStyle || ''}`)
    : 'default';
  return `${CACHE_PREFIX}${provider}:${targetLang}:${optionKey}:${String(text || '').length}:${hashText(text)}`;
}

function hashText(text) {
  let hash = 5381;
  const value = String(text || '');
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

async function cleanupCache() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([key]) => key.startsWith(CACHE_PREFIX))
    .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));

  const now = Date.now();
  const stale = entries
    .filter(([, value], index) => index >= MAX_CACHE_ENTRIES || now - (value?.ts || 0) > CACHE_TTL)
    .map(([key]) => key);

  if (stale.length > 0) {
    await chrome.storage.local.remove(stale);
  }
}

async function clearTranslationCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(key => key.startsWith(CACHE_PREFIX));
  if (keys.length > 0) {
    await chrome.storage.local.remove(keys);
  }
  return keys.length;
}

// Google Translate (Free) - uses the public endpoint
async function translateGoogle(segments, targetLang, sender) {
  const results = new Array(segments.length).fill(null);
  let completed = 0;

  for (let i = 0; i < segments.length; i += GOOGLE_CONCURRENCY) {
    const chunk = segments.slice(i, i + GOOGLE_CONCURRENCY);
    const promises = chunk.map((seg, idx) => {
      const originalIdx = i + idx;
      return translateGoogleSingle(seg.text, targetLang)
        .then(translated => {
          results[originalIdx] = translated;
          completed++;
          sendProgress(sender, `${completed}/${segments.length}`);
        })
        .catch(err => {
          results[originalIdx] = `[Translation failed: ${err.message}]`;
          completed++;
          sendProgress(sender, `${completed}/${segments.length}`);
        });
    });

    await Promise.all(promises);

    // Delay between chunks to avoid rate limiting
    if (i + GOOGLE_CONCURRENCY < segments.length) {
      await sleep(GOOGLE_DELAY_MS);
    }
  }

  return results;
}

async function translateGoogleSingle(text, targetLang, retryCount = 0) {
  const url = 'https://translate.googleapis.com/translate_a/single';
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: targetLang,
    dt: 't',
    q: text
  });

  const response = await fetch(`${url}?${params}`);
  if (!response.ok) {
    if ((response.status === 429 || response.status === 503) && retryCount < GOOGLE_MAX_RETRIES) {
      const delay = GOOGLE_BASE_DELAY_MS * Math.pow(2, retryCount) + Math.random() * 500;
      await sleep(delay);
      return translateGoogleSingle(text, targetLang, retryCount + 1);
    }
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data && data[0]) {
    return data[0].map(item => item[0]).join('');
  }

  throw new Error('Invalid response from Google Translate');
}

// DeepSeek API - batch translation with high quality
async function translateDeepseek(segments, targetLang, apiKey, sender, options = {}) {
  const langMap = {
    'zh-CN': '简体中文', 'zh-TW': '繁體中文', 'en': 'English',
    'ja': '日本語', 'ko': '한국어', 'fr': 'Français',
    'de': 'Deutsch', 'es': 'Español', 'ru': 'Русский'
  };
  const langName = langMap[targetLang] || targetLang;
  const results = new Array(segments.length);
  const batches = chunkArray(segments, DEEPSEEK_BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const startIndex = i * DEEPSEEK_BATCH_SIZE;

    const payload = batch.map((seg, idx) => ({
      id: idx + 1,
      text: seg.text
    }));

    const glossaryText = normalizeInstructionBlock(options.glossary);
    const styleText = normalizeInstructionBlock(options.customStyle);
    const glossaryInstruction = glossaryText
      ? `\nUse this glossary exactly when applicable:\n${glossaryText}`
      : '';
    const styleInstruction = styleText
      ? `\nFollow this translation style requirement:\n${styleText}`
      : '';
    const prompt = `Translate each item in this JSON array to ${langName}. Return ONLY valid JSON in this exact shape: {"translations":[{"id":1,"text":"translated text"}]}. Preserve paragraph breaks and line breaks inside each text field. If an item is already in ${langName}, return it unchanged.${glossaryInstruction}${styleInstruction}\n\n${JSON.stringify(payload)}`;

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: 'You are a professional translator. Output only valid JSON. No markdown, no explanations.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1,
          max_tokens: 4096
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';

      const translations = parseDeepseekTranslations(content, batch.length);

      for (let j = 0; j < batch.length; j++) {
        results[startIndex + j] = translations[j] || batch[j].text;
      }

      const done = results.filter(r => r !== undefined).length;
      sendProgress(sender, `${done}/${segments.length}`);

    } catch (err) {
      // Fill failed batch with error markers
      for (let j = 0; j < batch.length; j++) {
        results[startIndex + j] = `[DeepSeek error: ${err.message}]`;
      }
    }
  }

  return results;
}

function normalizeInstructionBlock(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 80)
    .join('\n');
}

function parseDeepseekTranslations(content, expectedCount) {
  const parsed = parseJsonTranslations(content, expectedCount);
  if (parsed.filter(Boolean).length > 0) {
    return parsed;
  }

  return parseNumberedTranslations(content, expectedCount);
}

function parseJsonTranslations(content, expectedCount) {
  const results = [];

  try {
    const jsonText = extractJsonObject(content);
    const data = JSON.parse(jsonText);
    const translations = Array.isArray(data) ? data : data.translations;
    if (!Array.isArray(translations)) return results;

    for (const item of translations) {
      const id = Number(item.id);
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (id >= 1 && id <= expectedCount && text) {
        results[id - 1] = text;
      }
    }
  } catch (e) {
    // Fall through to numbered parser.
  }

  return results;
}

function extractJsonObject(content) {
  const text = String(content || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/g, '')
    .trim();

  if (text.startsWith('[') && text.endsWith(']')) {
    return text;
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return text.slice(first, last + 1);
  }
  return text;
}

// Parse translations from DeepSeek's numbered response
function parseNumberedTranslations(content, expectedCount) {
  const results = [];
  // Match patterns like [1] translated text, [2] translated text
  const regex = /\[(\d+)\]\s*([\s\S]*?)(?=\[\d+\]|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const num = parseInt(match[1]);
    const text = match[2].trim();
    if (num >= 1 && num <= expectedCount) {
      results[num - 1] = text;
    }
  }

  // Fallback: if numbered parsing fails, split by double newlines
  if (results.filter(Boolean).length === 0) {
    const lines = content.split('\n').filter(l => l.trim());
    for (let i = 0; i < Math.min(lines.length, expectedCount); i++) {
      results[i] = lines[i].replace(/^\[\d+\]\s*/, '').trim();
    }
  }

  return results;
}

// Send progress update to popup
function sendProgress(sender, text) {
  try {
    chrome.runtime.sendMessage({ type: 'progress', text });
  } catch (e) {
    // Popup may be closed, ignore
  }
}

// Utility: sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Utility: chunk array
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
