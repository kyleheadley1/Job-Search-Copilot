import { normalizeText } from "./text.js";

/** NYC metro or common NJ commute — used for commutable + rule overrides. */
export const textImpliesNycMetroOrCommutableNj = (text: string): boolean => {
  const n = normalizeText(text).replace(
    /\([^)]*not\s+commutable\s+from\s+(nyc|new\s+york(\s+city)?)[^)]*\)/gi,
    " ",
  );
  return (
    /\b(nyc|new york city|new york,\s*ny|new york\s+ny|manhattan|brooklyn|queens|bronx|staten island)\b/i.test(
      n,
    ) ||
    /\b(jersey city|hoboken|newark|montclair|princeton|edison|fort lee|bergen county|hudson county)\b/i.test(
      n,
    ) ||
    /\b(new jersey|nj)\b/i.test(n)
  );
};

/** Venture-backed / startup context — weakens "traditional employer" heuristics. */
export const textImpliesVentureBackedStartup = (text: string): boolean => {
  const n = normalizeText(text);
  return (
    /\b(series\s+[a-e]|seed(\s+stage)?|venture[-\s]?backed|vc[-\s]?backed|y\s+combinator|yc\s+[ws]\d{2}|startup|founding\s+team)\b/i.test(
      n,
    ) || /\b(raised\s+\$|post[-\s]?seed|pre[-\s]?ipo)\b/i.test(n)
  );
};

/** Applied AI / product AI engineering — not finance domain by default. */
export const textImpliesAppliedAiEngineering = (text: string): boolean => {
  const n = normalizeText(text);
  return (
    /\b(ai engineer|applied ai|generative ai|llm\b|large language model|rag\b|retrieval[-\s]?augmented|vector\s+(db|database|search)|embedding|agentic|ai workflow|evals?\b|evaluation framework|prompt engineering|langchain|llamaindex)\b/i.test(
      n,
    ) || /\b(machine learning engineer|ml engineer)\b/i.test(n)
  );
};

const STRICT_FINANCE_PHRASES = [
  "investment bank",
  "investment banking",
  "retail bank",
  "commercial bank",
  "private bank",
  "bulge bracket",
  "hedge fund",
  "proprietary trading",
  "prop trading",
  "sell-side",
  "buy-side",
  "asset management",
  "wealth management",
  "capital markets",
  "mortgage lending",
  "loan origination",
  "underwriting",
  "insurance carrier",
  "life insurer",
  "reinsurance",
  "basel iii",
  "fdic",
  "finra",
  "kyc/aml",
  "open banking",
];

