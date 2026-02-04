import { mulberry32, makeSeed, shuffleInPlace } from './rng.js';

const BANK_URL = './assets/itembank_joint.json';
const LS_KEY = 'spinepro_jointcat_lastRun';
const LS_STATE = 'spinepro_jointcat_state_v2';

// --- Config (prototype; uses provided GRM params in the bank) ---
const config = {
  // content balancing
  minItemsPerDomain: 1,

  // length controls
  minTotalItems: null,        // computed after bank load = (#domains * minItemsPerDomain)
  maxTotalItems: 25,          // hard cap; cannot exceed bank size

  // stopping thresholds (posterior SD is used as SE proxy)
  targetOverallSE: 0.32,
  targetDomainSE: 0.45,

  // estimation
  thetaMin: -4,
  thetaMax: 4,
  thetaStep: 0.1,

  // variety
  topN: 3,                    // pick randomly among top N informative items

  ruleLabel: 'content-balance → uncertainty (GRM IRT prototype)',
};

let bank = null;
let rnd = null;
let grid = null;      // theta grid
let prior = null;     // prior weights on grid

function byId(id){ return document.getElementById(id); }
function fmt(x, d=2){ return (typeof x === 'number' && isFinite(x)) ? x.toFixed(d) : '—'; }

function buildGrid(){
  const g = [];
  for(let t=config.thetaMin; t<=config.thetaMax + 1e-9; t += config.thetaStep){
    g.push(Math.round(t*1000)/1000);
  }
  return g;
}
function normalPdf(x, mu=0, sigma=1){
  const z = (x-mu)/sigma;
  return Math.exp(-0.5*z*z) / (sigma * Math.sqrt(2*Math.PI));
}
function softmaxNormalize(w){
  // normalize positive weights
  let s = 0;
  for(const x of w) s += x;
  if(!(s>0)) return w.map(_=>1/w.length);
  return w.map(x=>x/s);
}
function posteriorStats(w){
  // w should be normalized
  let m=0, m2=0;
  for(let i=0;i<w.length;i++){
    const th = grid[i];
    const wi = w[i];
    m += wi * th;
    m2 += wi * th * th;
  }
  const v = Math.max(0, m2 - m*m);
  return { mean:m, sd: Math.sqrt(v) };
}

// --------- GRM (Samejima) helpers ----------
function logistic(x){
  if(x>35) return 1;
  if(x<-35) return 0;
  return 1/(1+Math.exp(-x));
}
function grmCategoryProb(theta, a, b, k){
  // k is 0..m-1, with m = b.length+1 categories
  // P(Y >= c) = logistic(a*(theta - b[c-1])) for c=1..m-1; P(Y>=m)=0; P(Y>=1)=1
  const m = b.length + 1;
  const c = k + 1; // category number 1..m
  const p_ge_c = (c===1) ? 1 : logistic(a*(theta - b[c-2]));
  const p_ge_c1 = (c===m) ? 0 : logistic(a*(theta - b[c-1]));
  return Math.max(1e-12, Math.min(1-1e-12, p_ge_c - p_ge_c1));
}
function grmCategoryProbs(theta, a, b){
  const m = b.length + 1;
  const probs = [];
  for(let k=0;k<m;k++) probs.push(grmCategoryProb(theta,a,b,k));
  return probs;
}
function grmItemInfo(theta, a, b){
  // Fisher information for GRM at theta
  // Approx via expected squared derivative of log-likelihood.
  const probs = grmCategoryProbs(theta,a,b);
  let info = 0;
  const eps = 1e-5;
  // numerical derivative of log prob per category
  for(let k=0;k<probs.length;k++){
    const p = probs[k];
    const p1 = grmCategoryProb(theta+eps,a,b,k);
    const p0 = grmCategoryProb(theta-eps,a,b,k);
    const dlog = (Math.log(p1) - Math.log(p0)) / (2*eps);
    info += p * dlog * dlog;
  }
  return info;
}

