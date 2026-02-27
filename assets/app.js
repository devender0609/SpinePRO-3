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
    try {
      return new Date().toISOString();
    } catch (e) {
      return "";
    }
  }

  function saveLS(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { /* noop */ }
  }

  function readLS(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function removeLS(key) {
    try { localStorage.removeItem(key); } catch (e) { /* noop */ }
  }

  function isSurveyPage() {
    const p = window.location.pathname.toLowerCase();
    return p.endsWith("/survey") || p.endsWith("/survey/") || p.endsWith("survey.html");
  }

  function isResultsPage() {
    const p = window.location.pathname.toLowerCase();
    return p.endsWith("/results") || p.endsWith("/results/") || p.endsWith("results.html");
  }

  function goToResults() {
    // Prefer cleanUrls
    try {
      const base = window.location.origin;
      window.location.href = base + "/results";
    } catch (e) {
      window.location.href = "results.html";
    }
  }

  function goToSurvey() {
    try {
      const base = window.location.origin;
      window.location.href = base + "/survey";
    } catch (e) {
      window.location.href = "survey.html";
    }
  }

  // -------------------------
  // Engine loader / adapter
  // -------------------------
  function makeEngine({ bank, constraints, policy, norms }) {
    // ✅ ensure frozen policy actually applies (even if engine reads bank.cat_config)
    try {
      if (policy && bank && typeof bank === "object") {
        bank.cat_config = Object.assign({}, bank.cat_config || {}, policy);
      }
    } catch (e) { /* noop */ }

    // IMPORTANT:
    // In this project, cat_engine.js may expose either:
    //  - window.createJointCATEngine({...})  (preferred factory; returns a live session wrapper)
    //  - window.JointCATEngine with static methods (createSession/nextItem/answer/finish)
    // Some earlier builds also exposed window.JointCATEngine as a constructor, but that is NOT guaranteed.
    //
    // The UI expects an engine/session object with nextItem/getNextItem/answer/isFinished/getResults.

    // 1) Preferred: factory that returns a live session wrapper
    if (typeof window.createJointCATEngine === "function") {
      return window.createJointCATEngine({
        bank,
        norms,
        constraints,
        // tolerate alternate naming used across builds
        pair_constraints: constraints,
        policy
      });
    }

    // 2) Fallback: JointCATEngine static-method API
    const JC = window.JointCATEngine;
    if (
      JC &&
      typeof JC.createSession === "function" &&
      typeof JC.nextItem === "function" &&
      typeof JC.answer === "function"
    ) {
      let session = JC.createSession(bank, norms, constraints);

      return {
        policy,
        bank,
        nextItem: () => JC.nextItem(bank, session),
        getNextItem: () => JC.nextItem(bank, session),
        answer: (itemId, choiceIndex) => {
          const s2 = JC.answer(bank, norms, session, itemId, choiceIndex);
          if (s2) session = s2;
          return { done: !!session.is_finished, results: session.results || null, session };
        },
        isFinished: () => !!session.is_finished,
        getResults: () =>
          session.results || JC.finish(bank, norms, session, session.stop_reason || "finished"),
        _getSession: () => session
      };
    }

    // 3) Legacy: alternate export name
    if (typeof window.createSession === "function") {
      // If someone exported a bare createSession() returning session and
      // nextItem/answer are globals (rare), let the app fail with a clearer message.
      throw new Error("Unsupported CAT engine export: found window.createSession but missing JointCATEngine/static API.");
    }

    throw new Error(
      "CAT engine not found. cat_engine.js must define window.createJointCATEngine (factory) or window.JointCATEngine static methods."
    );
  }

  // -------------------------
  // UI: progress ring
  // -------------------------
  function setProgress(pct) {
    const el = qs("#progressPct");
    if (el) setText(el, `${Math.max(0, Math.min(100, Math.round(pct)))}%`);
  }

  // -------------------------
  // Survey state / rendering
  // -------------------------
  function renderQuestion(item, srsTextMap) {
    const qEl = qs("#questionText");
    if (!qEl) return;

    // Prefer explicit text if provided
    let text = item && (item.text || item.prompt || item.stem || item.question);
    if (!text && item && item.item_id && srsTextMap && srsTextMap[item.item_id]) {
      text = srsTextMap[item.item_id];
    }
    if (!text && item && item.id && srsTextMap && srsTextMap[item.id]) {
      text = srsTextMap[item.id];
    }
    if (!text) text = "Please answer the following question:";

    setText(qEl, text);

    // Render choices
    const choicesWrap = qs("#choicesWrap");
    if (!choicesWrap) return;
    choicesWrap.innerHTML = "";

    const options = (item && (item.choices || item.options)) || [];
    options.forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.className = "choice-btn";
      btn.type = "button";
      btn.textContent = String(opt && (opt.label || opt.text || opt) || `Option ${idx + 1}`);
      btn.addEventListener("click", () => onAnswer(idx));
      choicesWrap.appendChild(btn);
    });

    if (!options.length) {
      // fallback: show standard 5-point
      ["Never", "Rarely", "Sometimes", "Often", "Very often"].forEach((lbl, idx) => {
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.type = "button";
        btn.textContent = lbl;
        btn.addEventListener("click", () => onAnswer(idx));
        choicesWrap.appendChild(btn);
      });
    }
  }

  // Globals for page runtime
  let _engine = null;
  let _bank = null;
  let _norms = null;
  let _constraints = null;
  let _policy = null;
  let _srsTextMap = null;

  let _asked = 0;
  let _max = 18;

  function updateProgress() {
    const maxItems = _policy && typeof _policy.max_items === "number" ? _policy.max_items : (_max || 18);
    const pct = (_asked / Math.max(1, maxItems)) * 100;
    setProgress(pct);
  }

  function getItemId(item) {
    return (item && (item.item_id || item.id || item.uid)) || "";
  }

  async function onAnswer(choiceIndex) {
    if (!_engine) return;
    try {
      const current = readLS(LS_KEYS.session, null);
      const item = current && current.current_item;
      const itemId = getItemId(item);

      const out = _engine.answer(itemId, choiceIndex);
      const done = out && (out.done || (out.session && out.session.is_finished));

      // persist session
      saveLS(LS_KEYS.session, Object.assign({}, current || {}, {
        answered_at: nowISO(),
        current_item: null,
        engine_session: out && out.session ? out.session : (out && out._getSession ? out._getSession() : null),
      }));

      _asked += 1;
      updateProgress();

      if (done) {
        const results = (out && out.results) || (_engine.getResults ? _engine.getResults() : null);
        saveLS(LS_KEYS.results, results);
        goToResults();
        return;
      }

      // next item
      const next = _engine.getNextItem ? _engine.getNextItem() : _engine.nextItem();
      const sessionObj = readLS(LS_KEYS.session, {});
      saveLS(LS_KEYS.session, Object.assign({}, sessionObj, {
        current_item: next,
        asked: _asked,
      }));
      renderQuestion(next, _srsTextMap);
    } catch (e) {
      console.error(e);
      setHTML(qs("#errorBox"), `Error: ${e.message || e}`);
    }
  }

  async function initSurvey() {
    try {
      // Load runtime assets
      const [bank, srsText, constraints, norms, policy] = await Promise.all([
        loadJSON(paths.bank),
        loadJSON(paths.srsText).catch(() => ({})),
        loadJSON(paths.constraints).catch(() => ({})),
        loadJSON(paths.norms).catch(() => ({})),
        loadJSON(paths.policy).catch(() => ({})),
      ]);

      _bank = bank;
      _constraints = constraints;
      _norms = norms;
      _policy = policy;
      _srsTextMap = srsText || {};

      _engine = makeEngine({ bank: _bank, constraints: _constraints, policy: _policy, norms: _norms });

      // determine max
      _max = (_policy && typeof _policy.max_items === "number") ? _policy.max_items : 18;

      // Start new session
      const first = _engine.getNextItem ? _engine.getNextItem() : _engine.nextItem();
      _asked = 0;

      saveLS(LS_KEYS.session, {
        started_at: nowISO(),
        asked: _asked,
        current_item: first,
        engine_session: _engine._getSession ? _engine._getSession() : null,
        policy: _policy || null,
        version: await loadJSON(paths.version).catch(() => null),
      });

      updateProgress();
      renderQuestion(first, _srsTextMap);
    } catch (e) {
      console.error(e);
      setHTML(qs("#errorBox"), `Error: ${e.message || e}`);
    }
  }

  // -------------------------
  // Results page rendering
  // -------------------------
  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function round1(x) {
    return Math.round(x * 10) / 10;
  }

  function inferPromisCategory(domainName, t) {
    // PROMIS: symptom domains higher=worse; function domains higher=better.
    // Keep the same thresholds used in your UI category pills.
    if (t == null || !isFinite(t)) return "—";

    const d = String(domainName || "").toLowerCase();

    const isFunction =
      d.includes("physical function") ||
      d.includes("social roles") ||
      d.includes("participation");

    // simple bucket thresholds; keep UI labels consistent
    // (You can adjust thresholds later if your manuscript uses specific PROMIS cutoffs.)
    if (isFunction) {
      // lower is worse for function
      if (t < 40) return "Severe";
      if (t < 45) return "Moderate";
      if (t < 55) return "Mild";
      return "None to Slight";
    } else {
      // higher is worse for symptoms
      if (t >= 70) return "Severe";
      if (t >= 60) return "Moderate";
      if (t >= 55) return "Mild";
      return "None to Slight";
    }
  }

  function inferSrsCategory(t) {
    if (t == null || !isFinite(t)) return "—";
    // Lower is worse relative to deformity cohort distribution.
    if (t < 40) return "Severe";
    if (t < 45) return "Moderate";
    if (t < 55) return "Mild";
    return "None to Slight";
  }

  function computeTFromTheta(theta) {
    if (theta == null || !isFinite(theta)) return null;
    // T = 50 + 10*theta (study-cohort or standardized theta; assumed)
    return 50 + 10 * theta;
  }

  function domainDisplayName(key) {
    const k = String(key || "");
    // PROMIS keys often match
    if (k === "Physical_Function") return "Physical Function";
    if (k === "Participation") return "Social Roles";
    // SRS keys
    if (k === "SRS_Pain") return "SRS Pain";
    if (k === "SRS_Function") return "SRS Function";
    if (k === "SRS_Self_Image") return "SRS Self-Image";
    if (k === "SRS_Mental_Health") return "SRS Mental Health";
    if (k === "SRS_Satisfaction") return "SRS Satisfaction";
    return k.replace(/_/g, " ");
  }

  function computeTForDomain(resDomain) {
    // Prefer explicit t_score if present
    if (resDomain && typeof resDomain.t_score === "number" && isFinite(resDomain.t_score)) {
      return resDomain.t_score;
    }
    // Otherwise convert theta -> T
    if (resDomain && typeof resDomain.theta === "number" && isFinite(resDomain.theta)) {
      return computeTFromTheta(resDomain.theta);
    }
    return null;
  }

  function renderResults() {
    const results = readLS(LS_KEYS.results, null);
    if (!results) {
      setHTML(qs("#errorBox"), "No results found. Please complete the survey first.");
      return;
    }

    // results structure can vary by engine build; normalize
    const domains = results.domains || results.domain_results || results.results || {};
    const promWrap = qs("#promisTableBody");
    const srsWrap = qs("#srsTableBody");
    const srsOverall = qs("#srsOverallMean");

    const promRows = [];
    const srsRows = [];

    // Split PROMIS vs SRS by instrument or key prefix
    Object.keys(domains).forEach((k) => {
      const d = domains[k] || {};
      const instrument = (d.instrument || "").toUpperCase();
      const isSrs = instrument === "SRS" || k.startsWith("SRS_");
      const t = computeTForDomain(d);
      const disp = domainDisplayName(k);

      if (!isSrs) {
        const cat = inferPromisCategory(d.domain || disp, t);
        promRows.push({ domain: disp, t, cat, key: k, raw: d });
      } else {
        const cat = inferSrsCategory(t);
        // classic mean might be provided
        const classic = (typeof d.mean_1_5 === "number" && isFinite(d.mean_1_5)) ? d.mean_1_5 :
                        (typeof d.classic_mean === "number" && isFinite(d.classic_mean)) ? d.classic_mean :
                        null;
        srsRows.push({ domain: disp, t, classic, cat, key: k, raw: d });
      }
    });

    // Sort display order
    const promOrder = ["Anxiety", "Depression", "Fatigue", "Social Roles", "Physical Function"];
    promRows.sort((a, b) => promOrder.indexOf(a.domain) - promOrder.indexOf(b.domain));

    const srsOrder = ["SRS Function", "SRS Mental Health", "SRS Pain", "SRS Satisfaction", "SRS Self-Image"];
    srsRows.sort((a, b) => srsOrder.indexOf(a.domain) - srsOrder.indexOf(b.domain));

    // Render PROMIS
    if (promWrap) {
      promWrap.innerHTML = "";
      promRows.forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${r.domain}</td>
          <td>${r.t == null ? "—" : round1(r.t).toFixed(1)}</td>
          <td><span class="pill ${String(r.cat).toLowerCase().replace(/\s+/g, "-")}">${r.cat}</span></td>
          <td>${(String(r.domain).toLowerCase().includes("function") || String(r.domain).toLowerCase().includes("roles"))
            ? "Higher scores indicate BETTER function/ability."
            : "Higher scores indicate MORE of the symptom/problem."}</td>
        `;
        promWrap.appendChild(tr);
      });
    }

    // Render SRS
    if (srsWrap) {
      srsWrap.innerHTML = "";
      srsRows.forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${r.domain}</td>
          <td>${r.t == null ? "—" : round1(r.t).toFixed(1)}</td>
          <td>${r.classic == null ? "—" : round1(r.classic).toFixed(1)}</td>
          <td><span class="pill ${String(r.cat).toLowerCase().replace(/\s+/g, "-")}">${r.cat}</span></td>
          <td>Higher scores indicate BETTER status.</td>
        `;
        srsWrap.appendChild(tr);
      });
    }

    // Overall SRS mean (classic)
    if (srsOverall) {
      let overall = results.srs_overall_mean;
      if (overall == null || !isFinite(overall)) {
        // compute from available classic means (weighted equally across domains)
        const vals = srsRows.map(r => r.classic).filter(v => v != null && isFinite(v));
        if (vals.length) overall = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      setText(srsOverall, overall == null || !isFinite(overall) ? "—" : round1(overall).toFixed(1));
    }

    // >>> YOUR ORIGINAL FILE CONTENT CONTINUES HERE <<<
  }

  // -------------------------
  // Boot
  // -------------------------
  function boot() {
    if (isSurveyPage()) {
      initSurvey();
      return;
    }
    if (isResultsPage()) {
      try {
        renderResults();
      } catch (e) {
        console.error(e);
        setHTML(qs("#errorBox"), `Error: ${e.message || e}`);
      }
      return;
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();