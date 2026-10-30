import { describe, expect, it } from "vitest";
import { exampleUserProfile } from "../../config/userProfile.example.js";
import {
  assessCommute,
  assessJdGeoCompatibility,
  HOME_ACCESS_BUFFER_MINUTES,
  ROUGH_TRANSFER_ALLOWANCE_MINUTES,
} from "../../services/gmail/jdRecovery/jdGeoCompatibility.js";

const nycProfile = exampleUserProfile;

const assess = (
  over: Parameters<typeof assessJdGeoCompatibility>[0]["candidate"] & { applicationLocation?: string; commute?: Parameters<typeof assessJdGeoCompatibility>[0]["commute"] },
) =>
  assessJdGeoCompatibility({
    candidate: over,
    applicationLocation: over.applicationLocation,
    commute: over.commute,
    profile: nycProfile,
  });

describe("assessJdGeoCompatibility", () => {
  it("treats an NYC onsite posting as compatible", () => {
    const result = assess({
      location: "New York, NY",
      text: "Software Engineer, onsite in New York, NY near Grand Central.",
    });
    expect(result.status).toBe("compatible");
    expect(result.workArrangement).toBe("onsite");
    expect(result.excludedFromDefaultReview).toBe(false);
  });

  it("treats an NYC hybrid posting as compatible", () => {
    const result = assess({
      location: "New York, NY",
      text: "Hybrid role based in Midtown West / Times Square, 2 days in office.",
    });
    expect(result.status).toBe("compatible");
    expect(result.workArrangement).toBe("hybrid");
  });

  it("treats remote US as compatible for an NYC-based candidate", () => {
    const result = assess({
      location: "Remote, United States",
      text: "This is a remote US role. Headquartered in Seattle.",
    });
    expect(result.status).toBe("compatible");
    expect(result.remoteEligibility).toBe("remote_us");
    expect(result.reason).toMatch(/headquarters/i);
  });

  it("treats remote restricted to another geography as incompatible", () => {
    const result = assess({
      location: "Remote",
      text: "Remote role. Candidates must be located in California. No New York applicants.",
    });
    expect(result.status).toBe("incompatible");
    expect(result.remoteEligibility).toBe("remote_restricted");
    expect(result.excludedFromDefaultReview).toBe(true);
  });

  it("does not use employer headquarters as the office when the job is available in NYC", () => {
    const result = assess({
      location: "New York, NY",
      text: "Headquartered in Seattle, WA. This role is based in New York, NY (hybrid).",
    });
    expect(result.status).toBe("compatible");
    expect(result.userPreferenceConflict).toBe(false);
  });

  it("keeps a multi-location posting if NYC is one of the options", () => {
    const result = assess({
      location: "Seattle, WA or New York, NY",
      text: "Offices in Seattle, WA and New York, NY. Hybrid.",
    });
    expect(result.status).toBe("compatible");
    expect(result.excludedFromDefaultReview).toBe(false);
  });

  it("excludes an explicit Seattle onsite posting", () => {
    const result = assess({
      location: "Seattle, WA",
      text: "Onsite Software Engineer in Seattle, WA. You will work from the Seattle office.",
    });
    expect(result.status).toBe("incompatible");
    expect(result.excludedFromDefaultReview).toBe(true);
    expect(result.userPreferenceConflict).toBe(true);
  });

  it("flags a candidate city that conflicts with a verified application city", () => {
    const result = assess({
      location: "Denver, CO",
      text: "Onsite in Denver, CO.",
      applicationLocation: "New York, NY",
    });
    expect(result.identityConflict).toBe(true);
    expect(result.status).toBe("incompatible");
  });

  it("returns unknown when location is missing", () => {
    const result = assess({
      text: "We are looking for a software engineer to build product.",
    });
    expect(result.status).toBe("unknown");
    expect(result.excludedFromDefaultReview).toBe(false);
    expect(result.reason).toMatch(/not proof of compatibility/i);
  });

  it("does not auto-exclude a Claude-only location assertion", () => {
    const result = assessJdGeoCompatibility({
      candidate: { location: "Seattle, WA", text: "Software engineer role. Build APIs." },
      locationProvenance: "claude_reported",
      profile: nycProfile,
    });
    expect(result.status).toBe("needs_review");
    expect(result.provenance).toBe("claude_reported");
    expect(result.excludedFromDefaultReview).toBe(false);
  });

  it("does not auto-hide a red-zone neighborhood without a verified commute", () => {
    const result = assess({
      location: "Williamsburg, Brooklyn",
      text: "Onsite in Williamsburg, Brooklyn.",
    });
    expect(result.neighborhoodZone).toBe("red");
    expect(result.status).toBe("needs_review");
    expect(result.excludedFromDefaultReview).toBe(false);
  });

  it("does not auto-hide New Jersey on heuristic commute alone", () => {
    const result = assess({
      location: "Hoboken, NJ",
      text: "Hybrid office in Hoboken, New Jersey. Two days onsite.",
    });
    expect(result.neighborhoodZone).toBe("red");
    expect(result.status).toBe("needs_review");
    expect(result.excludedFromDefaultReview).toBe(false);
  });

  it("accepts a red-zone office when a verified commute is within 60 minutes", () => {
    const result = assess({
      location: "Williamsburg, Brooklyn",
      text: "Onsite in Williamsburg, Brooklyn.",
      commute: {
        provenance: "verified_route",
        transitMinutes: 32,
        includesTransfers: true,
        includesHomeAccess: false,
        usesDirect25: false,
        transferCount: 1,
      },
    });
    expect(result.status).toBe("compatible");
    expect(result.commute.totalMinutes).toBe(32 + HOME_ACCESS_BUFFER_MINUTES);
    expect(result.excludedFromDefaultReview).toBe(false);
  });

  it("fails a preferred neighborhood when a verified commute exceeds 60 minutes", () => {
    const result = assess({
      location: "New York, NY",
      text: "Onsite near Grand Central / Midtown East.",
      commute: {
        provenance: "verified_route",
        transitMinutes: 50,
        includesHomeAccess: false,
        includesTransfers: true,
        includesFinalWalk: true,
      },
    });
    expect(result.commute.totalMinutes).toBe(65);
    expect(result.status).toBe("incompatible");
    expect(result.commute.classification).toBe("too_long");
  });
});