function defaultDomainState(){
  const w = prior.slice(); // normalized already
  const st = posteriorStats(w);
  return {
    theta: st.mean,
    se: st.sd,
    n: 0,
    asked: [],
    post: w,
  };
}

function initState(items){
  const seed = makeSeed();
  rnd = mulberry32(seed);

  const domains = {};
  for(const it of items){
    if(!domains[it.domain]) domains[it.domain] = defaultDomainState();
  }

  const domainKeys = Object.keys(domains);
  const minTotal = domainKeys.length * config.minItemsPerDomain;

  return {
    seed,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    rule: config.ruleLabel,
    configSnapshot: {
      minItemsPerDomain: config.minItemsPerDomain,
      minTotalItems: minTotal,
      maxTotalItems: Math.min(config.maxTotalItems, items.length),
      targetOverallSE: config.targetOverallSE,
      targetDomainSE: config.targetDomainSE,
      thetaMin: config.thetaMin,
      thetaMax: config.thetaMax,
      thetaStep: config.thetaStep,
      topN: config.topN,
    },
    totalAsked: 0,
    askedIds: [],
    responses: [], // {id, instrument, domain, stem, choiceIndex, choiceLabel, score, timestamp}
    domains,
    status: 'in_progress',
    stopReason: null,
  };
}

function domainsNeedingCoverage(state){
  return Object.entries(state.domains)
    .filter(([_,ds]) => ds.n < config.minItemsPerDomain)
    .map(([d,_]) => d);
}
function domainsByUncertainty(state){
  return Object.entries(state.domains)
    .sort((a,b) => (b[1].se - a[1].se));
}

function computeOverall(state){
  const ds = Object.values(state.domains).filter(d => d.n>0);
  if(ds.length === 0) return { theta: 0, se: 1.0 };
  const theta = ds.reduce((s,d)=>s+d.theta,0)/ds.length;
  const se = Math.sqrt(ds.reduce((s,d)=>s+d.se*d.se,0)/ds.length);
  return { theta, se };
}

function shouldStop(state){
  const minTotal = state.configSnapshot?.minTotalItems ?? (Object.keys(state.domains).length * config.minItemsPerDomain);
  const maxTotal = state.configSnapshot?.maxTotalItems ?? Math.min(config.maxTotalItems, bank.items.length);

  if(state.totalAsked < minTotal) return { stop:false };
  if(state.totalAsked >= maxTotal) return { stop:true, reason:`Reached max cap (${maxTotal}).` };

  const need = domainsNeedingCoverage(state);
  if(need.length) return { stop:false };

  const overall = computeOverall(state);
  const allDomainsOK = Object.values(state.domains).every(ds => ds.n>0 && ds.se <= config.targetDomainSE);
  if(overall.se <= config.targetOverallSE && allDomainsOK){
    return { stop:true, reason:`Uncertainty targets met (overall SE ≤ ${config.targetOverallSE}, per-domain SE ≤ ${config.targetDomainSE}).` };
  }
  return { stop:false };
}

