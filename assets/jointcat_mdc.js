import { mulberry32, makeSeed } from "./rng.js";

/**
 * SpinePRO Joint-CAT (static) – multidomain CAT scaffold
 * - Content balancing: guarantees at least 1 item per "required domain" when possible
 * - Adaptive: selects next item by maximum Fisher information near current global theta (GRM/2PL)
 * - Variable length: stops when global posterior SD <= target, after minItems and coverage met
 *
 * IMPORTANT: Replace assets/itembank_joint.json with your full calibrated PROMIS + SRS bank.
 */

// ---------------- Config ----------------
const CFG = {
  bankUrl: "/assets/itembank_joint.json",
  minItems: 8,            // must ask at least this many before precision stop
  maxItems: 25,           // safety cap (variable length; can end earlier)
  targetOverallSD: 0.30,  // stop when SD is at/below this (after minItems & coverage)
  requiredDomains: null,  // null = infer all domains present in bank; or set an explicit list
  minPerDomain: 1,        // coverage pass: aim at least 1 per required domain (if bank supports)
  topNRandom: 5,          // randomize within top-N info items to avoid deterministic order
  priorMean: 0,
  priorSD: 1.0
};

// ---------------- DOM helpers ----------------
const $ = (id)=>document.getElementById(id);
function setText(id, v){ const el=$(id); if(el) el.textContent = v; }
function setWidth(id, pct){ const el=$(id); if(el) el.style.width = `${pct}%`; }

// ---------------- State ----------------
const state = {
  seed: makeSeed(),
  rng: null,
  bank: [],
  domains: [],
  requiredDomains: [],
  askedIds: new Set(),
  responses: [],  // [{id, domain, instrument, stem, responseIndex, responseLabel}]
  theta: 0,
  sd: 1,
  perDomain: new Map(), // domain -> {theta, sd, n}
  ready: false
};

// ---------------- IRT math ----------------

// logistic
function sigm(x){ return 1/(1+Math.exp(-x)); }

// GRM category probabilities given a,b[k] thresholds, m categories = k+1
// Returns p[0..m-1]
function grmProbs(theta, a, b){
  // b length = m-1 thresholds
  const m = b.length + 1;
  const Pstar = [];
  for(let k=0;k<b.length;k++){
    // P(Y >= k+1)
    Pstar[k] = sigm(a*(theta - b[k]));
  }
  // p0 = 1 - P*(1)
  const p = new Array(m).fill(0);
  p[0] = 1 - Pstar[0];
  for(let k=1;k<m-1;k++){
    p[k] = Pstar[k-1] - Pstar[k];
  }
  p[m-1] = Pstar[m-2];
  // clamp numeric
  for(let i=0;i<p.length;i++){
    p[i] = Math.max(1e-9, Math.min(1-1e-9, p[i]));
  }
  // renorm
  const s = p.reduce((x,y)=>x+y,0);
  for(let i=0;i<p.length;i++) p[i]/=s;
  return p;
}

// Expected Fisher information for GRM at theta via numerical approximation on log-likelihood
function grmInfo(theta, a, b){
  const p = grmProbs(theta, a, b);
  // Use score derivative approximation:
  // I(theta)=E[(d/dθ log P(Y=y))^2]
  const eps = 1e-4;
  const p2 = grmProbs(theta+eps, a, b);
  const dlog = p.map((pi, i)=> (Math.log(p2[i]) - Math.log(pi))/eps );
  let info = 0;
  for(let i=0;i<p.length;i++){
    info += p[i] * dlog[i]*dlog[i];
  }
  return Math.max(1e-8, info);
}

// 2PL probabilities and info (if item has scalar b)
function irt2plProbs(theta, a, b){
  const P = sigm(a*(theta - b));
  return [1-P, P];
}
function irt2plInfo(theta, a, b){
  const P = sigm(a*(theta - b));
  return Math.max(1e-8, a*a*P*(1-P));
}

