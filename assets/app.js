/* SpinePRO CAT runtime (no jQuery)
 * - Fixes "$ is not defined"
 * - Safe JSON parsing (strips BOM; replaces NaN/Infinity tokens)
 * - Works with cleanUrls (/survey,/results) OR falls back to survey.html/results.html
 * - Requires cat_engine.js to expose a CAT engine factory/class (see makeEngine()).
 */

(function () {
  "use strict";

  const PATHS = {
    bank: "/assets/itembank_runtime.json",
    constraints: "/assets/pair_exclusion_constraints_RUNTIME.json",
    norms: "/assets/domain_norms_REAL.json",
    policy: "/assets/frozen_cat_policy.json",
    version: "/assets/version.json",
  };

  const LS_KEYS = {
    session: "spinepro_cat_session_v1",
    results: "spinepro_cat_results_v1",
  };

  // -------------------------
  // Utilities
  // -------------------------
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

  function setStatus(msg) {
    const el = document.querySelector('[data-role="status"]');
    if (el) el.textContent = msg;
  }


  async function loadJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Failed to load JSON (${res.status}): ${url}`);
    }
    const txt = await res.text();
    return safeJSONParse(txt, url);
  }

  function stripBOM(s) {
    // BOM is \uFEFF
    if (!s) return s;
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  }

  function safeJSONParse(text, urlForError) {
    const raw = stripBOM(String(text || ""));
    // Replace bare tokens NaN / Infinity / -Infinity with null
    // (valid JSON does not allow these)
    const cleaned = raw
      .replace(/\bNaN\b/g, "null")
      .replace(/\bInfinity\b/g, "null")
      .replace(/\b-Infinity\b/g, "null");

    try {
      return JSON.parse(cleaned);
    } catch (e) {
      const first = cleaned.slice(0, 220).replace(/\s+/g, " ");
      throw new Error(`Invalid JSON at ${urlForError}. First chars: ${first}`);
    }
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  }

  async function fetchJSON(url) {
    const text = await fetchText(url);
    return safeJSONParse(text, url);
  }

  function routeTo(pathNoExt, fallbackHtml) {
    // If cleanUrls works: /survey, /results
    // Otherwise: /survey.html, /results.html
    // We try cleanUrl first.
    try {
      window.location.href = pathNoExt;
    } catch {
      window.location.href = fallbackHtml;
    }
  }

  function resetSession() {
    localStorage.removeItem(LS_KEYS.session);
    localStorage.removeItem(LS_KEYS.results);
  }

  // -------------------------
  // Engine adapter
  // -------------------------
  function makeEngine({ bank, constraints, policy, norms }) {
    // Support a few possible exports from cat_engine.js
    // 1) window.JointCATEngine (constructor)
    if (typeof window.JointCATEngine === "function") {
      return new window.JointCATEngine({ bank, constraints, policy, norms });
    }
    // 2) window.createJointCATEngine (factory)
    if (typeof window.createJointCATEngine === "function") {
      return window.createJointCATEngine({ bank, constraints, policy, norms });
    }
    // 3) window.CATEngine (constructor)
    if (typeof window.CATEngine === "function") {
      return new window.CATEngine({ bank, constraints, policy, norms });
    }

    throw new Error(
      "CAT engine not found. cat_engine.js must define window.JointCATEngine (class) or window.createJointCATEngine (factory)."
    );
  }

  // Normalized methods we use. If your engine uses different names,
  // this wrapper maps safely or throws a helpful error.
  function engineAPI(engine) {
    const api = {};

    api.start = () => {
      if (typeof engine.start === "function") return engine.start();
      // if no explicit start, ok
      return null;
    };

    api.getNextItem = () => {
      if (typeof engine.nextItem === "function") return engine.nextItem();
      if (typeof engine.getNextItem === "function") return engine.getNextItem();
      if (typeof engine.next === "function") return engine.next();
      throw new Error("Engine missing nextItem()/getNextItem().");
    };

    api.answer = (itemId, choiceIndex) => {
      if (typeof engine.answer === "function") return engine.answer(itemId, choiceIndex);
      if (typeof engine.submit === "function") return engine.submit(itemId, choiceIndex);
      throw new Error("Engine missing answer()/submit().");
    };

    api.isFinished = () => {
      if (typeof engine.isFinished === "function") return engine.isFinished();
      if (typeof engine.finished === "function") return engine.finished();
      if (typeof engine.shouldStop === "function") return engine.shouldStop();
      // if engine exposes status
      if (engine.state && typeof engine.state.finished === "boolean") return engine.state.finished;
      return false;
    };

    api.getProgress = () => {
      // Best-effort progress
      let nAnswered =
        (engine.state && (engine.state.nAnswered || engine.state.n_answered)) ||
        engine.nAnswered ||
        engine.n_answered ||
        0;

      // If engine exposes internal session (createJointCATEngine does), use it for accurate counts.
      try {
        if ((!nAnswered || nAnswered === 0) && typeof engine._getSession === "function") {
          const s = engine._getSession();
          if (s && Array.isArray(s.administered)) nAnswered = s.administered.length;
        }
      } catch (_) {}

      const maxItems =
        (engine.policy && engine.policy.max_items) ||
        (engine.config && engine.config.max_items) ||
        (engine.bank && engine.bank.cat_config && engine.bank.cat_config.max_items) ||
        null;

      return { nAnswered, maxItems };
    };

    api.getResults = () => {
      if (typeof engine.getResults === "function") return engine.getResults();
      if (typeof engine.results === "function") return engine.results();
      if (engine.state && engine.state.results) return engine.state.results;
      // At minimum, dump state
      return { state: engine.state || null };
    };

    api.serialize = () => {
      // Get the actual session with theta values
      if (typeof engine._getSession === "function") {
        const session = engine._getSession();
        if (session) {
          console.log("api.serialize: Returning session from _getSession, theta:", session.theta);
          return session;
        }
      }
      if (typeof engine.serialize === "function") return engine.serialize();
      if (engine.state) return JSON.parse(JSON.stringify(engine.state));
      return null;
    };

    return api;
  }

  // -------------------------
  // Pages
  // -------------------------
  async function initIndex() {
    // index.html uses data-role="startBtn" and data-role="resetBtn".
    // Older builds used data-role="start"/"reset".
    // Support both so the button always works.
    const startBtn =
      document.querySelector('[data-role="startBtn"]') ||
      document.querySelector('[data-role="start"]') ||
      document.querySelector('#btnStart');

    const resetBtn =
      document.querySelector('[data-role="resetBtn"]') ||
      document.querySelector('[data-role="reset"]') ||
      document.querySelector('#btnReset');

    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        resetSession();
        setStatus("Session cleared.");
      });
    }

    // Warm-load JSON so Start is instant and we catch JSON errors early
    try {
      setStatus("Loading item bank…");
      await fetchJSON(PATHS.bank);
      setStatus("Ready.");
    } catch (e) {
      console.error(e);
      setStatus(String(e.message || e));
      return;
    }

    if (startBtn) {
      startBtn.addEventListener("click", () => {
        // Initialize session marker
        localStorage.setItem(
          LS_KEYS.session,
          JSON.stringify({ startedAt: new Date().toISOString(), version: "v1" })
        );
        routeTo("/survey", "/survey.html");
      });
    }
  }

  function renderSurveyShell() {
    // survey.html provides the full shell. Keep fallback if someone navigates directly without it.
    const root = document.querySelector('[data-role="surveyRoot"]') || document.body;
    if (!document.querySelector('[data-role="qstem"]')) {
      root.innerHTML = `
        <main class="wrap"><section class="card">
          <div class="qLead" data-role="qlead"></div>
          <div class="qStem" data-role="qstem"></div>
          <div class="options" data-role="options"></div>
          <div class="muted" data-role="progress"></div>
          <button class="btn secondary" data-role="quit">Quit</button>
          <div class="status" data-role="status"></div>
        </section></main>`;
    }
  }


  function setProgressText(n, maxItems) {
    const el = document.querySelector('[data-role="progress"]');
    const pctEl = document.querySelector('[data-role="progressPct"]');
    const ring = document.querySelector('[data-role="progressRing"]');
    if (el) el.textContent = "";
    if (maxItems && pctEl && ring) {
      const pct = Math.max(0, Math.min(100, Math.round(100 * (n / maxItems))));
      pctEl.textContent = `${pct}%`;
      ring.style.setProperty('--pct', `${pct}%`);
    }
  }


  function renderItem(item, onAnswer) {
    const stemEl = document.querySelector('[data-role="qstem"]');
    const optEl = document.querySelector('[data-role="options"]');
    if (!stemEl || !optEl) return;

    const domain = item.domain || item.dimension || "";
    const stemRaw = String(item.stem || item.question || item.item_text || item.label || "(missing stem)").trim();

    // Normalize lead-in wording (display only)
    const stemNorm = stemRaw.replace(/^In the past 7 days/i, "In the last 7 days");

    // PROMIS 7-day lead-in: ONLY for Anxiety, Depression, Fatigue, Pain Interference
    // NOT for Physical Function or Participation (Social Roles)
    // Merge lead-in directly into stem text (not separate element)
    const needs7dLeadIn = ["Anxiety","Depression","Fatigue","Pain_Interference"].includes(domain);
    const has7d = /^in the (last|past) 7 days/i.test(stemNorm);
    const fullStem = (needs7dLeadIn && !has7d)
      ? "In the last 7 days, " + stemNorm
      : stemNorm;

    stemEl.textContent = fullStem;

    optEl.innerHTML = "";

    const opts = item.response_options || item.options || [];
    if (!Array.isArray(opts) || opts.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No response options found for this item.";
      optEl.appendChild(p);
      return;
    }

    opts.forEach((label, idx) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.type = "button";
      b.textContent = String(label);
      b.addEventListener("click", () => onAnswer(idx));
      optEl.appendChild(b);
    });
  }


  async function initSurvey() {
    renderSurveyShell();
    setStatus("Loading CAT…");

    let bank, constraints, norms, policy;
    try {
      [bank, constraints, norms, policy] = await Promise.all([
        fetchJSON(PATHS.bank),
        fetchJSON(PATHS.constraints).catch(() => ({})),
        fetchJSON(PATHS.norms).catch(() => ({})),
        fetchJSON(PATHS.policy),
      ]);

      // Expose loaded assets for debugging and for engine fallbacks
      window.ITEMBANK = bank;
      window.DOMAIN_NORMS = norms;
      window.CAT_CONSTRAINTS = constraints;
      window.CAT_POLICY = policy;
      // Some engine builds reference a global `policy` identifier.
      // Provide aliases so those builds do not throw `policy is not defined`.
      window.policy = policy;
      globalThis.policy = policy;
      window.__CAT_ASSETS__ = { bank, norms, constraints, policy };
    } catch (e) {
      console.error(e);
      setStatus(String(e.message || e));
      return;
    }

    let engine;
    try {
      engine = makeEngine({ bank, constraints, policy, norms });
    } catch (e) {
      console.error(e);
      setStatus(String(e.message || e));
      return;
    }

    const api = engineAPI(engine);

    try { api.start(); } catch (e) { /* ok */ }

    const quitBtn = document.querySelector('[data-role="quit"]');
    if (quitBtn) {
      quitBtn.addEventListener("click", () => {
        routeTo("/", "/index.html");
      });
    }

    async function step() {
      if (api.isFinished()) {
        let results = api.getResults();
        // Normalize: engine may return session or results object
        if (results && results.results && (results.results.domain_results || results.results.domains)) results = results.results;
        if (results && results.domain_results == null && results.domains == null && results.results && (results.results.domain_results || results.results.domains)) results = results.results;
        localStorage.setItem(LS_KEYS.results, JSON.stringify(results));
        routeTo("/results", "/results.html");
        return;
      }

      const prog = api.getProgress();
      setProgressText(prog.nAnswered || 0, prog.maxItems || (bank && bank.cat_config && bank.cat_config.max_items) || (policy && policy.max_items) || 18);

      let item;
      try {
        item = api.getNextItem();
      } catch (e) {
        console.error(e);
        setStatus(String(e.message || e));
        return;
      }

      // Expect the engine to return an item object; if it returns an id, look it up
      if (typeof item === "string") {
        item = (bank.items && bank.items[item]) ? bank.items[item] : { item_text: `Item ${item}`, response_options: [] };
      }

      setStatus("");
      renderItem(item, (choiceIndex) => {
        try {
          api.answer(item.id || item.item_id || item.code || item.name, choiceIndex);
          // Persist engine session so SRS classic scoring can be computed on results.
          try {
            const snap = api.serialize();
            if (snap) localStorage.setItem(LS_KEYS.session, JSON.stringify(snap));
          } catch (e2) { /* ignore */ }
        } catch (e) {
          console.error(e);
          setStatus(String(e.message || e));
          return;
        }
        step();
      });
    }

    setStatus("Ready.");
    step();
  }

  
  function renderResults(results, bankForScoring) {
    // Prefer structured results UI (results.html) if present.
    const promisHost = document.querySelector('[data-role="promisTable"]');
    const srsHost = document.querySelector('[data-role="srsTable"]');
    const footerNote = document.querySelector('[data-role="footerNote"]');
    const metaHost = document.querySelector('[data-role="resultsMeta"]'); // optional
    const legacyRoot = document.querySelector('[data-role="resultsRoot"]') || document.body;

    // Normalize domain rows from engine results (support multiple shapes)
    const src = (results && results.results && (results.results.domain_results || results.results.domains)) ? results.results : results;

    const domainArr = src && (Array.isArray(src.domain_results) ? src.domain_results : null);
    const domainObj = src && (!Array.isArray(src.domains) && typeof src.domains === "object") ? src.domains : null;

    const rows = [];
    if (domainArr) {
      for (const d of domainArr) {
        const name = d.domain ?? d.name ?? "";
        const theta = toNumber(d.theta);
        const tRaw = toNumber(d.t_score ?? d.tScore ?? d.t);
        const t = (tRaw !== null) ? tRaw : (theta !== null ? (50 + 10*theta) : null);
        rows.push({ name, theta, t });
      }
    } else if (domainObj) {
      for (const [name, v] of Object.entries(domainObj)) {
        const theta = toNumber(v.theta);
        const tRaw = toNumber(v.t_score ?? v.tScore ?? v.t);
        const t = (tRaw !== null) ? tRaw : (theta !== null ? (50 + 10*theta) : null);
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
    // Fallback: if session snapshot is missing, derive administered responses from results payload
    const itemsAdmin = (src && Array.isArray(src.items_administered)) ? src.items_administered : ((results && Array.isArray(results.items_administered)) ? results.items_administered : []);
    if ((!administered || administered.length === 0) && itemsAdmin && itemsAdmin.length) {
      administered = itemsAdmin.map(x => ({
        item_id: x.item_id || x.id || x.code,
        domain: x.domain || "",
        // In items_administered, "response" is often a label; keep it in response_label
        response: (typeof x.response === "number") ? x.response : null,
        response_label: (typeof x.response === "string") ? x.response : (x.response != null ? String(x.response) : null)
      }));
    }

    const PROMIS_FUNCTION_DOMAINS = new Set(["Physical_Function", "Participation"]);
    const PROMIS_LABELS = {
      Anxiety: "Anxiety",
      Depression: "Depression",
      Fatigue: "Fatigue",
      Pain_Interference: "Pain Interference",
      Participation: "Social Roles",
      Physical_Function: "Physical Function"
    };
    const SRS_LABELS = {
      SRS_Pain: "SRS Pain",
      SRS_Self_Image: "SRS Self-Image",
      SRS_Function: "SRS Function",
      SRS_Mental_Health: "SRS Mental Health",
      SRS_Satisfaction: "SRS Satisfaction"
    };

    function toNumber(x){
      if (typeof x === "number" && Number.isFinite(x)) return x;
      if (typeof x === "string") {
        const s = x.trim();
        if (!s) return null;
        const n = Number(s);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }

    function fmt1(x){ const n = toNumber(x); return (n !== null) ? n.toFixed(1) : ""; }

    // PROMIS category + interpretation
    // Official PROMIS T-score thresholds (from PROMIS scoring manuals):
    // Symptom domains (Anxiety, Depression, Fatigue, Pain Interference):
    //   < 55        = None to Slight
    //   55.0-59.9   = Mild
    //   60.0-69.9   = Moderate
    //   ≥ 70        = Severe
    // Function domains (Physical Function, Social Roles):
    //   > 55        = None to Slight
    //   50.0-54.9   = Mild
    //   40.0-49.9   = Moderate
    //   < 40        = Severe
    function promisCategory(domain, t){
      const tt = toNumber(t);
      if (tt === null) return "";
      const isFunction = PROMIS_FUNCTION_DOMAINS.has(domain);
      if (!isFunction) {
        // Symptom domains: higher = MORE of the symptom/problem
        if (tt >= 70) return "Severe";
        if (tt >= 60) return "Moderate";
        if (tt >= 55) return "Mild";
        return "None to Slight";
      } else {
        // Function domains: higher = BETTER function/ability
        if (tt > 55) return "None to Slight";
        if (tt >= 50) return "Mild";
        if (tt >= 40) return "Moderate";
        return "Severe";
      }
    }

function promisInterpretation(domain){
      const isFunction = PROMIS_FUNCTION_DOMAINS.has(domain);
      return isFunction
        ? "Higher scores indicate BETTER function/ability."
        : "Higher scores indicate MORE of the symptom/problem.";
    }

    // Build PROMIS table from rows (exclude SRS_* domains)
    const promisRows = rows
      .filter(r => r.name && !String(r.name).startsWith("SRS_"))
      .map(r => ({
        domain: PROMIS_LABELS[r.name] || r.name,
        t: r.t,
        cat: promisCategory(r.name, r.t),
        interp: promisInterpretation(r.name)
      }));

    // SRS domains - CAT-based, show T-scores just like PROMIS
    // Higher SRS scores = BETTER (function domains - same direction as Physical_Function/Participation)
    const SRS_FUNCTION_DOMAINS = new Set(["SRS_Function", "SRS_Mental_Health", "SRS_Pain", "SRS_Satisfaction", "SRS_Self_Image"]);

    function srsCategory(domain, t, mean){
      // Category driven by mean (1–5) when available — ensures mean and category always agree.
      // All SRS domains: 1=worst, 5=best. Same thresholds for all domains.
      // If mean not available, fall back to T-score.
      if (mean !== null && mean !== undefined && Number.isFinite(mean)) {
        if (mean >= 4.0) return "None to Slight";
        if (mean >= 3.0) return "Mild";
        if (mean >= 2.0) return "Moderate";
        return "Severe";
      }
      // T-score fallback (higher = better for SRS)
      const tt = toNumber(t);
      if (tt === null) return "";
      if (tt > 55) return "None to Slight";
      if (tt >= 50) return "Mild";
      if (tt >= 40) return "Moderate";
      return "Severe";
    }

    function srsInterpretation(domain){
      return "Higher scores indicate BETTER status.";
    }

    // Compute SRS domain means (1–5) from administered items for familiar clinical reference.
    // All SRS items: response_options[0] = BEST answer (displayed first).
    // The raw choiceIndex 0 = best option selected.
    // Mean scoring: 1 = worst, 5 = best.
    // Since opts[0] is always best: score = K - choiceIndex  (e.g. K=5: idx0→5, idx4→1)
    const srsMeanByDomain = {};
    for (const a of administered) {
      const dom = a.domain;
      if (!dom || !String(dom).startsWith("SRS_")) continue;
      const idx = typeof a.response === "number" && Number.isFinite(a.response) ? a.response : null;
      if (idx === null) continue;
      let K = 5;
      if (bankForScoring && bankForScoring.items && a.item_id && bankForScoring.items[a.item_id]) {
        const it = bankForScoring.items[a.item_id];
        K = it.K || it.n_categories || (it.thresholds ? it.thresholds.length + 1 : 5);
      }
      // opts[0] = best → score K; opts[K-1] = worst → score 1
      const val = K - idx;
      if (!srsMeanByDomain[dom]) srsMeanByDomain[dom] = { sum: 0, n: 0 };
      srsMeanByDomain[dom].sum += val;
      srsMeanByDomain[dom].n += 1;
    }

    // Build SRS rows from CAT theta results + add mean (1–5)
    const srsRows = rows
      .filter(r => r.name && String(r.name).startsWith("SRS_"))
      .map(r => {
        const agg = srsMeanByDomain[r.name];
        const mean = (agg && agg.n > 0) ? (agg.sum / agg.n) : null;
        return {
          domain: SRS_LABELS[r.name] || r.name,
          t: r.t,
          mean,
          cat: srsCategory(r.name, r.t, mean),
          interp: srsInterpretation(r.name)
        };
      });

    // Overall SRS mean across all administered SRS items
    const srsAllVals = Object.values(srsMeanByDomain);
    const srsTotalSum = srsAllVals.reduce((s,a) => s + a.sum, 0);
    const srsTotalN   = srsAllVals.reduce((s,a) => s + a.n, 0);
    const srsTotalMean = srsTotalN > 0 ? srsTotalSum / srsTotalN : null;

    const stop = results && results.stop_reason ? `Stop reason: ${results.stop_reason}` : null;
    const meta = results && typeof results.total_items === "number" ? `Items administered: ${results.total_items}` : null;
    const metaText = [stop, meta].filter(Boolean).join(" • ");

    // If results.html hosts are present, populate them. Otherwise, fallback to a minimal legacy view.
    if (promisHost && srsHost) {
      if (metaHost) metaHost.textContent = metaText;

      promisHost.innerHTML = promisRows.length ? `
        <table class="resultsTable">
          <thead>
            <tr>
              <th>Domain</th>
              <th>T-score</th>
              <th>Category</th>
              <th>Interpretation</th>
            </tr>
          </thead>
          <tbody>
            ${promisRows.map(r => `
              <tr>
                <td>${escapeHtml(r.domain)}</td>
                <td>${fmt1(r.t)}</td>
                <td><span class="pill ${r.cat === 'Severe' ? 'pill-severe' : r.cat === 'Moderate' ? 'pill-moderate' : r.cat === 'Mild' ? 'pill-mild' : 'pill-none'}">${escapeHtml(r.cat)}</span></td>
                <td>${escapeHtml(r.interp)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<div class="status">No PROMIS results found.</div>`;

      srsHost.innerHTML = srsRows.length ? `
        ${srsTotalMean !== null ? `
          <div class="srsTotal">
            <div><b>Overall SRS Mean (1–5)</b>: ${fmt1(srsTotalMean)} </div>
          </div>` : ''}
        <table class="resultsTable" style="margin-top:10px">
          <thead>
            <tr>
              <th>Domain</th>
              <th>T-score <span class="smallMuted">(CAT/IRT)</span></th>
              <th>Mean (1–5) <span class="smallMuted">(classic)</span></th>
              <th>Category</th>
              <th>Interpretation</th>
            </tr>
          </thead>
          <tbody>
            ${srsRows.map(r => `
              <tr>
                <td>${escapeHtml(r.domain)}</td>
                <td>${fmt1(r.t)}</td>
                <td>${r.mean !== null ? fmt1(r.mean) : '<span class="smallMuted">—</span>'}</td>
                <td><span class="pill ${r.cat === 'Severe' ? 'pill-severe' : r.cat === 'Moderate' ? 'pill-moderate' : r.cat === 'Mild' ? 'pill-mild' : 'pill-none'}">${escapeHtml(r.cat)}</span></td>
                <td>${escapeHtml(r.interp)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div class="smallMuted" style="margin-top:6px">T-score uses IRT theta (50 = population mean, SD = 10). Mean (1–5) is the traditional SRS-22r scale for clinical reference.</div>
      ` : `<div class="status">No SRS results found.</div>`;

      if (footerNote) {
        footerNote.innerHTML = `
          <div class="smallMuted">
            Note: This is an adaptive assessment. Only domains with scorable responses are displayed.
          </div>
        `;
      }
      return;
    }

    // Legacy fallback (shouldn't be used in the styled build)
    legacyRoot.innerHTML = `
      <div class="status">${escapeHtml(metaText || "")}</div>
      <pre style="white-space:pre-wrap">${escapeHtml(JSON.stringify(results || {}, null, 2))}</pre>
    `;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  
  function bindResultsActions() {
    const btnPdf = document.getElementById("btnPdf");
    const btnPrint = document.getElementById("btnPrint");
    const btnEmail = document.getElementById("btnEmail");
    const btnSubmitFinish = document.getElementById("btnSubmitFinish");

    if (btnPdf) btnPdf.addEventListener("click", () => {
      // Browser print dialog can be used to "Save as PDF"
      window.print();
    });
    if (btnPrint) btnPrint.addEventListener("click", () => window.print());
    if (btnSubmitFinish) btnSubmitFinish.addEventListener("click", () => {
      window.location.href = "https://texasspineandscoliosis.com/";
    });
    if (btnEmail) btnEmail.addEventListener("click", () => {
      let payload = null;
      try { payload = JSON.parse(localStorage.getItem(LS_KEYS.results) || "null"); } catch {}
      const subject = encodeURIComponent("PROMIS + SRS Assessment Results");
      const body = encodeURIComponent(payload ? JSON.stringify(payload, null, 2) : "Results unavailable.");
      window.location.href = `mailto:?subject=${subject}&body=${body}`;
    });
  }

async function initResults() {
    bindResultsActions();
    // Primary: render stored results
    let results = null;
    try {
      const raw = localStorage.getItem(LS_KEYS.results);
      results = raw ? JSON.parse(raw) : null;
    } catch {
      results = null;
    }
    if (results && (results.domain_results || results.domains || (results.results && (results.results.domain_results || results.results.domains)))) {
      // Load bank so we can compute SRS classic scoring direction reliably.
      loadJSON(PATHS.bank).then((bank)=>{
        renderResults(results, bank);
      }).catch(()=>{
        renderResults(results, null);
      });
      return;
    }

    // Fallback: rebuild results from stored session + answers (so refresh doesn't wipe outcomes)
    Promise.all([loadJSON(PATHS.bank), loadJSON(PATHS.norms)])
      .then(([bank, norms]) => {
        let session = null;
        try {
          const rawS = localStorage.getItem(LS_KEYS.session);
          session = rawS ? JSON.parse(rawS) : null;
        } catch {}
        if (!session) {
          renderResults({}, bank);
          return;
        }
        const engine = makeEngine(bank, norms, null);
        // If the session already contains results, use them
        if (session.results) {
          localStorage.setItem(LS_KEYS.results, JSON.stringify(session.results));
          renderResults(session.results, bank);
          return;
        }
        // Otherwise, try engine.getResults if exposed
        const res = (engine && typeof engine.getResults === "function") ? engine.getResults(session) : null;
        if (res) {
          localStorage.setItem(LS_KEYS.results, JSON.stringify(res));
          renderResults(res, bank);
        } else {
          renderResults({}, bank);
        }
      })
      .catch(() => renderResults({}, null));
  }

  function currentPage() {
    const p = window.location.pathname.toLowerCase();
    if (p === "/" || p.endsWith("/index.html")) return "index";
    if (p.endsWith("/survey") || p.endsWith("/survey.html")) return "survey";
    if (p.endsWith("/results") || p.endsWith("/results.html")) return "results";
    // cleanUrls sometimes serve /survey as directory index
    if (p.includes("survey")) return "survey";
    if (p.includes("results")) return "results";
    return "index";
  }

  // -------------------------
  // Boot
  // -------------------------
  window.addEventListener("DOMContentLoaded", () => {
    const page = currentPage();
    if (page === "index") initIndex();
    else if (page === "survey") initSurvey();
    else if (page === "results") initResults();
    else initIndex();
  });
})();
