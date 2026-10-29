import { MongoClient, type Db } from "mongodb";
import { env } from "./env.js";
import { logger } from "../lib/logger.js";

let client: MongoClient | null = null;
let db: Db | null = null;
let dbOverride: Db | null = null;
let indexesEnsured = false;

const ensureIndexes = async (targetDb: Db): Promise<void> => {
  if (indexesEnsured) return;
  const jobs = targetDb.collection("jobs");
  const topJobs = targetDb.collection("top_jobs");
  const captures = targetDb.collection("job_captures");
  const gmailMessages = targetDb.collection("gmail_messages");
  await Promise.all([
    gmailMessages.createIndex({ date: 1, "classification.isApplicationEmail": 1 }),
    captures.createIndex({ jdTextHash: 1, createdAt: -1 }),
    captures.createIndex({ normalizedSourceUrl: 1, createdAt: -1 }),
    captures.createIndex({ jobId: 1 }),
    captures.createIndex({ status: 1, createdAt: 1 }),
    captures.createIndex({ createdAt: -1 }),
    jobs.createIndex(
      { importKey: 1 },
      { unique: true, sparse: true },
    ),
    jobs.createIndex({ status: 1, updatedAt: -1 }),
    jobs.createIndex({ "tracker.shortlist": 1, updatedAt: -1 }),
    jobs.createIndex({ recommendedResume: 1, updatedAt: -1 }),
    jobs.createIndex({ recommendation: 1, updatedAt: -1 }),
    jobs.createIndex({ "score.total": -1 }),
    jobs.createIndex({ "extracted.company": 1 }),
    jobs.createIndex({ "tracker.gmailKey": 1 }, { sparse: true }),
    jobs.createIndex({ updatedAt: -1 }),
    targetDb.collection("application_evaluations").createIndex({ trackerJobId: 1 }, { sparse: true }),
    topJobs.createIndex({ sourcePostedAt: -1 }),
    topJobs.createIndex({ "score.total": -1 }),
    topJobs.createIndex({ source: 1, externalId: 1 }, { unique: true }),
    topJobs.createIndex({ applyUrl: 1 }),
    targetDb.collection("top_jobs_alert_listings").createIndex({ status: 1, lastSeenAt: -1 }),
    targetDb.collection("job_prospects").createIndex({ companyKey: 1, status: 1, createdAt: -1 }),
    targetDb.collection("job_prospects").createIndex({ status: 1, createdAt: -1 }),
    targetDb.collection("job_prospects").createIndex({ cleanedTextHash: 1, companyKey: 1 }),
    targetDb.collection("score_revisions").createIndex({ applicationKey: 1, createdAt: -1 }),
    targetDb.collection("score_revisions").createIndex({ activeApplicationKey: 1 }, { unique: true, sparse: true }),
  ]);
  indexesEnsured = true;
};

export const getDb = async (): Promise<Db> => {
  if (dbOverride) return dbOverride;
  if (process.env.VITEST) {
    throw new Error("Tests must not touch the real database: use createMongoTestHarness or mock the repository.");
  }
  if (db) return db;
  client = new MongoClient(env.mongoUri, { ignoreUndefined: true });
  await client.connect();
  db = client.db(env.mongoDbName);
  await ensureIndexes(db);
  logger.info("MongoDB connected", { dbName: env.mongoDbName });
  return db;
};

export const closeDb = async (): Promise<void> => {
  if (client) {
    await client.close();
  }
  client = null;
  db = null;
  indexesEnsured = false;
};

/** Test-only helper to inject an isolated DB (e.g., mongodb-memory-server). */
export const setDbOverrideForTests = async (override: Db | null): Promise<void> => {
  dbOverride = override;
  if (dbOverride) {
    await ensureIndexes(dbOverride);
  } else {
    indexesEnsured = false;
  }
};
