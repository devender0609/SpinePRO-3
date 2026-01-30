# SpinePRO Joint-CAT (Multidomain Prototype)

This repo is a **deployable prototype** of a *single* integrated adaptive questionnaire (PROMIS + SRS items in one engine).

## What this build does
- Loads a combined item bank (PROMIS + SRS) from **/api/bank** (serverless) with a fallback to `/assets/itembank_joint.json`.
- Runs a **single engine** with:
  - **Content balancing**: ensures ≥1 item per domain first
  - Then selects items from the **domain with highest uncertainty** (proxy SD)
- Stores the most recent run in `localStorage` and renders a results page.

## What this build does NOT do (yet)
- It is **NOT** an official PROMIS CAT nor an official SRS CAT.
- The scoring is a **prototype proxy**: domain theta is updated via a lightweight rule and mapped to `T = 50 + 10·theta`.
- No psychometric validation is claimed.

## Deploy (Vercel)
1. Push this folder to GitHub.
2. In Vercel, import the repo.
3. Framework preset: **Other**
4. Build command: **None**
5. Output: **Static + Serverless** (Vercel detects `/api/*` automatically)

Routes:
- `/` → index
- `/survey_joint.html` → survey
- `/results_joint.html` → results
- `/api/bank` → item bank JSON
- `/api/health` → health check

## Next step (scientific path)
Replace the proxy update rules with your planned **multidimensional IRT calibration** and a published scoring spec:
- Fix item parameters (discrimination + thresholds) per domain
- Use MIRT/MDCAT selection (maximize expected info / minimize posterior variance)
- Cross-validate domain structure and linking/crosswalks