// log-likelihood, first and second derivatives for MAP Newton updates
function itemDerivs(theta, item, y){
  const a = Number(item.a ?? 1);
  // GRM if thresholds array provided
  const thr = item.b;
  if(Array.isArray(thr) && thr.length>=1){
    const p = grmProbs(theta, a, thr);
    // numeric derivative on log p_y
    const eps = 1e-4;
    const p2 = grmProbs(theta+eps, a, thr);
    const p3 = grmProbs(theta-eps, a, thr);
    const logp = Math.log(p[y]);
    const d1 = (Math.log(p2[y]) - Math.log(p3[y]))/(2*eps);
    const d2 = (Math.log(p2[y]) - 2*logp + Math.log(p3[y]))/(eps*eps);
    return {d1, d2};
  }
  // 2PL fallback
  const b = Number(item.b ?? 0);
  const P = sigm(a*(theta-b));
  // y in {0,1}
  const d1 = a*(y - P);
  const d2 = -a*a*P*(1-P);
  return {d1, d2};
}

function mapEstimate(items, priorMean=0, priorSD=1){
  // items: [{item, yIndex}] where yIndex is category index (0..m-1)
  let theta = 0;
  // initialize at prior mean
  theta = priorMean;
  const priorVar = priorSD*priorSD;
  for(let iter=0; iter<25; iter++){
    let g = -(theta - priorMean)/priorVar;   // derivative log prior
    let H = -1/priorVar;                     // second derivative log prior
    for(const it of items){
      const {d1, d2} = itemDerivs(theta, it.item, it.y);
      g += d1;
      H += d2;
    }
    // Newton step
    const step = g / (H===0 ? -1e-6 : H);
    theta = theta - step;
    if(Math.abs(step) < 1e-3) break;
  }
  // posterior SD approx = 1/sqrt(-H)
  let Hfinal = -1/(priorVar);
  for(const it of items){
    const {d2} = itemDerivs(theta, it.item, it.y);
    Hfinal += d2;
  }
  const sd = Math.sqrt(1/Math.max(1e-8, -Hfinal));
  return {theta, sd};
}

function itemInfoAtTheta(item, theta){
  const a = Number(item.a ?? 1);
  if(Array.isArray(item.b)){
    return grmInfo(theta, a, item.b);
  }
  return irt2plInfo(theta, a, Number(item.b ?? 0));
}

// ---------------- Bank loading ----------------
async function loadBank(){
  const res = await fetch(CFG.bankUrl, {cache:"no-store"});
  if(!res.ok) throw new Error(`Bank fetch failed: ${res.status}`);
  const data = await res.json();
  const items = (data.items || data || []);
  // normalize
  const norm = items.map(x=>({
    id: x.id,
    instrument: x.instrument || "",
    domain: x.domain || "",
    stem: x.stem || x.item || "",
    choices: x.choices || x.options || ["No","Yes"],
    a: x.a ?? 1,
    b: x.b ?? 0
  })).filter(x=>x.id && x.domain && x.stem && Array.isArray(x.choices));
  if(norm.length === 0) throw new Error("No items found in bank.");
  return {version: data.version || "unknown", items: norm};
}

// ---------------- Selection logic ----------------
function uniq(arr){ return [...new Set(arr)]; }

function countsByDomain(){
  const m = new Map();
  for(const r of state.responses){
    m.set(r.domain, (m.get(r.domain)||0)+1);
  }
  return m;
}

function coverageDomainsNeeded(){
  const counts = countsByDomain();
  const needed = [];
  for(const d of state.requiredDomains){
    if((counts.get(d)||0) < CFG.minPerDomain) needed.push(d);
  }
  return needed;
}

function candidateItems(filterDomain=null){
  return state.bank.filter(it=>{
    if(state.askedIds.has(it.id)) return false;
    if(filterDomain && it.domain !== filterDomain) return false;
    return true;
  });
}

