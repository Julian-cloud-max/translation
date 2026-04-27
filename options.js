document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const targetLangSelect = document.getElementById('targetLang');
  const sourceLangSelect = document.getElementById('sourceLang');
  const translationStyleSelect = document.getElementById('translationStyle');
  const deepseekSettings = document.getElementById('deepseekSettings');
  const btnSave = document.getElementById('btnSave');
  const savedMsg = document.getElementById('savedMsg');

  // Load saved settings
  chrome.storage.local.get(['provider', 'apiKey', 'targetLang', 'sourceLang', 'translationStyle'], (data) => {
    if (data.provider) providerSelect.value = data.provider;
    if (data.apiKey) apiKeyInput.value = data.apiKey;
    if (data.targetLang) targetLangSelect.value = data.targetLang;
    if (data.sourceLang) sourceLangSelect.value = data.sourceLang;
    if (data.translationStyle) translationStyleSelect.value = data.translationStyle;
    toggleDeepseekSettings();
  });

  providerSelect.addEventListener('change', toggleDeepseekSettings);

  function toggleDeepseekSettings() {
    deepseekSettings.style.display = providerSelect.value === 'deepseek' ? 'block' : 'none';
  }

  btnSave.addEventListener('click', () => {
    const settings = {
      provider: providerSelect.value,
      apiKey: apiKeyInput.value,
      targetLang: targetLangSelect.value,
      sourceLang: sourceLangSelect.value,
      translationStyle: translationStyleSelect.value
    };

    chrome.storage.local.set(settings, () => {
      savedMsg.classList.add('show');
      setTimeout(() => savedMsg.classList.remove('show'), 2000);
    });
  });
});
