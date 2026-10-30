/**
 * Data formats for the Specialist Evaluation Lab (format version 1).
 *
 * Every stored or exported record is validated against one of these schemas.
 * Imported files are untrusted: unknown fields are dropped, every text field
 * and list has a size limit, and ids are restricted to a safe character set.
 *
 * Rules that apply to every format:
 * - Unknown is `null`, never `0`. `0` means "measured, and it was zero".
 * - Each record names its format in `schema` and `schemaVersion`. A file made
 *   by a newer, unknown version is refused instead of guessed at.
 * - Fields added later get defaults, so older files still load.
 */
import { z } from 'zod';

export const FORMAT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Size limits. Imported files are untrusted, so every string and list is bounded.
// ---------------------------------------------------------------------------

const LEN_ID = 100;
const LEN_NAME = 300;
const LEN_FILE_NAME = 260;
const LEN_HASH = 200;
const LEN_LABEL = 60;
const LEN_PHRASE = 300;
const LEN_TEST_NAME = 500;
const LEN_NOTE = 1000;
const LEN_PARAGRAPH = 2000;
const LEN_GUIDANCE = 4000;
const LEN_LONG = 5000;
const LEN_DOCUMENT = 10_000;
const LEN_DEFAULT = 20_000;
const LEN_MATERIAL = 50_000;
const LEN_OUTPUT = 200_000;
const LEN_TAG = 40;

const MAX_SMALL_LIST = 20;
const MAX_PHRASES = 30;
const MAX_LIST = 50;
const MAX_CRITERIA = 100;
const MAX_DEFAULT_LIST = 200;
const MAX_METHODS = 4;
const MAX_BLIND_OUTPUTS = 6;
const MIN_BLIND_OUTPUTS = 2;
const MAX_VERSION = 100_000;
const MAX_PIECE = 100_000;
const MAX_TOKEN_COUNT = 1e12;
const MAX_DURATION_S = 1e9;
const RATING_BOUND = 100;
const WEIGHT_MAX = 100;
const MAX_TESTS = 5000;
const MAX_KNOWN_FAILURES = 1000;
const MAX_IMPORT_ENTRIES = 2000;
const MAX_BATCH_IDS = 4000;
const MAX_BUNDLE_SMALL = 5000;
const MAX_BUNDLE_CASES = 20_000;
const MAX_BUNDLE_OUTPUTS = 50_000;
const MAX_BUNDLE_RESULTS = 100_000;

/** Largest image the lab accepts, in bytes (5 MB). */
export const ATTACHMENT_MAX_BYTES = 5_242_880;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// Safe record id: letters, digits, dot, dash, underscore; starts with a letter or digit; at most 100 characters.
// Matches "case-master-001"; rejects "../etc/passwd". Ids also end up in file and URL paths, hence the strictness.
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9%5D%5BA-Za-z0-9._-%5D%7B0%2C99%7D%24&flags=gm&testString=case-master-001%0A..%2Fetc%2Fpasswd
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PARENT_DIR = '..';

export const Id = z
  .string()
  .regex(ID_PATTERN, 'must be 1-100 characters of letters, digits, dot, dash or underscore, starting with a letter or digit')
  .refine((s) => !s.includes(PARENT_DIR), 'must not contain ".."');

// Evidence reference id as cited in outputs, e.g. [E1]. Matches "E1"; rejects "E 1".
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_-%5D%7B1%2C40%7D%24&flags=gm&testString=E1%0AE%201
export const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

// Lowercase sha256 in hex. Matches "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; rejects "not-a-hash".
// https://regex101.com/?flavor=javascript&regex=%5E%5Ba-f0-9%5D%7B64%7D%24&flags=gm&testString=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855%0Anot-a-hash
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// JSON field path: dot-separated names, at most 10 levels. Matches "decision.reason"; rejects "decision..reason".
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_%5D%2B(%5C.%5BA-Za-z0-9_%5D%2B)%7B0%2C9%7D%24&flags=gm&testString=decision.reason%0Adecision..reason
const FIELD_PATH_PATTERN = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,9}$/;

// Attachment file name: lowercase name with a .png, .jpg or .webp ending and no folders.
// Matches "outfit-before.png"; rejects "../secret.svg".
// https://regex101.com/?flavor=javascript&regex=%5E%5Ba-z0-9%5D%5Ba-z0-9-%5D%7B0%2C99%7D%5C.(png%7Cjpg%7Cwebp)%24&flags=gm&testString=outfit-before.png%0A..%2Fsecret.svg
export const ATTACHMENT_NAME = /^[a-z0-9][a-z0-9-]{0,99}\.(png|jpg|webp)$/;

