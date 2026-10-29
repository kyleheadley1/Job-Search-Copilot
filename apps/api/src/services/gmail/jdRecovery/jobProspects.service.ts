import { randomUUID } from "node:crypto";
import { computeJdTextHash } from "../../../lib/jdTextHash.js";
import { logger } from "../../../lib/logger.js";
import { normalizeSourceUrl } from "../../../lib/normalizeSourceUrl.js";
import { normalizeCompany } from "../gmailApplications.js";
import { cleanProspectJd } from "./cleanProspectJd.js";
import {
  jobProspectsRepository,
  prospectFields,
  type JobProspect,
} from "./jobProspects.repository.js";
import { isDuplicateOf, isSpecificJobUrl, PROSPECT_MATCH_LOOKBACK_DAYS } from "./prospectMatch.js";
import { startRecoveryRun } from "./runRecovery.js";

export type SaveJobProspectInput = {
  rawText: string;
  company: string;
  title: string;
  location?: string;
  seniority?: string;
  requisitionId?: string;
  sourceUrl?: string;
  salary?: string;
};

export type SaveJobProspectResult = {
  id: string;
  company: string;
  title: string;
  location?: string;
  seniority?: string;
  requisitionId?: string;
  sourceUrl?: string;
  duplicate: boolean;
  status: JobProspect["status"];
  attachedKey?: string;
  recoveryQueued: boolean;
  rawChars: number;
  cleanedChars: number;
};

const blankToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const persistJobProspect = async (input: SaveJobProspectInput): Promise<{ prospect: JobProspect; duplicate: boolean }> => {
  const company = input.company.trim();
  const title = input.title.trim();
  const companyKey = normalizeCompany(company);
  if (!companyKey) {
    throw new Error("Company is empty after normalization");
  }
  const rawText = input.rawText.replace(/\r\n/g, "\n").trim();
  const cleanedText = cleanProspectJd(rawText) || rawText;
  const cleanedTextHash = computeJdTextHash(cleanedText);
  const requisitionId = blankToUndefined(input.requisitionId);
  const sourceUrl = blankToUndefined(input.sourceUrl);
  const normalizedSourceUrl = sourceUrl && isSpecificJobUrl(sourceUrl) ? normalizeSourceUrl(sourceUrl) : undefined;
  const incoming = { title, cleanedTextHash, requisitionId, normalizedSourceUrl, sourceUrl };

  const existing = (await jobProspectsRepository.findByCompanyKey(companyKey)).find((row) => isDuplicateOf(incoming, row));
  if (existing) {
    return { prospect: existing, duplicate: true };
  }

  const now = new Date().toISOString();
  const prospect: JobProspect = {
    id: randomUUID(),
    company,
    companyKey,
    title,
    ...prospectFields({
      location: blankToUndefined(input.location),
      seniority: blankToUndefined(input.seniority),
      requisitionId,
      sourceUrl,
      normalizedSourceUrl,
      salary: blankToUndefined(input.salary),
    }),
    rawText,
    cleanedText,
    cleanedTextHash,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  await jobProspectsRepository.insert(prospect);
  return { prospect, duplicate: false };
};

/** Persist only. Does not score, write the tracker, or create an application. */
export const saveJobProspect = async (input: SaveJobProspectInput): Promise<SaveJobProspectResult> => {
  const { prospect, duplicate } = await persistJobProspect(input);
  let recoveryQueued = false;
  if (prospect.status === "open") {
    try {
      const started = await startRecoveryRun(PROSPECT_MATCH_LOOKBACK_DAYS, { companyKey: prospect.companyKey });
      recoveryQueued = started.started || started.running;
    } catch (error) {
      logger.warn("Prospect saved but recovery enqueue failed", {
        prospectId: prospect.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info("Job prospect saved", {
    prospectId: prospect.id,
    duplicate,
    companyKey: prospect.companyKey,
    recoveryQueued,
  });
  return {
    id: prospect.id,
    company: prospect.company,
    title: prospect.title,
    location: prospect.location,
    seniority: prospect.seniority,
    requisitionId: prospect.requisitionId,
    sourceUrl: prospect.sourceUrl,
    duplicate,
    status: prospect.status,
    attachedKey: prospect.attachedKey,
    recoveryQueued,
    rawChars: prospect.rawText.length,
    cleanedChars: prospect.cleanedText.length,
  };
};
