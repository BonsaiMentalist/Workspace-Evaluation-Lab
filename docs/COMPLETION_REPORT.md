# Completion report: Specialist Evaluation Lab, Stage 1

## Summary

Stage 1 is a working local application: create a case → validate and freeze it → load outputs → score them by hand or by import → compare them blind → export. Every step of that core loop is in place and tested end to end. Everything the brief marks *never cut* is in: the security tests, the imported-assessment path, the blinded comparison and the dark theme default. Of the five items the brief allows to be cut, **one was cut**: charts on the History page (see "Cuts").

## What was implemented

| Brief section | Implemented |
|---|---|
| §2 Scope | TypeScript and Node. `npm install` then `npm start`, which opens the browser. Local only, with no external calls, keys or telemetry. Data is kept in a git-ignored `data/` folder. |
| §4 Profiles | Seven versioned, data-driven profiles: Master (including the two [v2] core criteria), Engineering (versions 1 and 2), Research, Lore (with literary prose as an optional capability reported separately), Designer (agent work and tool output judged apart), Trading Analysis and Trading Psychology. Each criterion is core or optional, may be mandatory, and has its methods and weight. New specialists and criteria are added through the UI or a JSON import, with no code change. |
| §5 Case lifecycle | Candidate → Validated → Frozen → Evaluated, with a plain-language list of what is missing. Stable ids, immutable frozen versions protected by a content hash, and edits that create new versions. Cases can be held out, archived, inspected, created by hand, imported, or created from an observation. A test-input download never includes answers. Compatible with the existing runner (freeze-set hash, baseline, known failure). |
| §6 Methods | A: deterministic checks. B: manual assessment, including inconclusive and not applicable. C: blinded comparison. D: the executable-report contract, plus an import. E: imported assessments with spot-check, correction and batch acceptance. F: the AI-judge interface only. |
| §7 Records | Results keep the case and version, profile and version, model, provider and effort, configuration and fingerprint, context and tool configuration ids, an output reference, method, evaluator identity and type, findings, overall outcome, uncertainty, exclusions, limitations, date, run id, resources with provenance, and Workspace job and reply ids. Unknown is `null` and is shown as "unknown". |
| §8 Scoring | Criterion-level outcomes and ratings. Configurable weights that never hide a mandatory failure. Comparison reports show which criteria favour each output, practical significance, uncertainty, whether there are enough observations, whether a further experiment is justified, and an equivalence verdict. |
| §9 Interface | All nine areas: Overview, Evaluation Library, Specialist Profiles, Evaluate, Spot-check, Compare, History, Observations and Settings / Data. Each page opens with a one-sentence explanation, and unavoidable terms carry an ⓘ. The warm charcoal dark theme is the default, with a light option. All colours are in `public/theme.css`, and every text pair meets WCAG AA in both themes. |
| §10 Formats | Sixteen JSON Schemas, generated from the code. JSON import and export with strict validation, plain-language errors, refusal of newer versions and defaults for older files. CSV export. The Analytics v1.1 join contract, with an example pair. |
| §11 Observations | A form, an import, a list and detail view, investigation status, and "create a candidate case from this". |
| §12 Security | Localhost only, with a host check against DNS rebinding. Origin and CSRF checks. Strict CSP. Escaped templates. Path containment. Image type checked from the file's bytes, with a size limit. Bounded input sizes. Logs that never record form contents. Synthetic and user data labelled apart. |
| §13 Starter suite | 24 cases across all seven specialists: successful and unsuccessful outputs, 4 ambiguous, 4 held-out, 3 candidates and 2 validated. 40 outputs, 21 human results, an 8-entry AI-reviewer batch (plus 1 malformed entry and 1 comparison), 5 observations, and 4 original synthetic images. |

## What was tested

`npm test` runs 201 automated tests in 11 files, with no network, keys or AI models. All pass. `npm run typecheck` is clean.

