import { describe, expect, it } from "vitest";
import { classifyRoleFunction, classifyRoleLane } from "../../lib/roleFunctionClassifier.js";
import { detectEnterpriseIamSpecializationGap } from "../../lib/capabilityGap.js";
import { riverdaleJob } from "./fixtures/riverdale-job.js";

describe("Riverdale Software Solutions Engineer", () => {
  it("treats a builder-heavy Solutions Engineer title as engineering, not adjacent", () => {
    expect(classifyRoleFunction(riverdaleJob as any).detected).toBe(false);
    expect(classifyRoleLane(riverdaleJob as any).label).not.toBe("adjacent_non_engineering");
  });

  it("does not dock enterprise IAM when SAML/OAuth appear only in preferred qualifications", () => {
    expect(detectEnterpriseIamSpecializationGap(riverdaleJob as any)).toBeUndefined();
  });

  it("still flags a pre-sales Solutions Engineer with no building duties", () => {
    const job = {
      company: "Acme",
      title: "Solutions Engineer",
      stack: [],
      requiredSkills: ["requirements documentation"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [
        "Run product demos for prospects and support the sales team.",
        "Gather functional requirements and coordinate user acceptance testing.",
      ],
      requirements: ["Stakeholder coordination and business analysis experience."],
    };
    expect(classifyRoleFunction(job as any).detected).toBe(true);
  });

  it("still docks enterprise IAM when it is in the required section", () => {
    const job = {
      company: "Acme",
      title: "Software Engineer, Identity",
      stack: ["SAML", "OIDC"],
      requiredSkills: [],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Build SSO integrations with SAML and OIDC for enterprise customers."],
      requirements: ["3+ years building SAML, OIDC, and OAuth integrations; LDAP experience."],
      rawText: "Software Engineer, Identity. SAML OIDC OAuth LDAP SSO identity and access management.",
    };
    const gap = detectEnterpriseIamSpecializationGap(job as any);
    expect(gap?.kind).toBe("enterprise_iam");
    expect(gap?.severity).toBe("central");
  });
});
