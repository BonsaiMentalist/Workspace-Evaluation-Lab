# Architecture note: Specialist Evaluation Lab, Stage 1

This note explains the major decisions and how later stages plug in. The brief is `EVALUATION_LAB_BRIEF_v2.md`. The cost-side contract is `ANALYTICS_EXPORT_SCHEMA_v1.1.md` (Workspace Analytics). This repository does not contain either document; where this note relies on them, it quotes the relevant parts.

## 1. Shape of the application

```
src/
  domain/        Pure logic and formats. No file or network access.
    schemas.ts       zod formats for every record (format version 1)
    cases.ts         case lifecycle, freeze hash, versioning, answer-free test input
    checks.ts        deterministic checks
    scoring.ts       criterion findings → outcome; evaluator-kind labels
    imports.ts       imported outside assessments and spot-checking
    comparisons.ts   blinded comparisons
    report.ts        comparison reports, equivalence, History
    results.ts       building manual and check results
    bundle.ts        export / re-import / CSV
    extensions/      analyticsJoin.ts, executable.ts, judge.ts (contracts for later stages)
  storage/       JSON-file store (data/records/*.json) and image attachments
  seed/          loads the synthetic suite from fixtures/
  server/        Express app, security middleware, HTML helpers, one module per page area
public/          theme.css (every colour), style.css (layout), app.js (optional enhancement)
fixtures/        synthetic starter suite, AI-reviewer batch, observations, images
examples/        Analytics join pair, executable report, runner-compat records
schemas/         JSON Schema per format, generated from the zod formats
tests/           vitest: unit, HTTP and end-to-end workflow tests
```

**Stack.** Node.js and TypeScript (run directly with `tsx`, so there is no build step), Express 5, zod 4, multer for uploads, and vitest with supertest for tests. There are no native modules, so `npm install` works on Windows without build tools. Pages are rendered on the server as plain HTML forms, and there is no client framework. That keeps the attack surface and the moving parts small, and every page works with JavaScript disabled.

**Storage.** There is one JSON file per collection under `data/records/`. Writes are atomic (a temporary file, then a rename) and serialised through a single queue, and every record is validated before it is written. This scales comfortably to thousands of records, which suits a one-person local lab. A database would add install friction on Windows without improving Stage 1. Because the store's interface is small (`add`, `addMany`, `replace`, `snapshot`), it can be swapped out later.

## 2. Data model

Every record names its format (`schema`, `schemaVersion: 1`). A file from a newer, unknown version is refused, never guessed at. Fields added later get defaults, so older files still load. Unknown values are `null`, never `0`, the same rule the Analytics export uses.

