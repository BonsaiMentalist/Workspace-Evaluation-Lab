# Specialist Evaluation Lab

A private workbench, running on your own computer, for checking how well AI models and specialist agents do their real jobs.

You give it **evaluation cases** (a task, the material the specialist had, and what a good answer looks like). You load **saved outputs** from different models or configurations. The lab then helps you judge those outputs criterion by criterion, compare them blind, and keep a clear record of how every judgement was made.

It does not call any AI service, needs no API keys, and sends nothing over the internet.

## Install and start

You need **Node.js 20.11 or newer**. If you don't have it, install the "LTS" version from [nodejs.org](https://nodejs.org) with the default options.

Open a terminal in this folder. On Windows: open the folder in File Explorer, click the address bar, type `cmd` and press Enter.

1. Install (once):

   ```bash
   npm install
   ```

2. Start:

   ```bash
   npm start
   ```

Your browser opens at `http://localhost:4317` by itself. To stop the lab, press **Ctrl+C** in the terminal.

The first time it starts, the lab loads a set of **made-up examples** for every specialist, so each page has something to show. They are labelled *Synthetic example*. You can remove them at any time on **Settings / Data**.

## Using it

The left-hand menu follows the order of the work.

| Page | What it is for |
|---|---|
| **Overview** | What needs your attention: cases awaiting validation, imported assessments awaiting your check, comparisons awaiting a preference. |
| **Evaluation Library** | Every case. Create a case as a *candidate*, **validate** it (the lab lists anything missing), then **freeze** it so its test conditions are fixed. Editing a frozen case makes a new version; the old one and its results stay as they were. |
| **Specialist Profiles** | What each specialist is judged on. Criteria are *core* or *optional*, and some are *mandatory*: if a mandatory one fails, the result is a **critical failure**, however well everything else went. Editing a profile creates a new version. |
| **Evaluate** | Pick a frozen case, add or import outputs, then **score by hand** or **run automatic checks**. You can also import assessments made elsewhere (for example by an AI reviewer) and test-runner results. |
| **Spot-check** | Assessments imported from an AI reviewer wait here until you accept, correct or reject them. Once you have checked a few one by one, you can accept the rest of the batch together. Until then they count nowhere. |
| **Compare** | Compare outputs **blind**: they appear as Output A and Output B, and you pick one (or call it a tie, or inconclusive) with a reason *before* the models are revealed. The report then shows which criteria favoured which output, and says plainly whether the conditions were comparable. |
| **History** | Every past result, grouped by specialist, model and configuration, with a warning wherever results are not directly comparable. |
| **Observations** | Things you noticed in real use. One can become a candidate case, but an observation is never treated as proof of a general weakness. |
| **Settings / Data** | Where your data lives, how it is protected, export and import, file formats, and the light/dark theme. |

### A first walk-through with the examples

1. Open **Evaluate**, then *Orders three queued jobs where two collide on the same files*, then **Criterion-level report**. This shows how three outputs differ.
2. Open **Spot-check** and look at an AI reviewer's assessment. Accept one, then correct another by changing a finding. The original stays visible beside your correction.
3. Open **Compare** and choose the waiting blind comparison. Read both outputs and record your preference; the identities are revealed only after that.
4. Open **Evaluation Library**, choose **New case**, write one of your own, then validate and freeze it.

## Your data and privacy

- Everything you create or import is stored in the **`data`** folder inside this folder. Git ignores that folder, so it is never committed or uploaded.
- The lab only answers on this computer (`localhost`). Other devices on your network cannot reach it.
- It makes no internet connections and has no telemetry.
- Imported files are treated as untrusted. Every field is checked, nothing inside them is ever run, and text is always shown as plain text.
- Images must be PNG, JPEG or WebP, up to 5 MB, and are checked by their contents rather than their names.
- To back up, copy the `data` folder or use **Export everything** on Settings / Data. An export may contain private material, so keep it somewhere safe.

To keep the data somewhere else, set `EVAL_LAB_DATA_DIR` before starting (for example `set EVAL_LAB_DATA_DIR=D:\lab-data` on Windows, then `npm start`). If port 4317 is busy, the lab tries the next free port and tells you which one it used.

## Importing work done elsewhere

The lab reads JSON files in documented formats. Each format is listed on **Settings / Data**, with its JSON Schema linked there and saved in [`schemas/`](schemas). Ready-made examples:

- `fixtures/assessments/ai-reviewer-batch.json` is a batch of AI-reviewer assessments. It includes one deliberately broken entry, so you can see how a rejection is reported.
- `examples/executable/engineering-test-report.json` is a test-runner report.
- `examples/analytics-join/` shows how a result lines up with a Workspace Analytics job line.

## For whoever maintains it

```bash
npm test
```

```bash
npm run typecheck
```

`npm test` runs all automated tests: no network, no API keys. `npm run typecheck` checks the TypeScript.

Other commands:

- `npm run schemas` regenerates `schemas/` after a format changes.
- `npm run check-fixtures` validates the synthetic suite.
- `npm run examples` regenerates `examples/runner-compat/`.
- `npm run screenshots -- http://localhost:4317 docs/screenshots` captures every page in both themes. It needs Playwright, which is not an app dependency.

How it is built and how later stages fit on: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). What Stage 1 includes and leaves out: [`docs/COMPLETION_REPORT.md`](docs/COMPLETION_REPORT.md).
