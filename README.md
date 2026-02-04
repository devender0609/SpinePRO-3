# SpinePRO Joint-CAT (PROMIS + SRS) — prototype scaffold

This is a **static (no backend)** prototype that runs entirely in the browser and stores the most recent run in `localStorage`.

## What this build does
- Loads a combined item bank from `assets/itembank_joint.json`
- Runs a **multidomain adaptive** survey:
  - Ensures **content balance** (≥1 item per domain first)
  - Then prioritizes domains with higher uncertainty
  - Stops when uncertainty targets are met or at a max cap
- Writes a clinician-facing **results summary** to `results_joint.html`

## IMPORTANT clinical note
- Item text is taken from the PROMIS short forms and SRS-22 that were provided.
- **IRT parameters in this build are placeholders** and must be replaced with validated calibrations before any clinical use.
- PROMIS proxy scores on the results page use `T = 50 + 10·theta` as a display-only scaffold (not official PROMIS scoring).

## Files
- `survey_joint.html` : survey UI
- `results_joint.html` : results UI
- `assets/jointcat.js` : adaptive engine
- `assets/results.js` : results rendering
- `assets/itembank_joint.json` : combined item bank
- `vercel.json` : static deployment config

## Deploy
Works on Vercel as a static site. If using GitHub+Vercel, just push the repo and deploy.
