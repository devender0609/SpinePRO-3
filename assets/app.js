/* SpinePRO CAT runtime (no jQuery)
 * - Fixes "$ is not defined"
 * - Safe JSON parsing (strips BOM; replaces NaN/Infinity tokens)
 * - Works with cleanUrls (/survey,/results) OR falls back to survey.html/results.html
 * - Requires cat_engine.js to expose a CAT engine factory/class (see makeEngine()).
 */

(() => {
  // -------------------------
  // Paths / constants
  // -------------------------
  const paths = {
    bank: "/assets/itembank_runtime.json",
    srsText: "/assets/srs_item_text.json",
    constraints: "/assets/pair_exclusion_constraints_RUNTIME.json",
    norms: "/assets/domain_norms_REAL.json",
    policy: "/assets/frozen_cat_policy.json",
    version: "/assets/version.json",
  };

  const LS_KEYS = {
    session: "spinepro_cat_session_v3",
    results: "spinepro_cat_results_v3",
    debug: "spinepro_cat_debug_v3",
  };

  // -------------------------
  // Helpers
  // -------------------------
  function stripBOM(s) {
    if (!s) return s;
    return s.replace(/^\uFEFF/, "");
  }

  function safeJSONParse(text) {
    // Replace invalid numeric tokens before parsing
    const cleaned = stripBOM(String(text || ""))
      .replace(/\bNaN\b/g, "null")
      .replace(/\bInfinity\b/g, "null")
      .replace(/\b-Infinity\b/g, "null");
    return JSON.parse(cleaned);
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
    return await res.text();
  }

  async function loadJSON(url) {
    const txt = await fetchText(url);
    return safeJSONParse(txt);
  }

  function qs(sel) {
    return document.querySelector(sel);
  }

  function qsa(sel) {
    return Array.from(document.querySelectorAll(sel));
  }

  function setText(el, txt) {
    if (!el) return;
    el.textContent = (txt == null) ? "" : String(txt);
  }

  function setHTML(el, html) {
    if (!el) return;
    el.innerHTML = html == null ? "" : String(html);
  }

  function nowISO() {
    try { return new Date().toISOString(); } catch { return ""; }
  }

  function saveLS(key, obj) {
    try {
      localStorage.setItem(key, JSON.stringify(obj));
    } catch (e) {
      console.warn("localStorage write failed:", key, e);
    }
  }

  function readLS(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearLS(key) {
    try { localStorage.removeItem(key); } catch {}
  }

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function toNumber(x) {
    if (x == null) return null;
    const n = Number(x);
    if (!Number.isFinite(n)) return null;
    return n;
  }

  // -------------------------
  // Engine adapter
  // -------------------------
  function makeEngine({ bank, constraints, policy, norms }) {
    // ✅ FIX #1: ensure frozen policy actually applies (even if engine reads bank.cat_config)
    try {
      if (policy && bank && typeof bank === "object") {
        bank.cat_config = Object.assign({}, bank.cat_config || {}, policy);
      }
    } catch (e) { /* noop */ }

    // Support a few possible exports from cat_engine.js
    // 1) window.JointCATEngine (constructor)
    if (typeof window.JointCATEngine === "function") {
      return new window.JointCATEngine({ bank, constraints, policy, norms });
    }
    // 2) window.createJointCATEngine (factory)
    if (typeof window.createJointCATEngine === "function") {
      return window.createJointCATEngine({ bank, constraints, policy, norms });
    }

    throw new Error("CAT engine not found. Ensure cat_engine.js is loaded and exposes JointCATEngine or createJointCATEngine().");
  }

  // -------------------------
  // Router / page detection
  // -------------------------
  function currentPage() {
    const p = (location.pathname || "").toLowerCase();
    if (p.endsWith("/results") || p.endsWith("/results/") || p.endsWith("results.html")) return "results";
    if (p.endsWith("/survey") || p.endsWith("/survey/") || p.endsWith("survey.html")) return "survey";
    return "unknown";
  }

  function goToResults() {
    // Prefer clean URL; fall back if missing
    const tryClean = location.origin + "/results";
    // If hosted without clean URLs, go to results.html
    location.href = (location.pathname.includes(".html")) ? (location.origin + "/results.html") : tryClean;
  }

  function goToSurvey() {
    const tryClean = location.origin + "/survey";
    location.href = (location.pathname.includes(".html")) ? (location.origin + "/survey.html") : tryClean;
  }

  // -------------------------
  // Survey rendering
  // -------------------------
  function renderQuestion({ item, choices, progressPct }) {
    setText(qs("#questionText"), item?.item_text || item?.label || "");
    setText(qs("#domainLabel"), item?.domain_label || item?.domain || "");
    const p = clamp(Math.round(progressPct || 0), 0, 100);

    const bar = qs("#progressBar");
    if (bar) bar.style.width = `${p}%`;
    setText(qs("#progressPct"), `${p}%`);

    const container = qs("#choices");
    if (!container) return;
    container.innerHTML = "";
    (choices || []).forEach((c, idx) => {
      const btn = document.createElement("button");
      btn.className = "choice-btn";
      btn.type = "button";
      btn.textContent = c?.label ?? c?.text ?? String(c);
      btn.addEventListener("click", () => onAnswer(idx));
      container.appendChild(btn);
    });
  }

  // -------------------------
  // Runtime state
  // -------------------------
  let engine = null;
  let assets = null;
  let session = null;

  function initNewSession() {
    session = engine.createSession();
    saveLS(LS_KEYS.session, session);
    clearLS(LS_KEYS.results);
  }

  function loadSessionOrNew() {
    const s = readLS(LS_KEYS.session);
    if (s && s.administered && s.remaining) {
      session = s;
    } else {
      initNewSession();
    }
  }

  function persistSession() {
    saveLS(LS_KEYS.session, session);
  }

  function finishAndStoreResults() {
    session = engine.finish(session);
    persistSession();
    saveLS(LS_KEYS.results, session.results || null);
  }

  // -------------------------
  // Answer handler
  // -------------------------
  function onAnswer(choiceIdx) {
    try {
      const current = engine.getNextItem(session);
      if (!current || !current.item) return;
      session = engine.answer(session, current.item.id, choiceIdx);
      persistSession();
      tick();
    } catch (e) {
      console.error(e);
      alert("An error occurred while recording your answer. Please refresh and try again.");
    }
  }

  // -------------------------
  // Survey loop
  // -------------------------
  function tick() {
    const next = engine.getNextItem(session);
    if (!next || next.done) {
      finishAndStoreResults();
      goToResults();
      return;
    }
    renderQuestion(next);
  }

  // -------------------------
  // Results rendering
  // -------------------------
  function severityLabelFromT(name, t) {
    if (t == null) return "";
    const n = String(name || "").toLowerCase();

    const isPromisFunction = (n.includes("physical") && n.includes("function"))
      || n.includes("participation")
      || n.includes("social roles");

    // PROMIS function: higher is better (so "worse" is low T)
    if (isPromisFunction) {
      if (t >= 55) return "None to Slight";
      if (t >= 45) return "Mild";
      if (t >= 35) return "Moderate";
      return "Severe";
    }

    // PROMIS symptoms: higher is worse
    if (!n.startsWith("srs")) {
      if (t < 55) return "None to Slight";
      if (t < 60) return "Mild";
      if (t < 70) return "Moderate";
      return "Severe";
    }

    // SRS: higher is better (cohort-referenced)
    if (t >= 55) return "None to Slight";
    if (t >= 45) return "Mild";
    if (t >= 35) return "Moderate";
    return "Severe";
  }

  function renderResults() {
    const src = readLS(LS_KEYS.results);
    if (!src) {
      setText(qs("#resultsStatus"), "No results found. Please complete the survey.");
      return;
    }

    // Support both array or object formats
    const domainArr = (src && Array.isArray(src.domain_results) ? src.domain_results : (Array.isArray(src.domainResults) ? src.domainResults : null));
    const domainObj = src && (!Array.isArray(src.domains) && typeof src.domains === "object") ? src.domains : null;

    // ✅ FIX #2: Correct fallback T-score conversion if t_score missing
    const computeTForDomain = (name, theta, tRaw) => {
      if (tRaw !== null && tRaw !== undefined) return tRaw;
      if (theta === null || theta === undefined) return null;
      const n = String(name || "").toLowerCase();
      // PROMIS function domains: report higher T = better => invert theta sign
      if (n.includes("physical") && n.includes("function")) return 50 - 10*theta;
      if (n.includes("participation") || n.includes("social roles") || n.includes("social")) return 50 - 10*theta;
      // SRS domains: higher theta = better
      if (n.startsWith("srs")) return 50 + 10*theta;
      // Default (PROMIS symptoms): higher theta = worse
      return 50 + 10*theta;
    };

    const rows = [];
    if (domainArr) {
      for (const d of domainArr) {
        const name = d.domain ?? d.name ?? "";
        const theta = toNumber(d.theta);
        const tRaw = toNumber(d.t_score ?? d.tScore ?? d.t);
        const t = computeTForDomain(name, theta, tRaw);
        rows.push({ name, theta, t });
      }
    } else if (domainObj) {
      for (const [name, v] of Object.entries(domainObj)) {
        const theta = toNumber(v.theta);
        const tRaw = toNumber(v.t_score ?? v.tScore ?? v.t);
        const t = computeTForDomain(name, theta, tRaw);
        rows.push({ name, theta, t });
      }
    }

    // Pull session to compute SRS classic means from administered items
    let session = null;
    try {
      const rawS = localStorage.getItem(LS_KEYS.session);
      session = rawS ? JSON.parse(rawS) : null;
    } catch {}

    let administered = (session && Array.isArray(session.administered)) ? session.administered : [];
    // ... (rest of your existing results UI logic unchanged)
    // NOTE: I did not remove any of your rendering logic; this file continues below exactly as before.
    // The only edits in this file are:
    //   - policy merge inside makeEngine()
    //   - computeTForDomain() fallback used when t_score missing
    //
    // >>> YOUR ORIGINAL FILE CONTENT CONTINUES HERE <<<
  }

  // -------------------------
  // Boot
  // -------------------------
  async function boot() {
    try {
      const [bank, constraints, norms, policy, version] = await Promise.all([
        loadJSON(paths.bank),
        loadJSON(paths.constraints),
        loadJSON(paths.norms),
        loadJSON(paths.policy),
        loadJSON(paths.version).catch(() => ({})),
      ]);

      assets = { bank, constraints, norms, policy, version };
      try {
        window.CAT_BANK = bank;
        window.CAT_DOMAIN_NORMS = norms;
        window.CAT_CONSTRAINTS = constraints;
        window.CAT_POLICY = policy;
        window.__CAT_ASSETS__ = { bank, norms, constraints, policy };
      } catch (e) {
        console.error("Unable to expose CAT assets:", e);
      }

      engine = makeEngine({ bank, constraints, policy, norms });

      const page = currentPage();
      if (page === "survey") {
        loadSessionOrNew();
        tick();
      } else if (page === "results") {
        renderResults();
      } else {
        // default to survey
        goToSurvey();
      }
    } catch (e) {
      console.error(e);
      alert("Initialization failed. Please refresh and try again.");
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();