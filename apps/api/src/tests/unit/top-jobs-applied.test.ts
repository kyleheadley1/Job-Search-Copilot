import { afterEach, describe, expect, it, vi } from "vitest";
import { jobsRepository } from "../../services/jobs/jobs.repository.js";
import { topJobsRepository } from "../../services/topJobs/topJobs.repository.js";
import { markTopJobApplied } from "../../services/topJobs/topJobsSync.js";
import type { JobRecord } from "../../types/job.js";
import type { TopJobRecord } from "../../types/topJob.js";

const trackerJob = (status: JobRecord["status"]) => ({ id: "job-1", status }) as unknown as JobRecord;

describe("markTopJobApplied", () => {
  afterEach(() => vi.restoreAllMocks());

  it("marks an already-promoted 'to review' row applied and hides it from Top Jobs", async () => {
    vi.spyOn(topJobsRepository, "getById").mockResolvedValue({ id: "top-1", promotedToJobId: "job-1" } as TopJobRecord);
    vi.spyOn(jobsRepository, "getById").mockResolvedValue(trackerJob("to_review"));
    const setApplied = vi.spyOn(jobsRepository, "updateAppliedAt").mockResolvedValue(trackerJob("applied"));
    const hide = vi.spyOn(topJobsRepository, "hide").mockResolvedValue();

    const saved = await markTopJobApplied("top-1");

    expect(setApplied).toHaveBeenCalledWith("job-1", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(saved.status).toBe("applied");
    expect(hide).toHaveBeenCalledWith("top-1", "applied");
  });

  it("leaves a row that already moved past applied untouched", async () => {
    vi.spyOn(topJobsRepository, "getById").mockResolvedValue({ id: "top-1", promotedToJobId: "job-1" } as TopJobRecord);
    vi.spyOn(jobsRepository, "getById").mockResolvedValue(trackerJob("interviewing"));
    const setApplied = vi.spyOn(jobsRepository, "updateAppliedAt");
    vi.spyOn(topJobsRepository, "hide").mockResolvedValue();

    const saved = await markTopJobApplied("top-1");

    expect(setApplied).not.toHaveBeenCalled();
    expect(saved.status).toBe("interviewing");
  });
});
