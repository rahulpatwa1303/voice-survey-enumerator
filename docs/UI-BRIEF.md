# UI rebuild brief — Late Shift voice survey

**For:** whoever (human or agent) rebuilds the front end.
**Status of the backend:** working and tested. Do not change it. Build against the contract in §6.
**Deadline context:** AssemblyAI Voice Agent Hackathon, submission 28 Sept 2026.

---

## 1. What the product is

A community health worker walks up to a house with a survey to complete. Instead of
tapping through 40 fields on a phone while translating questions aloud, she opens this
app and **the phone conducts the interview by voice** in the respondent's language. She
holds a button while the respondent answers, watches the answers land on screen, taps to
fix anything wrong, and the finished record is submitted to KoboToolbox — the system her
organisation already uses.

It runs any existing **XLSForm** (the open standard behind KoboToolbox, ODK, SurveyCTO,
CommCare), so an NGO uses the forms it already has.

Every interview also produces a **receipt**: what the respondent actually said, what got
recorded, and which form rule applied. That is the audit trail that makes AI-collected
data trustworthy.

---

## 2. Who is actually holding the phone

### Primary user: the enumerator (community health worker / NGO field surveyor)

Not a developer. Not sitting at a desk. Assume:

| Reality | Consequence for the UI |
|---|---|
| Standing outdoors in bright sun, or in a dim room | Very high contrast; no thin grey-on-grey text; no reliance on colour alone |
| Phone in one hand, one thumb free; may be holding a bag or a clipboard | Every control reachable in the bottom third of the screen, one-thumb |
| Cheap Android, small/cracked screen, low brightness | Large type, generous targets (≥56px), no hover, no tiny icons |
| 15–30 interviews a day | Speed and muscle memory beat discoverability; the main action is always in the same place |
| A person is sitting in front of her | She should be looking at the **respondent**, not the screen. The screen is a *glance* surface |
| Variable literacy and digital confidence; English may be her second language | Minimal words, plain language, icons+text together, no jargon |
| Patchy network, battery matters | Clear offline/again-later states; no decorative animation loops |

**The single most important consequence:** the screen must be readable at a glance, from
arm's length, in one second. If she has to *read* the screen, the design has failed.

### Secondary user: the respondent

She may see the screen, and at the end the worker may turn the phone toward her to
confirm answers. So the screen must never show anything alarming, technical, or
confusing (no error codes, no raw field names, no debug text). The confirmation view
should be legible to someone who did not set the phone up.

### Tertiary: the supervisor / data manager

Sees the **receipt** (already implemented, §6.5) later, usually as a PDF. Not a live user
of this screen.

---

## 3. Why the current UI fails (what to throw away)

The existing screen is an engineer's debug console. It is honest about that; it was built
to develop the voice loop, not to be used in a village. Specifically wrong:

1. **Latency numbers in the conversation feed** (`⏱ heard reply 721ms…`) — meaningless and
   alarming to a health worker.
2. **A scrolling event log as a primary panel** — she will never read a transcript live.
3. **Raw field names** (`respondent_name`, `months_pregnant`) shown as labels — these are
   database identifiers, not questions.
4. **Four-plus buttons of equal visual weight** (Start / Hold / Stop / Retry / Receipt)
   plus a dropdown and an upload control, all crammed into one bar. There is exactly one
   action that matters in the moment: *hold to let the respondent speak*.
5. **Tabs** ("Form" / "Conversation") — a mode switch is a decision, and she has no
   attention to spare for decisions mid-interview.
6. **No sense of progress** — nothing says "question 4 of 9" or how much is left.
7. **Technical error text** surfaced verbatim to the user.
8. **Setup and interview share one screen**, so choosing a form/language and running an
   interview compete for the same space.

Keep none of the visual design. Keep the interaction *primitives* listed in §5.

---

## 4. The jobs the UI must do

In priority order. If a design trades away #1 for anything else, it is wrong.

1. **Tell her what the system is doing, from arm's length.** Listening / thinking /
   speaking / your turn / something is wrong. One glance, no reading.
2. **Give her one obvious, huge, forgiving way to hand the conversation to the
   respondent** (push-to-talk) and take it back.
3. **Show the answer that just landed**, so she can catch a mistake immediately.
4. **Let her correct any answer** without derailing the interview, and without being able
   to do it by accident.
