import type { ResumeType } from "./resume.js";

export type ResumeRoleShape = "product_fullstack" | "applied_ai" | "early_career" | "integration_delivery";

export type ResumeProjectEvidence = {
  name?: string;
  summary: string;
  technologies: string[];
  outcomes: string[];
  evidenceSnippets: string[];
};

export type ResumeClaimSupport = {
  claim: string;
  evidenceSnippets: string[];
};

export type ResumeContextMetadata = {
  strongestThemes: string[];
  projectEvidence: ResumeProjectEvidence[];
  keywords: string[];
  bestFitRoleShapes: ResumeRoleShape[];
  avoidUseCases: string[];
  claimSupport: ResumeClaimSupport[];
};

export type ResumeContext = {
  type: ResumeType;
  sourcePath: string;
  sourceKind: "txt" | "pdf";
  loadedAt: string;
  rawText: string;
  metadata: ResumeContextMetadata;
};

export type ResumeContextSet = Partial<Record<ResumeType, ResumeContext>>;
