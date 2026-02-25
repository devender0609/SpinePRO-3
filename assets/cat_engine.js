
// SpinePRO Joint CAT Engine (between-item multidimensional GRM, MAP with MVN prior)
// Uses rank-1 covariance updates and A-optimal trace reduction selection.
const JointCATEngine = (() => {

  function deepCopy(x){ return JSON.parse(JSON.stringify(x)); }

  function matIdentity(n){
    const I = Array.from({length:n}, (_,i)=>Array.from({length:n},(_,j)=> i===j?1:0));
    return I;
  }
  function matVec(A, v){
    const n=A.length; const out=new Array(n).fill(0);
    for(let i=0;i<n;i++){ let s=0; for(let j=0;j<n;j++) s+=A[i][j]*v[j]; out[i]=s; }
    return out;
  }
  function matAdd(A,B){
    const n=A.length; const C=Array.from({length:n}, ()=>new Array(n).fill(0));
    for(let i=0;i<n;i++) for(let j=0;j<n;j++) C[i][j]=A[i][j]+B[i][j];
    return C;
  }
  function matSub(A,B){
    const n=A.length; const C=Array.from({length:n}, ()=>new Array(n).fill(0));
    for(let i=0;i<n;i++) for(let j=0;j<n;j++) C[i][j]=A[i][j]-B[i][j];
    return C;
  }
  function outer(u,v){
    const n=u.length; const m=v.length;
    const O=Array.from({length:n}, ()=>new Array(m).fill(0));
    for(let i=0;i<n;i++) for(let j=0;j<m;j++) O[i][j]=u[i]*v[j];
    return O;
  }
  function matMul(A,B){
    const n=A.length, m=B[0].length, k=B.length;
    const C=Array.from({length:n}, ()=>new Array(m).fill(0));
    for(let i=0;i<n;i++){
      for(let j=0;j<m;j++){
        let s=0;
        for(let t=0;t<k;t++) s+=A[i][t]*B[t][j];
        C[i][j]=s;
      }
    }
    return C;
  }
  function matTrace(A){
    let s=0; for(let i=0;i<A.length;i++) s+=A[i][i]; return s;
  }

  // Gauss-Jordan inverse for small matrices
  function matInverse(A){
    const n=A.length;
    const M=A.map(row=>row.slice());
    const I=matIdentity(n);
    for(let col=0; col<n; col++){
      // pivot
      let pivot=col;
      for(let r=col+1;r<n;r++) if(Math.abs(M[r][col])>Math.abs(M[pivot][col])) pivot=r;
      if(Math.abs(M[pivot][col])<1e-12) throw new Error("Singular matrix");
      if(pivot!==col){
        [M[pivot], M[col]]=[M[col], M[pivot]];
        [I[pivot], I[col]]=[I[col], I[pivot]];
      }
      const div=M[col][col];
      for(let j=0;j<n;j++){ M[col][j]/=div; I[col][j]/=div; }
      for(let r=0;r<n;r++){
        if(r===col) continue;
        const factor=M[r][col];
        for(let j=0;j<n;j++){ M[r][j]-=factor*M[col][j]; I[r][j]-=factor*I[col][j]; }
      }
    }
    return I;
  }

  function logistic(x){
    if (x>35) return 1.0;
    if (x<-35) return 0.0;
    return 1/(1+Math.exp(-x));
  }

  // GRM category probabilities for 5 categories (0..4) using 4 thresholds b1..b4
  function grmCatProbs(theta, a, b){
    // GRM category probabilities for K categories (0..K-1) using (K-1) thresholds
    const K = (b ? b.length : 0) + 1;
    // P(Y>=k) for k=1..K-1
    const Pge = [1.0];
    for(let k=0;k<K-1;k++){
      Pge.push(logistic(a*(theta - b[k])));
    }
    Pge.push(0.0); // P(Y>=K)
    const probs=[];
    for(let k=0;k<K;k++){
      probs.push(Pge[k]-Pge[k+1]);
    }
    return probs;
  }

  function grmCatDerivs(theta, a, b){
    // derivatives of category probs wrt theta
    // d/dtheta logistic(a*(theta-b)) = a*L*(1-L)
    const K = (b ? b.length : 0) + 1;
    const Pge=[1.0];
    const dPge=[0.0];
    for(let k=0;k<K-1;k++){
      const L=logistic(a*(theta - b[k]));
      Pge.push(L);
      dPge.push(a*L*(1-L));
    }
    Pge.push(0.0); dPge.push(0.0);
    const probs=[], dprobs=[];
    for(let k=0;k<K;k++){
      probs.push(Pge[k]-Pge[k+1]);
      dprobs.push(dPge[k]-dPge[k+1]);
    }
    // normalize with small eps (ignore derivative of renorm; ok for info approx)
    const eps=1e-12;
    let s=0; for(const p of probs) s+=p;
    if(s<=0) s=1;
    for(let k=0;k<probs.length;k++) probs[k]=Math.max(eps, probs[k])/s;
    return {probs, dprobs};
  }

  function itemInfo(theta, item){
    const a=item.discrimination;
    const bRaw=item.thresholds || [];
    const b=bRaw.filter(v => Number.isFinite(v));
    const {probs, dprobs} = grmCatDerivs(theta, a, b);
    let info=0;
    for(let k=0;k<probs.length;k++){
      const pk=Math.max(1e-12, probs[k]);
      const dlog = dprobs[k]/pk;
      info += pk * dlog*dlog;
    }
    return Math.max(1e-6, info);
  }

  function itemGradHess(theta, item, resp){
    const a=item.discrimination;
    const bRaw2=item.thresholds || [];
    const b=bRaw2.filter(v => Number.isFinite(v));
    const probs=grmCatProbs(theta, a, b);
    const pk=probs[resp];
    // numerical second derivative using finite differences for robustness
    const h=1e-4;
    const lp0=Math.log(pk);
    const lpP=Math.log(grmCatProbs(theta+h, a, b)[resp]);
    const lpM=Math.log(grmCatProbs(theta-h, a, b)[resp]);
    const grad=(lpP-lpM)/(2*h);
    const hess=(lpP - 2*lp0 + lpM)/(h*h);
    return {grad, hess}; // hess is second derivative
  }

  function createSession(bank, norms, constraints){
    if (!bank) {
      throw new Error("Item bank is missing (bank is undefined). Ensure itembank_runtime.json is loaded and passed into createJointCATEngine().");
    }
    // Normalize domains to an array of domain names.
    if (!Array.isArray(bank.domains)) {
      if (bank.domains && typeof bank.domains === 'object') {
        bank.domains = Object.keys(bank.domains);
      } else {
        // Derive from item metadata as a last resort.
        const ds = new Set();
        for (const it of Object.values(bank.items || {})) {
          if (it && it.domain) ds.add(it.domain);
        }
        bank.domains = Array.from(ds);
      }
    }
    const D=bank.domains.length;
    const thetaVec=new Array(D).fill(0);  // Initialize to 0, NOT null
    const Sigma=deepCopy(bank.prior_covariance); // posterior covariance start = prior
    
    // CRITICAL: Verify thetaVec has no nulls
    for(let i=0; i<D; i++){
      if(thetaVec[i] === null || thetaVec[i] === undefined || !Number.isFinite(thetaVec[i])){
        console.warn("WARNING: thetaVec[" + i + "] is null/undefined, forcing to 0");
        thetaVec[i] = 0;
      }
    }
    
    // Pair-exclusion constraints (local dependence mitigation)
    const adj = {};
    if (constraints && constraints.constraints && Array.isArray(constraints.constraints)){
      for (const pair of constraints.constraints){
        if (!pair || pair.length !== 2) continue;
        const [a,b] = pair;
        if (!adj[a]) adj[a] = {};
        if (!adj[b]) adj[b] = {};
        adj[a][b] = true;
        adj[b][a] = true;
      }
    }
    const session = {
      version: "web_v1",
      created_at: new Date().toISOString(),
      constraints_n: (constraints && constraints.constraints) ? constraints.constraints.length : 0,
      constraints_adj: adj,
      constraints_raw: constraints || null,
      theta: Object.fromEntries(bank.domains.map((d,i)=>[d, thetaVec[i]])),
      theta_vec: thetaVec,
      Sigma: Sigma,
      se: Object.fromEntries(bank.domains.map(d=>[d, null])),
      administered: [],
      remaining: Object.keys(bank.items),
      domain_counts: {},
      is_finished: false,
      stop_reason: null,
      current_item_id: null
    };
    // select first item
    const next = selectNextItem(bank, session);
    session.current_item_id = next;
    updateSE(bank, session);
    return session;
  }


  function nextItem(bank, s) {
    // Ensure a current item is selected; do NOT record an answer here.
    if (!s || s.is_finished) return null;

    if (s.current_item_id === null || s.current_item_id === undefined) {
      const nid = selectNextItem(bank, s);
      if (nid === null || nid === undefined) {
        // Bank exhausted
        s.is_finished = true;
        s.stop_reason = s.stop_reason || "bank_exhausted";
        s.results = finish(bank, null, s, s.stop_reason);
        return null;
      }
      s.current_item_id = nid;
    }
    return getCurrentItem(bank, s);
  }

  function updateSE(bank, s){
    const D=bank.domains.length;
    const diag = [];
    for(let i=0;i<D;i++){
      const v = Math.max(1e-12, s.Sigma[i][i]);
      diag.push(Math.sqrt(v));
      s.se[bank.domains[i]] = Math.sqrt(v);
    }
    return diag;
  }

  function globalSE(s){
    // RMS of domain SEs
    const ses = Object.values(s.se).filter(v=>typeof v==="number");
    if (!ses.length) return null;
    let m=0; for(const v of ses) m += v*v;
    return Math.sqrt(m/ses.length);
  }

  function coverageNeeded(bank, s){
    const need=[];
    for(const d of bank.domains){
      if (!s.domain_counts[d]) need.push(d);
    }
    return need;
  }

  function selectNextItem(bank, s){
    const remaining = s.remaining;
    const adj = s.constraints_adj || {};
    const administeredIds = new Set(s.administered.map(a=>a.item_id));
    function allowed(id){
      const partners = adj[id];
      if (!partners) return true;
      for (const prev of administeredIds){
        if (partners[prev]) return false;
      }
      return true;
    }

    if (!remaining.length) return null;

    const D=bank.domains.length;
    const domIndex = Object.fromEntries(bank.domains.map((d,i)=>[d,i]));

    const need = coverageNeeded(bank, s);
    let candidateIds = remaining;
    candidateIds = candidateIds.filter(allowed);
    if (!candidateIds.length) return null;
    if (need.length && s.administered.length < bank.cat_config.min_items + need.length) {
      candidateIds = remaining.filter(id => need.includes(bank.items[id].domain));
      if (!candidateIds.length) candidateIds = remaining;
    }
    candidateIds = candidateIds.filter(allowed);
    if (!candidateIds.length) return null;

    if ((s.administered||[]).length === 0 && candidateIds.length){
      const j = Math.floor((s.rng ? s.rng() : Math.random()) * candidateIds.length);
      return candidateIds[j];
    }

    let bestId = candidateIds[0];
    let bestScore = -Infinity;

    // IMPROVED: Stronger domain balancing with quadratic penalty
    // Allow tuning via policy/config:
    // - cfg.domain_penalty_lambda (default 0.5)
    // - cfg.domain_weights (e.g., { Participation: 1.8, Anxiety: 1.2 })
    const cfg = bank.cat_config || {};
    const lambda = (typeof cfg.domain_penalty_lambda === "number") ? cfg.domain_penalty_lambda : 0.5;
    const domainWeights = (cfg.domain_weights && typeof cfg.domain_weights === "object") ? cfg.domain_weights : {};

    for(const id of candidateIds){
      const it=bank.items[id];
      const d = domIndex[it.domain];
      const th = s.theta_vec[d];
      const info = itemInfo(th, it);
      
      let colSq=0;
      for(let i=0;i<D;i++){
        const v = s.Sigma[i][d];
        colSq += v*v;
      }
      const denom = 1 + info * s.Sigma[d][d];
      const gain = (info * colSq) / denom;

      // IMPROVED: Domain balancing with quadratic penalty and zero-count boost
      const domain_count = s.domain_counts[it.domain] || 0;
      let penalty = lambda * (domain_count * domain_count);

      // Domain weighting: reduce penalty for prioritized domains to increase their exposure.
      // weight > 1 -> more likely selected; weight < 1 -> less likely selected.
      const w = (typeof domainWeights[it.domain] === "number" && isFinite(domainWeights[it.domain])) ? domainWeights[it.domain] : 1.0;
      penalty = penalty / Math.max(0.25, w);

      // Strong boost for under-represented domains
      if (domain_count === 0) {
        penalty -= 3.0;
      } else if (domain_count === 1) {
        penalty -= 1.5;
      } else if (domain_count === 2 && it.domain.startsWith('SRS_')) {
        penalty -= 0.5;
      }

      const score = gain - penalty;

      if (score > bestScore + 1e-12){
        bestScore = score;
        bestId = id;
      } else if (Math.abs(score - bestScore) <= 1e-12 && bestId !== null && (s.rng ? s.rng() : Math.random()) < 0.5){
        bestId = id;
      }
    }
    return bestId;
  }

  function getCurrentItem(bank, s){
    const id=s.current_item_id;
    return (id === null || id === undefined) ? null : bank.items[id];
  }

  function updatePosteriorCov(bank, s, item){
    // Sherman-Morrison update on covariance: Sigma_new = Sigma - (Sigma u u^T Sigma) / (1 + u^T Sigma u), u = sqrt(info) e_d
    const D=bank.domains.length;
    const domIndex = Object.fromEntries(bank.domains.map((d,i)=>[d,i]));
    const d = domIndex[item.domain];
    const th = s.theta_vec[d];
    const info = itemInfo(th, item);
    const Sigma = s.Sigma;

    const Sigma_col = new Array(D).fill(0);
    for(let i=0;i<D;i++) Sigma_col[i] = Sigma[i][d];

    const denom = 1 + info * Sigma[d][d];
    // outer = (info/denom) * Sigma_col * Sigma_col^T
    const factor = info / denom;
    for(let i=0;i<D;i++){
      for(let j=0;j<D;j++){
        Sigma[i][j] = Sigma[i][j] - factor * Sigma_col[i] * Sigma_col[j];
      }
    }
    s.Sigma = Sigma;
  }

  function mapUpdateTheta(bank, s){
    const D = bank.domains.length;
    const domIndex = Object.fromEntries(bank.domains.map((d,i)=>[d,i]));

    // Use DIAGONAL-ONLY prior for numerical stability
    // (ignore cross-domain correlations which cause Hessian to become singular)
    const priorVar = new Array(D).fill(1.0); // variance = 1 per domain
    for(let i=0; i<D; i++){
      if(bank.prior_covariance && bank.prior_covariance[i] && Number.isFinite(bank.prior_covariance[i][i]) && bank.prior_covariance[i][i] > 0){
        priorVar[i] = bank.prior_covariance[i][i];
      }
    }
    const priorPrec = priorVar.map(v => 1.0 / v); // precision = 1/variance

    // Initialize theta from session, converting nulls to 0
    let theta = new Array(D).fill(0);
    if(s.theta_vec){
      for(let i=0; i<D; i++){
        const v = s.theta_vec[i];
        theta[i] = (v !== null && v !== undefined && Number.isFinite(v)) ? v : 0;
      }
    }

    // Newton-Raphson with DIAGONAL Hessian (much more stable)
    const maxIter = 50;
    for(let iter=0; iter<maxIter; iter++){
      // Per-domain gradient and Hessian (diagonal only)
      const grad = new Array(D).fill(0);
      const hess = new Array(D).fill(0);

      // Prior contribution: -priorPrec[d] * theta[d]
      for(let d=0; d<D; d++){
        grad[d] = -priorPrec[d] * theta[d];
        hess[d] = -priorPrec[d];
      }

      // Item likelihood contributions
      for(const a of s.administered){
        const it = bank.items[a.item_id];
        if(!it) continue;
        const d = domIndex[it.domain];
        if(d === undefined || d === null) continue;
        let resp = (typeof a.response === 'number') ? a.response : 0;

        // CRITICAL: Clamp response to valid range [0, K-1] BEFORE any processing
        // This prevents out-of-range indices from corrupting likelihood updates
        const K = (it.thresholds ? it.thresholds.length + 1 : it.K || it.n_categories || 5);
        resp = Math.max(0, Math.min(K - 1, Math.floor(resp)));

        // RESPONSE DIRECTION CORRECTION:
        // IRT calibration encodes: 0 = lowest observed numeric value in data.
        // Response options in bank are stored in DISPLAY order (first shown = index 0).
        //
        // For 'worse' symptom domains (Anxiety, Depression, Fatigue):
        //   Calibrated val 1 = Never (best/lowest symptom) → IRT index 0 = best
        //   Display opts[0] = Never (best) → choiceIndex 0 = best → IRT 0 = best ✅ no flip
        //
        // For 'worse' function domains (Physical_Function, Participation):
        //   PF calibrated val 1 = Unable to do (worst) → IRT index 0 = worst
        //   PF display opts[0] = Without difficulty (best) → choiceIndex 0 = best → IRT 0 = worst ❌ flip needed
        //   Participation calibrated val 1 = Never (best) → IRT index 0 = best
        //   Participation display opts[0] = Always (worst) → choiceIndex 0 = worst → IRT 0 = best ❌ flip needed
        //
        // For 'better' SRS domains:
        //   Calibrated val 1 = worst (Severely, Bedridden, etc.) → IRT index 0 = worst
        //   Display opts[0] = best (None, Full activities, etc.) → choiceIndex 0 = best → IRT 0 = worst ❌ flip needed
        //
        // Rule: flip when display[0] != calibration[0]:
        //   - Symptom domains (Anxiety/Depression/Fatigue): No flip (both 0=best)
        //   - Physical_Function: Flip (display 0=best, calib 0=worst)
        //   - Participation: Flip (display 0=worst, calib 0=best — net result same as flip)
        //   - All SRS (better): Flip (display 0=best, calib 0=worst)
        const needsFlip = (it.domain === 'Physical_Function' ||
                           it.domain === 'Participation' ||
                           (it.higher_theta_means === 'better'));
        if (needsFlip) {
          resp = (K - 1) - resp;
          // Re-clamp after flip (should be redundant but ensures safety)
          resp = Math.max(0, Math.min(K - 1, resp));
        }

        const {grad: g, hess: h} = itemGradHess(theta[d], it, resp);
        grad[d] += g;
        hess[d] += h;
      }

      // Newton step: delta = -grad / hess (diagonal, so trivial inversion)
      let maxChange = 0;
      const newTheta = theta.slice();
      for(let d=0; d<D; d++){
        const denom = hess[d] - 0.01; // small damping for stability
        if(Math.abs(denom) < 1e-8) continue; // skip if denominator too small
        let step = -grad[d] / denom;
        // Clamp step size to prevent explosion
        step = Math.max(-1.0, Math.min(1.0, step));
        newTheta[d] = theta[d] + step;
        // Clamp theta to valid range [-4, 4] (T-score 10 to 90)
        newTheta[d] = Math.max(-4.0, Math.min(4.0, newTheta[d]));
        maxChange = Math.max(maxChange, Math.abs(step));
      }

      theta = newTheta;

      if(maxChange < 1e-4) break;
    }

    // Final safety clamp
    for(let i=0; i<D; i++){
      if(!Number.isFinite(theta[i])) theta[i] = 0;
      theta[i] = Math.max(-4.0, Math.min(4.0, theta[i]));
    }

    s.theta_vec = theta;
    for(let i=0; i<D; i++) s.theta[bank.domains[i]] = theta[i];
  }

  
  function eligibleCandidates(bank, s){
    // Remaining items after applying pair-exclusion constraints (if provided)
    let cand = Array.isArray(s.remaining) ? s.remaining.slice() : [];
    const constraints = bank.pair_exclusion_constraints || bank.pair_exclusion || null;
    if (!constraints) return cand;

    // Build fast lookup: item -> set(excluded items)
    // Accept both {pairs:[[a,b],...]} and {a:[b,c],...} styles.
    const excludedMap = new Map();
    const addPair = (a,b) => {
      if (!excludedMap.has(a)) excludedMap.set(a, new Set());
      excludedMap.get(a).add(b);
    };

    if (Array.isArray(constraints.pairs)) {
      for (const p of constraints.pairs){
        if (!p || p.length<2) continue;
        addPair(p[0], p[1]); addPair(p[1], p[0]);
      }
    } else {
      for (const [a, arr] of Object.entries(constraints)){
        if (a === "meta") continue;
        if (Array.isArray(arr)) for (const b of arr){ addPair(a,b); addPair(b,a); }
      }
    }

    const asked = new Set(s.administered.map(x=>x.item_id));
    // Any remaining item that conflicts with an already-asked item is removed
    cand = cand.filter(id => {
      for (const a of asked){
        const ex = excludedMap.get(a);
        if (ex && ex.has(id)) return false;
      }
      return true;
    });
    return cand;
  }

function checkStop(bank, s){
    const cfg = bank.cat_config || {};
    const n = s.administered.length;
    const maxItems = (cfg.max_items ?? 18);
    const minItems = (cfg.min_items ?? 0);

    // Enforce minimum coverage without preventing termination at maxItems.
    // Goal: avoid zero-item domains and reduce prior-only (T=50/SD=0) failures.
    const srs_domains = ['SRS_Pain', 'SRS_Function', 'SRS_Self_Image', 'SRS_Mental_Health', 'SRS_Satisfaction'];
    const promis_domains = ['Physical_Function', 'Participation', 'Fatigue', 'Anxiety', 'Depression'];

    // Per-domain minimum exposure (must be feasible within maxItems).
    // Keep SRS minima modest (small pools / lower discrimination).
    const min_items_by_domain = {
      Participation: 2,
      SRS_Mental_Health: 1,
      SRS_Satisfaction: 1,
      SRS_Pain: 1,
      SRS_Function: 1,
      SRS_Self_Image: 1,
      Physical_Function: 1,
      Fatigue: 1,
      Anxiety: 1,
      Depression: 1
    };

    let srs_min_met = true;
    let promis_min_met = true;

    for (const domain of srs_domains) {
      const req = (min_items_by_domain[domain] ?? 1);
      if ((s.domain_counts[domain] || 0) < req) { srs_min_met = false; break; }
    }
    for (const domain of promis_domains) {
      const req = (min_items_by_domain[domain] ?? 1);
      if ((s.domain_counts[domain] || 0) < req) { promis_min_met = false; break; }
    }

    // Respect configured minimum items first
    if (n < minItems) return { stop:false, reason:null };

    // Respect domain coverage rule (e.g., >=4 domains) if configured
    if (cfg.domains_min != null) {
      const covered = new Set(s.administered.map(x => x.domain));
      if (covered.size < cfg.domains_min) {
        // But still stop if we hit the max items
        if (n >= maxItems) return { stop:true, reason:"max_items" };
        return { stop:false, reason:null };
      }
    }

    // If minimum per-domain exposure not met, keep going until maxItems (do NOT exceed maxItems)
    if (!srs_min_met || !promis_min_met) {
      if (n >= maxItems) return { stop:true, reason:"max_items" };
      return { stop:false, reason:null };
    }

    // Precision-based stopping
    // NOTE: In mixed PROMIS+SRS banks, SRS domains (small pools, lower discrimination) may never reach the same
    // precision targets as PROMIS within a short test. To avoid forcing maxItems every time, we allow stopping
    // based on PROMIS-only global precision once minimum domain exposure requirements are met.
    const thr_all = (cfg.global_SE_threshold ?? cfg.target_global_se ?? 0.35);
    const gse_all = globalSE(s);

    // PROMIS-only RMS SE
    const promis_ses = promis_domains
      .map(d => s.se[d])
      .filter(v => typeof v === "number");
    const gse_promis = (promis_ses.length)
      ? Math.sqrt(promis_ses.reduce((acc,v)=>acc+v*v,0)/promis_ses.length)
      : null;

    const thr_promis = (cfg.promis_SE_threshold ?? thr_all);

    // Prefer full precision when achievable; otherwise allow PROMIS precision stop.
    if (gse_all !== null && gse_all <= thr_all) return { stop:true, reason:"precision_reached_all_domains" };
    if (gse_promis !== null && gse_promis <= thr_promis) return { stop:true, reason:"precision_reached_promis" };


    // Hard cap
    if (n >= maxItems) return { stop:true, reason:"max_items" };

    // Bank exhausted
    if (cfg.stop_if_bank_exhausted) {
      const cand = eligibleCandidates(bank, s);
      if (!cand || cand.length === 0) return { stop:true, reason:"bank_exhausted" };
    }

    return { stop:false, reason:null };
  }

  function finish(bank, norms, s, reason){
    const normsMap = (norms && norms.domains) ? norms.domains : norms;
    s.is_finished = true;
    s.stop_reason = reason || s.stop_reason || "finished";
    updateSE(bank, s);

    // Build clinician-facing results object
    const domainResults = [];
    const domainIds = (bank.domains || []).map(d => (typeof d === "string" ? d : d.id)).filter(Boolean);

    // helper percentile from norms (supports either {mean,sd} or {p05,p50,p95} etc)
    function normalCdf(z){
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const d = 0.3989423 * Math.exp(-z*z/2);
      let p = d*t*(0.3193815 + t*(-0.3565638 + t*(1.781478 + t*(-1.821256 + t*1.330274))));
      if (z > 0) p = 1 - p;
      return p;
    }
    function toPercentile(theta, norm){
      if (!norm) return null;
      // Preferred: theta_scale percentiles table from empirical data
      if (norm.theta_scale && norm.theta_scale.percentiles){
        const pts = norm.theta_scale.percentiles;
        // convert {p5:val,...} into sorted list
        const arr = Object.entries(pts)
          .map(([k,v])=>({p:parseFloat(k.replace(/^p/i,'')), v}))
          .filter(o=>Number.isFinite(o.p) && typeof o.v==="number")
          .sort((a,b)=>a.v-b.v);
        if (arr.length){
          // find bracket
          if (theta <= arr[0].v) return Math.round(arr[0].p);
          if (theta >= arr[arr.length-1].v) return Math.round(arr[arr.length-1].p);
          for (let i=0;i<arr.length-1;i++){
            const a=arr[i], b=arr[i+1];
            if (theta >= a.v && theta <= b.v){
              const t=(theta-a.v)/(b.v-a.v);
              return Math.round(a.p + t*(b.p-a.p));
            }
          }
        }
      }
      // Fallback: assume standard normal theta
      const z = theta;
      return Math.round(100 * normalCdf(z));
    }
    function severityBand(theta, norm){
      // If we have empirical percentile-based bands in the norms, use percentile
      if (norm && norm.severity_bands){
        const pct = toPercentile(theta, norm);
        if (pct === null) return "";
        if (pct <= 20) return "Very low";
        if (pct <= 40) return "Low";
        if (pct <= 60) return "Moderate";
        if (pct <= 80) return "High";
        return "Very high";
      }
      // Fallback: SD cutoffs on theta (assume mean=0, sd=1)
      const z = theta;
      if (z <= -1.0) return "Low";
      if (z < 1.0) return "Typical";
      if (z < 2.0) return "High";
      return "Very high";
    }

    for (const did of domainIds){
      const theta = (s.theta && typeof s.theta[did] === "number") ? s.theta[did] : 0;
      const se = (s.se && typeof s.se[did] === "number") ? s.se[did] : null;

      const norm = normsMap && normsMap[did] ? normsMap[did] : null;
      const pct = toPercentile(theta, norm);
      const sev = severityBand(theta, norm);

      const t_score = 50 + 10*theta;
      domainResults.push({
        domain: did,
        theta,
        se,
        t_score,
        percentile: pct,
        severity: sev,
        clinical_note: ""
      });
    }

    const itemsAdmin = (s.administered || []).map(r => {
      const it = bank.items && bank.items[r.item_id] ? bank.items[r.item_id] : null;
      const opt = (it && it.response_options && Array.isArray(it.response_options)) ? it.response_options : [];
      const idx = (typeof r.response === "number") ? r.response : r.choice_index;
      const chosen = (typeof idx === "number" && opt[idx]) ? opt[idx] : null;
      return {
        item_id: r.item_id,
        domain: it ? it.domain : (r.domain || ""),
        stem: it ? (it.stem || it.label || it.item_text || "") : "",
        response: chosen ? (chosen.label || chosen.text || chosen) : idx
      };
    });

    s.global_SE = globalSE(s);
    s.results = {
      total_items: (s.administered || []).length,
      stop_reason: s.stop_reason,
      global_SE: s.global_SE,
      domain_results: domainResults,
      items_administered: itemsAdmin
    };

    return s;
  }
function answer(bank, norms, s, itemId, responseIdx){
    const item = bank.items[itemId];
    s.administered.push({item_id: itemId, response: responseIdx, domain: item.domain, ts: new Date().toISOString()});
    s.domain_counts[item.domain] = (s.domain_counts[item.domain]||0) + 1;
    // remove from remaining
    s.remaining = s.remaining.filter(id=>id!==itemId);

    // update covariance first (normal approx)
    updatePosteriorCov(bank, s, item);
    updateSE(bank, s);

    // MAP update theta
    mapUpdateTheta(bank, s);

    // stopping
    const stopCheck = checkStop(bank, s);
    if (stopCheck && stopCheck.stop){
      s.stop_reason = stopCheck.reason || s.stop_reason || "finished";
      return finish(bank, norms, s, s.stop_reason);
    }

    // select next
    s.current_item_id = selectNextItem(bank, s);
    if (s.current_item_id === null || s.current_item_id === undefined){
      return finish(bank, norms, s, "bank_exhausted");
    }
    return s;
  }

  function backOne(bank, norms, s){
    if (!s.administered.length) return s;
    // Rebuild session from scratch by replaying answers up to n-1 (simpler + safe)
    const answers = s.administered.slice(0, -1);
    const bank0 = bank;
    const session = createSession(bank0, norms, s.constraints_raw || null);
    session.administered = [];
    session.remaining = Object.keys(bank0.items);
    session.domain_counts = {};
    session.theta_vec = new Array(bank0.domains.length).fill(0);
    session.theta = Object.fromEntries(bank0.domains.map((d,i)=>[d,0]));
    session.Sigma = deepCopy(bank0.prior_covariance);
    session.is_finished = false;
    session.stop_reason = null;

    for (const a of answers){
      answer(bank0, norms, session, a.item_id, a.response);
      if (session.is_finished) break;
    }
    return session;
  }

  return {
    createSession,
    nextItem,
    getCurrentItem,
    answer,
    backOne,
    finish,
    globalSE
  };
})();


