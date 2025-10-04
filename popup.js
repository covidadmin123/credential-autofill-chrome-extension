/*
 * Popup script for the Colon‑Link Autofiller extension.  Provides a simple
 * interface to paste a list of colon‑style links, validate them, select all
 * or the first 100, and open them in new armed tabs.  The validation
 * leverages the same flexible parser used elsewhere in the extension.  All
 * messages to the background service worker are guarded to avoid errors if
 * the worker has been restarted.
 */

(function() {
  // Safe messaging helpers
  function runtimeAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch { return false; }
  }
  function safeSendMessage(msg, cb) {
    if (!runtimeAlive()) return;
    try {
      chrome.runtime.sendMessage(msg, cb);
    } catch {}
  }

  // Flexible colon‑link parser used throughout the extension.  Accepts links
  // with or without a scheme; if missing, `https://` is assumed.  Returns
  // null for strings that don’t contain exactly two colons.
  function parseColonLinkFlexible(href) {
    if (!href) return null;
    const raw = href.trim();
    const last = raw.lastIndexOf(':');
    const prev = raw.lastIndexOf(':', last - 1);
    if (last <= 0 || prev <= 0) return null;
    let base = raw.slice(0, prev);
    let u = raw.slice(prev + 1, last);
    let p = raw.slice(last + 1);
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    try {
      const url = new URL(base).toString();
      try { u = decodeURIComponent(u.trim()); } catch {}
      try { p = decodeURIComponent(p.trim()); } catch {}
      return { url, username: u.trim(), password: p.trim() };
    } catch {
      return null;
    }
  }

  const input = document.getElementById('input');
  const list = document.getElementById('list');
  const countEl = document.getElementById('count');
  const validateToggle = document.getElementById('validateToggle');
  let currentItems = [];

  function renderList(items) {
    currentItems = items;
    list.innerHTML = '';
    items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'row ' + (it.valid ? 'valid' : 'invalid');
      const checked = it.valid ? 'checked' : '';
      row.innerHTML = `
        <input type="checkbox" class="chk" ${checked} data-idx="${idx}" />
        <div>
          <div class="url">${it.raw}</div>
          <div class="muted">${it.valid ? (it.parsed.url + ' — ' + it.parsed.username + ' / •••') : 'Invalid colon‑link'}</div>
        </div>
      `;
      list.appendChild(row);
    });
    updateCount();
  }

  function updateCount() {
    const checks = list.querySelectorAll('.chk');
    let selected = 0;
    checks.forEach(ch => { if (ch.checked) selected++; });
    countEl.textContent = `${selected} selected`;
  }

  document.getElementById('parseBtn').addEventListener('click', () => {
    const lines = input.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const items = lines.map(raw => {
      const parsed = parseColonLinkFlexible(raw);
      let valid = !!parsed;
      if (validateToggle.checked) {
        valid = !!parsed && /^https?:\/\//i.test(parsed.url);
      }
      return { raw, parsed, valid };
    });
    renderList(items);
  });

  document.getElementById('selectAllBtn').addEventListener('click', () => {
    list.querySelectorAll('.chk').forEach(ch => {
      ch.checked = true;
    });
    updateCount();
  });

  document.getElementById('select100Btn').addEventListener('click', () => {
    const checks = Array.from(list.querySelectorAll('.chk'));
    checks.forEach((ch, i) => {
      ch.checked = i < 100;
    });
    updateCount();
  });

  list.addEventListener('change', (e) => {
    if (e.target.classList.contains('chk')) updateCount();
  });

  document.getElementById('openSelectedBtn').addEventListener('click', () => {
    const rows = Array.from(list.querySelectorAll('.row'));
    const checks = Array.from(list.querySelectorAll('.chk'));
    const selectedItems = rows.map((row, i) => {
      const chk = checks[i];
      const urlText = row.querySelector('.url').textContent;
      const parsed = parseColonLinkFlexible(urlText);
      return { selected: chk.checked, parsed };
    }).filter(x => x.selected && x.parsed);
    const batch = selectedItems.slice(0, 100);
    batch.forEach(it => {
      safeSendMessage({ type: 'openArmedTab', url: it.parsed.url, u: it.parsed.username, p: it.parsed.password, mode: {} });
    });
    window.close();
  });
})();