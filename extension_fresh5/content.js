// Content script for colon-link autofill with anti-loop and two-step support
(() => {
  console.log("[CS] injected on", location.href);

  const SCAN_MS = 800;
  // ===== Anti-loop config =====
  // Set to true if you want the script to automatically click the submit button.
  const AUTO_SUBMIT_DEFAULT = false;
  // Maximum number of times we will auto-click submit per tab.
  const MAX_SUBMITS_PER_TAB = 1;
  // After a detected failure, the script will not attempt any auto actions for this many milliseconds.
  const SUBMIT_COOLDOWN_MS  = 10 * 60 * 1000;
  // Common phrases that indicate a login failure on the page (multi-lingual).
  const FAILURE_TERMS = [
    "invalid", "incorrect", "try again", "failed", "mismatch", "not match",
    "unauthorized", "forbidden", "access denied", "locked", "captcha",
    "too many", "limit", "banned",
    "無効", "エラー", "错误", "失敗", "fehlgeschlagen", "неверный", "ошибка", "gagal"
  ];

  // Track the current credentials and state for this tab.
  let state = { armed:false, u:"", p:"", twoStep:false, stage:"" };
  // Track anti-loop information: whether auto submit is enabled, how many times we've submitted,
  // and timeouts to prevent repeated submissions.
  let anti = {
    autoSubmit: AUTO_SUBMIT_DEFAULT,
    submittedCount: 0,
    lastSubmitAt: 0,
    coolDownUntil: 0,
    lastUrlAfterSubmit: ""
  };

  // Helpers to normalise strings and check for keywords.
  const norm = s => (s||"").toString().toLowerCase();
  const hasAny = (s, arr) => { const n = norm(s); return arr.some(t => n.includes(t)); };

  // Keywords used to locate username/email fields and password fields.
  const USER_TERMS = ["user","username","login","email","e-mail","mail","id","correo","benutzer","로그인","メール","邮箱","帳號"];
  const PASS_TERMS = ["pass","password","senha","пароль","סיסמה","密碼","密码","비밀번호","パスワード"];

  // Set value into an input element, firing input/change events to notify frameworks.
  function setVal(el, val){
    try {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles:true }));
      el.dispatchEvent(new Event("change", { bubbles:true }));
      el.blur();
    } catch {}
  }

  // Scan a root for the best username/email and password inputs.
  function findBestInputs(root=document){
    const inputs = [...root.querySelectorAll("input")];
    let userBest=null, userScore=-1, passBest=null, passScore=-1;
    for (const el of inputs){
      const t = norm(el.type);
      let s = 0;
      if (!t || t==="text" || t==="email") s+=2;
      const meta = (el.name||"") + " " + (el.id||"") + " " + (el.placeholder||"") + " " + (el.getAttribute("aria-label")||"");
      if (hasAny(meta, USER_TERMS)) s+=6;
      const ac = norm(el.autocomplete);
      if (ac==="username"||ac==="email") s+=6;
      if (t==="email") s+=3;
      if (s>userScore){ userScore=s; userBest=el; }
    }
    for (const el of inputs){
      const t = norm(el.type);
      let s = 0;
      if (t==="password") s+=8;
      const meta = (el.name||"") + " " + (el.id||"") + " " + (el.placeholder||"") + " " + (el.getAttribute("aria-label")||"");
      if (hasAny(meta, PASS_TERMS)) s+=6;
      const ac = norm(el.autocomplete);
      if (ac.includes("password")) s+=6;
      if (s>passScore){ passScore=s; passBest=el; }
    }
    return { userBest, passBest };
  }

  // Locate a submit button near the given element.
  function findSubmitNear(el){
    const form = el?.form || el?.closest?.("form");
    if (form){
      const btn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (btn) return btn;
    }
    const near = el?.closest?.("form") || el?.closest?.('[role="form"]') || el?.parentElement || document;
    for (const b of near.querySelectorAll("button, input[type=submit]")){
      const txt = norm(b.innerText||b.value||"");
      if (txt.includes("login") || txt.includes("sign in") || txt.includes("continue") || txt.includes("next")) return b;
    }
    return null;
  }

  // Determine if we can auto-click submit based on anti-loop guards.
  function canAutoSubmit() {
    const now = Date.now();
    if (!anti.autoSubmit) return false;
    if (now < anti.coolDownUntil) return false;
    if (anti.submittedCount >= MAX_SUBMITS_PER_TAB) return false;
    return true;
  }

  // Record that we've auto-clicked submit.
  function recordSubmit() {
    anti.submittedCount += 1;
    anti.lastSubmitAt = Date.now();
    anti.lastUrlAfterSubmit = location.href;
  }

  // Start a cool down after failure.
  function onFailureCoolDown() {
    anti.coolDownUntil = Date.now() + SUBMIT_COOLDOWN_MS;
  }

  // Detect if the current page shows evidence of a login failure.
  function pageShowsLikelyFailure() {
    try {
      const txt = (document.body.innerText || "").toLowerCase();
      if (FAILURE_TERMS.some(k => txt.includes(k))) return true;
    } catch {}
    // If a password field is present and we are still on the same URL after submit, treat as failure.
    try {
      const { passBest } = findBestInputs(document);
      if (passBest) {
        if (anti.lastUrlAfterSubmit && anti.lastUrlAfterSubmit === location.href) return true;
      }
    } catch {}
    return false;
  }

  // Fill username and password if present on the page, optionally auto-submit.
  function fillBoth(u,p){
    let anyFilled = false;
    for (const root of allRoots()){
      try {
        const {userBest, passBest} = findBestInputs(root);
        let changed = false;
        if (userBest && u){
          setVal(userBest, u);
          changed = true;
          anyFilled = true;
        }
        if (passBest && p){
          setVal(passBest, p);
          changed = true;
          anyFilled = true;
        }
        if (changed && passBest){
          const submit = findSubmitNear(passBest || userBest);
          if (submit && canAutoSubmit()) {
            submit.click();
            recordSubmit();
          }
          return true;
        }
      } catch {}
    }
    return anyFilled;
  }

  // Fill only the username/email field (first step of two-step).
  function fillUser(u){
    for (const root of allRoots()){
      try {
        const {userBest, passBest} = findBestInputs(root);
        if (userBest && !passBest && u){
          setVal(userBest, u);
          const submit = findSubmitNear(userBest);
          if (submit && canAutoSubmit()) {
            submit.click();
            recordSubmit();
          }
          return true;
        }
      } catch {}
    }
    return false;
  }

  // Fill only the password field (second step of two-step).
  function fillPass(p){
    for (const root of allRoots()){
      try {
        const { passBest } = findBestInputs(root);
        if (passBest && p){
          setVal(passBest, p);
          const submit = findSubmitNear(passBest);
          if (submit && canAutoSubmit()) {
            submit.click();
            recordSubmit();
          }
          return true;
        }
      } catch {}
    }
    return false;
  }

  // Walk DOM across shadow roots and iframes.
  function* walkDom(root=document){
    const w=document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let n=w.currentNode;
    while(n){ yield n; n=w.nextNode(); }
  }
  function allRoots(){
    const roots=[document];
    for (const el of walkDom(document)){ if (el.shadowRoot) roots.push(el.shadowRoot); }
    for (const f of document.querySelectorAll("iframe,frame")){
      try { if (f.contentDocument) roots.push(f.contentDocument); } catch{}
    }
    return roots;
  }

  // Safe messaging wrapper to background.
  function safeSend(msg, cb){ try{ chrome.runtime.sendMessage(msg, cb); } catch(e){ console.warn("[CS] sendMessage error", e); } }

  // Request credentials for this tab from the background and start the fill process.
  function requestCreds(){
    safeSend({ type:"requestCreds" }, (res)=>{
      const c = res?.creds;
      console.log("[CS] requestCreds =>", c);
      if (!c) return;
      state.armed = true;
      state.u = c.u;
      state.p = c.p;
      state.twoStep = !!c.mode?.twoStep;
      state.stage = c.stage || "init";
      if (state.twoStep) runTwoStep();
      else runNormal();
    });
  }

  // Normal (single-step) login flow.
  function runNormal(){
    let attempts = 0;
    const max = 400;
    const int = setInterval(()=>{
      attempts++;
      if (!state.armed){
        clearInterval(int);
        return;
      }
      // If we detect a failure, disarm and cool down.
      if (pageShowsLikelyFailure()){
        state.armed = false;
        onFailureCoolDown();
        safeSend({ type: 'clearCreds' });
        safeSend({ type: 'markOriginFailure' });
        console.warn("[CS] Detected likely login failure → disarming and cooling down.");
        clearInterval(int);
        return;
      }
      if (fillBoth(state.u, state.p)){
        state.armed=false;
        safeSend({type:"clearCreds"});
        console.log("[CS] filled both (normal)");
        clearInterval(int);
      } else if (attempts >= max){
        console.warn("[CS] normal timed out");
        clearInterval(int);
      }
    }, SCAN_MS);
    const mo = new MutationObserver(()=> {
      if (!state.armed) return;
      // attempt fill again on DOM change
      fillBoth(state.u, state.p);
    });
    mo.observe(document.documentElement, { childList:true, subtree:true });
    setTimeout(()=> mo.disconnect(), 15000);
  }

  // Two-step login flow: fill username first, wait for password, then fill password.
  function runTwoStep(){
    let attempts = 0;
    const max = 1000;
    const int = setInterval(()=>{
      attempts++;
      if (!state.armed){
        clearInterval(int);
        return;
      }
      // Detect failure
      if (pageShowsLikelyFailure()){
        state.armed = false;
        onFailureCoolDown();
        safeSend({ type: 'clearCreds' });
        safeSend({ type: 'markOriginFailure' });
        console.warn("[CS] Detected likely login failure (two-step) → disarming and cooling down.");
        clearInterval(int);
        return;
      }
      if (state.stage === "init"){
        // Try quick path: both fields present
        if (fillBoth(state.u, state.p)){
          state.armed=false;
          safeSend({type:"clearCreds"});
          console.log("[CS] filled both (2step fast-path)");
          clearInterval(int);
          return;
        }
        if (fillUser(state.u)){
          state.stage="userSubmitted";
          safeSend({ type:"updateStage", stage:"userSubmitted" });
          console.log("[CS] user submitted; waiting pass");
        }
      } else {
        if (fillPass(state.p)){
          state.armed=false;
          safeSend({type:"clearCreds"});
          console.log("[CS] filled pass (2step)");
          clearInterval(int);
        }
      }
      if (attempts >= max){
        console.warn("[CS] 2step timed out");
        clearInterval(int);
      }
    }, SCAN_MS);
    const mo = new MutationObserver(()=>{
      if (!state.armed) return;
      if (state.stage === "userSubmitted") fillPass(state.p);
      else fillBoth(state.u, state.p);
    });
    mo.observe(document.documentElement, { childList:true, subtree:true });
    setTimeout(()=> mo.disconnect(), 20000);
  }

  // Capture the raw href on right-click so the background can parse an unmodified value.
  document.addEventListener("contextmenu", (e)=>{
    const a = e.target?.closest?.("a[href]");
    const href = a?.getAttribute?.("href") || "";
    // Send raw href to background; ignore errors.
    try {
      chrome.runtime.sendMessage({ type:"storeRawHref", href });
    } catch {}
  }, true);

  // Salvage colon-link typed directly in the address bar: if the URL itself has colon-link pattern,
  // we send it to background; the background will open proper tab and we stay on about:blank.
  (function salvageAddressBar(){
    const href = location.href;
    const last = href.lastIndexOf(":");
    const prev = href.lastIndexOf(":", last - 1);
    if (last > 0 && prev > 0){
      try {
        chrome.runtime.sendMessage({ type:"storeRawHref", href });
      } catch {}
      // Do not redirect; background handles opening.
    }
  })();

  // Start requesting credentials from background.
  requestCreds();
})();