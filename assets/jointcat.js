
import { mulberry32, makeSeed, shuffleInPlace } from './rng.js';

const BANK_URL = './assets/itembank_joint.json';
const LS_KEY = 'spinepro_jointcat_lastRun';
const LS_STATE = 'spinepro_jointcat_state_v1';

const config = {
  minTotalItems: 10,
  maxTotalItems: 25,
  minItemsPerDomain: 1,
  targetOverallSE: 0.32,
  targetDomainSE: 0.45,
  ruleLabel: 'content-balance → uncertainty (prototype IRT scaffold)',
};

let bank = null;
let rnd = null;

function byId(id){ return document.getElementById(id); }
function fmt(x, d=2){ return (typeof x === 'number' && isFinite(x)) ? x.toFixed(d) : '—'; }

function defaultDomainState(){
  return { theta: 0, se: 1.0, n: 0, asked: [] };
}

function initState(items){
  const seed = makeSeed();
  rnd = mulberry32(seed);
  const domains = {};
  for (const it of items){
    if(!domains[it.domain]) domains[it.domain] = defaultDomainState();
  }
  return {
    seed,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    rule: config.ruleLabel,
    totalAsked: 0,
    askedIds: [],
    responses: [], // {id, instrument, domain, stem, choiceIndex, choiceLabel, score, timestamp}
    domains,
    status: 'in_progress',
    stopReason: null,
  };
}

function saveState(state){
  localStorage.setItem(LS_STATE, JSON.stringify(state));
}

function loadState(){
  const raw = localStorage.getItem(LS_STATE);
  if(!raw) return null;
  try{ return JSON.parse(raw); }catch(e){ return null; }
}

function clearState(){
  localStorage.removeItem(LS_STATE);
}

function responseToScore(item, choiceIndex1){
  // choiceIndex1 is 1..K
  // For PROMIS: map to -2..+2 with direction based on higher_is_worse
  if(item.instrument === 'PROMIS'){
    const centered = (choiceIndex1 - 3); // -2..+2
    return item.higher_is_worse ? centered : -centered;
  }
  // For SRS: options in provided PDF are best->worst; map similarly
  // Use score_map for clinician-friendly score later, but theta uses impact-like direction (higher worse)
  const centered = (choiceIndex1 - 3);
  return centered; // higher idx worse => positive impact
}

function updateDomain(domainState, score){
  // Very lightweight Bayesian-ish update (prototype).
  // theta_n = weighted average of scores; se decreases with n.
  domainState.n += 1;
  const lr = 0.55; // step size
  domainState.theta = domainState.theta + lr * (score - domainState.theta) / Math.sqrt(domainState.n);
  domainState.se = 1 / Math.sqrt(domainState.n + 0.5);
}