const text = (max: number = LEN_DEFAULT) => z.string().max(max);
const shortText = text(LEN_NAME);
const IsoTime = z.iso.datetime({ offset: true });
const nullableShort = (max: number = LEN_ID) => z.string().max(max).nullable().default(null);
const list = <TItem extends z.ZodType>(item: TItem, max: number = MAX_DEFAULT_LIST) => z.array(item).max(max);
const evidenceId = z.string().regex(EVIDENCE_ID_PATTERN, 'evidence ids use letters, digits, dash or underscore (max 40)');

export const Origin = z.enum(['synthetic', 'user']);
export type Origin = z.infer<typeof Origin>;

export const Privacy = z.enum(['synthetic', 'local-private', 'shareable']);
export type Privacy = z.infer<typeof Privacy>;

export const Provenance = z.object({
  origin: Origin,
  source: z.enum(['synthetic-suite', 'manual-entry', 'file-import', 'observation', 'runner-import']),
  /** File name only (never a path) when the record came from a file. */
  sourceFile: nullableShort(LEN_FILE_NAME),
  importedAt: IsoTime.nullable().default(null),
  note: text(LEN_PARAGRAPH).default(''),
});
export type Provenance = z.infer<typeof Provenance>;

// ---------------------------------------------------------------------------
// Model, configuration, Workspace join keys, resources
// ---------------------------------------------------------------------------

/**
 * Who produced an output. `model`, `provider` and `effort` use the exact
 * values of the Workspace Analytics export (v1.1): registry model ids such as
 * `claude-opus` or `sol-6.1`, and provider `claude` or `codex`.
 */
export const ModelRef = z.object({
  model: nullableShort(),
  provider: nullableShort(),
  effort: nullableShort(),
  /** Provider version string, when known. Informational only. */
  modelVersion: nullableShort(),
});
export type ModelRef = z.infer<typeof ModelRef>;

export const ToolRef = z.object({
  name: shortText,
  model: nullableShort(),
  version: nullableShort(),
});

export const ConfigurationRef = z.object({
  /** Specialist configuration id (instructions version, etc.). */
  configurationId: nullableShort(),
  /** Hash or fingerprint of the configuration, when known. */
  fingerprint: nullableShort(LEN_HASH),
  contextConfigId: nullableShort(),
  toolConfigIds: list(z.string().max(LEN_ID), MAX_LIST).default([]),
});
export type ConfigurationRef = z.infer<typeof ConfigurationRef>;

/** Join keys into the Workspace Analytics export. All optional. */
export const WorkspaceRef = z.object({
  job: nullableShort(),
  piece: z.int().min(0).max(MAX_PIECE).nullable().default(null),
  phase: z.enum(['worker', 'review', 'master-check']).nullable().default(null),
  reply: nullableShort(),
  chat: nullableShort(),
});
export type WorkspaceRef = z.infer<typeof WorkspaceRef>;

const count = z.int().min(0).max(MAX_TOKEN_COUNT).nullable().default(null);

/** Same shape as the Analytics `tokens` object. */
export const Tokens = z.object({
  uncached: count,
  cacheWrite: count,
  cacheWrite1h: count,
  cacheRead: count,
  output: count,
  thinking: count,
});
export type Tokens = z.infer<typeof Tokens>;

export const Resources = z.object({
  tokens: Tokens.nullable().default(null),
  durationS: z.number().min(0).max(MAX_DURATION_S).nullable().default(null),
  steps: count,
  provenance: z
    .object({
      source: z.enum(['unknown', 'manual-entry', 'workspace-analytics', 'runner-report', 'synthetic']),
      note: text(LEN_NOTE).default(''),
    })
    .default(() => ({ source: 'unknown' as const, note: '' })),
});
export type Resources = z.infer<typeof Resources>;

export const emptyResources = (): Resources => Resources.parse({});

// Defaults are factories so no two records ever share one mutable default object.
const NO_MODEL = (): ModelRef => ({ model: null, provider: null, effort: null, modelVersion: null });
const NO_CONFIGURATION = (): ConfigurationRef => ({ configurationId: null, fingerprint: null, contextConfigId: null, toolConfigIds: [] });
const NO_WORKSPACE = (): WorkspaceRef => ({ job: null, piece: null, phase: null, reply: null, chat: null });

