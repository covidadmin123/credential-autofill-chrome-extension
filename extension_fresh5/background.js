// Minimal, loud-logging service worker
console.log("[BG] service worker starting v1.0.0");

const credsByTab = new Map();
let rawHrefPerTab = new Map();
// Track origin failures: store a timestamp until which we won't arm tabs for that origin.
const failUntilByOrigin = new Map();
// Cooldown window for origin failures (should match content script). 10 minutes.
const SUBMIT_COOLDOWN_MS = 10 * 60 * 1000;
// Helper to derive origin from a URL string.
function originOf(urlStr) {
  try {
    return new URL(urlStr).origin;
  } catch {
    return "";
  }
}

function parseColonLink(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // prefer full href if we captured it
  let href = s;

  // If this came from selection, it might be plain `host:user:pass`
  // Find last two colons
  const last = href.lastIndexOf(":");
  const prev = href.lastIndexOf(":", last - 1);
  if (last <= 0 || prev <= 0) return null;

  let base = href.slice(0, prev).trim();
  let u = href.slice(prev + 1, last).trim();
  let p = href.slice(last + 1).trim();

  // ignore bare schemes (avoid "http/" navigations)
  if (/^https?$/i.test(base)) return null;

  if (!/^https?:\/\//i.test(base)) base = "https://" + base;

  try { u = decodeURIComponent(u); } catch {}
  try { p = decodeURIComponent(p); } catch {}

  try {
    const url = new URL(base);
    return { url: url.toString(), u, p };
  } catch (e) {
    return null;
  }
}

function armTab(tabId, payload) {
  credsByTab.set(tabId, payload);
  console.log("[BG] armed tab", tabId, payload);
}

function disarmTab(tabId, reason) {
  if (credsByTab.delete(tabId)) {
    console.log("[BG] disarmed tab", tabId, reason || "");
  }
}

function ensureMenus() {
  const ids = [
    "cl-open",
    "cl-open-2step",
    "cl-open-incog",
    "cl-open-incog-2step"
  ];
  ids.forEach(id => chrome.contextMenus.remove(id, () => void chrome.runtime.lastError));

  const ctx = ["all"]; // always visible for debugging
  chrome.contextMenus.create({ id: "cl-open", title: "Open colon-link (armed)", contexts: ctx });
  chrome.contextMenus.create({ id: "cl-open-2step", title: "Open colon-link (armed, two-step)", contexts: ctx });
  chrome.contextMenus.create({ id: "cl-open-incog", title: "Open colon-link (armed in incognito)", contexts: ctx });
  chrome.contextMenus.create({ id: "cl-open-incog-2step", title: "Open colon-link (armed in incognito, two-step)", contexts: ctx });

  console.log("[BG] context menus registered");
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[BG] onInstalled");
  ensureMenus();
});
chrome.runtime.onStartup.addListener(() => {
  console.log("[BG] onStartup");
  ensureMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  const cached = rawHrefPerTab.get(tabId);
  if (cached) rawHrefPerTab.delete(tabId);

  const raw = cached || info.selectionText || info.linkUrl || "";
  console.log("[BG] context click raw=", raw);

  const parsed = parseColonLink(raw);
  if (!parsed) { console.warn("[BG] not a colon link"); return; }

  // Respect origin cooldown: if the origin is still cooling down, open the URL but do not arm.
  const origin = originOf(parsed.url);
  const until = failUntilByOrigin.get(origin) || 0;
  if (Date.now() < until) {
    console.warn("[BG] origin cooldown active; opening without arming:", origin);
    if (info.menuItemId === "cl-open-incog" || info.menuItemId === "cl-open-incog-2step") {
      // open incognito window without arming
      chrome.windows.create({ url: parsed.url, incognito: true });
    } else {
      // open normal tab without arming
      chrome.tabs.create({ url: parsed.url, active: true });
    }
    return;
  }

  const twoStep = (info.menuItemId === "cl-open-2step" || info.menuItemId === "cl-open-incog-2step");
  const incog = (info.menuItemId === "cl-open-incog" || info.menuItemId === "cl-open-incog-2step");

  const openAndArm = (createOpts) => {
    chrome.tabs.create(createOpts, newTab => {
      if (!newTab) return;
      armTab(newTab.id, { u: parsed.u, p: parsed.p, mode: { twoStep }, stage: "init" });
    });
  };

  if (incog) {
    chrome.windows.create({ url: parsed.url, incognito: true }, win => {
      const newTab = win?.tabs?.[0];
      if (newTab?.id) armTab(newTab.id, { u: parsed.u, p: parsed.p, mode: { twoStep }, stage: "init" });
    });
  } else {
    openAndArm({ url: parsed.url, active: true });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  if (msg?.type === "storeRawHref" && tabId) {
    rawHrefPerTab.set(tabId, msg.href || "");
    return;
  }
  if (msg?.type === "requestCreds" && tabId) {
    const creds = credsByTab.get(tabId) || null;
    sendResponse({ creds });
    return true;
  }
  if (msg?.type === "updateStage" && tabId) {
    const c = credsByTab.get(tabId);
    if (c) { c.stage = msg.stage; credsByTab.set(tabId, c); }
    return;
  }
  if (msg?.type === "clearCreds" && tabId) { disarmTab(tabId, "content-clear"); return; }
  if (msg?.type === "markOriginFailure" && tabId) {
    // When the content script detects a login failure, mark the origin as cooled down.
    const url = sender?.tab?.url || "";
    const origin = originOf(url);
    if (origin) {
      failUntilByOrigin.set(origin, Date.now() + SUBMIT_COOLDOWN_MS);
      console.warn("[BG] origin cooled down:", origin);
    }
    return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => disarmTab(tabId, "tab-closed"));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") console.log("[BG] tab loading", tabId);
  if (info.status === "complete") console.log("[BG] tab complete", tabId);
});

chrome.commands.onCommand.addListener(cmd => {
  console.log("[BG] command:", cmd);
});
