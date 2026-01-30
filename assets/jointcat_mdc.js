
/* SpinePRO Joint-CAT (multidomain prototype)
   - Single combined item bank (PROMIS + SRS)
   - Content balancing across domains (ensure broad coverage)
   - Lightweight "full-browser" engine for deployment testing
   - IMPORTANT: Not validated; parameters are placeholders.
*/
(function(){
  const LS_KEY = "spinepro_jointcat_run_v1";

  function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }

  function uniq(arr){ return Array.from(new Set(arr)); }

  // Map a response (0..k-1) to a symmetric score roughly in [-2,2]
  function responseToScore(idx, k){
    if(!Number.isFinite(idx) || !Number.isFinite(k) || k<=1) return 0;
    const mid = (k-1)/2;
    const z = (idx - mid) / (mid || 1);
    return clamp(z*2, -2, 2);
  }

  function nowISO(){ return new Date().toISOString(); }

  async function fetchJSON(url){
    const resp = await fetch(url, { cache: "no-store" });
    if(!resp.ok) throw new Error("HTTP "+resp.status);
    return await resp.json();
  }

  function normalizeBank(bank){
    if(!bank || !Array.isArray(bank.items)) return bank;
    bank.items = bank.items.map(it=>{
      const x = Object.assign({}, it);
      if(!x.choices && Array.isArray(x.options)) x.choices = x.options.slice();
      if(!x.options && Array.isArray(x.choices)) x.options = x.choices.slice();
      // basic sanity: ensure k matches choices length
      if(Array.isArray(x.choices)){
        x.k = x.choices.length;
        if(Array.isArray(x.b) && x.b.length !== x.k-1){
          // don't crash; keep as-is, but mark
          x._warn = "threshold_count_mismatch";
        }
      }
      return x;
    });
    return bank;
  }

  async function loadBank(){
    // Prefer serverless API to avoid static-path / cache / MIME issues on Vercel
    try{
      const b = normalizeBank(await fetchJSON("/api/bank"));
      if(b && b.items && Array.isArray(b.items) && b.items.length>0) return b;
    }catch(e){}
    // Fallback to static JSON (still included)
    try{
      const b = normalizeBank(await fetchJSON("/assets/itembank_joint.json"));
      if(b && b.items && Array.isArray(b.items) && b.items.length>0) return b;
    }catch(e){}
    throw new Error("Could not load itembank.");
  }

  function buildState(bank){
    const domains = uniq(bank.items.map(it => it.domain)).filter(Boolean).sort();
    const theta = {};
    const sd = {};
    const n = {};
    domains.forEach(d => { theta[d]=0; sd[d]=1.0; n[d]=0; });

    return {
      bank,
      domains,
      theta,
      sd,
      n,
      answered: [], // {id, instrument, domain, item, responseLabel, responseIndex, k}
      askedIds: new Set(),
      step: 0,
      maxItems: 20,
      minPerDomain: 3,     // content balancing
      stopSd: 0.35         // stop when all domains hit this AND min coverage met
    };
  }

  function domainCoverageSatisfied(state){
    return state.domains.every(d => state.n[d] >= state.minPerDomain || state.bank.items.filter(it=>it.domain===d).length===0);
  }

  function stopSatisfied(state){
    if(state.step >= state.maxItems) return true;
    if(domainCoverageSatisfied(state)){
      const worst = Math.max(...state.domains.map(d => state.sd[d] ?? 1));
      if(worst <= state.stopSd && state.step >= Math.min(10, state.maxItems)) return true;
    }
    return false;
  }

  function chooseNextItem(state){
    const remaining = state.bank.items.filter(it => !state.askedIds.has(it.id));

    if(remaining.length === 0) return null;

    // Phase 1: ensure at least minPerDomain items per domain (content balancing)
    const needDomains = state.domains.filter(d => state.n[d] < state.minPerDomain);
    if(needDomains.length){
      // pick domain with most remaining items
      needDomains.sort((a,b) => remaining.filter(it=>it.domain===b).length - remaining.filter(it=>it.domain===a).length);
      const d = needDomains.find(x => remaining.some(it=>it.domain===x)) || needDomains[0];
      const cand = remaining.filter(it=>it.domain===d);
      cand.sort((a,b) => (b.a||1)-(a.a||1)); // highest discrimination proxy first
      return cand[0] || remaining[0];
    }

    // Phase 2: pick domain with highest uncertainty (sd), then pick most informative remaining item
    const domainOrder = [...state.domains].sort((a,b) => (state.sd[b]??1) - (state.sd[a]??1));
    for(const d of domainOrder){
      const cand = remaining.filter(it => it.domain===d);
      if(!cand.length) continue;
      cand.sort((a,b) => (b.a||1)-(a.a||1));
      return cand[0];
    }

    return remaining[0];
  }

  function updatePosterior(state, item, responseIndex){
    const d = item.domain || "GEN";
    const k = (item.choices && item.choices.length) ? item.choices.length : 5;
    const score = responseToScore(responseIndex, k);

    // Lightweight update: theta_d shifts toward higher severity/limitation based on response direction.
    // Directionality: PROMIS items typically higher = worse for PI/ANX/DEP/FAT, higher = better for PF/SR.
    // We use item.key_dir if present; else infer by domain.
    let dir = item.key_dir;
    if(dir !== 1 && dir !== -1){
      const betterHigh = ["PF","SR","SRS_Function"]; // treat higher response as worse limitation? Actually SRS options are "Never..Always" often worse with higher.
      // We'll default: higher category index => worse for most items EXCEPT PF/SR where higher => more limitation too in PROMIS wording.
      // To avoid wrong signs, keep neutral: all domains increase theta with higher category index (more severe).
      dir = 1;
    }

    const stepSize = 0.35;
    state.theta[d] = clamp((state.theta[d] ?? 0) + dir * stepSize * score, -4, 4);

    state.n[d] = (state.n[d] ?? 0) + 1;
    // posterior sd decreases with n; keep a floor
    state.sd[d] = clamp(1.0 / Math.sqrt(state.n[d] + 0.5), 0.25, 1.2);
  }

  function overallTheta(state){
    const vals = state.domains.map(d => state.theta[d] ?? 0);
    if(!vals.length) return 0;
    return vals.reduce((a,b)=>a+b,0)/vals.length;
  }
  function overallSD(state){
    const vals = state.domains.map(d => state.sd[d] ?? 1);
    if(!vals.length) return 1;
    return Math.max(...vals);
  }

  function saveRun(state){
    const payload = {
      completed: nowISO(),
      step: state.step,
      maxItems: state.maxItems,
      theta: state.theta,
      sd: state.sd,
      n: state.n,
      answered: state.answered
    };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  }

  function readRun(){
    try{
      const raw = localStorage.getItem(LS_KEY);
      if(!raw) return null;
      return JSON.parse(raw);
    }catch(e){ return null; }
  }

  function setText(id, txt){
    const el = document.getElementById(id);
    if(el) el.textContent = txt;
  }
  function setHTML(id, html){
    const el = document.getElementById(id);
    if(el) el.innerHTML = html;
  }

  function renderChoices(state, item){
    const choicesEl = document.getElementById("choices");
    if(!choicesEl) return;
    choicesEl.innerHTML = "";

    const choices = (item.choices && item.choices.length) ? item.choices : ((item.options && item.options.length) ? item.options : ["Not at all","A little bit","Somewhat","Quite a bit","Very much"]);
    choices.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        // record
        state.askedIds.add(item.id);
        state.answered.push({
          id: item.id,
          instrument: item.instrument || "",
          domain: item.domain || "",
          item: item.stem || item.item || "",
          responseLabel: label,
          responseIndex: idx,
          k: choices.length
        });
        updatePosterior(state, item, idx);
        state.step += 1;

        // Next or finish
        if(stopSatisfied(state)){
          saveRun(state);
          window.location.href = "/results_joint.html";
          return;
        }
        const next = chooseNextItem(state);
        if(!next){
          saveRun(state);
          window.location.href = "/results_joint.html";
          return;
        }
        renderQuestion(state, next);
      });
      choicesEl.appendChild(btn);
    });
  }

  function renderQuestion(state, item){
    setText("statusBadge", "In progress");
    setText("countBadge", `${state.step}/${state.maxItems} items`);
    setText("domainBadge", `Domain: ${item.domain || "—"}`);
    setText("questionText", item.stem || item.item || "—");

    const pct = Math.round((state.step/state.maxItems)*100);
    const fill = document.getElementById("progressFill");
    if(fill) fill.style.width = `${pct}%`;

    setText("theta", overallTheta(state).toFixed(2));
    setText("sd", overallSD(state).toFixed(2));

    renderChoices(state, item);
  }

  async function startSurvey(){
    // Only run on survey page
    if(!document.getElementById("questionText")) return;

    const restartBtn = document.getElementById("restartBtn");
    const finishBtn = document.getElementById("finishBtn");

    if(restartBtn){
      restartBtn.addEventListener("click", () => {
        localStorage.removeItem(LS_KEY);
        window.location.reload();
      });
    }
    if(finishBtn){
      finishBtn.addEventListener("click", () => {
        // allow finishing even if incomplete
        // create minimal run from whatever is in memory if present
        try{
          saveRun(window.__JOINTCAT_STATE__);
        }catch(e){}
        window.location.href = "/results_joint.html";
      });
    }

    try{
      setText("statusBadge", "Loading bank…");
      const bank = await loadBank();
      const state = buildState(bank);
      window.__JOINTCAT_STATE__ = state;

      // First item: pick from domain needing coverage, otherwise uncertainty
      const first = chooseNextItem(state);
      if(!first) throw new Error("Bank has no items.");
      renderQuestion(state, first);
    }catch(e){
      setText("statusBadge", "Error");
      setText("questionText", (e && e.message) ? e.message : "Could not load itembank.");
      setHTML("choices", "");
      setText("domainBadge", "Domain: —");
      setText("theta", "—");
      setText("sd", "—");
    }
  }

  function domainLabel(d){
    // Friendlier labels
    const map = {
      PF: "Physical Function (PROMIS)",
      PI: "Pain Interference (PROMIS)",
      SR: "Ability to Participate (PROMIS)",
      FAT: "Fatigue (PROMIS)",
      ANX: "Anxiety (PROMIS)",
      DEP: "Depression (PROMIS)",
      GEN: "General / Other",
      SRS_Function: "SRS-22 Function/Activity",
      SRS_Pain: "SRS-22 Pain",
      SRS_SelfImage: "SRS-22 Self-Image",
      SRS_Mental: "SRS-22 Mental Health",
      SRS_Satisfaction: "SRS-22 Satisfaction"
    };
    return map[d] || d;
  }

  function categoryFromT(T, d){
    // Very rough: higher T = worse for symptom domains; for PF/SR higher = better in PROMIS, but we treat as proxy only.
    if(!Number.isFinite(T)) return "Not assessed";
    if(T < 40) return "Low";
    if(T < 55) return "Average";
    if(T < 65) return "Elevated";
    return "High";
  }

  function interpretation(d){
    // keep neutral wording since sign not finalized
    return "Prototype score (T = 50 + 10·theta). Directionality not finalized.";
  }

  function renderResults(){
    const run = readRun();
    const top = document.getElementById("topBadges");
    const summary = document.getElementById("summaryTable");
    const answered = document.getElementById("answeredTable");

    if(!top || !summary || !answered) return;

    if(!run){
      top.innerHTML = `<span class="badge">No saved run found</span>`;
      summary.innerHTML = `<div class="small">Take the survey first, then return here.</div>`;
      answered.innerHTML = "";
      return;
    }

    const allDomains = Object.keys(run.theta || {}).sort();
    const overallT = 50 + 10 * (allDomains.map(d=>run.theta[d]||0).reduce((a,b)=>a+b,0)/(allDomains.length||1));

    const badgeHTML = [
      `<span class="badge">Overall T (proxy): <b>${overallT.toFixed(1)}</b></span>`,
      `<span class="badge">Worst SD: <b>${Math.max(...allDomains.map(d=>run.sd[d]??1)).toFixed(2)}</b></span>`,
      `<span class="badge">Items answered: <b>${(run.answered||[]).length}</b></span>`,
      `<span class="badge">Completed: <b>${run.completed || "—"}</b></span>`
    ].join(" ");
    top.innerHTML = badgeHTML;

    // Summary table includes ALL domains in the bank file, even if n=0
    let rows = "";
    allDomains.forEach(d => {
      const n = (run.n && run.n[d]) ? run.n[d] : 0;
      const theta = (run.theta && Number.isFinite(run.theta[d])) ? run.theta[d] : null;
      const T = (theta===null) ? null : (50 + 10*theta);
      rows += `<tr>
        <td>${d}</td>
        <td>${domainLabel(d)}</td>
        <td>${n ? T.toFixed(1) : "—"}</td>
        <td>${n ? categoryFromT(T,d) : "Not assessed"}</td>
        <td class="small">${n ? interpretation(d) : "No items administered for this domain in this run."}</td>
      </tr>`;
    });

    summary.innerHTML = `<table>
      <thead><tr>
        <th>Domain</th><th>Label</th><th>T-score (proxy)</th><th>Category</th><th>Interpretation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    // Answered items
    const ans = run.answered || [];
    let arows = "";
    ans.forEach((x, i) => {
      arows += `<tr>
        <td>${i+1}</td>
        <td>${x.instrument || ""}</td>
        <td>${x.domain || ""}</td>
        <td>${(x.item || "").replace(/</g,"&lt;")}</td>
        <td>${x.responseLabel || ""}</td>
      </tr>`;
    });
    answered.innerHTML = `<table>
      <thead><tr><th>#</th><th>Instrument</th><th>Domain</th><th>Item</th><th>Response</th></tr></thead>
      <tbody>${arows || `<tr><td colspan="5" class="small">No items recorded.</td></tr>`}</tbody>
    </table>`;
  }

  window.JOINTCAT = { startSurvey, renderResults };
  // Auto-start on survey page
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", startSurvey);
  }else{
    startSurvey();
  }
})();
