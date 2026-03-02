/* ===== SpinePRO app.js (UPDATED - session-based engineAPI wrapper fix) =====
   IMPORTANT:
   - This update fixes survey not starting / stuck at 0% / click not advancing / "item is undefined"
   - It does NOT change UI layout.
   - It aligns app.js with cat_engine.js which uses:
        const session = engine.createSession();
        session.nextItem();
        session.answer(itemId, responseIndex, meta?);
*/

(() => {
  "use strict";

  // -----------------------------
  // Constants / LocalStorage keys
  // -----------------------------
  const LS_KEYS = {
    session: "spinepro_jointcat_session_v3",
    results: "spinepro_jointcat_results_v3",
  };

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (sel) => document.querySelector(sel);
  const setText = (sel, txt) => {
    const el = $(sel);
    if (el) el.textContent = txt;
  };
  const setHTML = (sel, html) => {
    const el = $(sel);
    if (el) el.innerHTML = html;
  };
  const show = (sel) => {
    const el = $(sel);
    if (el) el.style.display = "";
  };
  const hide = (sel) => {
    const el = $(sel);
    if (el) el.style.display = "none";
  };

  // -----------------------------
  // Progress ring (if present)
  // -----------------------------
  function setProgressPercent(pct) {
    const el = $("#progressPercent");
    if (el) el.textContent = `${pct}%`;
  }

  // -----------------------------
  // Safe JSON fetch
  // -----------------------------
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
    return await res.json();
  }

  // -----------------------------
  // Engine creation
  // -----------------------------
  function makeEngine({ bank, norms, constraints, policy }) {
    if (window.JointCATEngine && typeof window.JointCATEngine === "function") {
      // Not used in your current builds typically, but keep fallback.
      return window.JointCATEngine({ bank, norms, pair_constraints: constraints, policy });
    }
    if (window.createJointCATEngine && typeof window.createJointCATEngine === "function") {
      return window.createJointCATEngine({
        bank,
        norms,
        pair_constraints: constraints,
        policy,
      });
    }
    throw new Error("CAT engine not found (JointCATEngine/createJointCATEngine missing).");
  }

  // -----------------------------
  // ✅ FIX: session-based engineAPI wrapper
  // -----------------------------
  function engineAPI(engine) {
    // Supports the SpinePRO Joint CAT engine interface:
    //   const session = engine.createSession();
    //   session.nextItem()
    //   session.getCurrentItem()
    //   session.answer(itemId, responseIndex, meta?)
    //   session.isComplete()
    //   session.finish()
    //   session.getResults()
    //   session.getProgress()
    //   session._getSession()

    if (!engine || typeof engine.createSession !== "function") {
      throw new Error("CAT engine is not available (createSession missing).");
    }

    const session = engine.createSession();
    let lastAnswer = null;

    return {
      start() {
        // Ensure the first item is selected.
        const item = session.nextItem();
        return item;
      },

      getCurrentItem() {
        return session.getCurrentItem ? session.getCurrentItem() : null;
      },

      getNextItem() {
        return session.nextItem();
      },

      answer(itemId, responseIndex, meta) {
        lastAnswer = session.answer(itemId, responseIndex, meta);
        return lastAnswer;
      },

      isFinished() {
        if (lastAnswer && typeof lastAnswer.done === "boolean") return lastAnswer.done;
        return typeof session.isComplete === "function" ? session.isComplete() : false;
      },

      finish() {
        return session.finish();
      },

      getResults() {
        if (typeof session.getResults === "function") return session.getResults();
        if (lastAnswer && lastAnswer.results) return lastAnswer.results;
        return null;
      },

      getProgress() {
        if (typeof session.getProgress === "function") return session.getProgress();
        const snap = this.getSession();
        if (!snap) return { percent: 0, answered: 0, max_items_total: null };
        const answered = Array.isArray(snap.administered) ? snap.administered.length : (snap.answered_count ?? 0);
        const maxItems = snap.max_items_total ?? snap.max_items ?? null;
        const percent = maxItems ? Math.min(100, Math.round((answered / maxItems) * 100)) : 0;
        return { percent, answered, max_items_total: maxItems };
      },

      getSession() {
        return typeof session._getSession === "function" ? session._getSession() : null;
      },
    };
  }

  // -----------------------------
  // Rendering (keeps your layout assumptions)
  // -----------------------------
  function renderItem(item) {
    if (!item) {
      setText("#questionText", "(Question text missing)");
      setText("#errorText", "No response options found for this item.");
      return;
    }

    // Question text
    setText("#questionText", item.prompt || item.text || item.question || "(Question text missing)");

    // Responses
    const options = item.response_options || item.options || item.choices || [];
    const container = $("#responses");
    if (!container) return;

    container.innerHTML = "";

    if (!Array.isArray(options) || options.length === 0) {
      setText("#errorText", "No response options found for this item.");
      return;
    }

    setText("#errorText", "");

    options.forEach((optLabel, idx) => {
      const btn = document.createElement("button");
      btn.className = "resp-btn";
      btn.type = "button";
      btn.textContent = String(optLabel);

      btn.addEventListener("click", () => {
        onAnswer(idx);
      });

      container.appendChild(btn);
    });
  }

  let api = null;
  let currentItem = null;

  function updateProgressUI() {
    if (!api) return;
    const p = api.getProgress();
    if (p && typeof p.percent === "number") setProgressPercent(p.percent);
  }

  function onAnswer(choiceIndex) {
    try {
      if (!api || !currentItem) return;

      const itemId = currentItem.id || currentItem.item_id || currentItem.itemId;
      if (!itemId) {
        setText("#errorText", "Internal error: item id missing.");
        return;
      }

      api.answer(itemId, choiceIndex);

      // Persist session snapshot (optional but kept)
      const snap = api.getSession();
      if (snap) localStorage.setItem(LS_KEYS.session, JSON.stringify(snap));

      updateProgressUI();

      if (api.isFinished()) {
        const results = api.getResults() || api.finish();
        localStorage.setItem(LS_KEYS.results, JSON.stringify(results || {}));
        // If your app routes to results page elsewhere, keep it.
        window.location.href = "/results";
        return;
      }

      currentItem = api.getNextItem();
      renderItem(currentItem);
    } catch (e) {
      console.error(e);
      setText("#errorText", e?.message ? String(e.message) : "Unexpected error.");
    }
  }

  // -----------------------------
  // Main init
  // -----------------------------
  async function initSurvey() {
    try {
      // Load runtime assets
      const [
        bank,
        norms,
        constraints,
        policy,
      ] = await Promise.all([
        fetchJSON("/assets/itembank_runtime.json"),
        fetchJSON("/assets/domain_norms_REAL.json"),
        fetchJSON("/assets/pair_exclusion_constraints_RUNTIME.json"),
        fetchJSON("/assets/frozen_cat_policy.json"),
      ]);

      // Merge frozen policy into bank.cat_config (so policy actually applies)
      // (This is your earlier requirement; no UI/layout impact.)
      if (policy && bank) {
        bank.cat_config = bank.cat_config || {};
        const mergeKeys = [
          "domains_min",
          "domains_max",
          "max_items_total",
          "stopping_rule",
          "min_per_domain",
          "max_per_domain",
          "se_threshold",
          "se_thresholds",
        ];
        mergeKeys.forEach((k) => {
          if (policy[k] !== undefined) bank.cat_config[k] = policy[k];
        });
        if (policy.domain_min_items && !bank.cat_config.min_per_domain) {
          bank.cat_config.min_per_domain = policy.domain_min_items;
        }
        if (policy.domain_max_items && !bank.cat_config.max_per_domain) {
          bank.cat_config.max_per_domain = policy.domain_max_items;
        }
      }

      const engine = makeEngine({ bank, norms, constraints, policy });
      api = engineAPI(engine);

      // Start session and render first item
      currentItem = api.start();
      renderItem(currentItem);
      updateProgressUI();
    } catch (e) {
      console.error(e);
      setText("#questionText", "(Question text missing)");
      setText("#errorText", e?.message ? String(e.message) : "Failed to initialize survey.");
    }
  }

  // Run survey init only on /survey route
  window.addEventListener("DOMContentLoaded", () => {
    try {
      if (window.location.pathname.includes("/survey")) {
        initSurvey();
      }
    } catch (e) {
      console.error(e);
    }
  });

})();