function pickNextItem(state){
  const unused = bank.items.filter(it => !state.askedIds.includes(it.id));
  if(unused.length === 0) return null;

  const need = domainsNeedingCoverage(state);
  let candidateDomains = need.length ? need : domainsByUncertainty(state).map(([d,_])=>d);

  // Keep only domains with remaining items
  candidateDomains = candidateDomains.filter(d => unused.some(it => it.domain === d));
  if(candidateDomains.length === 0) return null;

  // Choose domain
  let chosenDomain;
  if(need.length){
    chosenDomain = candidateDomains.sort((d1,d2)=>state.domains[d1].n - state.domains[d2].n)[0];
  } else {
    chosenDomain = candidateDomains.sort((d1,d2)=>state.domains[d2].se - state.domains[d1].se)[0];
  }

  const domainItems = unused.filter(it => it.domain === chosenDomain);

  // Prefer items with model parameters
  const withModel = domainItems.filter(it => it.model && it.model.type === 'GRM' && typeof it.model.a === 'number' && Array.isArray(it.model.b));
  const pool = withModel.length ? withModel : domainItems;

  // Compute information at current domain theta
  const theta = state.domains[chosenDomain]?.theta ?? 0;
  const scored = pool.map(it => {
    let info = 0;
    try{
      if(it.model && it.model.type === 'GRM'){
        info = grmItemInfo(theta, it.model.a, it.model.b);
      } else {
        info = 0.01;
      }
    }catch(e){ info = 0.01; }
    return { it, info };
  }).sort((a,b)=>b.info - a.info);

  const topN = Math.min(config.topN, scored.length);
  const top = scored.slice(0, topN).map(x=>x.it);
  shuffleInPlace(top, rnd);
  return top[0];
}

function saveState(state){
  try{ localStorage.setItem(LS_STATE, JSON.stringify(state)); }catch(e){}
}
function loadState(){
  try{
    const raw = localStorage.getItem(LS_STATE);
    if(!raw) return null;
    const st = JSON.parse(raw);
    // only resume if not finished
    if(st && st.status === 'in_progress') return st;
  }catch(e){}
  return null;
}
function clearInProgressState(){
  try{ localStorage.removeItem(LS_STATE); }catch(e){}
}

function finalizeRun(state){
  state.finishedAt = new Date().toISOString();
  state.status = 'complete';
  // store snapshot for results page
  try{ localStorage.setItem(LS_KEY, JSON.stringify(state)); }catch(e){}
  clearInProgressState();
}

function render(state, currentItem){
  const maxTotal = state.configSnapshot?.maxTotalItems ?? config.maxTotalItems;
  byId('badge_domain').textContent = currentItem ? `Domain: ${currentItem.domain}` : 'Complete';
  byId('badge_items').textContent = `${state.totalAsked}/${maxTotal} items (cap)`;
  byId('progressFill').style.width = `${Math.min(100, (state.totalAsked/maxTotal)*100)}%`;

  const overall = computeOverall(state);
  byId('k_overall_theta').textContent = fmt(overall.theta,2);
  byId('k_overall_se').textContent = fmt(overall.se,2);
  byId('k_rule').textContent = state.rule || config.ruleLabel;

  if(state.status === 'complete'){
    byId('question').textContent = 'Survey complete.';
    byId('choices').innerHTML = '';
    byId('stopReason').textContent = state.stopReason ? `Stopped: ${state.stopReason}` : '';
    byId('viewResults').style.display = 'inline-block';
    return;
  }

  if(!currentItem){
    byId('question').textContent = 'No more items available.';
    byId('choices').innerHTML = '';
    byId('stopReason').textContent = 'Stopped because the item bank ran out of unused items.';
    byId('viewResults').style.display = 'inline-block';
    return;
  }

  byId('question').textContent = currentItem.stem;
  byId('viewResults').style.display = 'none';
  byId('stopReason').textContent = '';

  const choices = byId('choices');
  choices.innerHTML = '';
  currentItem.options.forEach((label, idx) => {
    const btn = document.createElement('button');
    btn.className = 'choice';
    btn.textContent = label;
    btn.onclick = () => onAnswer(state, currentItem, idx);
    choices.appendChild(btn);
  });
}

function computeScore(item, choiceIndex){
  // score is used only for display / logs; IRT update uses choiceIndex directly
  if(Array.isArray(item.score_map)){
    const v = item.score_map[choiceIndex];
    if(typeof v === 'number') return v;
  }
  return choiceIndex + 1;
}

