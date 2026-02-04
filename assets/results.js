
const LS_KEY = 'spinepro_jointcat_lastRun';

function byId(id){ return document.getElementById(id); }
function fmt(x,d=2){ return (typeof x === 'number' && isFinite(x)) ? x.toFixed(d) : '—'; }

function interpretationPROMIS(domain, t, higherIsWorse){
  // Prototype banding for clinician readability (not an official PROMIS interpretation spec)
  if(t === null || !isFinite(t)) return '—';
  if(higherIsWorse){
    if(t < 40) return 'Within expected range';
    if(t <= 60) return 'Within expected range';
    return 'Elevated impact';
  } else {
    // higher better => low is worse
    if(t < 40) return 'Reduced function';
    if(t <= 60) return 'Within expected range';
    return 'Better than average';
  }
}

function interpretationSRS(meanScore){
  if(meanScore === null || !isFinite(meanScore)) return '—';
  if(meanScore >= 4.0) return 'Favorable';
  if(meanScore >= 3.0) return 'Moderate impact';
  return 'Concerning impact';
}

function render(){
  const raw = localStorage.getItem(LS_KEY);
  if(!raw){
    byId('summary').textContent = 'No saved run found. Complete the survey first.';
    return;
  }
  let run = null;
  try{ run = JSON.parse(raw); }catch(e){ byId('summary').textContent='Could not parse saved run.'; return; }

  byId('k_theta').textContent = fmt(run.overall?.theta ?? null, 2);
  byId('k_se').textContent = fmt(run.overall?.se ?? null, 2);
  byId('k_items').textContent = String(run.totalAsked ?? (run.responses?.length ?? 0));
  byId('k_saved').textContent = run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—';
  byId('k_seed').textContent = String(run.seed ?? '—');

  // Build per-domain table
  const tbody = byId('domainBody');
  tbody.innerHTML = '';

  // SRS raw scoring by conventional subscales (prototype mapping)
  const srsMap = {
    SRS_Pain: [1,2,8,11],
    SRS_Function: [5,9,12,18],
    SRS_SelfImage: [4,6,10,19],
    SRS_Mental: [3,7,13,16,20],
    SRS_Satisfaction: [21,22],
  };
  const srsScores = {};
  for(const [d, nums] of Object.entries(srsMap)){
    const ids = nums.map(n => 'SRS'+String(n).padStart(2,'0'));
    const rs = (run.responses||[]).filter(r => ids.includes(r.id));
    // score_map stored in bank, but not in responses; reconstruct: 1..5 chosen index where 1=best->score5
    const vals = rs.map(r => 6 - r.choiceIndex); // 1->5, 5->1
    const mean = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length) : null;
    srsScores[d] = { mean, n: vals.length };
  }

  const domainKeys = Object.keys(run.domains || {}).sort();
  for(const d of domainKeys){
    const ds = run.domains[d];
    const instrument = d.startsWith('SRS_') ? 'SRS' : 'PROMIS';
    const theta = ds?.theta ?? null;

    let proxy = null;
    let interp = '—';
    let n = ds?.n ?? 0;

    if(instrument === 'PROMIS'){
      proxy = 50 + 10*theta;
      // Determine direction from first answered item in domain
      const first = (run.responses||[]).find(r => r.domain === d && r.instrument === 'PROMIS');
      const higherIsWorse = first ? (first.score >= 0 ? true : false) : true; // crude; overridden below
      // Better: look up from responses by comparing raw choice index vs score sign
      let hisw = true;
      if(first){
        // for PROMIS PF/SR, score flips sign; detect using domain name
        hisw = !(d === 'PF' || d === 'SR');
      }
      interp = interpretationPROMIS(d, proxy, hisw);
    } else {
      const mean = srsScores[d]?.mean ?? null;
      proxy = mean; // mean 1..5 (higher better)
      interp = interpretationSRS(mean);
      n = srsScores[d]?.n ?? n;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${d}</b></td>
      <td>${instrument}</td>
      <td>${fmt(theta,2)}</td>
      <td>${instrument==='PROMIS' ? fmt(proxy,0) : fmt(proxy,2)}</td>
      <td>${interp}</td>
      <td>${n}</td>
    `;
    tbody.appendChild(tr);
  }

  // Answered items table
  const itBody = byId('itemsBody');
  itBody.innerHTML = '';
  const rows = (run.responses||[]).map((r, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td>${r.instrument}</td>
      <td>${r.domain}</td>
      <td>${escapeHtml(r.stem)}</td>
      <td><b>${escapeHtml(r.choiceLabel)}</b></td>
    `;
    return tr;
  });
  rows.forEach(r => itBody.appendChild(r));

  byId('takeAgain').addEventListener('click', () => { window.location.href = './survey_joint.html?restart=1'; });
  byId('home').addEventListener('click', () => { window.location.href = './index.html'; });

  // summary note
  byId('summary').textContent =
    'Domain values are prototype summaries from the adaptive state. Replace placeholder IRT parameters and PROMIS/SRS mappings with validated calibration/spec before clinical use.';
}

function escapeHtml(str){
  if(str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

render();
