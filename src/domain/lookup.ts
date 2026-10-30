/** Read-only view of everything the lab holds, plus lookups shared by the domain modules and pages. */
import type {
  BlindedComparison,
  EvaluationCase,
  EvaluationResult,
  ImportBatchRecord,
  ProductionObservation,
  SavedOutput,
  SpecialistProfile,
} from './schemas.js';

export interface LabSnapshot {
  readonly profiles: readonly SpecialistProfile[];
  readonly cases: readonly EvaluationCase[];
  readonly outputs: readonly SavedOutput[];
  readonly results: readonly EvaluationResult[];
  readonly comparisons: readonly BlindedComparison[];
  readonly observations: readonly ProductionObservation[];
  readonly importBatches: readonly ImportBatchRecord[];
}

interface Versioned {
  readonly id: string;
  readonly version: number;
}

function latestOf<TRecord extends Versioned>(records: readonly TRecord[], id: string): TRecord | undefined {
  return records.filter((r) => r.id === id).reduce<TRecord | undefined>((best, r) => (!best || r.version > best.version ? r : best), undefined);
}

/** Latest version of every distinct id. */
function latestEach<TRecord extends Versioned>(records: readonly TRecord[]): TRecord[] {
  const ids = [...new Set(records.map((r) => r.id))];
  return ids.flatMap((id) => {
    const latest = latestOf(records, id);
    return latest ? [latest] : [];
  });
}

export const findProfile = (lab: LabSnapshot, id: string, version: number): SpecialistProfile | undefined =>
  lab.profiles.find((p) => p.id === id && p.version === version);

export const latestProfile = (lab: LabSnapshot, id: string): SpecialistProfile | undefined => latestOf(lab.profiles, id);
export const latestProfiles = (lab: LabSnapshot): SpecialistProfile[] => latestEach(lab.profiles);
export const profileVersions = (lab: LabSnapshot, id: string): SpecialistProfile[] =>
  lab.profiles.filter((p) => p.id === id).sort((a, b) => b.version - a.version);

export const findCase = (lab: LabSnapshot, id: string, version: number): EvaluationCase | undefined =>
  lab.cases.find((c) => c.id === id && c.version === version);

export const latestCase = (lab: LabSnapshot, id: string): EvaluationCase | undefined => latestOf(lab.cases, id);
export const latestCases = (lab: LabSnapshot): EvaluationCase[] => latestEach(lab.cases);
export const caseVersions = (lab: LabSnapshot, id: string): EvaluationCase[] =>
  lab.cases.filter((c) => c.id === id).sort((a, b) => b.version - a.version);

/** The profile version a case is judged against: the one it names, else the latest. */
export function profileForCase(lab: LabSnapshot, c: EvaluationCase): SpecialistProfile | undefined {
  return c.profileVersion === null ? latestProfile(lab, c.specialistId) : findProfile(lab, c.specialistId, c.profileVersion);
}

export const findOutput = (lab: LabSnapshot, id: string): SavedOutput | undefined => lab.outputs.find((o) => o.id === id);
export const outputsForCase = (lab: LabSnapshot, caseId: string, caseVersion: number): SavedOutput[] =>
  lab.outputs.filter((o) => o.caseId === caseId && o.caseVersion === caseVersion);

export const resultsForOutput = (lab: LabSnapshot, outputId: string): EvaluationResult[] => lab.results.filter((r) => r.outputId === outputId);
export const findResult = (lab: LabSnapshot, id: string): EvaluationResult | undefined => lab.results.find((r) => r.id === id);
export const findComparison = (lab: LabSnapshot, id: string): BlindedComparison | undefined => lab.comparisons.find((c) => c.id === id);
export const findObservation = (lab: LabSnapshot, id: string): ProductionObservation | undefined => lab.observations.find((o) => o.id === id);
export const findBatch = (lab: LabSnapshot, id: string): ImportBatchRecord | undefined => lab.importBatches.find((b) => b.id === id);

export const byNewest = <TRecord extends { readonly createdAt: string }>(a: TRecord, b: TRecord): number => b.createdAt.localeCompare(a.createdAt);
