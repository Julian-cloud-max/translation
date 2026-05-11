# QuickTranslate

QuickTranslate is a browser extension for translating webpages without leaving the page. It is designed for long-form reading: translate full pages with one click, keep the original context visible, and switch between fast default translation and higher-quality AI translation when needed.

## Features

- One-click full page translation
- Bilingual reading modes
- Replace original text, show translation below, or inline
- Lazy translation for long pages
- Selection translation
- Auto-translate on page load
- Glossary and custom style controls
- Site allow/block rules
- Local translation cache
- Optional DeepSeek API support for higher-quality translation

## Project Structure

```text
manifest.json
background.js
content.js
content.css
popup.html / popup.js / popup.css
options.html / options.js
icons/
```

## How It Works

- `background.js` handles translation requests, caching, retries, and provider communication.
- `content.js` scans the page, injects translated text, and restores original text when needed.
- `popup.*` provides the quick action UI.
- `options.*` provides advanced settings such as glossary, translation style, site rules, and cache management.

## Translation Providers

QuickTranslate supports two translation modes:

- Google Translate public endpoint for fast, zero-setup usage
- DeepSeek API for users who want better contextual translation and are willing to provide their own API key

## Packaging

This project is a Manifest V3 extension and can be packaged directly as a browser extension ZIP. The package root must contain `manifest.json`.

For Edge packaging in this repo:

```powershell
.\package-edge.ps1
```

## Status

The extension has been prepared for Edge Add-ons submission and is structured to remain easy to package for Chrome-compatible browsers as well.
