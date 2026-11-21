import { describe, expect, it, vi } from "vitest";
import {
  looksLikeApplicationReceipt,
  RECEIPT_REASON,
  repairReceiptScores,
} from "../../services/gmail/jdRecovery/applicationReceipt.js";
import { assessJdCompleteness } from "../../services/gmail/jdRecovery/jdCompleteness.js";
import { PostingFetchError, validatePosting } from "../../services/gmail/jdRecovery/fetchPosting.js";

const WORKABLE_RECEIPT = `Software Engineer, Early Career
Remote Engineering Full-time
United States
Your application was received on Thursday, November 12, 2026 at 12:32 AM.
Did you change your mind?
Withdraw this application
Personal information
Name
Kyle Headley
Headline
Full-Stack Engineer
Experience
• Built a 50-question golden-set evaluation harness combining deterministic retrieval checks and LLM-as-judge scoring
• Developed RESTful APIs in Node.js and Express to support frontend features and handle business logic for internal users
• Implemented authentication and role-based access control to support secure multi-user workflows across the app
Resume
Kyle_Headley_Resume_Base.pdf
Answers
Do you have experience with JavaScript or TypeScript?
Yes
`.repeat(2);

const REAL_JD = `Junior Full Stack Engineer
About the Role
We're looking for a Junior Full Stack Engineer to help build the applications that power our platform.
What You'll Do
- Build and improve full-stack features across our web applications.
- Develop frontend interfaces using JavaScript, TypeScript, and React.
- Help implement backend functionality using Node.js and TypeScript.
Requirements
- Working knowledge of JavaScript or TypeScript and modern frontend frameworks.
- Familiarity with Node.js or another backend development environment.
- Basic knowledge of SQL databases or relational data and REST APIs.
Apply for this job
First Name
Last Name
Email
Phone
Resume/CV
Cover Letter
Will you now or in the future require visa sponsorship?
What are your salary expectations?
`;

describe("looksLikeApplicationReceipt", () => {
  it("flags a Workable candidate-portal page", () => {
    expect(looksLikeApplicationReceipt(WORKABLE_RECEIPT)).toBe(true);
  });

  it("flags candidate-portal and thank-you URLs", () => {
    expect(looksLikeApplicationReceipt("x", "https://bask-health-1.workable.com/jobs/6265191/candidates/abc")).toBe(true);
    expect(looksLikeApplicationReceipt("x", "https://acme.com/careers/thank-you")).toBe(true);
  });

  it("does not flag a real posting with an embedded apply form", () => {
    expect(looksLikeApplicationReceipt(REAL_JD, "https://job-boards.greenhouse.io/acme/jobs/123")).toBe(false);
  });

  it("marks receipts incomplete so they are never scored", () => {
    const a = assessJdCompleteness(WORKABLE_RECEIPT);
    expect(a.applicationReceipt).toBe(true);
    expect(a.complete).toBe(false);
  });

  it("rejects receipt pages at fetch time", () => {
    expect(() => validatePosting({ text: WORKABLE_RECEIPT }, "https://x.workable.com/j/1", "generic")).toThrow(
      PostingFetchError,
    );
  });
});

describe("repairReceiptScores", () => {
  const rows = [
    { key: "bask::early", company: "Bask Health", role: "Software Engineer, Early Career", recovery: { status: "scored", url: "https://bask-health-1.workable.com/jobs/1/candidates/x" }, jd: { text: "anything" }, fit: { total: 86 } },
    { key: "bask::full", company: "Bask Health", role: "Junior Full Stack Engineer", recovery: { status: "scored" }, jd: { text: REAL_JD }, fit: { total: 89 } },
  ];

  it("lists without changing anything by default", async () => {
    const invalidateScore = vi.fn();
    const result = await repairReceiptScores({ apply: false }, { listScoredSince: async () => rows, invalidateScore });
    expect(result.found).toBe(1);
    expect(result.rows[0]!.key).toBe("bask::early");
    expect(invalidateScore).not.toHaveBeenCalled();
  });

  it("withdraws only receipt-scored rows and restarts recovery", async () => {
    const invalidateScore = vi.fn(async () => ({}));
    const restartRecovery = vi.fn(async () => ({}));
    const result = await repairReceiptScores(
      { apply: true },
      { listScoredSince: async () => rows, invalidateScore, restartRecovery },
    );
    expect(invalidateScore).toHaveBeenCalledWith("bask::early", RECEIPT_REASON);
    expect(result.invalidated).toBe(1);
    expect(restartRecovery).toHaveBeenCalled();
  });
});
