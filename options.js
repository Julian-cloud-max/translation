document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const targetLangSelect = document.getElementById('targetLang');
  const sourceLangSelect = document.getElementById('sourceLang');
  const translationStyleSelect = document.getElementById('translationStyle');
  const translateModeSelect = document.getElementById('translateMode');
  const selectionTranslateEnabledInput = document.getElementById('selectionTranslateEnabled');
  const customStyleInput = document.getElementById('customStyle');
  const glossaryInput = document.getElementById('glossary');
  const siteRuleModeSelect = document.getElementById('siteRuleMode');
  const siteRulesInput = document.getElementById('siteRules');
  const deepseekSettings = document.getElementById('deepseekSettings');
  const btnClearCache = document.getElementById('btnClearCache');
  const btnSave = document.getElementById('btnSave');
  const savedMsg = document.getElementById('savedMsg');

  // Load saved settings
  chrome.storage.local.get([
    'provider',
    'apiKey',
    'targetLang',
    'sourceLang',
    'translationStyle',
    'translateMode',
    'selectionTranslateEnabled',
    'customStyle',
    'glossary',
    'siteRuleMode',
    'siteRules'
  ], (data) => {
    if (data.provider) providerSelect.value = data.provider;
    if (data.apiKey) apiKeyInput.value = data.apiKey;
    if (data.targetLang) targetLangSelect.value = data.targetLang;
    if (data.sourceLang) sourceLangSelect.value = data.sourceLang;
    if (data.translationStyle) translationStyleSelect.value = data.translationStyle;
    if (data.translateMode) translateModeSelect.value = data.translateMode;
    selectionTranslateEnabledInput.checked = data.selectionTranslateEnabled !== false;
    if (data.customStyle) customStyleInput.value = data.customStyle;
    if (data.glossary) glossaryInput.value = data.glossary;
    if (data.siteRuleMode) siteRuleModeSelect.value = data.siteRuleMode;
    if (data.siteRules) siteRulesInput.value = data.siteRules;
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
      translationStyle: translationStyleSelect.value,
      translateMode: translateModeSelect.value,
      selectionTranslateEnabled: selectionTranslateEnabledInput.checked,
      customStyle: customStyleInput.value,
      glossary: glossaryInput.value,
      siteRuleMode: siteRuleModeSelect.value,
      siteRules: siteRulesInput.value
    };

    chrome.storage.local.set(settings, () => {
      savedMsg.classList.add('show');
      setTimeout(() => savedMsg.classList.remove('show'), 2000);
    });
  });

  btnClearCache.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'clearCache' }, (response) => {
      if (response && response.success) {
        savedMsg.textContent = `已清除 ${response.count} 条缓存`;
      } else {
        savedMsg.textContent = '清除缓存失败';
      }
      savedMsg.classList.add('show');
      setTimeout(() => {
        savedMsg.classList.remove('show');
        savedMsg.textContent = '已保存';
      }, 2000);
    });
  });
});