5. **Show progress** — where we are, how much is left.
6. **Recover from trouble in her language, not the system's.** "The phone can't hear you —
   check the microphone" beats "getUserMedia NotAllowedError".
7. **End well**: a confirmation view she can turn toward the respondent, then a clear
   "saved" state, then straight into the next interview.
8. **Setup (choose form, choose language) must be a separate, calm step** before the
   interview starts.

---

## 5. Interaction primitives that must survive

These are product decisions, not styling. Changing them breaks correctness.

- **Push-to-talk is mandatory.** The microphone is live *only* while the control is held.
  Reason: the enumerator and the respondent share one phone microphone. If the mic were
  always open, the enumerator's coaching ("she means the small one") would be transcribed
  as the respondent's answer and recorded as data. Holding also gives the respondent a
  clear signal that it is her turn. Do not replace this with always-on listening.
- **The agent speaks first** and opens the interview itself; the user never has to
  "kick it off".
- **Barge-in exists**: if the respondent talks over the agent, playback stops. The UI
  should not fight this.
- **Corrections re-run the form logic.** Changing an earlier answer can make later
  questions appear or disappear. The UI must re-render from the server's `answers`, never
  assume a fixed question list.
- **Consent is the first question** of every interview and must be visible as such.

---

## 6. Technical contract (the backend you are building against)

Backend: Fastify + TypeScript, `server/`. Front end lives in `web/`. Dev: `npm run dev`
(Vite on 5173 proxying `/ws` to Fastify on 8787). HTTPS in dev because microphone access
requires a secure context.

