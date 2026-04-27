// Background service worker - handles translation API calls

const GOOGLE_BATCH_SIZE = 10;
const DEEPSEEK_BATCH_SIZE = 15;
const MAX_CONCURRENT = 5;

// Translation dispatch
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'translate') {
    handleTranslate(msg, sender)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }
});

async function handleTranslate(msg, sender) {
  const { segments, provider, targetLang, apiKey } = msg;

  if (!segments || segments.length === 0) {
    return { success: false, error: 'No translatable content found' };
  }

  try {
    let translations;
    if (provider === 'google') {
      translations = await translateGoogle(segments, targetLang, sender);
    } else if (provider === 'deepseek') {
      translations = await translateDeepseek(segments, targetLang, apiKey, sender);
    } else {
      return { success: false, error: 'Unknown provider' };
    }

    return { success: true, translations };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Google Translate (Free) - uses the public endpoint
async function translateGoogle(segments, targetLang, sender) {
  const results = new Array(segments.length);
  const batches = chunkArray(segments, GOOGLE_BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const promises = batch.map((seg, idx) => {
      const originalIdx = i * GOOGLE_BATCH_SIZE + idx;
      return translateGoogleSingle(seg.text, targetLang)
        .then(translated => {
          results[originalIdx] = translated;
          // Send progress
          const done = results.filter(Boolean).length;
          sendProgress(sender, `${done}/${segments.length}`);
        })
        .catch(err => {
          results[originalIdx] = `[Translation failed: ${err.message}]`;
        });
    });

    await Promise.all(promises);
  }

  return results;
}

async function translateGoogleSingle(text, targetLang) {
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
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  // Google returns array of arrays: [[translated_text, original_text, ...], ...]
  if (data && data[0]) {
    return data[0].map(item => item[0]).join('');
  }

  throw new Error('Invalid response from Google Translate');
}

// DeepSeek API - batch translation with high quality
async function translateDeepseek(segments, targetLang, apiKey, sender) {
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

    // Build numbered segments
    const numberedText = batch.map((seg, idx) =>
      `[${idx + 1}] ${seg.text}`
    ).join('\n\n');

    const prompt = `Translate the following text to ${langName}. Output ONLY the translations, keeping the [number] format. Preserve paragraph breaks and line breaks within each numbered segment. Maintain the original meaning and tone accurately. If a segment is already in ${langName}, output it unchanged.\n\n${numberedText}`;

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
              content: 'You are a professional translator. Output only translations with [number] format. No explanations.'
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

      // Parse numbered translations from response
      const translations = parseNumberedTranslations(content, batch.length);

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

// Utility: chunk array
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
