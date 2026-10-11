import { Router } from "express";
import { topJobsRepository } from "../services/topJobs/topJobs.repository.js";
import {
  markTopJobApplied,
  promoteTopJobToTracker,
  runTopJobsSync,
  TopJobsGmailRequiredError,
  TopJobsSyncCooldownError,
} from "../services/topJobs/topJobsSync.js";

export const topJobsRouter = Router();

topJobsRouter.get("/", async (_req, res, next) => {
  try {
    const items = await topJobsRepository.list();
    res.json({ items, total: items.length });
  } catch (error) {
    next(error);
  }
});

topJobsRouter.get("/sync/status", async (_req, res, next) => {
  try {
    const status = await topJobsRepository.getSyncStatus();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

topJobsRouter.post("/sync", async (_req, res, next) => {
  try {
    const stats = await runTopJobsSync({ manual: true });
    const status = await topJobsRepository.getSyncStatus();
    res.json({ stats, status });
  } catch (error) {
    if (error instanceof TopJobsSyncCooldownError) {
      res.status(429).json({ message: error.message });
      return;
    }
    if (error instanceof TopJobsGmailRequiredError) {
      res.status(409).json({ message: error.message });
      return;
    }
    next(error);
  }
});

topJobsRouter.get("/:id", async (req, res, next) => {
  try {
    const job = await topJobsRepository.getById(req.params.id!);
    if (!job) {
      res.status(404).json({ message: "Top job not found" });
      return;
    }
    res.json(job);
  } catch (error) {
    next(error);
  }
});

topJobsRouter.post("/:id/promote", async (req, res, next) => {
  try {
    const job = await promoteTopJobToTracker(req.params.id!);
    res.json(job);
  } catch (error) {
    if (error instanceof Error && error.message === "Top job not found") {
      res.status(404).json({ message: error.message });
      return;
    }
    next(error);
  }
});

topJobsRouter.post("/:id/applied", async (req, res, next) => {
  try {
    const job = await markTopJobApplied(req.params.id!);
    res.json(job);
  } catch (error) {
    if (error instanceof Error && error.message === "Top job not found") {
      res.status(404).json({ message: error.message });
      return;
    }
    next(error);
  }
});
