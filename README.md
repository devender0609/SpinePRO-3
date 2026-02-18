# SpinePRO Joint CAT (Web Prototype)

This is a **static** (no backend) Vercel-ready adaptive survey prototype for a combined PROMIS + SRS multidomain CAT.

## Files
- `index.html` start page
- `survey.html` adaptive survey
- `results.html` results rendering
- `assets/itembank_runtime.json` calibrated bank export
- `assets/domain_norms_REAL.json` sample-referenced norms (N=897)
- `assets/cat_engine.js` CAT logic (between-item multidimensional GRM, MAP + A-optimal selection)
- `vercel.json` static deployment config

## Deploy to Vercel
1. Push this folder contents to the **root** of your GitHub repo.
2. Import project into Vercel.
3. Framework preset: **Other**
4. Build command: **None**
5. Output directory: **/** (root)
6. Deploy.

## Notes
- Constraints (pair exclusions) are not included in this build because the provided constraints file used different item IDs than this runtime bank.
