/*
 * Background service worker for the Colon‑Link Login Autofiller Pro extension.
 *
 * This script manages per‑tab credential storage, creates context menu entries
 * for opening colon‑style links (with optional two‑step flows), and responds
 * to messages from the content script and popup.  Credentials are stored in
 * memory keyed by the destination tab ID and cleared once the login form has
 * been filled.  A flexible parser is used to support both fully qualified
 * URLs and bare hostnames (e.g. `example.com:user:pass`), adding an
 * `https://` scheme when necessary.  The context menu logic captures the
 * raw href from the content script so that special characters are not
 * mangled by the browser’s URL resolver.
 */

// Map of tabId → { u, p, stage, mode }
const credsByTab = new Map();
// Map of tabId → raw href captured on the originating page
const rawHrefByTab = new Map();

/**
 * Parse a colon‑style link into its components.  A valid colon link must
 * contain exactly two colons separating the base URL/host, the username and
 * the password.  If the base does not start with a scheme, `https://` is
 * automatically prepended.  Returns null if the string is not a colon link.
 *
 * @param {string} href The raw href attribute from the page.
 * @returns {{url: string, username: string, password: string}|null}
 */
function parseColonLinkFlexible(href) {
  if (!href) return null;
  const last = href.lastIndexOf(':');
  const prev = href.lastIndexOf(':', last - 1);
  if (last <= 0 || prev <= 0) return null;
  let base = href.slice(0, prev).trim();
  let u = href.slice(prev + 1, last).trim();
  let p = href.slice(last + 1).trim();
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  try {
    const url = new URL(base).toString();
    try { u = decodeURIComponent(u); } catch {}
    try { p = decodeURIComponent(p); } catch {}
    return { url, username: u, password: p };
  } catch {
    return null;
  }
}

// Create context menu items when the extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'openColonLink',
    title: 'Open colon‑link (armed)',
    contexts: ['link']
  });
  chrome.contextMenus.create({
    id: 'openColonLinkTwoStep',
    title: 'Open colon‑link (armed, two‑step)',
    contexts: ['link']
  });
});

// Respond to context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  // Retrieve the raw href captured by the content script, falling back to
  // info.linkUrl if none is available.  The browser may percent‑encode
  // special characters in info.linkUrl, so the raw href is preferred.
  let raw = null;
  if (tabId && rawHrefByTab.has(tabId)) {
    raw = rawHrefByTab.get(tabId);
  }
  if (!raw) {
    raw = info.linkUrl || '';
  }
  const parsed = parseColonLinkFlexible(raw);
  if (!parsed) return;
  const twoStep = (info.menuItemId === 'openColonLinkTwoStep');
  chrome.tabs.create({ url: parsed.url }, (newTab) => {
    if (!newTab) return;
    credsByTab.set(newTab.id, { u: parsed.username, p: parsed.password, stage: 'init', mode: { twoStep } });
  });
});

// Handle messages from the content script and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (!msg) return;
    if (msg.type === 'setRawHrefForTab' && sender.tab) {
      // The content script reports the raw href of the link that will be
      // opened via the context menu.  Store it keyed by the originating tab.
      rawHrefByTab.set(sender.tab.id, msg.href);
    } else if (msg.type === 'openArmedTab') {
      // A request to open a colon‑link programmatically (from the popup or
      // content script).  Create a new tab for the URL and store its creds.
      const { url, u, p, mode } = msg;
      chrome.tabs.create({ url }, (newTab) => {
        if (!newTab) return;
        credsByTab.set(newTab.id, { u: u, p: p, stage: 'init', mode: mode || {} });
      });
    } else if (msg.type === 'requestCreds') {
      // The content script asks for credentials for the current tab.  If
      // available, return them; otherwise return an empty object.
      const tabId = sender?.tab?.id;
      if (tabId && credsByTab.has(tabId)) {
        sendResponse({ creds: credsByTab.get(tabId) });
      } else {
        sendResponse({});
      }
    } else if (msg.type === 'clearCreds') {
      const tabId = sender?.tab?.id;
      if (tabId) {
        credsByTab.delete(tabId);
      }
    } else if (msg.type === 'updateStage') {
      const tabId = sender?.tab?.id;
      if (tabId && credsByTab.has(tabId)) {
        const existing = credsByTab.get(tabId);
        existing.stage = msg.stage;
      }
    } else if (msg.type === 'disarmTab') {
      const tabId = sender?.tab?.id;
      if (tabId) credsByTab.delete(tabId);
    }
  } catch {
    // ignore errors; the service worker may be reloaded
  }
});