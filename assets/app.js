/* SpinePRO Joint CAT - app.js (patched to match current cat_engine.js API)
   Fixes:
   - Uses engine.submitResponse / isFinished / getResults
   - Persists session as engine.serializeSession() (JSON string)
   - Restores session by passing initial_session into createJointCATEngine()
   - Prevents “item is undefined / stuck on first page” errors
*/

(() => {
  "use strict";

  // -------------------------
  // LocalStorage helpers
  // -------------------------
  const LS_KEYS = {
    session: "spinepro_jointcat_session_v3",
    results: "spinepro_jointcat_results_v3",
  };

  function saveLS(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn("localStorage save failed:", e);
    }
  }

  function readLS(key) {
    try {
      const v = localStorage.getItem(key);
      if (v == null) return null;
      return JSON.parse(v);
    } catch (e) {
      return null;
    }
  }

  function clearLS(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }

  // -------------------------
  // DOM refs
  // -------------------------
  const el = {
    questionText: document.getElementById("questionText"),
    answerRow: document.getElementById("answerRow"),
    progressPct: document.getElementById("progressPct"),
    errorText: document.getElementById("errorText"),
  };

  // -------------------------
  // Globals
  // -------------------------
  let engine = null;     // CAT engine instance
  let policy = null;     // loaded frozen_cat_policy.json (for progress display only)

  // -------------------------
  // Asset loading
  // -------------------------
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return await res.json();
  }

  async function loadAllAssets() {
    const [
      bank,
      constraints,
      norms,
      policyObj
    ] = await Promise.all([
      fetchJSON("./assets/itembank_runtime.json"),
      fetchJSON("./assets/pair_exclusion_constraints_RUNTIME.json"),
      fetchJSON("./assets/domain_norms_REAL.json"),
      fetchJSON("./assets/frozen_cat_policy.json"),
    ]);

    policy = policyObj || null;

    return { bank, constraints, norms, policy: policyObj };
  }

  // -------------------------
  // Engine wrapper
  // -------------------------
  function makeEngine({ bank, constraints, policy, norms, initial_session }) {
    if (!window.createJointCATEngine) {
      throw new Error("CAT engine not found. cat_engine.js must define window.createJointCATEngine().");
    }
    return window.createJointCATEngine({ bank, constraints, policy, norms, initial_session });
  }

  // -------------------------
  // Rendering
  // -------------------------
  function setError(msg) {
    if (!el.errorText) return;
    el.errorText.textContent = msg || "";
  }

  function setProgressFromSession() {
    if (!el.progressPct) return;

    try {
      const sStr = engine.serializeSession();
      const s = JSON.parse(sStr);

      const answered = (s && s.administered && Array.isArray(s.administered)) ? s.administered.length : 0;
      const maxItems = (policy && typeof policy.max_items === "number") ? policy.max_items : 18;

      const pct = Math.max(0, Math.min(100, Math.round((answered / maxItems) * 100)));
      el.progressPct.textContent = `${pct}%`;
    } catch (e) {
      el.progressPct.textContent = "0%";
    }
  }

  function clearAnswers() {
    if (!el.answerRow) return;
    el.answerRow.innerHTML = "";
  }

  function renderQuestion(q) {
    setError("");
    setProgressFromSession();

    const item = (q && q.item) ? q.item : q;
    if (!item) {
      if (el.questionText) el.questionText.textContent = "(Question text missing)";
      clearAnswers();
      setError("No item returned by CAT engine.");
      return;
    }

    // Question text
    if (el.questionText) el.questionText.textContent = item.text || "(Question text missing)";

    // Choices
    const choices = q.choices || q.options || item.choices || null;
    if (!choices || !Array.isArray(choices) || choices.length === 0) {
      clearAnswers();
      setError("No response options found for this item.");
      return;
    }

    clearAnswers();
    choices.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "answer-btn"; // keep existing styling
      btn.textContent = String(label);

      btn.addEventListener("click", () => onAnswer(idx));
      el.answerRow.appendChild(btn);
    });
  }

  // -------------------------
  // Session persistence (engine is source of truth)
  // -------------------------
  function persistSession() {
    try {
      const s = engine.serializeSession(); // JSON string
      saveLS(LS_KEYS.session, s);
    } catch (e) {
      console.warn("Could not persist session:", e);
    }
  }

  function initNewSession() {
    engine.createSession();
    persistSession();
    clearLS(LS_KEYS.results);
  }

  function loadSessionOrNew() {
    // Stored session is a JSON string from engine.serializeSession()
    const s = readLS(LS_KEYS.session);
    if (typeof s === "string" && s.trim().startsWith("{")) {
      // engine was already constructed with initial_session in boot()
      return;
    }
    initNewSession();
  }

  function finishAndStoreResults() {
    try {
      const results = engine.getResults();
      saveLS(LS_KEYS.results, results || null);
      persistSession();
    } catch (e) {
      console.warn("Could not store results:", e);
      persistSession();
    }
  }

  // -------------------------
  // Navigation
  // -------------------------
  function goToResults() {
    window.location.href = "./results";
  }

  // -------------------------
  // Answer handler
  // -------------------------
  function onAnswer(choiceIdx) {
    try {
      const current = engine.getNextItem(); // returns current item (does not advance if already selected)
      const item = (current && current.item) ? current.item : current;
      if (!item || !item.id) return;

      engine.submitResponse(item.id, choiceIdx);
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
    try {
      if (engine.isFinished()) {
        finishAndStoreResults();
        goToResults();
        return;
      }

      const next = engine.getNextItem(); // returns item or null
      if (!next) {
        finishAndStoreResults();
        goToResults();
        return;
      }

      renderQuestion(next);
    } catch (e) {
      console.error(e);
      alert("An error occurred while loading the next question. Please refresh and try again.");
    }
  }

  // -------------------------
  // Boot
  // -------------------------
  async function boot() {
    try {
      setError("");

      const { bank, constraints, norms, policy: policyObj } = await loadAllAssets();
      policy = policyObj || policy;

      // Restore prior session if present (stored as engine.serializeSession() JSON string)
      let _storedSessionObj = null;
      const _storedSessionStr = readLS(LS_KEYS.session);
      if (typeof _storedSessionStr === "string" && _storedSessionStr.trim().startsWith("{")) {
        try { _storedSessionObj = JSON.parse(_storedSessionStr); } catch (e) { _storedSessionObj = null; }
      }

      engine = makeEngine({ bank, constraints, policy: policyObj, norms, initial_session: _storedSessionObj });

      loadSessionOrNew();
      tick();
    } catch (e) {
      console.error(e);
      setError(e && e.message ? e.message : String(e));
    }
  }

  // Start
  document.addEventListener("DOMContentLoaded", boot);
})();