function updateDomainPosterior(domainState, item, choiceIndex){
  const a = item?.model?.a ?? 1.0;
  const b = item?.model?.b ?? [-1.5,-0.5,0.5,1.5];
  const m = b.length + 1;

  const newW = [];
  for(let i=0;i<domainState.post.length;i++){
    const th = grid[i];
    const p = grmCategoryProb(th, a, b, Math.min(m-1, Math.max(0, choiceIndex)));
    newW.push(domainState.post[i] * p);
  }
  const norm = softmaxNormalize(newW);
  domainState.post = norm;
  const st = posteriorStats(norm);
  domainState.theta = st.mean;
  domainState.se = st.sd;
  domainState.n += 1;
  domainState.asked.push(item.id);
}

function onAnswer(state, item, choiceIndex){
  const ds = state.domains[item.domain];
  if(!ds) return;

  state.askedIds.push(item.id);
  const score = computeScore(item, choiceIndex);
  state.responses.push({
    id: item.id,
    instrument: item.instrument,
    domain: item.domain,
    stem: item.stem,
    choiceIndex,
    choiceLabel: item.options[choiceIndex],
    score,
    timestamp: new Date().toISOString(),
  });

  updateDomainPosterior(ds, item, choiceIndex);
  state.totalAsked += 1;

  const stop = shouldStop(state);
  if(stop.stop){
    state.status = 'complete';
    state.stopReason = stop.reason;
    finalizeRun(state);
    render(state, null);
    return;
  }

  const next = pickNextItem(state);
  if(!next){
    state.status = 'complete';
    state.stopReason = 'Item bank exhausted (no remaining items under current constraints).';
    finalizeRun(state);
    render(state, null);
    return;
  }

  saveState(state);
  render(state, next);
}

async function loadBank(){
  const res = await fetch(BANK_URL, { cache: 'no-store' });
  if(!res.ok) throw new Error(`Failed to load bank (${res.status})`);
  return await res.json();
}

function wireButtons(state){
  byId('restart').onclick = () => {
    // keep lastRun; clear in-progress and reload
    clearInProgressState();
    window.location.reload();
  };
  byId('finish').onclick = () => {
    // allow finish only after coverage minimum, otherwise keep asking
    const minTotal = state.configSnapshot?.minTotalItems ?? (Object.keys(state.domains).length * config.minItemsPerDomain);
    if(state.totalAsked < minTotal){
      byId('stopReason').textContent = `Please answer at least ${minTotal} items to cover all domains once.`;
      return;
    }
    state.status = 'complete';
    state.stopReason = 'Finished by user.';
    finalizeRun(state);
    render(state, null);
  };
  byId('viewResults').onclick = () => {
    window.location.href = './results_joint.html';
  };
}

async function main(){
  byId('question').textContent = 'Loading...';
  try{
    grid = buildGrid();
    prior = softmaxNormalize(grid.map(t => normalPdf(t,0,1)));
    bank = await loadBank();

    // compute minTotalItems after load
    const domainCount = new Set(bank.items.map(it=>it.domain)).size;
    config.minTotalItems = domainCount * config.minItemsPerDomain;

    // cap max to bank size
    const maxCap = Math.min(config.maxTotalItems, bank.items.length);
    config.maxTotalItems = maxCap;

    let state = loadState();
    if(!state){
      state = initState(bank.items);
      saveState(state);
    } else {
      // refresh config snapshot if needed
      if(!state.configSnapshot){
        state.configSnapshot = initState(bank.items).configSnapshot;
      } else {
        state.configSnapshot.maxTotalItems = Math.min(state.configSnapshot.maxTotalItems ?? config.maxTotalItems, bank.items.length);
      }
    }

    wireButtons(state);

    // pick first item
    const first = pickNextItem(state);
    if(!first){
      state.status = 'complete';
      state.stopReason = 'No items available.';
      finalizeRun(state);
      render(state, null);
      return;
    }
    render(state, first);
  }catch(e){
    console.error(e);
    byId('question').textContent = String(e?.message || e);
    byId('stopReason').textContent = 'Error loading item bank.';
  }
}

main();