// Browser exports
if (typeof window !== 'undefined') {
  window.JointCATEngine = JointCATEngine;
  // Factory that returns an engine instance with nextItem/getNextItem API expected by app.js
  function coverageNeeded(bank, s){
    const need=[];
    const req = (s.required_domains && Array.isArray(s.required_domains) && s.required_domains.length)
      ? s.required_domains
      : (bank.domains || []);
    for(const d of req){
      if (!s.domain_counts[d]) need.push(d);
    }
    return need;
  }

  function createJointCATEngine({ bank, itembank, norms, pair_constraints, constraints } = {}) {
    // Some UI builds keep assets on window.__CAT_ASSETS__. Provide a robust fallback
    // so the engine can still start even if the caller forgets to pass "bank".
    const globalAssets = (typeof window !== 'undefined' && window.__CAT_ASSETS__) ? window.__CAT_ASSETS__ : null;
    const _bank = bank || itembank || (globalAssets && globalAssets.bank) || null;
    const _norms = norms || (globalAssets && globalAssets.norms) || null;
    const _constraints = pair_constraints || constraints || (globalAssets && (globalAssets.pair_constraints || globalAssets.constraints)) || (_bank && _bank.constraints_raw) || null;
    let _session = JointCATEngine.createSession(_bank, _norms, _constraints);

    return {
      getNextItem: () => JointCATEngine.nextItem(_bank, _session),
      nextItem: () => JointCATEngine.nextItem(_bank, _session),
      answer: (itemId, choiceIndex) => {
        const s2 = JointCATEngine.answer(_bank, _norms, _session, itemId, choiceIndex);
        if (s2) _session = s2;
        return { done: !!_session.is_finished, results: _session.results || null, session: _session };
      },
      isFinished: () => !!_session.is_finished,
      getResults: () => (_session.results || JointCATEngine.finish(_bank, _norms, _session, _session.stop_reason)),
      _getSession: () => _session
    };
  };

  // Expose factory on window for app.js
  window.createJointCATEngine = createJointCATEngine;
}

// --- RNG helper (deterministic per-session) ---
function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