function computeOverall(state){
  const thetas = [];
  const ses = [];
  for(const d of Object.keys(state.domains)){
    const ds = state.domains[d];
    if(ds.n>0){ thetas.push(ds.theta); ses.push(ds.se); }
  }
  const theta = thetas.length ? thetas.reduce((a,b)=>a+b,0)/thetas.length : 0;
  const se = ses.length ? ses.reduce((a,b)=>a+b,0)/ses.length : 1;
  return { theta, se };
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

function pickNextItem(state){
  const unused = bank.items.filter(it => !state.askedIds.includes(it.id));
  if(unused.length === 0) return null;

  const need = domainsNeedingCoverage(state);
  let candidateDomains = need.length ? need : domainsByUncertainty(state).map(([d,_])=>d);

  // Prefer domains with remaining items
  candidateDomains = candidateDomains.filter(d => unused.some(it => it.domain === d));
  if(candidateDomains.length === 0){
    return null;
  }

  // Domain choice:
  // If still covering, pick domain with lowest n; else pick highest se.
  let chosenDomain = candidateDomains[0];
  if(need.length){
    chosenDomain = candidateDomains.sort((d1,d2)=>state.domains[d1].n - state.domains[d2].n)[0];
  } else {
    chosenDomain = candidateDomains.sort((d1,d2)=>state.domains[d2].se - state.domains[d1].se)[0];
  }

  // Item choice within domain: random among top few (keeps variety)
  const domainItems = unused.filter(it => it.domain === chosenDomain);
  shuffleInPlace(domainItems, rnd);
  return domainItems[0];
}

function shouldStop(state){
  if(state.totalAsked < config.minTotalItems) return { stop:false };
  if(state.totalAsked >= config.maxTotalItems) return { stop:true, reason:`Reached max cap (${config.maxTotalItems}).` };

  const need = domainsNeedingCoverage(state);
  if(need.length) return { stop:false };

  // uncertainty rules
  const overall = computeOverall(state);
  const allDomainsOK = Object.values(state.domains).every(ds => ds.n>0 && ds.se <= config.targetDomainSE);
  if(overall.se <= config.targetOverallSE && allDomainsOK){
    return { stop:true, reason:`Uncertainty targets met (overall SE ≤ ${config.targetOverallSE}, per-domain SE ≤ ${config.targetDomainSE}).` };
  }
  return { stop:false };
}

function renderStatus(state){
  const overall = computeOverall(state);
  byId('k_overall_theta').textContent = fmt(overall.theta,2);
  byId('k_overall_se').textContent = fmt(overall.se,2);
  byId('k_rule').textContent = state.rule;

  const progress = Math.min(1, state.totalAsked / config.maxTotalItems);
  byId('progressFill').style.width = (progress*100).toFixed(0)+'%';

  byId('badge_items').textContent = `${state.totalAsked}/${config.maxTotalItems} items (cap)`;
  // show current domain badge if question rendered
}

function renderQuestion(state, item){
  byId('badge_domain').textContent = `Domain: ${item.domain}`;
  byId('question').textContent = item.stem;

  const choices = byId('choices');
  choices.innerHTML = '';
  item.options.forEach((label, idx0) => {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => answer(state, item, idx0+1, label));
    choices.appendChild(btn);
  });

  renderStatus(state);
}

function finish(state, reason){
  state.status = 'complete';
  state.finishedAt = new Date().toISOString();
  state.stopReason = reason || 'Completed.';
  const overall = computeOverall(state);
  state.overall = overall;

  // Persist a "last run" snapshot for results page
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  saveState(state);

  // show completion UI
  byId('question').textContent = 'Survey complete.';
  byId('choices').innerHTML = '';
  byId('badge_domain').textContent = 'Complete';
  byId('stopReason').textContent = state.stopReason || '';
  byId('viewResults').style.display = 'inline-flex';
  byId('viewResults').onclick = () => { window.location.href = './results_joint.html'; };

  renderStatus(state);
}

function answer(state, item, choiceIndex1, choiceLabel){
  // record
  const score = responseToScore(item, choiceIndex1);
  state.responses.push({
    id:item.id,
    instrument:item.instrument,
    domain:item.domain,
    stem:item.stem,
    choiceIndex:choiceIndex1,
    choiceLabel,
    score,
    timestamp: new Date().toISOString()
  });
  state.askedIds.push(item.id);
  state.totalAsked += 1;
  state.domains[item.domain].asked.push(item.id);
  updateDomain(state.domains[item.domain], score);
  saveState(state);

  // stop?
  const stop = shouldStop(state);
  if(stop.stop){
    finish(state, stop.reason);
    return;
  }

  const next = pickNextItem(state);
  if(!next){
    finish(state, 'Stopped because the item bank ran out of unused items. Add more items to allow a longer CAT.');
    return;
  }
  renderQuestion(state, next);
}

async function loadBank(){
  const res = await fetch(BANK_URL, { cache:'no-store' });
  if(!res.ok) throw new Error('Failed to load itembank_joint.json');
  return await res.json();
}

async function main(){
  byId('restart').addEventListener('click', () => {
    clearState();
    window.location.href = './survey_joint.html';
  });
  byId('finish').addEventListener('click', () => {
    const state = loadState();
    if(state) finish(state, 'Finished early by user.');
  });

  bank = await loadBank();
  let state = loadState();

  if(!state || state.status !== 'in_progress'){
    state = initState(bank.items);
    saveState(state);
  }

  rnd = mulberry32(state.seed >>> 0);

  // If already complete, show completion
  if(state.status === 'complete'){
    finish(state, state.stopReason || 'Completed.');
    return;
  }

  const next = pickNextItem(state);
  if(!next){
    finish(state, 'No items available.');
    return;
  }
  renderQuestion(state, next);
}

main().catch(err => {
  console.error(err);
  byId('question').textContent = 'Error loading survey.';
  byId('stopReason').textContent = String(err && err.message ? err.message : err);
});