function pickNextItem(){
  const needed = coverageDomainsNeeded();
  let pool = [];
  let domainPicked = null;

  if(needed.length > 0){
    // Choose among needed domains: prefer the one with highest domain SD (uncertainty)
    // If no perDomain info yet, pick randomly among needed
    let bestD = null;
    let bestSD = -1;
    for(const d of needed){
      const info = state.perDomain.get(d);
      const sd = info?.sd ?? 999;
      if(sd > bestSD){ bestSD = sd; bestD = d; }
    }
    domainPicked = bestD;
    pool = candidateItems(domainPicked);
  } else {
    // Adaptive pass: choose item across all domains by information at current global theta
    pool = candidateItems(null);
  }

  if(pool.length === 0) return null;

  // Rank by information at theta
  const scored = pool.map(it=>({it, info:itemInfoAtTheta(it, state.theta)}));
  scored.sort((a,b)=> b.info - a.info);

  // Randomize within top-N to avoid deterministic order
  const N = Math.min(CFG.topNRandom, scored.length);
  const top = scored.slice(0, N);

  const r = state.rng();
  const pick = top[Math.floor(r * top.length)].it;

  return pick;
}

function stopNow(){
  const n = state.responses.length;
  const coverageDone = (coverageDomainsNeeded().length === 0);
  if(n === 0) return false;
  if(n >= CFG.maxItems) return true;
  if(n < CFG.minItems) return false;
  return coverageDone && (state.sd <= CFG.targetOverallSD);
}

// ---------------- Rendering ----------------
function renderQuestion(item){
  setText("statusPill", "In progress");
  setText("domainPill", `Domain: ${item.domain}`);
  setText("countPill", `${state.responses.length}/${CFG.maxItems} items (cap)`);
  setWidth("progressBar", Math.min(100, (state.responses.length/CFG.maxItems)*100));

  setText("questionText", item.stem);

  const choicesDiv = $("choices");
  choicesDiv.innerHTML = "";
  item.choices.forEach((label, idx)=>{
    const btn = document.createElement("button");
    btn.className = "choice";
    btn.textContent = label;
    btn.onclick = ()=> answerItem(item, idx, label);
    choicesDiv.appendChild(btn);
  });
}

function renderStats(){
  setText("thetaText", state.theta.toFixed(2));
  setText("sdText", state.sd.toFixed(2));
}

// ---------------- Run persistence & results ----------------
function tScoreProxy(theta){ return 50 + 10*theta; } // placeholder proxy
function interpretT(t){
  if(!isFinite(t)) return "—";
  if(t < 40) return "Low impact";
  if(t < 55) return "Within expected range";
  if(t < 65) return "Elevated impact";
  return "High / severe impact";
}

function saveRunAndGoResults(){
  const domains = [];
  for(const d of state.requiredDomains){
    const info = state.perDomain.get(d) || {theta: null, sd: null, n: 0};
    const t = (info.theta===null || info.theta===undefined) ? null : tScoreProxy(info.theta);
    domains.push({
      domain: d,
      instrument: (d.startsWith("SRS_") ? "SRS" : "PROMIS"),
      theta: info.theta,
      sd: info.sd,
      n: info.n,
      tScoreProxy: t
    });
  }
  const payload = {
    savedAt: new Date().toLocaleString(),
    seed: state.seed,
    n: state.responses.length,
    theta: state.theta,
    sd: state.sd,
    domains,
    items: state.responses
  };
  localStorage.setItem("spinepro_jointcat_lastRun", JSON.stringify(payload));
  window.location.href = "/results_joint.html";
}

// ---------------- Answer handling ----------------
function recomputeEstimates(){
  // Global
  const answered = state.responses.map(r=>{
    const item = state.bank.find(x=>x.id===r.id);
    return {item, y:r.responseIndex};
  }).filter(x=>x.item);
  const est = mapEstimate(answered, CFG.priorMean, CFG.priorSD);
  state.theta = est.theta;
  state.sd = est.sd;

  // Per-domain
  const byDomain = new Map();
  for(const r of state.responses){
    if(!byDomain.has(r.domain)) byDomain.set(r.domain, []);
    const item = state.bank.find(x=>x.id===r.id);
    if(item) byDomain.get(r.domain).push({item, y:r.responseIndex});
  }
  for(const d of state.requiredDomains){
    const arr = byDomain.get(d) || [];
    if(arr.length === 0){
      state.perDomain.set(d, {theta: null, sd: null, n: 0});
    } else {
      const de = mapEstimate(arr, CFG.priorMean, CFG.priorSD);
      state.perDomain.set(d, {theta: de.theta, sd: de.sd, n: arr.length});
    }
  }
}

