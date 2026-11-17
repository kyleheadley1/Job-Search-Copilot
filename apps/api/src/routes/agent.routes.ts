import { Router, type Response } from "express";
import { z } from "zod";
import {
  AgentBusyError,
  approveSuggestion,
  dismissSuggestion,
  draftSuggestion,
  getAgentPanel,
  runAgentNow,
  suggestionReplyTarget,
  SuggestionNotFoundError,
} from "../services/agent/dailyAgent.js";
import { GMAIL_DRAFTS_URL, InvalidRecipientError } from "../services/gmail/replyDraft.js";
import { DraftsNotAllowedError, ProposalTargetError } from "../services/proposals/execute.js";

export const agentRouter = Router();

agentRouter.get("/suggestions", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getAgentPanel());
  } catch (error) {
    next(error);
  }
});

agentRouter.post("/run", async (_req, res, next) => {
  try {
    const run = await runAgentNow();
    res.json({ run, ...(await getAgentPanel()) });
  } catch (error) {
    if (error instanceof AgentBusyError) {
      res.status(409).json({ message: error.message });
      return;
    }
    next(error);
  }
});

agentRouter.post("/suggestions/:id/approve", async (req, res, next) => {
  try {
    const suggestion = await approveSuggestion(req.params.id!);
    res.json({ suggestion });
  } catch (error) {
    if (!proposalError(error, res)) next(error);
  }
});

const proposalError = (error: unknown, res: Response): boolean => {
  if (error instanceof SuggestionNotFoundError || error instanceof ProposalTargetError) {
    res.status(404).json({ message: error.message });
    return true;
  }
  if (error instanceof InvalidRecipientError) {
    res.status(400).json({ message: error.message });
    return true;
  }
  if (error instanceof DraftsNotAllowedError) {
    res.status(409).json({ message: error.message });
    return true;
  }
  return false;
};

agentRouter.get("/suggestions/:id/reply-target", async (req, res, next) => {
  try {
    res.json(await suggestionReplyTarget(req.params.id!));
  } catch (error) {
    if (!proposalError(error, res)) next(error);
  }
});

const DraftBodySchema = z.object({
  to: z.string().trim().min(3).max(320),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(5000),
});

agentRouter.post("/suggestions/:id/draft", async (req, res, next) => {
  try {
    const approved = DraftBodySchema.parse(req.body);
    const entry = await draftSuggestion(req.params.id!, approved);
    res.json({ draftId: entry.draftId, threadId: entry.threadId, to: entry.to, draftsUrl: GMAIL_DRAFTS_URL });
  } catch (error) {
    if (!proposalError(error, res)) next(error);
  }
});

agentRouter.post("/suggestions/:id/dismiss", async (req, res, next) => {
  try {
    await dismissSuggestion(req.params.id!);
    res.status(204).end();
  } catch (error) {
    if (error instanceof SuggestionNotFoundError) {
      res.status(404).json({ message: error.message });
      return;
    }
    next(error);
  }
});