const includesAny = (haystack: string, needles: string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

/** Drop benefits / wellness boilerplate so 401k cannot open the finance path. */
const stripBenefitsBoilerplate = (text: string): string =>
  text
    .replace(/\bbenefits?\b[:\s-][^\n.]{0,400}/gi, " ")
    .replace(
      /\b(401\(?k\)?|retirement\s+planning|financial\s+wellness|pension\s+(?:plan|education)|health\s+insurance|competitive\s+salary)\b/gi,
      " ",
    );

const BANK_LIKE_COMPANY = /\b(bank|bancorp|bancshares)\b/i;

/**
 * SaaS / AI vendor selling *to* finance or insurance customers — not itself a financial institution.
 * Suppresses customer-industry phrase matches (underwriting, insurance carrier, banks as customers).
 */
export const textImpliesSellsToFinanceCustomers = (text: string): boolean => {
  const n = normalizeText(text);
  return (
    /\b(sell(?:s|ing)?\s+(?:software|products?|solutions?|ai)\s+to|customers?\s+(?:include|are|in)|used\s+by\s+(?:finance|insurance|banks?)|helps?\s+(?:finance|insurance)\s+(?:operations?\s+)?teams|for\s+(?:insurance\s+carriers?|banks?|financial\s+services)|finance\s+and\s+insurance\s+(?:operations?\s+)?teams|fortune\s+500\s+customers|builds?\s+(?:ai\s+)?(?:software|tools|systems)\s+for\s+(?:insurance|banks?|financial))\b/i.test(
      n,
    ) ||
    /\b(?:hr|human resources|payroll|it product|workforce)\b[^.\n]{0,48}\bfinance\b/i.test(n) ||
    /\bhr,\s*it(?:,|\s+and)\s+finance\b/i.test(n)
  );
};

const EMPLOYER_FINANCE_SELF_IDENTITY =
  /\b(we\s+are\s+an?\s+(?:commercial\s+|retail\s+|investment\s+)?(?:bank|insurer|insurance\s+carrier|hedge\s+fund|asset\s+manager)|fdic[-\s]?insured|our\s+(?:bank|insurance\s+carrier|fund))\b/i;

const NAMED_FINANCE_EMPLOYER =
  /\b(jpmorgan|goldman|morgan stanley|citigroup|citi\b|wells fargo|bank of america|deutsche bank|barclays|ubs\b|credit suisse|prudential|jane street|citadel|two sigma|blackrock)\b/i;

/** Explicit finance / banking / trading employer or JD — not generic "enterprise" or "customers". */
export const detectStrictFinanceEmployerContext = (combinedText: string, companyNorm: string): boolean => {
  const c = stripBenefitsBoilerplate(normalizeText(combinedText));
  const co = normalizeText(companyNorm);
  if (BANK_LIKE_COMPANY.test(co) && !/\bfood\s+bank\b/i.test(co)) return true;
  if (EMPLOYER_FINANCE_SELF_IDENTITY.test(c)) return true;
  if (NAMED_FINANCE_EMPLOYER.test(co)) return true;

  const sellsToFinanceCustomers = textImpliesSellsToFinanceCustomers(c);
  // Named banks / carriers in body: employer when company matches; otherwise ignore vendor customer lists.
  if (NAMED_FINANCE_EMPLOYER.test(c) && !sellsToFinanceCustomers) return true;

  if (/\b(quantitative trader|quant researcher|trading firm|market maker)\b/i.test(c)) return true;
  // Also suppress bare "fintech + lending" for product BNPL / healthcare financing employers.
  if (/\b(fintech)\b/i.test(c) && /\b(lending|core banking|treasury)\b/i.test(c)) {
    if (
      /\b(bnpl|buy\s+now\s+pay\s+later|patient\s+financ|healthcare\s+financ|medical\s+financ|consumer\s+financ)\b/i.test(
        c,
      )
    ) {
      return false;
    }
    return !sellsToFinanceCustomers;
  }

  // Product BNPL / healthcare financing is not a bank/trading institution.
  if (
    /\b(bnpl|buy\s+now\s+pay\s+later|patient\s+financ|healthcare\s+financ|medical\s+financ|consumer\s+financ)\b/i.test(
      c,
    )
  ) {
    return false;
  }

  if (includesAny(c, STRICT_FINANCE_PHRASES)) {
    // Customer/vendor boilerplate ("for insurance carriers", "loan origination tools we sell") is not the employer.
    if (sellsToFinanceCustomers) return false;
    return true;
  }
  return false;
};

const TRADITIONAL_STRICT_PHRASES = [
  "federal government",
  "government contractor",
  "department of defense",
  "defense contractor",
  "public sector",
  "healthcare system",
  "hospital system",
  "health system",
  "campus hire",
  "campus recruiting",
];

const FORTUNE_500_EMPLOYER = /\b(fortune\s+500\s+company|fortune\s+500\s+employer|we\s+are\s+a\s+fortune)\b/i;

/**
 * Traditional / credential-heavy employer — not generic "institution", "customers", or "enterprise".
 * Venture-backed applied-AI startups may still get "campus hire / Fortune 500 employer" noise; suppress only weak signals.
 */
export const detectTraditionalEmployerContextStrict = (combinedText: string, companyNorm: string): boolean => {
  const c = normalizeText(combinedText);
  const co = normalizeText(companyNorm);

  const strongTraditional =
    /\b(federal government|government contractor|department of defense|defense contractor|public sector)\b/i.test(
      c,
    ) ||
    /\b(healthcare system|hospital system|health system)\b/i.test(c) ||
    /\b(ts\/sci|top\s+secret\s+clearance)\b/i.test(c) ||
    /\b(state street|federal reserve|irs\b|dod\b|dhs\b)\b/i.test(c) ||
    (BANK_LIKE_COMPANY.test(co) && !/\bfood\s+bank\b/i.test(co));

  const weakTraditional =
    includesAny(c, TRADITIONAL_STRICT_PHRASES) || FORTUNE_500_EMPLOYER.test(c);

  if (strongTraditional) return true;

  if (!weakTraditional) return false;

  const startup = textImpliesVentureBackedStartup(c);
  const appliedAi = textImpliesAppliedAiEngineering(c);
  const campusPipeline = /\b(campus hire|campus recruiting|rotational program|rotation program)\b/i.test(c);
  if (startup && appliedAi && !campusPipeline) return false;

  return true;
};
