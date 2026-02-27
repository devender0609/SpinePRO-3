/* ============================================================================
   SpinePRO Joint CAT — app.js
   (Updated: robust engine adapter + undefined-item guards + safe step flow)
   ========================================================================== */

(() => {
  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (sel) => document.querySelector(sel);

  const els = {
    questionText: $("#questionText"),
    choicesWrap: $("#choicesWrap"),
    progressText: $("#progressText"),
    progressRing: $("#progressRing"),
    statusText: $("#statusText"),
    resultsWrap: $("#resultsWrap"),
    surveyWrap: $("#surveyWrap"),
    btnSavePdf: $("#btnSavePdf"),
    btnSubmit: $("#btnSubmit"),
    btnPrint: $("#btnPrint"),
    btnEmail: $("#btnEmail"),
  };

  function setStatus(msg) {
    if (!els.statusText) return;
    els.statusText.textContent = msg || "";
  }

  function setProgress(pct) {
    const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (els.progressText) els.progressText.textContent = `${v}%`;
    // If you use an SVG ring, you can update it here; leaving minimal
    if (els.progressRing) {
      els.progressRing.setAttribute("data-progress", String(v));
    }
  }

  function setQuestionText(text) {
    if (els.questionText) els.questionText.textContent = text || "(Question text missing)";
  }

  function clearChoices() {
    if (!els.choicesWrap) return;
    els.choicesWrap.innerHTML = "";
  }

  function setChoices(buttonLabels, onClick) {
    clearChoices();
    if (!els.choicesWrap) return;

    if (!Array.isArray(buttonLabels) || buttonLabels.length === 0) {
      const err = document.createElement("div");
      err.style.color = "crimson";
      err.textContent = "No response options found for this item.";
      els.choicesWrap.appendChild(err);
      return;
    }

    buttonLabels.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.className = "choiceBtn";
      btn.type = "button";
      btn.textContent = label;
      btn.addEventListener("click", () => onClick(idx));
      els.choicesWrap.appendChild(btn);
    });
  }

  // -----------------------------
  // Fetch helpers (local assets)
  // -----------------------------
  async function fetchJson(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to fetch ${path}: ${r.status}`);
    return await r.json();
  }

  // -----------------------------
  // Engine adapter (handles build differences)
  // -----------------------------
  function createEngineAdapter({ bank, norms, pair_constraints, policy }) {
    if (!window.createJointCATEngine) {
      throw new Error("CAT engine is missing. Ensure assets/cat_engine.js is loaded.");
    }

    // Merge frozen policy into bank.cat_config so the engine uses the deployed policy
    // (Your engine reads bank.cat_config for stop thresholds / domain minima)
    if (policy && typeof policy === "object") {
      bank.cat_config = bank.cat_config || {};
      // Shallow merge is enough given your policy shape
      bank.cat_config = { ...bank.cat_config, ...policy };
    }

    // IMPORTANT:
    // Your engine expects an options object. It uses:
    // - opts.bank
    // - opts.norms
    // - opts.constraints (pair exclusion constraints)
    const engine = window.createJointCATEngine({
      bank,
      norms,
      constraints: pair_constraints, // pair exclusion constraints
      // policy is already merged into bank.cat_config
    });

    // Normalize method names
    const api = {};

api.start = () => {
    // Normalized start: different engine builds use different method names.
    if (typeof engine.createSession === "function") return engine.createSession();
    if (typeof engine.start === "function") return engine.start();
    // Some builds auto-create on first getNextItem; if so, no-op is fine.
    return null;
  };

    api.getNextItem = () => {
      if (typeof engine.getNextItem === "function") return engine.getNextItem();
      if (typeof engine.nextItem === "function") return engine.nextItem();
      throw new Error("Engine missing getNextItem()/nextItem().");
    };

    api.answer = (itemId, choiceIndex) => {
      // Normalized answer: different engine builds name this differently.
      if (typeof engine.answerItem === "function") return engine.answerItem(itemId, choiceIndex);
      if (typeof engine.recordResponse === "function") return engine.recordResponse(itemId, choiceIndex);
      if (typeof engine.answer === "function") return engine.answer(itemId, choiceIndex);
      if (typeof engine.submit === "function") return engine.submit(itemId, choiceIndex);
      throw new Error("Engine missing answerItem()/recordResponse()/answer()/submit().");
    };

    api.isFinished = () => {
      if (typeof engine.isFinished === "function") return !!engine.isFinished();
      if (typeof engine.finished === "function") return !!engine.finished();
      return false;
    };

    api.getResults = () => {
      if (typeof engine.getResults === "function") return engine.getResults();
      if (typeof engine.finish === "function") return engine.finish();
      throw new Error("Engine missing getResults()/finish().");
    };

    api.getSession = () => {
      if (typeof engine.getSession === "function") return engine.getSession();
      if (typeof engine._getSession === "function") return engine._getSession();
      return null;
    };

    return api;
  }

  // -----------------------------
  // Render item + results
  // -----------------------------
  function renderItem(item, api) {
  if (!item) {
    setQuestionText("(Question text missing)");
    setChoices([]);
    setStatus("Engine returned an empty item. This usually means the session was not initialized or an item id was not found in the bank.");
    return;
  }

    const question =
      item.question ||
      item.text ||
      item.stem ||
      item.prompt ||
      item.label ||
      "(Question text missing)";

    setQuestionText(question);

    // Track progress if the engine provides it
    const session = api.getSession?.();
    if (session && session.answered_count != null && session.max_items != null) {
      const pct = (session.answered_count / session.max_items) * 100;
      setProgress(pct);
    } else {
      // If unknown, keep at 0–100 but don’t crash
      setProgress(0);
    }

    // Don’t assume item.domain exists (some builds may omit it)
    const domain = item.domain || item.domain_name || item.scale || "";
    if (!domain) {
      // Not fatal; just informative
      setStatus("");
    } else {
      setStatus("");
    }

    const options = item.response_options || item.options || [];
    setChoices(options, async (choiceIndex) => {
      try {
        // Disable buttons while processing
        const btns = els.choicesWrap ? Array.from(els.choicesWrap.querySelectorAll("button")) : [];
        btns.forEach((b) => (b.disabled = true));

        // Submit answer
        const itemId = item.id || item.item_id || item.key;
        if (!itemId) throw new Error("Item missing id/item_id/key.");
        await api.answer(itemId, choiceIndex);

        // Next step
        await step(api);
      } catch (e) {
        setStatus(String(e && e.message ? e.message : e));
      }
    });
  }

  async function renderResults(api) {
    const res = await api.getResults();

    // Basic assumption: your existing HTML renders results from res via a helper.
    // If your app already has renderResultsTable(res), keep it.
    if (typeof window.renderResultsTable === "function") {
      window.renderResultsTable(res);
    } else {
      // Minimal fallback
      if (els.resultsWrap) {
        els.resultsWrap.style.display = "block";
        els.resultsWrap.textContent = JSON.stringify(res, null, 2);
      }
    }

    if (els.surveyWrap) els.surveyWrap.style.display = "none";
    if (els.resultsWrap) els.resultsWrap.style.display = "block";
  }

  // -----------------------------
  // Step loop
  // -----------------------------
  async function step(api) {
    try {
      if (api.isFinished()) {
        await renderResults(api);
        return;
      }

      const item = await api.getNextItem();
    if (!item) {
      if (api.isFinished()) {
        await renderResults();
        return;
      }
      setStatus("No next item returned (item is undefined). Attempting to re-initialize session…");
      try { api.start(); } catch (e) {}
      const retry = await api.getNextItem();
      if (!retry) {
        setStatus("Still no item. Check console for engine/policy errors.");
        return;
      }
      renderItem(retry, api);
      return;
    }

      renderItem(item, api);
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e));
    }
  }

  // -----------------------------
  // Boot
  // -----------------------------
  async function initSurvey() {
    setStatus("Loading…");
    setProgress(0);

    // Load required assets (same paths you showed in Network tab)
    const [bank, norms, pair_constraints, policy] = await Promise.all([
      fetchJson("assets/itembank_runtime.json"),
      fetchJson("assets/domain_norms_REAL.json"),
      fetchJson("assets/pair_exclusion_constraints_RUNTIME.json"),
      fetchJson("assets/frozen_cat_policy.json"),
    ]);

    const api = createEngineAdapter({
      bank,
      norms,
      pair_constraints,
      policy,
    });

    // Start if needed
    try {
      api.start();
    } catch (e) {
      // Not fatal if engine auto-starts
    }

    setStatus("");
    if (els.surveyWrap) els.surveyWrap.style.display = "block";
    if (els.resultsWrap) els.resultsWrap.style.display = "none";

    await step(api);
  }

  // Hook basic buttons if present
  if (els.btnPrint) els.btnPrint.addEventListener("click", () => window.print());
  if (els.btnSubmit) els.btnSubmit.addEventListener("click", () => {
    // You already have this flow in your app; keep minimal
    setStatus("Submitted.");
  });
  if (els.btnSavePdf) els.btnSavePdf.addEventListener("click", () => {
    setStatus("Use your existing PDF export handler.");
  });
  if (els.btnEmail) els.btnEmail.addEventListener("click", () => {
    setStatus("Use your existing email handler.");
  });

  // Auto boot
  window.addEventListener("DOMContentLoaded", () => {
    initSurvey().catch((e) => setStatus(String(e && e.message ? e.message : e)));
  });
})();