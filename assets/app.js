/**
 * SpinePRO Joint CAT - app.js
 *
 * Responsibilities:
 *  - Load all assets (item bank, norms, constraints, policy, SRS text map)
 *  - Create engine via window.createJointCATEngine (or JointCATEngine factory)
 *  - Drive adaptive survey UI on /survey
 *  - Persist session + write results payload for /results
 *
 * IMPORTANT:
 *  This file intentionally does NOT call engine.createSession().
 *  The current cat_engine.js exposes window.createJointCATEngine()
 *  which returns an engine API with nextItem/getNextItem/answer/isFinished/getResults.
 */

(function () {
  "use strict";

  // -----------------------------
  // Helpers
  // -----------------------------
  const $ = (sel, root = document) => root.querySelector(sel);

  function safeText(x) {
    return (x === null || x === undefined) ? "" : String(x);
  }

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function round1(x) {
    return Math.round(x * 10) / 10;
  }

  function toPct(x) {
    return `${Math.round(x)}%`;
  }

  function logDebug(...args) {
    try {
      if (window && window.__DEBUG__) console.log(...args);
    } catch (_) {}
  }

  // -----------------------------
  // Global state
  // -----------------------------
  const STATE = {
    assets: null,
    engine: null,
    currentItem: null,
    answeredCount: 0,
    maxItems: 18,
    minItems: 8,
    startedAt: null,
    isSurveyPage: false
  };

  // -----------------------------
  // Asset loading
  // -----------------------------
  async function fetchJSON(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
    return await res.json();
  }

  async function loadAssets() {
    // IMPORTANT: keep these paths matching your /assets folder names
    const base = "assets/";

    const [
      bank,
      pair_constraints,
      norms,
      policy,
      srs_text
    ] = await Promise.all([
      fetchJSON(base + "itembank_runtime.json"),
      fetchJSON(base + "pair_exclusion_constraints_RUNTIME.json"),
      fetchJSON(base + "domain_norms_REAL.json"),
      fetchJSON(base + "frozen_cat_policy.json"),
      fetchJSON(base + "srs_item_text.json").catch(() => ({})) // optional
    ]);

    const assets = {
      bank,
      pair_constraints,
      norms,
      policy,
      srs_text
    };

    // Expose for debugging and for cat_engine fallback (some engines read this)
    window.__CAT_ASSETS__ = assets;

    // Pull key policy parameters for UI/progress
    if (policy && typeof policy === "object") {
      STATE.maxItems = Number(policy.max_items || STATE.maxItems);
      STATE.minItems = Number(policy.min_items || STATE.minItems);
    }

    return assets;
  }

  // -----------------------------
  // Engine creation (NO createSession calls)
  // -----------------------------
  function makeEngine(assets) {
    // Preferred factory: window.createJointCATEngine
    if (typeof window.createJointCATEngine === "function") {
      return window.createJointCATEngine({
        bank: assets.bank,
        norms: assets.norms,
        pair_constraints: assets.pair_constraints
      });
    }

    // Legacy support: class-based engine if present
    if (window.JointCATEngine && typeof window.JointCATEngine === "function") {
      return new window.JointCATEngine(assets.bank, assets.norms, assets.pair_constraints);
    }

    throw new Error(
      "CAT engine not found. cat_engine.js must define window.createJointCATEngine (factory) or window.JointCATEngine (class)."
    );
  }

  // -----------------------------
  // Survey DOM bindings (survey.html uses data-role)
  // -----------------------------
  function getSurveyEls() {
    return {
      progressRing: $("[data-role='progress']"),
      qStem: $("[data-role='qstem']"),
      optionsWrap: $("[data-role='options']"),
      status: $("[data-role='status']")
    };
  }

  function setStatus(msg) {
    const els = getSurveyEls();
    if (els.status) els.status.textContent = safeText(msg);
  }

  function setProgress(pct) {
    const els = getSurveyEls();
    if (!els.progressRing) return;

    // survey.html uses a simple inner text ring (0% etc.)
    els.progressRing.textContent = toPct(clamp(pct, 0, 100));
  }

  // -----------------------------
  // Item rendering
  // -----------------------------
  function normalizeStem(item) {
    if (!item) return "";
    return item.stem || item.question || item.text || item.prompt || "";
  }

  function normalizeChoices(item) {
    if (!item) return [];
    if (Array.isArray(item.choices) && item.choices.length) return item.choices;
    if (Array.isArray(item.options) && item.options.length) return item.options;
    if (Array.isArray(item.answers) && item.answers.length) return item.answers;

    // Fallback for common PROMIS/SRS templates:
    if (item.response_map && Array.isArray(item.response_map)) return item.response_map;
    return [];
  }

  function renderItem(item) {
    const els = getSurveyEls();
    if (!els.qStem || !els.optionsWrap) return;

    const stem = normalizeStem(item);
    const choices = normalizeChoices(item);

    els.qStem.textContent = stem || "(Question text missing)";
    els.optionsWrap.innerHTML = "";

    if (!choices.length) {
      const div = document.createElement("div");
      div.style.color = "#b00020";
      div.textContent = "No response options found for this item.";
      els.optionsWrap.appendChild(div);
      return;
    }

    choices.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "answer-btn";
      btn.textContent = safeText(label);

      btn.addEventListener("click", () => onAnswer(idx), { once: true });
      els.optionsWrap.appendChild(btn);
    });
  }

  // -----------------------------
  // Session / results persistence
  // -----------------------------
  function saveSessionSnapshot() {
    try {
      const snap = {
        answeredCount: STATE.answeredCount,
        currentItem: STATE.currentItem,
        startedAt: STATE.startedAt
      };
      localStorage.setItem("spinepro_session_meta", JSON.stringify(snap));
    } catch (_) {}
  }

  function writeResultsPayload(resultsObj) {
    try {
      localStorage.setItem("spinepro_results", JSON.stringify(resultsObj));
    } catch (_) {}
  }

  // -----------------------------
  // Core survey flow
  // -----------------------------
  function getNextItemFromEngine() {
    const eng = STATE.engine;
    if (!eng) throw new Error("Engine not initialized");

    // Support both getNextItem() and nextItem()
    if (typeof eng.getNextItem === "function") return eng.getNextItem();
    if (typeof eng.nextItem === "function") return eng.nextItem();

    throw new Error("Engine API missing getNextItem/nextItem");
  }

  function answerIntoEngine(itemId, choiceIndex) {
    const eng = STATE.engine;
    if (!eng) throw new Error("Engine not initialized");
    if (typeof eng.answer !== "function") throw new Error("Engine API missing answer()");
    return eng.answer(itemId, choiceIndex);
  }

  function isFinished() {
    const eng = STATE.engine;
    if (!eng) return false;
    if (typeof eng.isFinished === "function") return !!eng.isFinished();
    // fallback: some engines return done in answer()
    return false;
  }

  function getResults() {
    const eng = STATE.engine;
    if (!eng) return null;
    if (typeof eng.getResults === "function") return eng.getResults();
    return null;
  }

  function computeProgressPct() {
    // Use min/max to display stable progress bar.
    // We want progress to hit 100% only at finish.
    const n = STATE.answeredCount;
    const min = STATE.minItems || 8;
    const max = STATE.maxItems || 18;

    // Before min reached: scale 0..70
    if (n <= min) return (n / min) * 70;

    // After min: scale 70..98 until near max
    if (n < max) return 70 + ((n - min) / (max - min)) * 28;

    // At/over max: show 98 until actually finished
    return 98;
  }

  function finishSurvey(donePayload) {
    let results = null;

    // Prefer answer() return results
    if (donePayload && donePayload.results) results = donePayload.results;

    // Otherwise ask engine
    if (!results) results = getResults();

    const elapsedMs = STATE.startedAt ? (Date.now() - STATE.startedAt) : null;

    const payload = {
      results: results || null,
      answeredCount: STATE.answeredCount,
      elapsedMs
    };

    writeResultsPayload(payload);

    // Navigate to results page
    window.location.href = "results";
  }

  function stepToNextItem() {
    try {
      setStatus("");

      if (isFinished()) {
        finishSurvey(null);
        return;
      }

      const item = getNextItemFromEngine();
      if (!item) {
        // If engine returns null but isFinished() not true, force results safely
        finishSurvey(null);
        return;
      }

      STATE.currentItem = item;

      // progress
      setProgress(computeProgressPct());

      renderItem(item);
      saveSessionSnapshot();
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Unexpected error starting survey.");
    }
  }

  function onAnswer(choiceIndex) {
    try {
      if (!STATE.currentItem) return;

      const itemId = STATE.currentItem.id || STATE.currentItem.item_id || STATE.currentItem.itemId;
      if (!itemId) throw new Error("Item is missing an id");

      const resp = answerIntoEngine(itemId, choiceIndex);
      STATE.answeredCount += 1;

      // Update progress: do NOT set to 100 until finishSurvey()
      setProgress(computeProgressPct());

      // If engine says done, finish
      if (resp && resp.done) {
        finishSurvey(resp);
        return;
      }

      // Some engines mark finish in session
      if (isFinished()) {
        finishSurvey(resp);
        return;
      }

      // Next
      stepToNextItem();
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Error recording answer.");
    }
  }

  // -----------------------------
  // Boot
  // -----------------------------
  async function bootSurvey() {
    STATE.isSurveyPage = true;
    setStatus("Loading…");

    try {
      STATE.assets = await loadAssets();
      STATE.engine = makeEngine(STATE.assets);

      STATE.startedAt = Date.now();
      STATE.answeredCount = 0;
      STATE.currentItem = null;

      setStatus("");
      setProgress(0);

      // First item
      stepToNextItem();
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Failed to initialize survey.");
    }
  }

  function isOnSurveyRoute() {
    // Works for /survey and /survey.html
    const p = (location.pathname || "").toLowerCase();
    return p.endsWith("/survey") || p.endsWith("/survey.html");
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (isOnSurveyRoute()) {
      bootSurvey();
    }
  });
})();