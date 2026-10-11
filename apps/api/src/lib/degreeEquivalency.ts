import type { ExtractedJobData } from "../types/job.js";
import type { RuleEvaluation } from "../types/scoring.js";
import type { UserProfile } from "../types/userProfile.js";
import { normalizeMatcherText, normalizeText } from "./text.js";

export const jobCredentialBlob = (job: ExtractedJobData): string =>
  normalizeMatcherText(
    [
      job.title ?? "",
      job.rawText ?? "",
      job.degreeRequirement?.raw ?? "",
      ...(job.requirements ?? []),
      ...(job.responsibilities ?? []),
    ].join("\n"),
  );

/**
 * True when the JD actually mentions degree/credential requirements (Required/raw/degree field).
 * Used to block ungrounded "no bachelor's could hurt" Key Risks from industry inference alone.
 */
export const jdMentionsDegreeLanguage = (job: ExtractedJobData): boolean => {
  if (job.degreeRequirement?.raw?.trim() || job.degreeRequirement?.level === "required") {
    return true;
  }
  const blob = jobCredentialBlob(job);
  return (
    /\b(bachelor'?s?|bachelors|bs\s+in|b\.s\.|ba\s+in|undergraduate\s+degree|four[\s-]year\s+degree)\b/i.test(
      blob,
    ) ||
    /\b(degree\s+in|cs\s+degree|computer\s+science\s+degree|master'?s?\s+degree|phd|ph\.d)\b/i.test(blob) ||
    /\b(degree|bachelor)\b[^.\n]{0,80}\b(required|preferred|mandatory)\b/i.test(blob) ||
    /\b(required|preferred|mandatory)\b[^.\n]{0,80}\b(degree|bachelor)\b/i.test(blob)
  );
};

/** Broader than equivalency-clause detection — portfolio-first / experience-over-degree framing. */
export const jdIsDegreePositive = (job: ExtractedJobData): boolean => {
  const degreeLevel = job.degreeRequirement?.level ?? "unknown";
  const degreeRaw = normalizeMatcherText(job.degreeRequirement?.raw ?? "");
  const blob = jobCredentialBlob(job);

  const unconditionalDegreeGate =
    degreeLevel === "required" &&
    /\b(bachelor|degree|bs in|b\.s\.)\b/.test(degreeRaw) &&
    /\brequired\b/.test(degreeRaw) &&
    !jdHasDegreeEquivalencyClause(blob, degreeLevel, job.degreeRequirement?.raw ?? "");

  if (unconditionalDegreeGate) return false;

  return (
    /\bpractical experience matters more than (?:a )?(?:specific )?degree\b/.test(blob) ||
    /\bexperience matters more than (?:a )?degree\b/.test(blob) ||
    /\bexperience over (?:a )?degree\b/.test(blob) ||
    /\bno degree required\b/.test(blob) ||
    /\bdegree not required\b/.test(blob) ||
    /\bself taught welcome\b/.test(blob) ||
    /\bbootcamp welcome\b/.test(blob) ||
    /\bportfolio\b[^.\n]{0,80}\bwelcome\b/.test(blob) ||
    /\bshow the work\b/.test(blob) ||
    /\b(shipped app|hackathon|prototype you can show)\b/.test(blob) ||
    /\bearly career (?:builders|students|freelancers)\b[^.\n]{0,80}\bwelcome\b/.test(blob) ||
    /\b(?:builders|students|freelancers)\b[^.\n]{0,80}\bwelcome\b/.test(blob)
  );
};

export const profileHasPortfolio = (profile: UserProfile, resumeText = ""): boolean => {
  const blob = normalizeMatcherText(
    [
      profile.headline,
      ...(profile.flagshipProjects?.map((p) => `${p.name} ${p.summary}`) ?? []),
      resumeText,
    ].join(" "),
  );
  if ((profile.flagshipProjects?.length ?? 0) >= 1) return true;
  return /\b(github\.com|gitlab\.com|shipped|deployed|portfolio|open source|open-source|hackathon|prototype)\b/.test(
    blob,
  );
};

export const isHardStructuredDegreeGate = (rules: RuleEvaluation): boolean =>
  Boolean(
    rules.explicitDegreeRisk &&
      rules.matureStructuredEmployer &&
      !rules.degreeEquivalencySatisfied,
  );

const profileCredentialBlob = (profile: UserProfile): string =>
  normalizeText(
    [profile.degreeStatus.note, profile.training?.program ?? "", profile.headline].join(" "),
  );

export const profileHasAssociateDegree = (profile: UserProfile): boolean => {
  if (profile.degreeStatus.hasBachelors) return false;
  return /\b(associate of arts|associate(?:'?s)?\s+degree|associate'?s|\ba\.?\s*a\.?\b)\b/i.test(
    profileCredentialBlob(profile),
  );
};

export const profileHasBootcampCert = (profile: UserProfile): boolean => {
  const blob = profileCredentialBlob(profile);
  if (/\b(bootcamp|immersive|certificate|certification program|software development certificate)\b/i.test(blob)) {
    return true;
  }
  return Boolean(
    profile.training?.program &&
      /\b(bootcamp|immersive|residency|fellowship|certificate)\b/i.test(profile.training.program),
  );
};

/** JD exposes an alternate credential path — not an unconditional degree hard gate. */
export const jdHasDegreeEquivalencyClause = (
  combinedText: string,
  degreeLevel: ExtractedJobData["degreeRequirement"] extends { level?: infer L } ? L : string | undefined,
  degreeRaw = "",
): boolean => {
  const blob = normalizeMatcherText(`${combinedText}\n${degreeRaw}`);
  const dr = normalizeMatcherText(degreeRaw);
  return (
    degreeLevel === "equivalent_allowed" ||
    degreeLevel === "preferred" ||
    /\bin lieu of (?:a )?degree\b/.test(blob) ||
    /\bcertificate in lieu\b/.test(blob) ||
    /\bcompleted [^.\n]{0,80}certificate in lieu\b/.test(blob) ||
    /\bassociate or bachelor'?s?\b/.test(blob) ||
    /\bassociate'?s?\s+or\s+bachelor'?s?\b/.test(blob) ||
    /\bbootcamp accepted\b/.test(blob) ||
    /\bbootcamp[^.\n]{0,80}\b(accepted|considered|welcome|qualify)\b/.test(blob) ||
    /\bor related experience\b/.test(blob) ||
    /\bor equivalent experience\b/.test(blob) ||
    /\bor equivalent practical experience\b/.test(blob) ||
    /\bor comparable experience\b/.test(blob) ||
    /\brelevant experience may substitute\b/.test(blob) ||
    /\bexperience in lieu of a degree\b/.test(blob) ||
    /\b(bachelor'?s?|degree)\s+or\s+equivalent\b/.test(blob) ||
    /\bdegree preferred but not required\b/.test(blob) ||
    /\bdegree is a plus\b/.test(blob) ||
    /\b(preferred|nice to have|a plus)\b[^.\n]{0,80}\b(degree|bachelor)\b/.test(blob) ||
    /\b(bootcamp|open[-\s]?source|project experience)\b[^.\n]{0,100}\b(accepted|considered|welcome|qualify)\b/.test(
      blob,
    ) ||
    /\b(bachelor|degree)[^.\n]{0,120}\bor equivalent\b/.test(blob) ||
    /\bor equivalent[^.\n]{0,80}\b(bachelor|degree)\b/.test(blob) ||
    /\bassociate[^.\n]{0,80}\bor[^.\n]{0,40}\bbachelor/.test(blob) ||
    /\bbachelor[^.\n]{0,80}\bor[^.\n]{0,40}\bassociate/.test(blob) ||
    // Precisely-style: explicit experience substituted for the education requirement
    /\bequivalent work experience will be accepted\b/.test(blob) ||
    /\bequivalent (?:work )?experience\b[^.\n]{0,80}\bin place of\b/.test(blob) ||
    /\bin place of the (?:education|degree) requirement\b/.test(blob) ||
    /\bwork experience accepted in lieu of (?:a )?(?:degree|education)\b/.test(blob) ||
    /\b(?:work )?experience (?:will be|is) accepted in (?:lieu|place) of\b/.test(blob) ||
    /\bin lieu of\b/.test(dr) ||
    /\bin place of the (?:education|degree) requirement\b/.test(dr)
  );
};

const STRICT_FIELD_DEGREE_RE =
  /\b(?:bachelor'?s?|b\.?s\.?|b\.?a\.?|undergraduate)\b[^\n]{0,25}?\b(?:degree\s+)?in\s+(?:computer science|cs|computer engineering|software engineering|engineering|information technology|mathematics|a (?:technical|stem) field)\b/i;
const DEGREE_ALTERNATIVE_ON_LINE_RE =
  /\b(?:equivalent|experience|in lieu|in place of|preferred|a plus|nice to have|ideally|bonus|or similar|bootcamp)\b/i;

/**
 * A requirement line naming a degree field ("Bachelors Degree in Computer Science") with no
 * alternative on that line. With a separate "or equivalent" line elsewhere, the JD is conflicting:
 * the specific line is usually what screeners and knockout questions use.
 */
export const jdHasStrictFieldDegreeLine = (rawText: string): boolean =>
  rawText
    .split(/\n|•|·|;/)
    .some((line) => STRICT_FIELD_DEGREE_RE.test(line) && !DEGREE_ALTERNATIVE_ON_LINE_RE.test(line));

export const jdAcceptsAssociateDegreePath = (combinedText: string, degreeRaw = ""): boolean => {
  const blob = normalizeText(`${combinedText}\n${degreeRaw}`);
  return (
    /\bassociate or bachelor'?s?\b/i.test(blob) ||
    /\bassociate'?s?\s+or\s+bachelor'?s?\b/i.test(blob) ||
    /\bassociate'?s?\s+degree\b/i.test(blob) ||
    /\bassociate[^.\n]{0,80}\bor[^.\n]{0,40}\bbachelor/i.test(blob)
  );
};

export const jdAcceptsCertificateInLieuPath = (combinedText: string, degreeRaw = ""): boolean => {
  const blob = normalizeText(`${combinedText}\n${degreeRaw}`);
  return (
    /\bin lieu of (?:a )?degree\b/i.test(blob) ||
    /\bcertificate in lieu\b/i.test(blob) ||
    /\bsoftware development certificate\b/i.test(blob) ||
    /\bbootcamp accepted\b/i.test(blob) ||
    /\bbootcamp[^.\n]{0,80}\b(accepted|considered|welcome|qualify)\b/i.test(blob)
  );
};

/** JD substitutes equivalent work / practical experience for the degree requirement. */
export const jdAcceptsWorkExperienceInLieuPath = (
  combinedText: string,
  degreeRaw = "",
): boolean => {
  const blob = normalizeMatcherText(`${combinedText}\n${degreeRaw}`);
  return (
    /\bequivalent work experience will be accepted\b/.test(blob) ||
    /\bequivalent (?:work )?experience\b[^.\n]{0,80}\bin place of\b/.test(blob) ||
    /\bin place of the (?:education|degree) requirement\b/.test(blob) ||
    /\bwork experience accepted in lieu of (?:a )?(?:degree|education)\b/.test(blob) ||
    /\b(?:work )?experience (?:will be|is) accepted in (?:lieu|place) of\b/.test(blob)
  );
};

/**
 * Candidate has concrete SWE experience the JD can accept in place of a degree
 * (bootcamp / residency + shipped work, or associate path already covered elsewhere).
 */
export const profileHasEquivalentWorkExperience = (
  profile: UserProfile,
  resumeText = "",
): boolean => {
  const hasTraining = profileHasBootcampCert(profile);
  const hasShippedWork =
    profileHasPortfolio(profile, resumeText) || (profile.flagshipProjects?.length ?? 0) >= 1;
  return hasTraining && hasShippedWork;
};

/** Candidate meets at least one JD-accepted alternate credential path. */
export const candidateSatisfiesDegreeEquivalency = (
  profile: UserProfile,
  combinedText: string,
  degreeLevel: ExtractedJobData["degreeRequirement"] extends { level?: infer L } ? L : string | undefined,
  degreeRaw = "",
  resumeText = "",
): boolean => {
  if (profile.degreeStatus.hasBachelors) return true;
  if (!jdHasDegreeEquivalencyClause(combinedText, degreeLevel, degreeRaw)) return false;

  const hasAssociate = profileHasAssociateDegree(profile);
  const hasBootcamp = profileHasBootcampCert(profile);

  if (hasAssociate && jdAcceptsAssociateDegreePath(combinedText, degreeRaw)) return true;
  if (hasBootcamp && jdAcceptsCertificateInLieuPath(combinedText, degreeRaw)) return true;
  if (
    jdAcceptsWorkExperienceInLieuPath(combinedText, degreeRaw) &&
    profileHasEquivalentWorkExperience(profile, resumeText)
  ) {
    return true;
  }

  return false;
};

export const resolveDegreeEquivalencyRules = (
  profile: UserProfile,
  combinedText: string,
  degreeRequiredSignal: boolean,
  degreeLevel: ExtractedJobData["degreeRequirement"] extends { level?: infer L } ? L : string | undefined,
  degreeRaw = "",
  resumeText = "",
): Pick<
  RuleEvaluation,
  "degreeHasEquivalencyClause" | "degreeEquivalencySatisfied" | "explicitDegreeRisk"
> => {
  const degreeHasEquivalencyClause = jdHasDegreeEquivalencyClause(combinedText, degreeLevel, degreeRaw);
  const degreeEquivalencySatisfied = candidateSatisfiesDegreeEquivalency(
    profile,
    combinedText,
    degreeLevel,
    degreeRaw,
    resumeText,
  );
  const explicitDegreeRisk =
    degreeRequiredSignal && !degreeHasEquivalencyClause && !degreeEquivalencySatisfied;

  return {
    degreeHasEquivalencyClause,
    degreeEquivalencySatisfied,
    explicitDegreeRisk,
  };
};