| Brief §14 requirement | Where |
|---|---|
| Profile and benchmark versioning | `profiles.test.ts`, `cases.test.ts` |
| Validation and state transitions | `cases.test.ts`, `workflow.test.ts` |
| Scoring rules; mandatory versus optional | `scoring.test.ts` |
| Blinded comparisons | `comparisons.test.ts`, `workflow.test.ts` (HTML checked for leaks) |
| Historical comparability | `comparisons.test.ts` (rubric change, thin evidence, equivalence) |
| Import and export compatibility | `bundle.test.ts`, `workflow.test.ts`, `profiles.test.ts` (schema files match the code) |
| Imported assessments: identity, spot-check state, correction keeps both, malformed entry rejected clearly | `imports.test.ts` |
| Analytics join ids line up | `contracts.test.ts` |
| Missing and unknown data | `bundle.test.ts`, `workflow.test.ts` |
| Privacy and file-handling boundaries | `security.test.ts` (host, origin, CSRF, XSS, traversal, disguised SVG, oversize, logs, git-ignore, no `eval`/network/`child_process` in source) |
| Reproducibility of deterministic assessments | `checks.test.ts` |
| Inconclusive behaviour | `scoring.test.ts`, `workflow.test.ts`, `comparisons.test.ts` |
| Full synthetic workflow (steps 1–8 of §14) | `workflow.test.ts`, through the real HTTP routes |
| Accessibility basics | `theme.test.ts` (AA contrast in both themes, dark default, an intro sentence on every page) |

Also checked by hand:

- a crawl of all 311 internal pages (no errors);
- screenshots of every page in both themes;
- a phone-width check (no horizontal scrolling);
- `scripts/check-fixtures.ts`, which validates the suite and cross-references and prints each check's outcome.

## Cuts (brief §17)

1. CSV export: **kept**.
2. Charts on the History page: **cut**. History is a sortable, filterable table with grouped counts and comparability warnings.
3. Designer image handling: **kept**. Images are used as context, as tool output in outputs, in the blind view, and as uploads.
4. Production observations screen: **kept**.
5. Executable assessment contracts: **kept**, with an import as well as the documented interface.

## Decisions taken without an explicit instruction (please confirm or change)

- **Imported assessments from a *person*** do not need a spot-check. Only `ai-reviewer` imports start as *needs spot-check*, as the brief says.
- **Batch acceptance** unlocks after `max(2, 20%)` of a batch, capped at its size, has been checked one by one.
- **Corrected AI assessments** are labelled *AI reviewer, corrected by owner*, as a separate kind of evaluator in every report.
- **The comparison report declines to pick a winner** on a criterion that different kinds of evaluator assessed for different outputs. For example, if one output was scored by you and the other by an AI reviewer, that criterion shows "cannot compare".
- **Equivalence.** Exactly one differing setup variable (model, effort, configuration, context or tools) counts as *equivalent*. More than one counts as *partially equivalent*.
- **Practical significance** means a pass versus fail difference, any failure of a mandatory criterion, or a rating gap of at least 40% of the scale. "Passed" versus "partly met" is minor.
- **Your name** is recorded as "Owner" on validations, freezes and spot-checks. A setting for this could follow.
- **The Analytics schema document** is not copied into the repository. The architecture note quotes the fields the join uses.

## Limitations and unfinished work

- Blinding can be defeated by an output that names its own model; the blind page warns about this.
- Deterministic checks are textual (wording, labels, JSON fields, citations, length). Every finding says they cannot judge meaning.
- Storage is JSON files: fine for thousands of records, not for millions. There is no multi-user locking; this is a single-user app.
- Records cannot be deleted from the UI. Cases can be archived; synthetic examples can be removed in bulk; anything else is removed by editing the data folder.
- Saved outputs cannot be edited after saving, by design. Re-add an output to correct it.
- Only format version 1 exists, so there is no migration code yet. A newer version is refused with a clear message.
- Development and tests ran on Linux. The app uses no native modules and only `node:path`-based paths, so `npm install` and `npm start` should work unchanged on Windows, **but it has not been run on Windows**. A first launch there is the remaining manual check.
- Out of scope, as the brief requires: direct AI Workspace integration, reading Analytics files, AI judging, model routing, autonomous experiments and workflow evaluation.

## Independent review

_To be completed after the review._