function answerItem(item, responseIndex, responseLabel){
  state.askedIds.add(item.id);
  state.responses.push({
    id: item.id,
    instrument: item.instrument,
    domain: item.domain,
    stem: item.stem,
    responseIndex,
    responseLabel
  });

  recomputeEstimates();
  renderStats();

  if(stopNow()){
    completeSurvey();
    return;
  }

  const next = pickNextItem();
  if(!next){
    // bank exhausted
    completeSurvey("Stopped because the item bank ran out of unused items. Add more items to allow a longer CAT.");
    return;
  }
  renderQuestion(next);
}

function completeSurvey(extraNote=null){
  setText("statusPill", "Complete");
  setText("domainPill", `Domain: ${state.responses.at(-1)?.domain || "—"}`);
  setText("countPill", `${state.responses.length}/${CFG.maxItems} items (cap)`);
  setWidth("progressBar", 100);
  setText("questionText", "Survey complete.");
  $("choices").innerHTML = "";

  const note = $("note");
  if(note){
    note.textContent = extraNote || `Complete. Global theta=${state.theta.toFixed(2)} (proxy T=${tScoreProxy(state.theta).toFixed(0)}; ${interpretT(tScoreProxy(state.theta))}).`;
  }

  // replace choices with "View results"
  const btn = document.createElement("button");
  btn.className = "btn primary";
  btn.textContent = "View results";
  btn.onclick = saveRunAndGoResults;
  $("choices").appendChild(btn);
}

// ---------------- Restart / Finish ----------------
function hardRestart(){
  // clear run state
  localStorage.removeItem("spinepro_jointcat_lastRun");
  state.askedIds = new Set();
  state.responses = [];
  state.theta = 0;
  state.sd = 1;
  state.perDomain = new Map();
  state.seed = makeSeed();
  state.rng = mulberry32(state.seed);

  setText("statusPill","Loading…");
  setText("countPill","0 items");
  setText("domainPill","Domain: —");
  setWidth("progressBar", 0);
  setText("questionText","Loading…");
  $("choices").innerHTML = "";
  setText("thetaText","—");
  setText("sdText","—");

  // start fresh
  const next = pickNextItem();
  if(!next){
    completeSurvey("No items available.");
    return;
  }
  renderQuestion(next);
}

function finishNow(){
  completeSurvey();
}

// ---------------- Init ----------------
async function init(){
  state.rng = mulberry32(state.seed);
  $("restartBtn")?.addEventListener("click", hardRestart);
  $("finishBtn")?.addEventListener("click", finishNow);

  try{
    const {version, items} = await loadBank();
    state.bank = items;
    state.domains = uniq(items.map(x=>x.domain)).filter(Boolean);

    state.requiredDomains = CFG.requiredDomains ? CFG.requiredDomains.slice() : state.domains.slice();
    // keep stable order (PROMIS first, then SRS) but not required
    state.requiredDomains.sort((a,b)=>{
      const ia = a.startsWith("SRS_") ? 1 : 0;
      const ib = b.startsWith("SRS_") ? 1 : 0;
      if(ia!==ib) return ia-ib;
      return a.localeCompare(b);
    });

    // init per-domain placeholders
    for(const d of state.requiredDomains){
      state.perDomain.set(d, {theta:null, sd:null, n:0});
    }

    setText("statusPill","In progress");
    setText("countPill", `0/${CFG.maxItems} items (cap)`);

    const first = pickNextItem();
    if(!first){
      completeSurvey("No items available in the bank.");
      return;
    }
    renderQuestion(first);
    renderStats();
  } catch(err){
    console.error(err);
    setText("statusPill","Error");
    setText("questionText", String(err?.message || err));
    $("choices").innerHTML = "";
  }
}

init();
