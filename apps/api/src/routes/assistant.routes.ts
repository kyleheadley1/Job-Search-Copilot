import { Router, type Response } from "express";
import { z } from "zod";
import {
  approveProposal,
  AssistantBusyError,
  clearAssistantThread,
  dismissProposal,
  getAssistantThread,
  proposalReplyTarget,
  ProposalNotFoundError,
  sendAssistantMessage,
} from "../services/assistant/assistant.js";
import { GMAIL_DRAFTS_URL, InvalidRecipientError } from "../services/gmail/replyDraft.js";
import { DraftsNotAllowedError, ProposalTargetError } from "../services/proposals/execute.js";
import { ListingNotScorableError } from "../services/topJobs/topJobsSync.js";

export const assistantRouter = Router();

const handled = (error: unknown, res: Response): boolean => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ message: error.issues[0]?.message ?? "Invalid request" });
    return true;
  }
  if (error instanceof ProposalNotFoundError || error instanceof ProposalTargetError) {
    res.status(404).json({ message: error.message });
    return true;
  }
  if (error instanceof InvalidRecipientError) {
    res.status(400).json({ message: error.message });
    return true;
  }
  if (
    error instanceof DraftsNotAllowedError ||
    error instanceof AssistantBusyError ||
    error instanceof ListingNotScorableError
  ) {
    res.status(409).json({ message: error.message });
    return true;
  }
  return false;
};

assistantRouter.get("/thread", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getAssistantThread());
  } catch (error) {
    next(error);
  }
});

assistantRouter.delete("/thread", async (_req, res, next) => {
  try {
    await clearAssistantThread();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

const MessageSchema = z.object({ text: z.string().trim().min(1).max(2000) });

assistantRouter.post("/message", async (req, res, next) => {
  try {
    const { text } = MessageSchema.parse(req.body);
    res.json(await sendAssistantMessage(text));
  } catch (error) {
    if (!handled(error, res)) next(error);
  }
});

assistantRouter.get("/proposals/:id/reply-target", async (req, res, next) => {
  try {
    res.json(await proposalReplyTarget(req.params.id!));
  } catch (error) {
    if (!handled(error, res)) next(error);
  }
});

const ApproveSchema = z.object({
  email: z
    .object({
      to: z.string().trim().min(3).max(320),
      subject: z.string().trim().min(1).max(500).optional(),
      body: z.string().trim().min(1).max(5000),
    })
    .optional(),
});

assistantRouter.post("/proposals/:id/approve", async (req, res, next) => {
  try {
    const { email } = ApproveSchema.parse(req.body ?? {});
    const proposal = await approveProposal(req.params.id!, email);
    res.json({ proposal, ...(proposal.payload.kind === "email_draft" ? { draftsUrl: GMAIL_DRAFTS_URL } : {}) });
  } catch (error) {
    if (!handled(error, res)) next(error);
  }
});

assistantRouter.post("/proposals/:id/dismiss", async (req, res, next) => {
  try {
    await dismissProposal(req.params.id!);
    res.status(204).end();
  } catch (error) {
    if (!handled(error, res)) next(error);
  }
});