### 6.1 HTTP

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{ ok: true, hasKey: boolean }` |
| `POST /upload` | Body: raw `.xlsx` bytes, `Content-Type: application/octet-stream`, max 8 MB. Returns `{ id, title, questions, languages: string[], limitations: string[] }`, or HTTP 400 `{ error }`. `limitations` are human-readable notes about parts of the form we cannot handle (unsupported question types, unsupported skip logic) — **these must be shown to the user before they start**, not swallowed. |
| `GET /ws` | WebSocket, one per interview. |

### 6.2 Client → server (JSON over the WebSocket)

```jsonc
{ "type": "start", "lang": "en", "formId": "<id from /upload, or null for the built-in demo form>" }
{ "type": "audio", "data": "<base64 PCM16, 24 kHz, mono>" }   // only while push-to-talk is held
{ "type": "nudge" }                                            // ask a stalled agent to continue
{ "type": "end" }                                              // end the session (also stops billing)
```

### 6.3 Server → client

```jsonc
{ "type": "ready" }                                   // agent connected
{ "type": "phase", "phase": "idle|listening|thinking|speaking" }
{ "type": "audio", "data": "<base64 PCM16 24 kHz>" }  // play immediately
{ "type": "user_partial", "text": "..." }             // live partial transcript
{ "type": "user", "text": "..." }                     // final respondent utterance
{ "type": "agent", "text": "..." }                    // what the agent said
{ "type": "answer", "name": "age", "value": 28, "display": "28",
  "answers": { "...": "..." } }                       // an answer was recorded; `answers` is the full current state
{ "type": "interrupted" }                             // respondent barged in: clear the audio queue
{ "type": "stalled", "nudging": true|false }          // true = auto-recovering; false = gave up, offer Retry
{ "type": "submit", "ok": true, "instanceId": "uuid:…", "record": {...},
  "receipt": {...}, "receiptText": "…", "note": "…", "message": "…" }
{ "type": "error" | "fatal", "message": "…" }         // technical; translate before showing
{ "type": "closed" }                                  // connection ended
{ "type": "latency", "...": "..." }                   // development only — do not show users
```

### 6.4 Audio requirements (do not break these)

`web/audio-worklet.js` **should be kept as-is.** It handles resampling in both directions
and was the fiddliest part to get right.

- Capture: microphone → mono PCM16 at **24 kHz** → base64 → `{type:'audio'}`. Only while held.
- Playback: base64 PCM16 24 kHz from `{type:'audio'}` → queue → speakers.
- On `{type:'interrupted'}`: post `'clear'` to the playback worklet to drop the queue.
- **iOS Safari**: `AudioContext` starts suspended; it must be `resume()`d inside a user
  gesture (the Start tap). Getting this wrong means silent audio on iPhone.
- Touch handlers need `preventDefault` so holding the button does not scroll or zoom.

### 6.5 Receipt (already built — presentation may be redesigned)

Arrives in the `submit` message as `receipt` (structured) and `receiptText` (plain text).
Structure: `{ form:{id,title}, language, startedAt, finishedAt, summary:{answered,skipped,corrections}, answers, events[] }`.

`events[]` entries:
- `{t:'answer', question, display, heard, shownBecause?, validatedBy?}`
- `{t:'rejected', question, attempted, heard, reason, rule?}`
- `{t:'skipped', question}`
- `{t:'submitted', ok, destination, instanceId?}`

There is an existing print stylesheet that turns the receipt panel into a clean A4 PDF
via the browser's print pipeline. **Keep printing to PDF through the browser** — Node PDF
libraries cannot shape Devanagari, and this product must render Hindi correctly. Verified
working. Redesign the on-screen presentation freely; preserve the print output quality.

---

## 7. Hard constraints

- **Languages.** Question labels come from the form and may be in any script (Devanagari,
  Arabic, Latin with accents). Type must render them correctly; do not assume Latin.
  Layout must tolerate strings 2–3× longer than English.
- **Spoken vs understood.** The voice agent *speaks* 6 languages (English, Spanish,
  French, German, Italian, Portuguese) and *understands* 18. For anything else (e.g.
  Hindi) it understands the respondent but replies in English. The language chooser must
  communicate this honestly without a paragraph of text.
- **Screen sizes.** Must work on a ~360 px wide Android at the small end. Desktop is used
  only for demos.
- **No framework is required.** Current front end is plain TypeScript + Vite (no React).
  React is acceptable if it earns its place, but the audio worklet path must keep working.
- **Offline/failure states are first-class**, not afterthoughts: mic permission denied,
  no network, agent unreachable, Kobo submission failed (the answers must not be lost —
  offer the record for download).
- **Accessibility**: real contrast (WCAG AA minimum, aim higher for sunlight), focus
  states, and do not encode meaning in colour alone — the state indicator needs a shape or
  word too.

---

## 8. Screens (suggested, not prescriptive)

1. **Setup** — choose the form (built-in demo, or upload an `.xlsx`), choose the language,
   show any `limitations` from the parse plainly, then one big Start. Calm, can be read.
2. **Interview** — the whole point. Dominated by the state indicator and the hold-to-talk
   control; the current question and the last recorded answer visible; progress shown;
   a discreet way to correct the previous answer; a way to stop.
3. **Review / confirm** — the read-back at the end; legible enough to turn toward the
   respondent; tap any answer to correct it.
4. **Done** — clear "saved to KoboToolbox" (or "saved on this phone" if submission
   failed), the receipt available, and an obvious "Next interview".

---

## 9. Success criteria

A design is good if:

- A health worker can tell what the phone is doing **from 60 cm away, in sunlight, in
  under a second**, without reading a sentence.
- The main action is hittable **one-handed with a thumb**, without looking.
- A wrong answer can be corrected in **≤2 taps** and cannot be triggered accidentally.
- Nothing on screen uses a word the user would not use: no "session", "socket",
  "latency", "instance", "XLSForm", no field identifiers.
- A stranger handed the phone can complete an interview with **no instructions**.
- The end-of-interview screen is something you would be comfortable turning toward the
  respondent.

---

## 10. Out of scope

- Backend, voice pipeline, form parsing, interview logic, Kobo submission — all working,
  all tested (`npm test`, 33 checks). Do not modify `server/`.
- Authentication, multi-user accounts, offline sync, editing forms in the app.
- The receipt's *content* (redesign its presentation, not what it records).

---

## 11. Getting it running

```bash
npm install
npm run dev        # Fastify :8787 + Vite :5173 (HTTPS, self-signed)
npm test           # 33 checks: interview logic, form parser, receipt
```

`.env` needs `ASSEMBLYAI_API_KEY`, and `KOBO_TOKEN` + `KOBO_ASSET_UID` for real
submission. Without a Kobo asset the interview still runs and returns the record for
download. The built-in demo form (`forms/maternal_followup_v1.xlsx`, English/Hindi/Spanish,
with one skip rule and constraints) is the fastest way to exercise every state;
`forms/water_point_v1.xlsx` is a second, unrelated form for testing generality.

**Files to replace:** `web/index.html`, `web/client.ts`.
**File to keep:** `web/audio-worklet.js`.
**Do not touch:** `server/`, `scripts/`, `forms/`.
