/*
 * Content script for the Colon‑Link Login Autofiller Pro extension.
 *
 * This script runs on every page and performs three main tasks:
 *  1. Intercept clicks on colon‑style links (e.g. `https://site/path:username:password` or
 *     `site.com:username:password`), open an "armed" tab via the background worker,
 *     and pass along whether the Alt key was held for two‑step flows.
 *  2. Detect login forms and automatically fill them with stored credentials, including
 *     support for sites that require entering the username/email before revealing
 *     the password field.  The detection logic is language‑agnostic and relies on
 *     multiple signals such as element type, autocomplete hints and common
 *     username/password keywords in many languages.
 *  3. Provide a manual fill mechanism (triggered by context menu or hotkey) and
 *     maintain resilience against extension reloads by guarding all runtime
 *     messaging.  Intervals and mutation observers are cleaned up on page
 *     unload to avoid calling into a stale service worker.
 */

(function() {
  const AUTO_SUBMIT = true;
  const SCAN_INTERVAL_MS = 800;

  // ----- Safe runtime helpers -----
  function runtimeAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch { return false; }
  }
  function safeSendMessage(msg, cb) {
    if (!runtimeAlive()) return;
    try {
      chrome.runtime.sendMessage(msg, cb);
    } catch {
      // The service worker may have been restarted; silently ignore
    }
  }
  function safeOnMessage(handler) {
    if (!runtimeAlive()) return () => {};
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        try { handler(msg, sender, sendResponse); } catch {}
      });
    } catch {}
    return () => {};
  }

  // Track disposers for intervals/observers to clean them up on unload
  const disposers = [];
  function trackDisposer(fn) {
    disposers.push(fn);
    return fn;
  }
  window.addEventListener('beforeunload', () => {
    while (disposers.length) {
      const fn = disposers.pop();
      try { fn(); } catch {}
    }
  });

  // Language‑agnostic keyword lists.  These were hand‑curated to cover
  // username/email, password and submit/continue terms in many popular
  // languages.  Feel free to extend these lists as needed.
  const USER_TERMS = [
    'user','username','login','email','e-mail','mail','usuario','usuário','utilisateur','utente','usuari','correo','adresse',
    'benutzer','benutzername','anmelden','einloggen','brugernavn','gebruikersnaam','e-post','имя','логин','пользов','користувач','логін',
    'użytkownik','kullanıcı','eposta','χρήστη','σύνδεση','משתמש','דוא"ל','بريد','مستخدم','حساب','ايميل',
    'ईमेल','उपयोगकर्ता','メール','ユーザー','ログイン','电子邮件','郵件','邮箱','帳號','賬號','사용자','아이디'
  ];
  const PASS_TERMS = [
    'pass','password','senha','mot de passe','contrasena','contraseña','hasło','şifre','пароль','סיסמה','密碼','密码',
    '암호','비밀번호','パスワード','รหัสผ่าน','mật khẩu'
  ];
  const SUBMIT_TERMS = [
    'login','log in','sign in','anmelden','einloggen','connexion','accedi','acceso','entrar','iniciar sesión','giriş','войти',
    'התחבר','تسجيل الدخول','ログイン','로그인','登录','登入','đăng nhập','เข้าสู่ระบบ','zaloguj','continue','next','weiter','suivant',
    'avanti','continuar','siguiente','下一步','继续','次へ','다음','продолжить','lanjut','berikutnya'
  ];

  // Utility functions to normalise and match strings against the keyword lists
  function norm(s) { return (s || '').toString().toLowerCase(); }
  function hasTerm(str, terms) {
    const n = norm(str);
    return terms.some(t => n.includes(t));
  }

  // Score potential username inputs
  function scoreUsernameInput(el) {
    let score = 0;
    const type = norm(el.type);
    if (type === 'email' || type === 'text' || !type) score += 2;
    const nameId = norm(el.name) + ' ' + norm(el.id);
    const placeholder = norm(el.placeholder);
    const aria = norm(el.getAttribute('aria-label'));
    if (hasTerm(nameId, USER_TERMS)) score += 6;
    if (hasTerm(placeholder, USER_TERMS)) score += 4;
    if (hasTerm(aria, USER_TERMS)) score += 4;
    const ac = norm(el.autocomplete);
    if (ac === 'username' || ac === 'email') score += 6;
    if (type === 'email') score += 3;
    return score;
  }

  // Score potential password inputs
  function scorePasswordInput(el) {
    let score = 0;
    const type = norm(el.type);
    if (type === 'password') score += 8;
    const nameId = norm(el.name) + ' ' + norm(el.id);
    const placeholder = norm(el.placeholder);
    const aria = norm(el.getAttribute('aria-label'));
    if (hasTerm(nameId, PASS_TERMS)) score += 5;
    if (hasTerm(placeholder, PASS_TERMS)) score += 4;
    if (hasTerm(aria, PASS_TERMS)) score += 4;
    const ac = norm(el.autocomplete);
    if (ac.includes('password')) score += 6;
    return score;
  }

  // Find the best username and password inputs on a given root.  The heuristic
  // considers multiple signals and prefers fields that appear in the same form.
  function findBestInputs(root) {
    const inputs = Array.from(root.querySelectorAll('input'));
    let passBest = null, passScore = -1;
    let userBest = null, userScore = -1;
    for (const el of inputs) {
      const ps = scorePasswordInput(el);
      if (ps > passScore) { passScore = ps; passBest = el; }
    }
    for (const el of inputs) {
      const us = scoreUsernameInput(el);
      if (us > userScore) { userScore = us; userBest = el; }
    }
    // Prefer a username field in the same form as the password field, if any
    if (passBest && userBest && passBest.form && userBest.form && passBest.form !== userBest.form) {
      const cands = Array.from(passBest.form.querySelectorAll('input[type="email"], input[type="text"], input:not([type])'));
      let best = null, bestScore = -1;
      for (const c of cands) {
        const sc = scoreUsernameInput(c);
        if (sc > bestScore) { bestScore = sc; best = c; }
      }
      if (best && bestScore >= Math.max(3, userScore - 2)) {
        userBest = best;
      }
    }
    return { userBest, passBest };
  }

  // Locate a submit/continue button near a given context element or root
  function findSubmitButton(root, ctx) {
    const form = ctx?.form || (typeof ctx.closest === 'function' && ctx.closest('form'));
    if (form) {
      const btn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (btn) return btn;
    }
    const near = ctx ? ctx.closest('form') || ctx.closest('[role="form"]') || ctx.parentElement : root;
    const cands = [...(near?.querySelectorAll?.('button, input[type="submit"]') || [])];
    for (const c of cands) {
      const txt = norm(c.innerText || c.value || '');
      if (hasTerm(txt, SUBMIT_TERMS)) return c;
    }
    const any = root.querySelector('button[type="submit"], input[type="submit"]');
    if (any) return any;
    for (const b of root.querySelectorAll('button')) {
      const t = norm(b.innerText);
      if (t && t.length < 28 && hasTerm(t, SUBMIT_TERMS)) return b;
    }
    return null;
  }

  // Safely set the value of an input and dispatch the appropriate events
  function setVal(el, val) {
    try {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    } catch {}
  }

  // Walk the DOM tree and include shadow roots and same‑origin iframes
  function* walkDom(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node = walker.currentNode;
    while (node) {
      yield node;
      node = walker.nextNode();
    }
  }
  function allRoots() {
    const roots = [document];
    for (const el of walkDom(document)) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    for (const f of document.querySelectorAll('iframe, frame')) {
      try {
        if (f.contentDocument) roots.push(f.contentDocument);
      } catch {}
    }
    return roots;
  }

  // Fill the username/email only (for two‑step flows)
  function fillUsernameOnly(u) {
    for (const root of allRoots()) {
      try {
        const { userBest, passBest } = findBestInputs(root);
        if (userBest && !passBest && u) {
          setVal(userBest, u);
          const next = findSubmitButton(root, userBest);
          if (next) next.click?.();
          return true;
        }
      } catch {}
    }
    return false;
  }

  // Fill only the password field (for two‑step flows)
  function fillPasswordIfPresent(p) {
    for (const root of allRoots()) {
      try {
        const { passBest } = findBestInputs(root);
        if (passBest && p) {
          setVal(passBest, p);
          const submit = findSubmitButton(root, passBest);
          submit?.click?.();
          return true;
        }
      } catch {}
    }
    return false;
  }

  // Fill both username and password if present
  function fillBothIfPresent(u, p) {
    let any = false;
    for (const root of allRoots()) {
      try {
        const { userBest, passBest } = findBestInputs(root);
        if (userBest && u) { setVal(userBest, u); any = true; }
        if (passBest && p) { setVal(passBest, p); any = true; }
        if (any && passBest) {
          const submit = findSubmitButton(root, passBest || userBest);
          submit?.click?.();
          return true;
        }
      } catch {}
    }
    return false;
  }

  // Attempt autofill for two‑step flows (username/email then password)
  function tryAutofillTwoStep(creds, stage) {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (stage === 'init') {
        if (fillBothIfPresent(creds.u, creds.p)) {
          safeSendMessage({ type: 'clearCreds' });
          clearInterval(interval);
          toast('Autofilled ✔︎');
          return;
        }
        if (fillUsernameOnly(creds.u)) {
          safeSendMessage({ type: 'updateStage', stage: 'userSubmitted' });
          stage = 'userSubmitted';
        }
      } else {
        if (fillPasswordIfPresent(creds.p)) {
          safeSendMessage({ type: 'clearCreds' });
          clearInterval(interval);
          toast('Password filled ✔︎');
          return;
        }
      }
      if (attempts >= 500) {
        clearInterval(interval);
      }
    }, SCAN_INTERVAL_MS);
    trackDisposer(() => clearInterval(interval));
    try {
      const observer = new MutationObserver(() => {
        if (stage === 'userSubmitted') {
          if (fillPasswordIfPresent(creds.p)) {
            safeSendMessage({ type: 'clearCreds' });
            try { observer.disconnect(); } catch {}
            clearInterval(interval);
            toast('Password filled ✔︎');
          }
        } else {
          fillBothIfPresent(creds.u, creds.p);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      trackDisposer(() => { try { observer.disconnect(); } catch {} });
    } catch {}
  }

  // Attempt autofill for single‑page logins (username/email and password on one page)
  function tryAutofillNormal(creds) {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (fillBothIfPresent(creds.u, creds.p)) {
        safeSendMessage({ type: 'clearCreds' });
        clearInterval(interval);
        toast('Autofilled ✔︎');
      } else if (attempts >= 400) {
        clearInterval(interval);
      }
    }, SCAN_INTERVAL_MS);
    trackDisposer(() => clearInterval(interval));
    try {
      const observer = new MutationObserver(() => fillBothIfPresent(creds.u, creds.p));
      observer.observe(document.documentElement, { childList: true, subtree: true });
      trackDisposer(() => { try { observer.disconnect(); } catch {} });
    } catch {}
  }

  // Request stored credentials from the background and begin autofill attempts
  function requestCredsAndMaybeFill() {
    safeSendMessage({ type: 'requestCreds' }, (res) => {
      const creds = res?.creds;
      if (!creds) return;
      if (creds.mode?.twoStep) {
        tryAutofillTwoStep(creds, creds.stage || 'init');
      } else {
        tryAutofillNormal(creds);
      }
    });
  }

  // Display a small toast at the bottom right of the page
  function toast(msg) {
    try {
      let style = document.getElementById('clla-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'clla-style';
        style.textContent = '#clla-toast{position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 12px;background:rgba(0,0,0,.85);color:#fff;border-radius:10px;opacity:0;transition:opacity .15s ease;font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto;box-shadow:0 6px 22px rgba(0,0,0,.35)}';
        document.documentElement.appendChild(style);
      }
      let el = document.getElementById('clla-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'clla-toast';
        document.documentElement.appendChild(el);
      }
      el.textContent = msg;
      requestAnimationFrame(() => {
        el.style.opacity = '1';
        setTimeout(() => {
          el.style.opacity = '0';
        }, 1800);
      });
    } catch {}
  }

  // Parse colon link flexible with optional scheme
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

  // Intercept left‑clicks on colon‑style links and open an armed tab
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const raw = a.getAttribute('href') || '';
    const parsed = parseColonLinkFlexible(raw);
    if (!parsed) return;
    const twoStep = !!e.altKey;
    e.preventDefault();
    e.stopPropagation();
    safeSendMessage({ type: 'openArmedTab', url: parsed.url, u: parsed.username, p: parsed.password, mode: { twoStep } });
  }, true);

  // Intercept middle‑clicks (auxclick) on colon‑style links
  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const raw = a.getAttribute('href') || '';
    const parsed = parseColonLinkFlexible(raw);
    if (!parsed) return;
    const twoStep = !!e.altKey;
    e.preventDefault();
    e.stopPropagation();
    safeSendMessage({ type: 'openArmedTab', url: parsed.url, u: parsed.username, p: parsed.password, mode: { twoStep } });
  }, true);

  // Intercept Ctrl/Cmd + click to ensure armed tab creation instead of default new tab
  document.addEventListener('mousedown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const raw = a.getAttribute('href') || '';
    const parsed = parseColonLinkFlexible(raw);
    if (!parsed) return;
    const twoStep = !!e.altKey;
    e.preventDefault();
    e.stopPropagation();
    safeSendMessage({ type: 'openArmedTab', url: parsed.url, u: parsed.username, p: parsed.password, mode: { twoStep } });
  }, true);

  // Capture the raw href when the user opens the context menu on a link
  document.addEventListener('contextmenu', (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const raw = a.getAttribute('href') || '';
    safeSendMessage({ type: 'setRawHrefForTab', href: raw });
  }, true);

  // Attempt to salvage colon links typed directly into the address bar.  If the
  // current URL itself has the colon‑style structure (host:username:password),
  // open an armed tab and replace the current location with about:blank.  This
  // avoids Chrome rewriting userinfo segments (e.g. `user:pass@host`) into a
  // different host.
  (function salvage() {
    try {
      const parsed = parseColonLinkFlexible(location.href);
      if (!parsed) return;
      safeSendMessage({ type: 'openArmedTab', url: parsed.url, u: parsed.username, p: parsed.password, mode: {} }, () => {
        try { window.stop?.(); } catch {}
        try { location.replace('about:blank'); } catch {}
      });
    } catch {}
  })();

  // Listen for manual fill requests and disarm notifications
  safeOnMessage((msg) => {
    if (!msg) return;
    if (msg.type === 'manualFill') {
      safeSendMessage({ type: 'requestCreds' }, (res) => {
        const creds = res?.creds;
        if (!creds) {
          toast('No stored credentials for this tab.');
          return;
        }
        if (creds.mode?.twoStep) {
          if (creds.stage === 'userSubmitted') {
            const ok = fillPasswordIfPresent(creds.p);
            if (ok) safeSendMessage({ type: 'clearCreds' });
            toast(ok ? 'Password filled (manual) ✔︎' : 'Password field not found yet.');
          } else {
            const ok = fillUsernameOnly(creds.u) || fillBothIfPresent(creds.u, creds.p);
            if (ok) safeSendMessage({ type: 'updateStage', stage: 'userSubmitted' });
            toast(ok ? 'Username filled (manual) ✔︎' : 'Username field not found yet.');
          }
        } else {
          const ok = fillBothIfPresent(creds.u, creds.p);
          if (ok) safeSendMessage({ type: 'clearCreds' });
          toast(ok ? 'Manual fill ✔︎' : 'Login fields not found.');
        }
      });
    }
    if (msg.type === 'disarmed') {
      toast('Autofill disarmed.');
    }
  });

  // Kick off autofill attempts for this tab
  requestCredsAndMaybeFill();
})();