// ---------------------------------------------------------------------------
// Methods, evaluators, findings
// ---------------------------------------------------------------------------

export const Method = z.enum(['deterministic', 'manual', 'blinded-comparison', 'executable']);
export type Method = z.infer<typeof Method>;

export const EvaluatorType = z.enum([
  'human',
  'ai-reviewer',
  'deterministic-check',
  'executable-runner',
  /** Reserved for the future automated judge. Never produced in Stage 1. */
  'ai-judge',
]);
export type EvaluatorType = z.infer<typeof EvaluatorType>;

export const Evaluator = z.object({
  type: EvaluatorType,
  /** Model name for AI reviewers, a person's name for people, the engine name for checks. */
  name: shortText,
  /** Version or configuration id of the evaluator. */
  version: nullableShort(),
  date: IsoTime.nullable().default(null),
});
export type Evaluator = z.infer<typeof Evaluator>;

export const Outcome = z.enum(['pass', 'partial', 'fail', 'inconclusive', 'not-applicable']);
export type Outcome = z.infer<typeof Outcome>;

export const Rating = z
  .object({ value: z.number(), min: z.number(), max: z.number() })
  .refine((r) => r.min < r.max && r.value >= r.min && r.value <= r.max, 'rating value must lie between min and max');

export const Finding = z.object({
  criterionId: Id,
  outcome: Outcome,
  rating: Rating.nullable().default(null),
  explanation: text(LEN_LONG).default(''),
  evidenceRefs: list(z.string().max(LEN_HASH), MAX_LIST).default([]),
  method: Method.default('manual'),
  /** Set on findings made by a deterministic check. */
  checkId: Id.nullable().default(null),
  /** True when the owner changed this finding while spot-checking an imported assessment. */
  correctedByOwner: z.boolean().default(false),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewState = z.enum(['not-required', 'needs-spot-check', 'accepted', 'corrected', 'rejected']);
export type ReviewState = z.infer<typeof ReviewState>;

export const Review = z.object({
  state: ReviewState,
  decidedAt: IsoTime.nullable().default(null),
  decidedBy: nullableShort(),
  via: z.enum(['individual', 'batch']).nullable().default(null),
  note: text(LEN_PARAGRAPH).default(''),
  /** The outside reviewer's findings as imported, kept when the owner corrects them. */
  originalFindings: list(Finding).nullable().default(null),
});
export type Review = z.infer<typeof Review>;

const NO_REVIEW = (): Review => ({ state: 'not-required', decidedAt: null, decidedBy: null, via: null, note: '', originalFindings: null });

// ---------------------------------------------------------------------------
// Specialist profiles
// ---------------------------------------------------------------------------

export const Scale = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('outcome') }),
  z.object({
    kind: z.literal('rating'),
    min: z.int().min(-RATING_BOUND).max(RATING_BOUND),
    max: z.int().min(-RATING_BOUND).max(RATING_BOUND),
    anchors: text(LEN_NOTE).default(''),
  }),
]);
export type Scale = z.infer<typeof Scale>;

export const Criterion = z.object({
  id: Id,
  name: shortText.min(1),
  description: text(LEN_PARAGRAPH).default(''),
  tier: z.enum(['core', 'optional']),
  /** A failure of a mandatory criterion is a critical failure, whatever the other scores. */
  mandatory: z.boolean().default(false),
  /** Capability group. Each capability is reported on its own. */
  capability: Id.default('primary'),
  methods: list(Method, MAX_METHODS).min(1),
  /** Relative importance within the specialist (0-100). */
  weight: z.number().min(0).max(WEIGHT_MAX).default(1),
  /** Whether this judges the agent's own work, a tool's output (such as a generated image), or both. */
  assesses: z.enum(['agent', 'tool-output', 'combined']).default('agent'),
  scale: Scale.default({ kind: 'outcome' }),
  guidance: text(LEN_GUIDANCE).default(''),
});
export type Criterion = z.infer<typeof Criterion>;

export const Capability = z.object({
  id: Id,
  name: shortText.min(1),
  description: text(LEN_NOTE).default(''),
  /** Optional capabilities are reported separately and never change the main outcome. */
  optional: z.boolean().default(false),
});
export type Capability = z.infer<typeof Capability>;

