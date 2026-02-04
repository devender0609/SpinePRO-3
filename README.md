# SpinePRO Joint-CAT (Full Model Scaffold)

This is a **static deployable** Joint-CAT prototype that merges PROMIS + SRS item banks into one adaptive engine.

## What this does
- Loads the item bank from: `assets/itembank_joint.json`
- Uses **IRT** scoring (GRM if `b` is an array of thresholds; otherwise 2PL)
- Performs **content balancing** (coverage pass) + **adaptive information selection**
- Stops at variable length:
  - after `minItems`
  - AND once all required domains have at least `minPerDomain` items (when possible)
  - AND global posterior SD <= target threshold
  - OR at `maxItems`

## Replace with your real bank
Replace:
- `assets/itembank_joint.json`

Your items should look like:

```json
{
  "id":"PI_xxx",
  "instrument":"PROMIS",
  "domain":"PI",
  "stem":"How much did pain interfere…",
  "choices":["Not at all","A little bit","Somewhat","Quite a bit","Very much"],
  "a":1.2,
  "b":[-1.8,-0.6,0.4,1.4]
}
```

If you only have 2PL parameters, use scalar `b` and two choices.

## Deploy (Vercel)
- Import the GitHub repo in Vercel
- No build command needed (static)
- Ensure root directory is repo root (leave blank)

## Pages
- `/index.html`
- `/survey_joint.html`
- `/results_joint.html`

## Clinical results (prototype)
The results page shows a **proxy T-score** (`T = 50 + 10*theta`) and interpretation bands.
Replace this mapping with validated PROMIS / SRS scoring once calibration is final.