describe("assessCommute", () => {
  it("adds the home-access buffer to a direct 2/5 route", () => {
    const result = assessCommute({
      provenance: "verified_route",
      transitMinutes: 22,
      usesDirect25: true,
      transferCount: 0,
      includesTransfers: true,
      includesHomeAccess: false,
    });
    expect(result.totalMinutes).toBe(37);
    expect(result.classification).toBe("excellent");
    expect(result.usedVerifiedRoute).toBe(true);
  });

  it("does not double-count transfers when the routing result already includes them", () => {
    const result = assessCommute({
      provenance: "verified_route",
      transitMinutes: 35,
      usesDirect25: false,
      transferCount: 1,
      includesTransfers: true,
      includesHomeAccess: false,
    });
    expect(result.totalMinutes).toBe(50);
    expect(result.assumptions.some((row) => /not double-counted/i.test(row))).toBe(true);
    expect(result.classification).toBe("manageable_hybrid");
  });

  it("adds a transfer allowance only to rough estimates that omit transfers", () => {
    const result = assessCommute({
      provenance: "rough_estimate",
      transitMinutes: 30,
      includesTransfers: false,
      includesHomeAccess: false,
      transferCount: 1,
    });
    expect(result.totalMinutes).toBe(30 + HOME_ACCESS_BUFFER_MINUTES + ROUGH_TRANSFER_ALLOWANCE_MINUTES);
  });

  it("adds final walking time when the transit estimate excludes it", () => {
    const result = assessCommute({
      provenance: "verified_route",
      transitMinutes: 20,
      includesHomeAccess: true,
      includesTransfers: true,
      includesFinalWalk: false,
      finalWalkMinutes: 8,
    });
    expect(result.totalMinutes).toBe(28);
  });

  it("classifies under 45, 45–60, and over 60 minutes", () => {
    expect(assessCommute({ provenance: "verified_route", transitMinutes: 20, includesHomeAccess: true, includesTransfers: true }).classification).toBe("excellent");
    expect(assessCommute({ provenance: "verified_route", transitMinutes: 50, includesHomeAccess: true, includesTransfers: true }).classification).toBe("manageable_hybrid");
    expect(assessCommute({ provenance: "verified_route", transitMinutes: 61, includesHomeAccess: true, includesTransfers: true }).classification).toBe("too_long");
  });

  it("does not invent minutes when no routing data exists", () => {
    const result = assessCommute({ provenance: "none" });
    expect(result.totalMinutes).toBeUndefined();
    expect(result.classification).toBe("unknown");
    expect(result.usedVerifiedRoute).toBe(false);
  });
});
