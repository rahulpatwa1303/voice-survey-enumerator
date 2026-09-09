# Voice Survey Enumerator

Entry for the AssemblyAI Voice Agent Hackathon (lablab.ai, Sept 2026).
A voice agent that conducts an existing XLSForm/KoboToolbox survey with a respondent while the enumerator watches the form fill in live, then submits the record to Kobo.

Design doc: `~/.gstack/projects/json_ui/ubuntu-unknown-design-20260909-153528.md`

## Layout
- `forms/` — demo XLSForm (`maternal_followup_v1.xlsx`, en/hi/es, one skip, constraints)
- `scripts/kobo_submit.sh` — posts one test record via the OpenRosa endpoint (proves the pipe)

## Setup
Copy `.env.example` to `.env` and fill in `ASSEMBLYAI_API_KEY`, `KOBO_TOKEN`, `KOBO_ASSET_UID`.
