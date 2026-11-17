import { getDb } from "../../../config/mongo.js";

export type JobProspectStatus = "open" | "attached";

export type JobProspect = {
  id: string;
  company: string;
  companyKey: string;
  title: string;
  location?: string;
  seniority?: string;
  requisitionId?: string;
  sourceUrl?: string;
  normalizedSourceUrl?: string;
  salary?: string;
  rawText: string;
  cleanedText: string;
  cleanedTextHash: string;
  status: JobProspectStatus;
  attachedKey?: string;
  /** User-asserted application date (YYYY-MM-DD), recorded when no confirmation email is needed to know. */
  appliedAt?: string;
  /** User said they did not apply (or will not); excluded from the unconfirmed list. */
  notApplied?: boolean;
  /** Tracker row created for a user-marked application that had no Gmail confirmation. */
  trackerJobId?: string;
  /** True when trackerJobId was created by marking applied (so "not applied" may remove it). */
  trackerCreatedByMark?: boolean;
  /** Last failure creating that tracker row, cleared on success. */
  trackerSyncError?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProspectApplicationPatch = Partial<
  Pick<JobProspect, "appliedAt" | "notApplied" | "trackerJobId" | "trackerCreatedByMark" | "trackerSyncError">
>;

type Doc = Omit<JobProspect, "id"> & { _id: string };

let indexesEnsured = false;

const strip = ({ _id, ...rest }: Doc): JobProspect => ({ ...rest, id: _id });

const optional = <T>(value: T | undefined): T | undefined => (value == null || value === "" ? undefined : value);

export const jobProspectsRepository = {
  async collection() {
    const db = await getDb();
    const col = db.collection<Doc>("job_prospects");
    if (!indexesEnsured) {
      indexesEnsured = true;
      await Promise.all([
        col.createIndex({ companyKey: 1, status: 1, createdAt: -1 }),
        col.createIndex({ status: 1, createdAt: -1 }),
        col.createIndex({ cleanedTextHash: 1, companyKey: 1 }),
      ]).catch(() => {
        indexesEnsured = false;
      });
    }
    return col;
  },

  async insert(prospect: JobProspect): Promise<JobProspect> {
    const col = await this.collection();
    const { id, ...rest } = prospect;
    await col.insertOne({ ...rest, _id: id });
    return prospect;
  },

  async findById(id: string): Promise<JobProspect | null> {
    const col = await this.collection();
    const doc = await col.findOne({ _id: id });
    return doc ? strip(doc) : null;
  },

  async findOpen(): Promise<JobProspect[]> {
    const col = await this.collection();
    const docs = await col.find({ status: "open" }).sort({ createdAt: -1 }).toArray();
    return docs.map(strip);
  },

  async findByCompanyKey(companyKey: string): Promise<JobProspect[]> {
    const col = await this.collection();
    const docs = await col.find({ companyKey }).sort({ createdAt: -1 }).toArray();
    return docs.map(strip);
  },

  async findOpenByCompanyKey(companyKey: string): Promise<JobProspect[]> {
    const col = await this.collection();
    const docs = await col.find({ companyKey, status: "open" }).sort({ createdAt: -1 }).toArray();
    return docs.map(strip);
  },

  async findAll(): Promise<JobProspect[]> {
    const col = await this.collection();
    const docs = await col.find({}).sort({ createdAt: -1 }).toArray();
    return docs.map(strip);
  },

  /** Set or clear the user's application state. `undefined` values are unset. */
  async updateApplicationState(id: string, patch: ProspectApplicationPatch): Promise<JobProspect | null> {
    const col = await this.collection();
    const $set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    const $unset: Record<string, ""> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) $unset[field] = "";
      else $set[field] = value;
    }
    const update = Object.keys($unset).length > 0 ? { $set, $unset } : { $set };
    const doc = await col.findOneAndUpdate({ _id: id }, update, { returnDocument: "after" });
    return doc ? strip(doc) : null;
  },

  /** Attach only if still open, or already attached to this same application. */
  async markAttached(id: string, applicationKey: string): Promise<JobProspect | null> {
    const col = await this.collection();
    const now = new Date().toISOString();
    const doc = await col.findOneAndUpdate(
      {
        _id: id,
        $or: [{ status: "open" }, { status: "attached", attachedKey: applicationKey }],
      },
      { $set: { status: "attached", attachedKey: applicationKey, updatedAt: now } },
      { returnDocument: "after" },
    );
    return doc ? strip(doc) : null;
  },
};

export const prospectFields = (input: {
  location?: string;
  seniority?: string;
  requisitionId?: string;
  sourceUrl?: string;
  normalizedSourceUrl?: string;
  salary?: string;
  attachedKey?: string;
}): Pick<
  JobProspect,
  "location" | "seniority" | "requisitionId" | "sourceUrl" | "normalizedSourceUrl" | "salary" | "attachedKey"
> => ({
  location: optional(input.location),
  seniority: optional(input.seniority),
  requisitionId: optional(input.requisitionId),
  sourceUrl: optional(input.sourceUrl),
  normalizedSourceUrl: optional(input.normalizedSourceUrl),
  salary: optional(input.salary),
  attachedKey: optional(input.attachedKey),
});
