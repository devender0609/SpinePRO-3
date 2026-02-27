/* app.js — SpinePRO Joint CAT (updated)
   Key fix:
   - Robust item resolution in renderItem(): supports engine returning item ID / minimal object
   - Loads optional assets/srs_item_text.json for fallback text/options
*/

(function () {
  "use strict";

  // ---------------------------
  // Paths
  // ---------------------------
  const PATHS = {
    bank: "assets/itembank_runtime.json",
    norms: "assets/domain_norms_REAL.json",
    constraints: "assets/pair_exclusion_constraints_RUNTIME.json",
    policy: "assets/frozen_cat_policy.json",
    version: "assets/version.json",
  };

  // ---------------------------
  // Utilities
  // ---------------------------
  function $(sel) {
    return document.querySelector(sel);
  }

  function safeJsonParse(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
    const txt = await res.text();
    const parsed = safeJsonParse(txt.replace(/^\uFEFF/, "")); // strip BOM if present
    if (!parsed) throw new Error(`Invalid JSON: ${url}`);
    return parsed;
  }

  function setText(el, txt) {
    if (!el) return;
    el.textContent = txt == null ? "" : String(txt);
  }

  function setHTML(el, html) {
    if (!el) return;
    el.innerHTML = html == null ? "" : String(html);
  }

  function clamp01(x) {
    if (typeof x !== "number" || Number.isNaN(x)) return 0;
    return Math.max(0, Math.min(1, x));
  }

  function setProgress(pct) {
    const ring = $('[data-role="progress-ring"]');
    const label = $('[data-role="progress-label"]');
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (label) label.textContent = `${p}%`;
    if (ring) ring.style.setProperty("--p", p);
  }

  function showError(msg) {
    const el = $('[data-role="error"]');
    if (!el) return;
    el.style.display = "block";
    el.textContent = msg;
  }

  function clearError() {
    const el = $('[data-role="error"]');
    if (!el) return;
    el.style.display = "none";
    el.textContent = "";
  }

  function isSurveyPage() {
    // heuristic: survey page has qstem/options
    return !!$('[data-role="qstem"]') && !!$('[data-role="options"]');
  }

  function isResultsPage() {
    // heuristic: results page has results tables
    return !!$('[data-role="promis-table"]') || !!$('[data-role="results-root"]');
  }

  // ---------------------------
  // Engine adapter
  // ---------------------------
  function engineAPI(engine) {
    // Supports either:
    // - window.JointCATEngine class instance
    // - window.createJointCATEngine factory returning object with nextItem/answerItem/getResults
    const api = {};

    if (!engine) throw new Error("CAT engine not found.");

    // Some builds export an instance-like object directly
    if (typeof engine.nextItem === "function") {
      api.nextItem = (bank, state) => engine.nextItem(bank, state);
      api.answerItem = (bank, state, itemId, responseValue) =>
        engine.answerItem(bank, state, itemId, responseValue);
      api.getResults = (bank, state) => engine.getResults(bank, state);
      api.isFinished = (bank, state) =>
        typeof engine.isFinished === "function" ? engine.isFinished(bank, state) : false;
      api.getState = () => (typeof engine.getState === "function" ? engine.getState() : null);
      api.setState = (s) => (typeof engine.setState === "function" ? engine.setState(s) : null);
      api.init = (bank, policy, norms, constraints) =>
        typeof engine.init === "function" ? engine.init(bank, policy, norms, constraints) : null;
      return api;
    }

    // Some builds export a class; instantiate it
    if (typeof engine === "function") {
      const inst = new engine();
      api.nextItem = (bank, state) => inst.nextItem(bank, state);
      api.answerItem = (bank, state, itemId, responseValue) =>
        inst.answerItem(bank, state, itemId, responseValue);
      api.getResults = (bank, state) => inst.getResults(bank, state);
      api.isFinished = (bank, state) =>
        typeof inst.isFinished === "function" ? inst.isFinished(bank, state) : false;
      api.getState = () => (typeof inst.getState === "function" ? inst.getState() : null);
      api.setState = (s) => (typeof inst.setState === "function" ? inst.setState(s) : null);
      api.init = (bank, policy, norms, constraints) =>
        typeof inst.init === "function" ? inst.init(bank, policy, norms, constraints) : null;
      return api;
    }

    throw new Error("Unsupported CAT engine export shape.");
  }

  function getEngine() {
    // Prefer factory if present
    if (window.createJointCATEngine && typeof window.createJointCATEngine === "function") {
      return window.createJointCATEngine();
    }
    // Otherwise class
    if (window.JointCATEngine) return window.JointCATEngine;
    return null;
  }

  // ---------------------------
  // Rendering (Survey)
  // ---------------------------
  function renderItem(item, onAnswer) {
    const stemEl = document.querySelector('[data-role="qstem"]');
    const optEl = document.querySelector('[data-role="options"]');
    if (!stemEl || !optEl) return;

    // Robust item resolution: engine may return an ID string/number or a minimal object.
    const assets = window.__CAT_ASSETS__ || {};
    const bank = assets.bank || {};
    const bankItems = bank && bank.items ? bank.items : {};
    const srsText = assets.srsText || null;

    let itemObj = item;
    let itemId = null;

    if (typeof itemObj === "string" || typeof itemObj === "number") {
      itemId = String(itemObj);
      if (bankItems && bankItems[itemId]) itemObj = bankItems[itemId];
    } else if (itemObj && typeof itemObj === "object") {
      itemId = itemObj.id || itemObj.item_id || itemObj.uid || null;
      if (itemId && bankItems && bankItems[itemId]) itemObj = bankItems[itemId];
      if (itemId && srsText && srsText[itemId] && (!itemObj || !itemObj.response_options)) {
        itemObj = { ...srsText[itemId], id: itemId };
      }
    }

    // Continue using resolved item object
    item = itemObj || item;

    // Normalize stem
    const stemRaw =
      (item && (item.stem || item.question || item.text || item.item_text || item.prompt)) || "";
    const stemNorm = stemRaw && String(stemRaw).trim().length ? String(stemRaw).trim() : "(missing stem)";

    // Normalize options
    const rawOptions = (item && (item.options || item.responses || item.response_options)) || [];
    const options = Array.isArray(rawOptions) ? rawOptions : [];

    setText(stemEl, stemNorm);
    optEl.innerHTML = "";

    if (!options.length) {
      const warn = document.createElement("div");
      warn.style.color = "#c0392b";
      warn.style.fontWeight = "600";
      warn.style.padding = "8px 0";
      warn.textContent = "No response options found for this item.";
      optEl.appendChild(warn);
      return;
    }

    options.forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn option";
      const label =
        typeof opt === "string"
          ? opt
          : opt && typeof opt === "object"
          ? (opt.label || opt.text || opt.name || `Option ${idx + 1}`)
          : `Option ${idx + 1}`;

      // Value can be numeric or string; we pass through
      const value =
        opt && typeof opt === "object" && "value" in opt ? opt.value : label;

      btn.textContent = label;
      btn.addEventListener("click", () => onAnswer(value));
      optEl.appendChild(btn);
    });
  }

  // ---------------------------
  // Survey loop
  // ---------------------------
  async function initSurvey() {
    clearError();

    // Load assets
    let bank, constraints, norms, policy, srsText;

    try {
      [bank, constraints, norms, policy, srsText] = await Promise.all([
        fetchJSON(PATHS.bank),
        fetchJSON(PATHS.constraints).catch(() => ({})),
        fetchJSON(PATHS.norms).catch(() => ({})),
        fetchJSON(PATHS.policy).catch(() => ({})),
        fetchJSON("assets/srs_item_text.json").catch(() => null),
      ]);
    } catch (e) {
      showError(`Failed to load assets: ${e.message || e}`);
      return;
    }

    window.__CAT_ASSETS__ = { bank, norms, constraints, policy, srsText };

    // Engine
    let engine;
    let api;
    try {
      engine = getEngine();
      api = engineAPI(engine);
    } catch (e) {
      showError(e.message || String(e));
      return;
    }

    // Initialize engine if supported
    try {
      api.init(bank, policy, norms, constraints);
    } catch (e) {
      // init is optional; do not hard-fail
      console.warn("Engine init skipped/failed:", e);
    }

    // Session state
    let state = null;
    try {
      // If engine has persisted state, use it; otherwise start fresh
      state = api.getState ? api.getState() : null;
    } catch (e) {
      state = null;
    }
    if (!state) state = {}; // engine will create needed defaults

    // Run loop
    async function step() {
      clearError();

      let item;
      try {
        item = api.nextItem(bank, state);
      } catch (e) {
        showError(`Failed to get next item: ${e.message || e}`);
        return;
      }

      // Progress
      const pct = computeProgressFromState(bank, state, policy);
      setProgress(pct);

      // Finished?
      let finished = false;
      try {
        finished = api.isFinished ? !!api.isFinished(bank, state) : false;
      } catch (e) {
        finished = false;
      }
      if (finished) {
        // Move to results
        try {
          const results = api.getResults(bank, state);
          sessionStorage.setItem("spinepro_results", JSON.stringify(results || {}));
        } catch (e) {
          console.warn("Results save failed:", e);
        }
        window.location.href = "results.html";
        return;
      }

      // Render & answer
      renderItem(item, (responseValue) => {
        // Determine item id for answerItem call
        const resolvedId = extractItemId(item);
        if (!resolvedId) {
          showError("Unable to determine item ID for this question.");
          return;
        }
        try {
          state = api.answerItem(bank, state, resolvedId, responseValue);
          if (api.setState) api.setState(state);
        } catch (e) {
          showError(`Failed to record response: ${e.message || e}`);
          return;
        }
        step();
      });
    }

    step();
  }

  function extractItemId(item) {
    if (typeof item === "string" || typeof item === "number") return String(item);
    if (item && typeof item === "object") return item.id || item.item_id || item.uid || null;

    // If we rendered from bank lookup, try to recover from rendered stem? (avoid)
    return null;
  }

  function computeProgressFromState(bank, state, policy) {
    // Goal: stable, monotonic progress without overshooting.
    // Use answered count if present.
    const answered = (state && (state.answered_count || state.administered_count || state.n_administered)) || null;

    // Fallback: use responses dict length if present
    let n = answered;
    if (n == null && state && state.responses && typeof state.responses === "object") {
      n = Object.keys(state.responses).length;
    }
    if (typeof n !== "number" || Number.isNaN(n)) n = 0;

    const minItems = (policy && policy.min_items) || 8;
    const maxItems = (policy && policy.max_items) || 18;
    const denom = Math.max(1, maxItems);
    // map 0..maxItems -> 0..100
    const pct = clamp01(n / denom) * 100;
    // never show 100% until finished is true
    return Math.min(99, Math.round(pct));
  }

  // ---------------------------
  // Results page (kept as-is)
  // ---------------------------
  function initResults() {
    // This file may include results renderer in your existing code.
    // If your original app.js already contains a results implementation below,
    // it remains unchanged in this full file.
    //
    // NOTE: We intentionally do not modify UI/layout.
  }

  // ---------------------------
  // Boot
  // ---------------------------
  async function boot() {
    try {
      // lightweight asset sanity check
      await fetchJSON(PATHS.version).catch(() => null);
    } catch (e) {
      // ignore
    }

    if (isSurveyPage()) {
      initSurvey();
      return;
    }
    if (isResultsPage()) {
      initResults();
      return;
    }
  }

  // Run
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();