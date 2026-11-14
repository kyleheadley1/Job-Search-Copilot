/**
 * Install resume PDFs into apps/api/data/resumes and extract the .txt the loader prefers.
 *
 *   npx tsx scripts/extract-resume-text.mts BASE /path/to/your-base-resume.pdf
 *   npx tsx scripts/extract-resume-text.mts AI /path/to/your-ai-resume.pdf
 *   npx tsx scripts/extract-resume-text.mts FDE /path/to/your-fde-resume.pdf
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { resumeFilePaths } from "../src/config/resumeContext.js";
import { isActiveResumeType } from "../src/types/resume.js";

const MIN_RESUME_CHARS = 1500;

const [type, source] = process.argv.slice(2);
if (!isActiveResumeType(type) || !source) {
  console.error("Usage: extract-resume-text.mts <BASE|AI|FDE> <path/to/resume.pdf>");
  process.exit(1);
}

const buf = await fs.readFile(path.resolve(source));
const parser = new PDFParse({ data: buf });
const parsed = await parser.getText();
await parser.destroy();

const text = (parsed.text ?? "")
  .replace(/\r/g, "")
  .replace(/^-- \d+ of \d+ --$/gm, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

if (text.length < MIN_RESUME_CHARS) {
  console.error(
    `Refusing to install ${type}: only ${text.length} characters extracted (min ${MIN_RESUME_CHARS}). Is the PDF corrupted or image-only?`,
  );
  process.exit(1);
}

const target = resumeFilePaths[type];
await fs.mkdir(path.dirname(target.pdf), { recursive: true });
await fs.copyFile(path.resolve(source), target.pdf);
await fs.writeFile(target.txt, `${text}\n`, "utf8");
console.log(`Installed ${type}: ${text.length} chars -> ${path.relative(process.cwd(), target.txt)}`);
