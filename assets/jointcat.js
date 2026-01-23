(function(){
  const BANK_URL = "./assets/itembank_joint.json";
  const APP_VERSION = "clean-deploy-v3";
  const STORAGE_KEY = "spinepro_jointcat_last_run_v1";

  function $(id){ return document.getElementById(id); }
  function sigmoid(x){ return 1/(1+Math.exp(-x)); }

  // GRM category probabilities
  function grmProbs(theta, a, b){
    const K = b.length + 1;
    const Pge = new Array(K+2).fill(0); // 1..K+1
    Pge[1] = 1.0;
    for(let k=2;k<=K;k++){
      const bk = b[k-2];
      Pge[k] = sigmoid(a*(theta - bk));
    }
    Pge[K+1] = 0.0;
    const P = new Array(K+1).fill(0);
    for(let k=1;k<=K;k++){
      P[k] = Math.max(1e-12, Pge[k]-Pge[k+1]);
    }
    return P; // 1..K
  }

  function expectedAndVar(theta, item){
    const P = grmProbs(theta, item.a, item.b);
    const K = item.b.length + 1;
    let mu=0, v=0;
    for(let k=1;k<=K;k++){ mu += k*P[k]; }
    for(let k=1;k<=K;k++){ v += (k-mu)*(k-mu)*P[k]; }
    return {mu, v, P};
  }

  function itemInfoApprox(theta, item){
    // quick, robust proxy: a^2 * Var(score | theta)
    const ev = expectedAndVar(theta, item);
    return (item.a*item.a) * ev.v;
  }

  // EAP update on grid
  function eapEstimate(itemsAnswered){
    const gridMin=-4, gridMax=4, N=161;
    const prior = (t)=> Math.exp(-0.5*t*t);
    const grid = [];
    for(let i=0;i<N;i++){
      grid.push(gridMin + (gridMax-gridMin)*i/(N-1));
    }
    const logPost = grid.map(t => Math.log(prior(t)));
    for(const ans of itemsAnswered){
      for(let i=0;i<N;i++){
        const t = grid[i];
        const P = grmProbs(t, ans.a, ans.b);
        const p = P[ans.k] || 1e-12;
        logPost[i] += Math.log(p);
      }
    }
    const maxLP = Math.max(...logPost);
    const w = logPost.map(lp => Math.exp(lp-maxLP));
    let sumW=0, mean=0;
    for(let i=0;i<N;i++){ sumW += w[i]; mean += w[i]*grid[i]; }
    mean /= (sumW||1);
    // NOTE: do not use identifier `var` (reserved keyword in JS).
    let variance=0;
    for(let i=0;i<N;i++){ variance += w[i]*(grid[i]-mean)*(grid[i]-mean); }
    variance /= (sumW||1);
    return {theta: mean, se: Math.sqrt(Math.max(variance, 1e-6))};
  }

  function inferInstrument(stem){
    const s = (stem||"").toLowerCase();
    // heuristic: SRS tends to have appearance, trunk, clothes, management/satisfaction, self-image, treatment
    const srsKeys = ["trunk","clothes","appearance","management","satisfied","treatment","self","image","brace","operation","surgery","back as it is"];
    for(const k of srsKeys){ if(s.includes(k)) return "SRS"; }
    return "PROMIS";
  }

  function inferDomain(stem){
    const s = (stem||"").toLowerCase();
    if(s.includes("fatigue") || s.includes("tired") || s.includes("energy") || s.includes("exhaust")) return "FAT";
    if(s.includes("pain") || s.includes("hurt") || s.includes("ache")) return "PI";
    if(s.includes("depress") || s.includes("unhappy") || s.includes("hopeless") || s.includes("sad")) return "DEP";
    if(s.includes("anx") || s.includes("nervous") || s.includes("fear") || s.includes("worry")) return "ANX";
    if(s.includes("physical") || s.includes("walk") || s.includes("run") || s.includes("stairs") || s.includes("carry") || s.includes("bend") || s.includes("stand")) return "PF";
    if(s.includes("social") || s.includes("family") || s.includes("work") || s.includes("friends") || s.includes("roles")) return "SR";
    if(inferInstrument(stem)==="SRS") return "SRS";
    return "GEN";
  }
  async function loadBank(){
    // Prefer embedded bank (avoids path/routing issues on static hosts)
    const embedded = document.getElementById("itembank-json");
    if (embedded && embedded.textContent && embedded.textContent.trim().length > 0) {
      return JSON.parse(embedded.textContent);
    }
    const res = await fetch(BANK_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("bank fetch failed");
    return await res.json();
  }

  function renderItem(state, item){
    $("status").textContent = "In progress";
    $("progress").textContent = `${state.asked.length}/${state.maxItems} items`;
    $("domain").textContent = `Domain: ${item.domain}`;
    $("theta").textContent = state.theta.toFixed(2);
    $("se").textContent = state.se.toFixed(2);
    $("stem").textContent = item.stem;

    const optionsDiv = $("options");
    optionsDiv.innerHTML = "";
    item.options.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.className = "opt";
      btn.textContent = label;
      btn.onclick = ()=> handleResponse(state, item, idx+1, label);
      optionsDiv.appendChild(btn);
    });
  }

  function stopRule(state){
    const minItems = 8;
    return (state.asked.length >= state.maxItems) || (state.asked.length>=minItems && state.se <= 0.35);
  }

  function chooseNextItem(state){
    const remaining = state.bank.filter(it => !state.askedIds.has(it.id));
    if(remaining.length===0) return null;

    // soft balancing: alternate SRS vs PROMIS early
    const needInstrument = (state.asked.length<10)
      ? (state.asked.length%2===0 ? "SRS" : "PROMIS")
      : null;

    let best=null, bestInfo=-1;
    for(const it of remaining){
      if(needInstrument && it.instrument!==needInstrument) continue;
      const info = itemInfoApprox(state.theta, it);
      if(info>bestInfo){ bestInfo=info; best=it; }
    }
    if(!best){
      // fallback overall best
      for(const it of remaining){
        const info = itemInfoApprox(state.theta, it);
        if(info>bestInfo){ bestInfo=info; best=it; }
      }
    }
    return best;
  }

  function persistRun(state){
    const payload = {
      completedAt: new Date().toISOString(),
      theta: state.theta,
      se: state.se,
      itemsAnswered: state.asked.map(a => ({
        instrument: a.instrument,
        domain: a.domain,
        stem: a.stem,
        response: a.label,
        k: a.k
      }))
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function handleResponse(state, item, k, label){
    state.askedIds.add(item.id);
    state.asked.push({
      id: item.id,
      stem: item.stem,
      instrument: item.instrument,
      domain: item.domain,
      a: item.a, b: item.b,
      k, label
    });

    const est = eapEstimate(state.asked);
    state.theta = est.theta;
    state.se = est.se;

    if(stopRule(state)){
      persistRun(state);
      window.location.href = "./results_joint.html";
      return;
    }
    const next = chooseNextItem(state);
    if(!next){
      persistRun(state);
      window.location.href = "./results_joint.html";
      return;
    }
    renderItem(state, next);
  }

  function setupButtons(){
    const restart = $("btnRestart");
    if(restart) restart.onclick = ()=> window.location.href = "./survey_joint.html?restart=1";
    const finish = $("btnFinish");
    if(finish) finish.onclick = ()=> {
      // allow early finish
      const run = localStorage.getItem(STORAGE_KEY);
      if(!run){
        // store partial if any
      }
      window.location.href = "./results_joint.html";
    };
  }

  async function main(){
    setupButtons();
    $("status").textContent = "Loading bank…";
    try{
      const items = await loadBank();
      const state = {
        bank: items,
        asked: [],
        askedIds: new Set(),
        theta: 0.0,
        se: 1.0,
        maxItems: 15
      };
      const first = chooseNextItem(state);
      if(!first) throw new Error("Bank empty.");
      renderItem(state, first);
    }catch(err){
      console.error(err);
      $("status").textContent = "Error";
      $("stem").textContent = "Could not load itembank. Check console/network and the /assets/itembank_joint.json path.";
      $("options").innerHTML = "";
    }
  }

  document.addEventListener("DOMContentLoaded", main);
})();