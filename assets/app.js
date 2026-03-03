/* ==== SpinePRO Joint CAT app.js (FIXED) ====
   Fix: define mergeCatConfig (was referenced but missing) so app boots correctly.
   No other logic/layout changes.
*/

(() => {
  "use strict";

  // --------------------------
  // DOM helpers
  // --------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // --------------------------
  // Utils
  // --------------------------
  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function safeJSONParse(text, fallback = null) {
    try {
      // strip BOM if present
      const cleaned = typeof text === "string" ? text.replace(/^\uFEFF/, "") : text;
      return JSON.parse(cleaned);
    } catch (e) {
      return fallback;
    }
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
    const text = await res.text();
    const j = safeJSONParse(text, null);
    if (j === null) throw new Error(`Invalid JSON in ${url}`);
    return j;
  }

  // Merge frozen_cat_policy.json into bank.cat_config safely.
  // This ensures the deployed policy values actually drive the CAT engine.
  function mergeCatConfig(existing, policy) {
    const out = (existing && typeof existing === "object") ? { ...existing } : {};
    if (!policy || typeof policy !== "object") return out;

    const isPlainObj = (x) => x && typeof x === "object" && !Array.isArray(x);

    for (const [k, v] of Object.entries(policy)) {
      if (v === undefined || v === null) continue;

      if (isPlainObj(v) && isPlainObj(out[k])) {
        out[k] = mergeCatConfig(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // --------------------------
  // Routing
  // --------------------------
  function routeTo(path) {
    if (window.location.pathname !== path) window.location.href = path;
  }

  // --------------------------
  // UI state
  // --------------------------
  const state = {
    bank: null,
    policy: null,
    norms: null,
    exclusions: null,
    srsText: null,
    engine: null,
    session: null,
    currentItem: null,
    currentItemOptions: null,
    answeredCount: 0,
    maxItems: 18
  };

  // --------------------------
  // UI rendering
  // --------------------------
  function setProgress(pct) {
    const el = $("#progressPct");
    if (el) el.textContent = `${Math.round(pct)}%`;
    const ring = $("#progressRing");
    if (ring) ring.style.setProperty("--pct", `${pct}`);
  }

  function setError(msg) {
    const el = $("#errorMsg");
    if (el) {
      el.textContent = msg || "";
      el.style.display = msg ? "block" : "none";
    }
  }

  function setQuestionText(text) {
    const q = $("#questionText");
    if (q) q.textContent = text || "(Question text missing)";
  }

  function clearOptions() {
    const wrap = $("#responseButtons");
    if (!wrap) return;
    wrap.innerHTML = "";
  }

  function renderOptions(options) {
    const wrap = $("#responseButtons");
    if (!wrap) return;

    wrap.innerHTML = "";

    if (!options || !Array.isArray(options) || options.length === 0) {
      const err = document.createElement("div");
      err.style.color = "crimson";
      err.style.marginTop = "10px";
      err.textContent = "No response options found for this item.";
      wrap.appendChild(err);
      return;
    }

    options.forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.className = "respBtn";
      btn.type = "button";
      btn.textContent = String(opt);
      btn.addEventListener("click", () => handleResponse(idx));
      wrap.appendChild(btn);
    });
  }

  // --------------------------
  // Engine/session
  // --------------------------
  function makeEngine(bank) {
    // `createJointCATEngine` is expected to exist from assets/cat_engine.js
    if (typeof window.createJointCATEngine !== "function") {
      throw new Error("CAT engine is missing (createJointCATEngine not found). Ensure cat_engine.js is loaded.");
    }
    const engine = window.createJointCATEngine(bank);
    return engine;
  }

  function createSession(engine) {
    // Some builds expose createSession; others return a session from init().
    if (engine && typeof engine.createSession === "function") {
      return engine.createSession();
    }
    if (engine && typeof engine.init === "function") {
      return engine.init();
    }
    throw new Error("Engine session creation method not found.");
  }

  function getNextItem(engine, session) {
    if (!engine) throw new Error("Engine not ready.");
    if (typeof engine.nextItem === "function") return engine.nextItem(session);
    if (typeof engine.getNextItem === "function") return engine.getNextItem(session);
    throw new Error("Engine next-item method not found.");
  }

  function submitAnswer(engine, session, itemId, responseIndex) {
    if (typeof engine.submit === "function") return engine.submit(session, itemId, responseIndex);
    if (typeof engine.submitAnswer === "function") return engine.submitAnswer(session, itemId, responseIndex);
    if (typeof engine.answer === "function") return engine.answer(session, itemId, responseIndex);
    throw new Error("Engine submit method not found.");
  }

  function shouldStop(engine, session) {
    if (typeof engine.shouldStop === "function") return engine.shouldStop(session);
    if (typeof engine.stop === "function") return engine.stop(session);
    if (typeof engine.isDone === "function") return engine.isDone(session);
    return false;
  }

  function finish(engine, session) {
    if (typeof engine.finish === "function") return engine.finish(session);
    if (typeof engine.results === "function") return engine.results(session);
    if (typeof engine.getResults === "function") return engine.getResults(session);
    throw new Error("Engine finish/results method not found.");
  }

  // --------------------------
  // Flow
  // --------------------------
  async function loadAllAssets() {
    // NOTE: keep file names exactly as in your deploy.
    const [
      bank,
      norms,
      exclusions,
      policy,
      srsText
    ] = await Promise.all([
      fetchJSON("./assets/itembank_runtime.json"),
      fetchJSON("./assets/domain_norms_REAL.json"),
      fetchJSON("./assets/pair_exclusion_constraints_RUNTIME.json"),
      fetchJSON("./assets/frozen_cat_policy.json"),
      fetchJSON("./assets/srs_item_text.json")
    ]);

    // IMPORTANT FIX INTENDED BY YOUR POLICY-MERGE WORKFLOW:
    // apply frozen policy to bank.cat_config (engine reads from bank.cat_config)
    bank.cat_config = mergeCatConfig(bank.cat_config || {}, policy || {});

    state.bank = bank;
    state.norms = norms;
    state.exclusions = exclusions;
    state.policy = policy;
    state.srsText = srsText;

    // keep local max items consistent if present
    if (state.bank && state.bank.cat_config && typeof state.bank.cat_config.max_items === "number") {
      state.maxItems = state.bank.cat_config.max_items;
    }
  }

  function renderCurrent() {
    setError("");

    const item = state.currentItem;
    if (!item) {
      setQuestionText("(Question text missing)");
      renderOptions([]);
      return;
    }

    // item text: prefer item.text, else look up in srs text map, else placeholder
    let qText = item.text;
    if (!qText && state.srsText && item.id && state.srsText[item.id]) qText = state.srsText[item.id];
    setQuestionText(qText || "(Question text missing)");

    const opts = item.response_options || item.options || state.currentItemOptions;
    renderOptions(opts);
  }

  function advance() {
    const next = getNextItem(state.engine, state.session);
    state.currentItem = next;

    // progress: avoid divide by zero
    const pct = state.maxItems ? clamp((state.answeredCount / state.maxItems) * 100, 0, 100) : 0;
    setProgress(pct);

    renderCurrent();
  }

  function handleResponse(responseIndex) {
    try {
      if (!state.currentItem) return;

      const itemId = state.currentItem.id || state.currentItem.item_id || state.currentItem.itemId;
      if (!itemId) throw new Error("Item id missing.");

      submitAnswer(state.engine, state.session, itemId, responseIndex);
      state.answeredCount += 1;

      if (shouldStop(state.engine, state.session)) {
        const results = finish(state.engine, state.session);
        // redirect to results page (expected in your app)
        window.SpinePRO_RESULTS = results;
        routeTo("/results");
        return;
      }

      advance();
    } catch (e) {
      setError(String(e && e.message ? e.message : e));
      console.error(e);
    }
  }

  async function boot() {
    try {
      setError("");

      await loadAllAssets();
      state.engine = makeEngine(state.bank);
      state.session = createSession(state.engine);
      state.answeredCount = 0;

      advance();
    } catch (e) {
      setError(String(e && e.message ? e.message : e));
      console.error(e);
    }
  }

  // --------------------------
  // Start
  // --------------------------
  window.addEventListener("DOMContentLoaded", boot);
})();