export const SpecialistProfile = z
  .object({
    schema: z.literal('eval-lab/specialist-profile'),
    schemaVersion: z.literal(FORMAT_VERSION),
    id: Id,
    version: z.int().min(1).max(MAX_VERSION),
    name: shortText.min(1),
    purpose: text(LEN_PARAGRAPH).default(''),
    capabilities: list(Capability, MAX_SMALL_LIST).min(1),
    criteria: list(Criterion, MAX_CRITERIA).min(1),
    changeNote: text(LEN_PARAGRAPH).default(''),
    createdAt: IsoTime,
    origin: Origin,
  })
  .superRefine((p, ctx) => {
    const capIds = new Set(p.capabilities.map((c) => c.id));
    if (capIds.size !== p.capabilities.length) ctx.addIssue({ code: 'custom', message: 'capability ids must be unique', path: ['capabilities'] });
    const criterionIds = p.criteria.map((c) => c.id);
    p.criteria.forEach((c, i) => {
      if (criterionIds.indexOf(c.id) !== i)
        ctx.addIssue({ code: 'custom', message: `criterion id "${c.id}" is used twice`, path: ['criteria', i, 'id'] });
      if (!capIds.has(c.capability))
        ctx.addIssue({ code: 'custom', message: `criterion "${c.id}" names unknown capability "${c.capability}"`, path: ['criteria', i, 'capability'] });
      if (c.scale.kind === 'rating' && c.scale.min >= c.scale.max)
        ctx.addIssue({ code: 'custom', message: `criterion "${c.id}" rating scale min must be below max`, path: ['criteria', i, 'scale'] });
    });
  });
export type SpecialistProfile = z.infer<typeof SpecialistProfile>;

// ---------------------------------------------------------------------------
// Attachments and deterministic checks
// ---------------------------------------------------------------------------

