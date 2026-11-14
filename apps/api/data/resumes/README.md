# Local Resume Files (Gitignored)

This folder is for local-only resume files used by resume selection, scoring, and generation grounding.

Expected filenames (one per resume type):

- `base_resume.txt` or `base_resume.pdf` (BASE: general full-stack)
- `ai_resume.txt` or `ai_resume.pdf` (AI: AI-heavy)
- `fde_resume.txt` or `fde_resume.pdf` (FDE: integrations, internal tools, and applied AI delivery)

Your candidate profile also lives here as `user_profile.json`. See `src/config/userProfile.example.ts` for its shape.

Install or refresh from a PDF (copies the PDF and extracts the `.txt`):

```
node --import tsx scripts/extract-resume-text.mts BASE /path/to/your-base-resume.pdf
node --import tsx scripts/extract-resume-text.mts AI /path/to/your-ai-resume.pdf
node --import tsx scripts/extract-resume-text.mts FDE /path/to/your-fde-resume.pdf
```

Notes:

- These files are local-only and are ignored by git.
- If both `.txt` and `.pdf` exist for a resume type, the app prefers `.txt`.
- Restart the API after replacing a resume; contexts are cached in memory.
- Do not commit personal resume content to a public repository.