| Record | Key points |
|---|---|
| **Specialist profile** (`id` + `version`) | Capabilities and criteria. Each criterion has: `tier` (core/optional); `mandatory`; `methods`; `weight`; `assesses` (the agent's own work, a tool's output, or both); `scale` (outcome or rating); and rubric `guidance`. Versions are immutable, and an edit adds a version. New specialists are pure data, with no code change. |
| **Evaluation case** (`id` + `version`) | Has a lifecycle `status`, `split` (development or held-out), and the rubric version it was written for. It also holds: task, context items (marked authoritative where they settle correctness), expected behaviour, acceptance criteria, reference answer, evidence, methods, deterministic checks, limitations, ambiguity, provenance, privacy, `freeze` (with its content hash) and `externalRef`. |
| **Saved output** | The agent's own text, kept apart from `toolArtifacts` (for example a generated image, with the tool's identity). Also records `producedBy` (model, provider, effort), `configuration` (configuration id or fingerprint, context and tool configuration ids), `workspace` join keys, `resources` (tokens, duration and steps, with provenance), privacy and provenance. |
| **Evaluation result** | Records the case and version, profile and version, and output, plus snapshots of the model, configuration, Workspace keys and resources. It has the method(s), `evaluator` (type, name, version or configuration, date) and criterion `findings`. It also stores the computed `overall`, uncertainty, exclusions and limitations, plus `review` (the spot-check state, with the reviewer's original findings kept when corrected), `baseline`, `knownFailure`, `importRef` and provenance. |
| **Blinded comparison** | `entries` (label → output), the preference (overall and per criterion, each with a reason), the imported reviewer's preference when imported, and the review state. |
| **Import batch record** | Evaluator identity, source file, accepted entry ids, rejected entries with their messages, and the spot-check sample size. |
| **Production observation** | Type, source, specialist, model and Workspace keys, what happened, evidence, confidence, the candidate case link, and investigation state. |

## 3. Rules that must not be broken

Each rule is enforced in one place and covered by tests.

- **Frozen means frozen.** Freezing records a sha256 of the case's test conditions (`cases.ts → testConditions`). The store refuses any change to a frozen version except its archive flag and the frozen → evaluated step. Editing makes a new candidate version. Bundle import refuses a frozen case whose hash no longer matches its content.
- **A critical failure is never hidden.** `scoring.ts` decides the overall outcome by ordered rules: a mandatory fail comes first, then a core fail, then inconclusive, then incomplete, then partly met. It shows the weighted share for context only and never uses it to decide. Optional capabilities (such as Lore's literary prose) are reported on their own and never change the outcome.
- **Evaluator kinds are never silently mixed.** Every result is labelled Person, AI reviewer, *AI reviewer corrected by owner*, Automatic check or Test runner. A comparison row only says which output a criterion favours when *one* kind of evaluator assessed every output on it. Otherwise it says the criterion cannot be compared.
- **AI reviewer assessments count only after a spot-check.** They import as *needs spot-check* and appear in no report, comparison or history until accepted or corrected. A correction keeps both versions. The rest of a batch can be accepted together only after `max(2, 20%)` of it has been checked one by one (capped at the batch size).
- **Blind means blind.** The blind view is built from an allow-list of fields (text, plus tool images without tool identity). Identities appear only once a preference with a reason is recorded, or an imported preference is accepted. Labels are assigned in a seeded random order. The page warns that an output naming its own model defeats the blinding.
- **No false precision.** History shows counts, not percentages. It warns when a group has fewer than five cases, mixes rubric versions, mixes evaluator kinds, or mixes held-out with development cases. A one-case comparison always says one case cannot establish a general strength or weakness.
- **Equivalence is stated.** A comparison is *equivalent* when one setup variable differs (or none). It is *partially equivalent* when more than one differs, or when the case version, rubric version or evaluator kind differ, or a value is unknown for some outputs. It is *not directly comparable* when the outputs answer different cases. The reasons are always listed.
- **Held-out answers stay out of test inputs.** `testInputFor` returns only the task and context. Expected behaviour, reference answers, evidence notes, checks, limitations and the title are left out.

## 4. Evaluation methods

| Method | Stage 1 |
|---|---|
| A. Deterministic checks | Six kinds: required wording, forbidden claim, expected label, required JSON field, evidence cited, and word limit. Each finding states what the check shows and what it cannot show. Results are reproducible: the result id is derived from the engine version, the checks and the output text, so a re-run gives the identical record. |
| B. Manual assessment | Per-criterion outcome (pass, partly met, fail, inconclusive, not applicable), optional rating on the criterion's scale, explanation and evidence references. |
| C. Blinded comparison | Implemented, including ties, inconclusive, per-criterion preferences and imported AI preferences. |
| D. Executable contracts | Contract `eval-lab/executable-report` (see §6.3). The lab reads reports and never runs commands. |
| E. Imported assessments | Contract `eval-lab/imported-assessment-batch`, with spot-checking as above. Example: `fixtures/assessments/ai-reviewer-batch.json`. |
| F. Automated AI judging | Interface only (`extensions/judge.ts`). It ships no judges and makes no calls. |

## 5. Security model

The lab is a single-user app on the owner's computer. The threats are other websites in the same browser, other devices on the network, and hostile content inside imported files.

- **Listening.** It listens on `127.0.0.1` only. Every request must be addressed to `localhost`, `127.0.0.1` or `[::1]`; any other host is refused with 421, which blocks DNS rebinding.
- **Writes.** A state-changing request must not be reported by the browser as cross-site (Origin / Sec-Fetch-Site) and must carry the per-process form token. On upload routes the token is checked after the multipart body is parsed.
- **Headers.** Strict Content-Security-Policy (`script-src 'self'`, no inline script or style, `frame-ancestors 'none'`), `nosniff`, `no-referrer` and no framing.
- **Escaping.** Every page is built with an escaping template tag (`server/html.ts`). Imported text is always rendered as text.
- **Files.** Record ids follow a strict pattern (no `..` or slashes). Attachments are stored under their content hash, served only from two fixed folders after a path-containment check, and accepted only when their bytes are PNG, JPEG or WebP, up to 5 MB. SVG is refused. JSON uploads are capped at 10 MB, and every list and string in a format has a maximum size.
- **Spreadsheet safety.** CSV cells that a spreadsheet would treat as formulas are neutralised.
- **Logs.** Request logging is off by default. When enabled it records method, path and status, never bodies or query strings.
- **Source checks.** The application source contains no `eval`, `new Function`, `child_process`, `http(s)` client or `fetch`, and a test enforces this. The browser is opened by the `open` package at start-up only.

## 6. Extension points

### 6.1 Joining with Workspace Analytics (contract only)

A quality result can later be matched with what the same work cost. The lab carries the Analytics v1.1 identifiers exactly as that schema names them. It does not read Analytics files or call the Analytics app.

| Lab field (on outputs and results) | Analytics v1.1 field |
|---|---|
| `workspace.job` | `jobs.jsonl` → `job` |
| `workspace.piece` | `jobs.jsonl` → `piece` |
| `workspace.phase` (default `worker`) | `jobs.jsonl` → `phase` (`worker`, `review` or `master-check`) |
| (job, piece, phase) | `jobs.jsonl` → `id` = `<job>:<piece>:<phase>` |
| `workspace.reply` | `replies.jsonl` → `id`; master-check lines → `reply` |
| `workspace.chat` | `replies.jsonl` → `chat` |
| `model.model` / `producedBy.model` | `model` (registry ids such as `claude-opus` or `sol-6.1`) |
| `model.effort` | `effort` |
| `model.provider` (`claude` or `codex`) | `jobs.jsonl` → `worker`; `replies.jsonl` → `provider` |
| `resources.tokens` | Same shape as the Analytics `tokens` object. `thinking` is kept out of `output` when known, and is `null` when it can't be separated. |

`src/domain/extensions/analyticsJoin.ts` holds the matching rules: `joinKeysOf`, `analyticsJobLineId`, `checkJobLine` and `checkReplyLine`. Unknown keys are never treated as a match. A later stage that reads Analytics files would:

1. Parse `jobs.jsonl` and `replies.jsonl` lines with `AnalyticsJobLine` / `AnalyticsReplyLine`, ignoring unknown fields as the Analytics schema requires.
2. Index the lines by `id`.
3. Look up each result's `analyticsJobLineId(joinKeysOf(result))`, or its reply id.

It must keep the Analytics cautions. A review phase line carries its piece's times. A master-check line is the only home of that reply's tokens. Cost weights are applied by the Analytics app, never in the export.

`examples/analytics-join/` holds one synthetic result and the matching fictional job line. `tests/contracts.test.ts` checks that their ids line up.

### 6.2 Importing from AI Workspace's existing test runner

The brief describes that runner as follows:

- a frozen case set;
- a held-out split locked by a freeze record (case ids plus a content hash);
- saved baselines that new runs are compared against;
- a list of known, tracked failures;
- one timestamped JSON results file per run.

Stage 1 does not rebuild it or guess its file format. The lab's formats already hold every one of those properties, so a later importer only needs to translate:

| Runner property | Lab field |
|---|---|
| Frozen case | `EvaluationCase` with `status: frozen`, `freeze.contentHash`; runner case id in `externalRef` |
| Held-out split | `EvaluationCase.split = "held-out"` (and `EvaluationResult.split`) |
| Freeze record of the held-out split | `freeze.freezeSetId` + `freeze.freezeSetHash` on each case in the set |
| Saved baseline a run was compared against | `EvaluationResult.baseline` (`runId`, `resultId`, `label`) |
| Known failure (distinct from a new failure) | `EvaluationResult.knownFailure` (`reference`, `since`); a new failure has `knownFailure: null` |
| One results file per run | `EvaluationResult.runId`; `provenance.sourceFile`; `evaluator.type = executable-runner` |

`examples/runner-compat/lab-records-after-runner-import.json` shows the lab records such an import would produce. It is generated by `scripts/make-examples.ts` through the real lifecycle, so the hashes are genuine. `tests/bundle.test.ts` imports it and checks that all four properties survive.

### 6.3 Executable assessment contract

A local runner outside the lab writes `eval-lab/executable-report` (schema in `schemas/executable-report.schema.json`, example in `examples/executable/`). The file contains:

- the runner's identity;
- the case and output it tested;
- a test list with statuses;
- a `criterionMapping` (test-name prefix → criterion);
- an optional `baseline`;
- `knownFailures`.

Each mapped criterion is decided as follows:

- any matching failed or errored test makes it **fail**;
- all matching tests passed makes it **pass**;
- no matching tests ran makes it **inconclusive**.

Failures listed as known are labelled so, and the result carries `knownFailure`. The lab only reads these files; executing tests stays outside the lab.

### 6.4 Automated AI judging

`extensions/judge.ts` fixes the interface (`AutomatedJudge.assess`). A judge would return the same shape as an imported assessment entry, so its results go through the existing path:

- evaluator type `ai-judge`;
- state *needs spot-check*;
- findings kept per criterion.

A later stage would add it behind an explicit, opt-in setting. Expected answers would be passed only for non-held-out cases.

### 6.5 Later stages

- **Production observation intake.** Observations already have a format, a screen and an import, and can be linked to candidate cases. Automatic intake from AI Workspace would write the same records.
- **Model routing and resource allocation.** This needs the Analytics join (§6.1) plus more comparable observations per specialist. History already groups results by specialist, model and configuration, and flags thin evidence.
- **Multi-specialist workflow evaluation.** A workflow case would reference several specialist profiles and per-step outputs. The current case and result formats would gain a `steps` list; the scoring and equivalence logic can be reused for each step.
- **Autonomous experiments.** These would sit on top of the judge interface and the comparison report's "is a further experiment justified?" verdict. They are deliberately not started in Stage 1.