export const AttachmentRef = z.object({
  /** `fixture`: a synthetic image shipped in the repository. `local`: an image the user added (data folder). */
  store: z.enum(['fixture', 'local']),
  name: z.string().regex(ATTACHMENT_NAME, 'attachment name must be a plain file name ending in .png, .jpg or .webp'),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  bytes: z.int().min(1).max(ATTACHMENT_MAX_BYTES),
  alt: text(LEN_NOTE).default(''),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

const checkBase = {
  id: Id,
  criterionId: Id,
  description: text(LEN_NOTE).default(''),
};

export const DeterministicCheck = z.discriminatedUnion('type', [
  z.object({
    ...checkBase,
    type: z.literal('required-phrase'),
    phrases: list(z.string().min(1).max(LEN_PHRASE), MAX_PHRASES).min(1),
    match: z.enum(['any', 'all']).default('any'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('forbidden-phrase'),
    phrases: list(z.string().min(1).max(LEN_PHRASE), MAX_PHRASES).min(1),
  }),
  z.object({
    ...checkBase,
    type: z.literal('expected-label'),
    /** The output must contain a line "<label>: <value>". */
    label: z.string().min(1).max(LEN_LABEL),
    accepted: list(z.string().min(1).max(LEN_ID), MAX_SMALL_LIST).min(1),
  }),
  z.object({
    ...checkBase,
    type: z.literal('required-field'),
    /** Dot path into a JSON object found in the output, e.g. "decision.reason". */
    field: z.string().regex(FIELD_PATH_PATTERN, 'field must be a dot path such as decision.reason'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('evidence-reference'),
    /** Evidence ids that count, cited in square brackets like [E1]. */
    refs: list(evidenceId, MAX_LIST).min(1),
    min: z.int().min(1).max(MAX_LIST).default(1),
  }),
  z.object({
    ...checkBase,
    type: z.literal('max-words'),
    max: z.int().min(1).max(LEN_OUTPUT),
  }),
]);
export type DeterministicCheck = z.infer<typeof DeterministicCheck>;
export type CheckType = DeterministicCheck['type'];

// ---------------------------------------------------------------------------
// Evaluation cases
// ---------------------------------------------------------------------------

export const CaseStatus = z.enum(['candidate', 'validated', 'frozen', 'evaluated']);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const ContextItem = z.object({
  id: Id,
  title: shortText.min(1),
  kind: z.enum(['text', 'image']),
  text: text(LEN_MATERIAL).default(''),
  attachment: AttachmentRef.nullable().default(null),
  /** Authoritative material (canon, rules, a newer record) that settles what is correct. */
  authoritative: z.boolean().default(false),
  note: text(LEN_NOTE).default(''),
});
export type ContextItem = z.infer<typeof ContextItem>;

export const EvidenceItem = z.object({
  id: evidenceId,
  description: text(LEN_PARAGRAPH),
  contextItemId: Id.nullable().default(null),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const Freeze = z.object({
  frozenAt: IsoTime,
  frozenBy: shortText.default('Owner'),
  /** sha256 of the case's test conditions (see cases.ts `caseContentHash`). */
  contentHash: z.string().regex(SHA256_PATTERN),
  /** For cases imported from a runner that freezes a whole set: the set's id and hash. */
  freezeSetId: nullableShort(),
  freezeSetHash: nullableShort(LEN_HASH),
});
export type Freeze = z.infer<typeof Freeze>;

const EMPTY_EXPECTED = (): { behaviour: string; acceptanceCriteria: string[]; referenceAnswer: string; answerKind: 'judgement' } => ({
  behaviour: '',
  acceptanceCriteria: [],
  referenceAnswer: '',
  answerKind: 'judgement',
});

export const EvaluationCase = z.object({
  schema: z.literal('eval-lab/evaluation-case'),
  schemaVersion: z.literal(FORMAT_VERSION),
  id: Id,
  version: z.int().min(1).max(MAX_VERSION),
  status: CaseStatus,
  archived: z.boolean().default(false),
  /** `held-out` cases are kept back for final checks and never used while tuning. */
  split: z.enum(['development', 'held-out']).default('development'),
  specialistId: Id,
  /** Profile version the case was written against. */
  profileVersion: z.int().min(1).nullable().default(null),
  capability: Id.default('primary'),
  title: shortText.min(1),
  task: text(LEN_MATERIAL).default(''),
  context: list(ContextItem, MAX_LIST).default([]),
  /** What context the specialist has, in words, when there are no context items. */
  contextNote: text(LEN_PARAGRAPH).default(''),
  expected: z
    .object({
      behaviour: text(LEN_DOCUMENT).default(''),
      acceptanceCriteria: list(z.string().max(LEN_NOTE), MAX_LIST).default([]),
      referenceAnswer: text(LEN_DEFAULT).default(''),
      answerKind: z.enum(['objective', 'judgement', 'mixed']).default('judgement'),
    })
    .default(EMPTY_EXPECTED),
  evidence: list(EvidenceItem, MAX_LIST).default([]),
  methods: list(Method, MAX_METHODS).default([]),
  checks: list(DeterministicCheck, MAX_LIST).default([]),
  limitations: text(LEN_LONG).default(''),
  ambiguity: z.enum(['clear', 'some', 'ambiguous']).default('clear'),
  ambiguityNote: text(LEN_PARAGRAPH).default(''),
  provenance: Provenance,
  privacy: Privacy,
  tags: list(z.string().max(LEN_TAG), MAX_SMALL_LIST).default([]),
  validation: z
    .object({ validatedAt: IsoTime, validatedBy: shortText, notes: text(LEN_PARAGRAPH).default('') })
    .nullable()
    .default(null),
  freeze: Freeze.nullable().default(null),
  /** Where the case came from in an outside system (for a later runner import). */
  externalRef: z.object({ system: shortText, id: shortText }).nullable().default(null),
  previousVersion: z.int().min(1).nullable().default(null),
  changeNote: text(LEN_PARAGRAPH).default(''),
  createdAt: IsoTime,
});
export type EvaluationCase = z.infer<typeof EvaluationCase>;

// ---------------------------------------------------------------------------
// Saved outputs
// ---------------------------------------------------------------------------

export const ToolArtifact = z.object({
  id: Id,
  /** The tool that made this artifact, e.g. an image generator. Kept apart from the agent's own work. */
  tool: ToolRef,
  kind: z.enum(['image', 'text']),
  text: text(LEN_MATERIAL).default(''),
  attachment: AttachmentRef.nullable().default(null),
  description: text(LEN_PARAGRAPH).default(''),
});
export type ToolArtifact = z.infer<typeof ToolArtifact>;

export const SavedOutput = z.object({
  schema: z.literal('eval-lab/saved-output'),
  schemaVersion: z.literal(FORMAT_VERSION),
  id: Id,
  caseId: Id,
  caseVersion: z.int().min(1),
  /** Short human label, e.g. "Opus, instructions v3". Hidden during blinded comparisons. */
  label: shortText.min(1),
  /** The agent's own output text (its answer, interpretation, instructions or inspection). */
  text: text(LEN_OUTPUT).default(''),
  toolArtifacts: list(ToolArtifact, MAX_SMALL_LIST).default([]),
  producedBy: ModelRef.default(NO_MODEL),
  configuration: ConfigurationRef.default(NO_CONFIGURATION),
  workspace: WorkspaceRef.default(NO_WORKSPACE),
  resources: Resources.default(emptyResources),
  producedAt: IsoTime.nullable().default(null),
  provenance: Provenance,
  privacy: Privacy,
  createdAt: IsoTime,
});
export type SavedOutput = z.infer<typeof SavedOutput>;

// ---------------------------------------------------------------------------
// Evaluation results
// ---------------------------------------------------------------------------

export const OverallStatus = z.enum(['critical-failure', 'fail', 'pass-with-issues', 'pass', 'inconclusive', 'incomplete']);
export type OverallStatus = z.infer<typeof OverallStatus>;

const ImportRef = z.object({ batchId: Id, entryId: Id });

export const EvaluationResult = z.object({
  schema: z.literal('eval-lab/evaluation-result'),
  schemaVersion: z.literal(FORMAT_VERSION),
  id: Id,
  /** Groups results made together (one import batch, one check run, one runner file). */
  runId: Id,
  caseId: Id,
  caseVersion: z.int().min(1),
  split: z.enum(['development', 'held-out']).default('development'),
  profileId: Id,
  profileVersion: z.int().min(1),
  outputId: Id,
  // Snapshots of who produced the output, so the result stays readable if the output record changes later.
  model: ModelRef.default(NO_MODEL),
  configuration: ConfigurationRef.default(NO_CONFIGURATION),
  workspace: WorkspaceRef.default(NO_WORKSPACE),
  resources: Resources.default(emptyResources),
  methods: list(Method, MAX_METHODS).min(1),
  evaluator: Evaluator,
  findings: list(Finding).default([]),
  /** Outcome computed when the result was saved (see scoring.ts). */
  overall: OverallStatus.nullable().default(null),
  overallNote: text(LEN_LONG).default(''),
  uncertainty: text(LEN_LONG).default(''),
  exclusions: text(LEN_LONG).default(''),
  limitations: text(LEN_LONG).default(''),
  review: Review.default(NO_REVIEW),
  /** The earlier run this result was compared against, when an outside runner supplied one. */
  baseline: z
    .object({ runId: shortText, resultId: nullableShort(), label: text(LEN_NAME).default('') })
    .nullable()
    .default(null),
  /** Set when this failure is already known and tracked, as distinct from a new failure. */
  knownFailure: z
    .object({ reference: text(LEN_NAME), since: IsoTime.nullable().default(null) })
    .nullable()
    .default(null),
  /** Import batch and entry this came from, when imported. */
  importRef: ImportRef.nullable().default(null),
  provenance: Provenance,
  createdAt: IsoTime,
});
export type EvaluationResult = z.infer<typeof EvaluationResult>;

// ---------------------------------------------------------------------------
// Blinded comparisons
// ---------------------------------------------------------------------------

export const BLIND_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export const BlindLabel = z.enum(BLIND_LABELS);
export type BlindLabel = z.infer<typeof BlindLabel>;
export const NON_PREFERENCE_CHOICES = ['tie', 'inconclusive'] as const;
export const Choice = z.union([BlindLabel, z.enum(NON_PREFERENCE_CHOICES)]);
export type Choice = z.infer<typeof Choice>;

export const Preference = z.object({
  overall: z.object({ choice: Choice, reason: text(LEN_LONG).min(1, 'a reason is required') }),
  perCriterion: list(z.object({ criterionId: Id, choice: Choice, reason: text(LEN_PARAGRAPH).default('') }), MAX_CRITERIA).default([]),
});
export type Preference = z.infer<typeof Preference>;

export const BlindedComparison = z
  .object({
    schema: z.literal('eval-lab/blinded-comparison'),
    schemaVersion: z.literal(FORMAT_VERSION),
    id: Id,
    caseId: Id,
    caseVersion: z.int().min(1),
    profileId: Id,
    profileVersion: z.int().min(1),
    entries: list(z.object({ label: BlindLabel, outputId: Id }), MAX_BLIND_OUTPUTS).min(MIN_BLIND_OUTPUTS),
    criterionIds: list(Id, MAX_CRITERIA).default([]),
    status: z.enum(['open', 'recorded']),
    preference: Preference.nullable().default(null),
    evaluator: Evaluator.nullable().default(null),
    /** For comparisons imported from an outside reviewer: the reviewer's own preference, kept as imported. */
    importedPreference: Preference.nullable().default(null),
    review: Review.default(NO_REVIEW),
    importRef: ImportRef.nullable().default(null),
    provenance: Provenance,
    createdAt: IsoTime,
    recordedAt: IsoTime.nullable().default(null),
  })
  .superRefine((c, ctx) => {
    const labels = c.entries.map((e) => e.label);
    if (new Set(labels).size !== labels.length) ctx.addIssue({ code: 'custom', message: 'blind labels must be unique', path: ['entries'] });
    const outs = c.entries.map((e) => e.outputId);
    if (new Set(outs).size !== outs.length) ctx.addIssue({ code: 'custom', message: 'an output can appear only once', path: ['entries'] });
  });
export type BlindedComparison = z.infer<typeof BlindedComparison>;

// ---------------------------------------------------------------------------
// Imported outside assessments
// ---------------------------------------------------------------------------

export const ImportedEvaluator = z.object({
  type: z.enum(['ai-reviewer', 'human']),
  name: shortText.min(1),
  version: nullableShort(),
  date: IsoTime.nullable().default(null),
});
export type ImportedEvaluator = z.infer<typeof ImportedEvaluator>;

export const ImportedAssessmentEntry = z.object({
  entryId: Id,
  caseId: Id,
  caseVersion: z.int().min(1),
  outputId: Id,
  /** Defaults to the profile version the case was written against. */
  profileVersion: z.int().min(1).nullable().default(null),
  findings: list(Finding, MAX_CRITERIA).min(1, 'an assessment needs at least one finding'),
  overallNote: text(LEN_LONG).default(''),
  uncertainty: text(LEN_LONG).default(''),
  limitations: text(LEN_LONG).default(''),
});
export type ImportedAssessmentEntry = z.infer<typeof ImportedAssessmentEntry>;

export const ImportedComparisonEntry = z.object({
  entryId: Id,
  caseId: Id,
  caseVersion: z.int().min(1),
  outputIds: list(Id, MAX_BLIND_OUTPUTS).min(MIN_BLIND_OUTPUTS),
  overall: z.object({
    /** An output id, or "tie" / "inconclusive". */
    preferred: z.string().max(LEN_ID),
    reason: text(LEN_LONG).min(1, 'a reason is required'),
  }),
  perCriterion: list(
    z.object({ criterionId: Id, preferred: z.string().max(LEN_ID), reason: text(LEN_PARAGRAPH).default('') }),
    MAX_CRITERIA,
  ).default([]),
});
export type ImportedComparisonEntry = z.infer<typeof ImportedComparisonEntry>;

/** Envelope of an import file. Entries are validated one by one so one bad entry can't hide the rest. */
export const ImportedAssessmentBatch = z.object({
  schema: z.literal('eval-lab/imported-assessment-batch'),
  schemaVersion: z.literal(FORMAT_VERSION),
  batchId: Id,
  producedAt: IsoTime,
  evaluator: ImportedEvaluator,
  assessments: z.array(z.unknown()).max(MAX_IMPORT_ENTRIES).default([]),
  comparisons: z.array(z.unknown()).max(MAX_IMPORT_ENTRIES).default([]),
});
export type ImportedAssessmentBatch = z.infer<typeof ImportedAssessmentBatch>;

export const ImportBatchRecord = z.object({
  schema: z.literal('eval-lab/import-batch-record'),
  schemaVersion: z.literal(FORMAT_VERSION),
  id: Id,
  evaluator: ImportedEvaluator,
  producedAt: IsoTime,
  importedAt: IsoTime,
  sourceFile: nullableShort(LEN_FILE_NAME),
  acceptedEntryIds: list(Id, MAX_BATCH_IDS).default([]),
  rejected: list(z.object({ entry: z.string().max(LEN_HASH), message: text(LEN_PARAGRAPH) }), MAX_BATCH_IDS).default([]),
  /** How many entries the owner must check one by one before accepting the rest together. */
  spotCheckSample: z.int().min(0),
  origin: Origin,
});
export type ImportBatchRecord = z.infer<typeof ImportBatchRecord>;

// ---------------------------------------------------------------------------
// Production observations
// ---------------------------------------------------------------------------

export const ProductionObservation = z.object({
  schema: z.literal('eval-lab/production-observation'),
  schemaVersion: z.literal(FORMAT_VERSION),
  id: Id,
  type: z.enum(['success', 'failure', 'correction', 'review', 'other']),
  /** Where it was noticed, in words. */
  source: text(LEN_NAME).min(1),
  observedAt: IsoTime.nullable().default(null),
  specialistId: Id.nullable().default(null),
  model: ModelRef.default(NO_MODEL),
  configuration: ConfigurationRef.default(NO_CONFIGURATION),
  workspace: WorkspaceRef.default(NO_WORKSPACE),
  whatHappened: text(LEN_DOCUMENT).min(1),
  evidence: text(LEN_DOCUMENT).default(''),
  confidence: z.enum(['unknown', 'low', 'medium', 'high']).default('unknown'),
  uncertaintyNote: text(LEN_PARAGRAPH).default(''),
  candidateCaseId: Id.nullable().default(null),
  investigation: z.enum(['not-yet', 'investigating', 'investigated']).default('not-yet'),
  investigationNote: text(LEN_LONG).default(''),
  provenance: Provenance,
  privacy: Privacy,
  createdAt: IsoTime,
});
export type ProductionObservation = z.infer<typeof ProductionObservation>;

// ---------------------------------------------------------------------------
// Executable assessment contract (results from an outside test runner)
// ---------------------------------------------------------------------------

export const ExecutableReport = z.object({
  schema: z.literal('eval-lab/executable-report'),
  schemaVersion: z.literal(FORMAT_VERSION),
  runner: z.object({ name: shortText.min(1), version: nullableShort() }),
  ranAt: IsoTime,
  caseId: Id,
  caseVersion: z.int().min(1),
  outputId: Id,
  tests: list(
    z.object({
      name: z.string().min(1).max(LEN_TEST_NAME),
      status: z.enum(['passed', 'failed', 'skipped', 'error']),
      durationMs: z.number().min(0).nullable().default(null),
      message: text(LEN_PARAGRAPH).default(''),
    }),
    MAX_TESTS,
  ),
  /** Which tests decide which criterion. A criterion passes only if every matching test passed. */
  criterionMapping: list(z.object({ criterionId: Id, testNamePrefix: z.string().max(LEN_TEST_NAME).default('') }), MAX_CRITERIA).min(1),
  baseline: z.object({ runId: shortText, label: text(LEN_NAME).default('') }).nullable().default(null),
  knownFailures: list(z.string().max(LEN_TEST_NAME), MAX_KNOWN_FAILURES).default([]),
});
export type ExecutableReport = z.infer<typeof ExecutableReport>;

// ---------------------------------------------------------------------------
// Export bundle
// ---------------------------------------------------------------------------

export const ExportBundle = z.object({
  schema: z.literal('eval-lab/export-bundle'),
  schemaVersion: z.literal(FORMAT_VERSION),
  exportedAt: IsoTime,
  app: z.object({ name: shortText, version: shortText }),
  profiles: z.array(z.unknown()).max(MAX_BUNDLE_SMALL).default([]),
  cases: z.array(z.unknown()).max(MAX_BUNDLE_CASES).default([]),
  outputs: z.array(z.unknown()).max(MAX_BUNDLE_OUTPUTS).default([]),
  results: z.array(z.unknown()).max(MAX_BUNDLE_RESULTS).default([]),
  comparisons: z.array(z.unknown()).max(MAX_BUNDLE_OUTPUTS).default([]),
  observations: z.array(z.unknown()).max(MAX_BUNDLE_OUTPUTS).default([]),
  importBatches: z.array(z.unknown()).max(MAX_BUNDLE_SMALL).default([]),
});
export type ExportBundle = z.infer<typeof ExportBundle>;

/** Every documented format, keyed by its file name in `schemas/`. */
export const RECORD_SCHEMAS = {
  'specialist-profile': SpecialistProfile,
  'evaluation-case': EvaluationCase,
  'saved-output': SavedOutput,
  'evaluation-result': EvaluationResult,
  'criterion-finding': Finding,
  'blinded-comparison': BlindedComparison,
  'imported-assessment-batch': ImportedAssessmentBatch,
  'imported-assessment-entry': ImportedAssessmentEntry,
  'imported-comparison-entry': ImportedComparisonEntry,
  'production-observation': ProductionObservation,
  'executable-report': ExecutableReport,
  'model-descriptor': ModelRef,
  'configuration-descriptor': ConfigurationRef,
  'workspace-join-keys': WorkspaceRef,
  'resource-measurements': Resources,
  'export-bundle': ExportBundle,
} as const;
