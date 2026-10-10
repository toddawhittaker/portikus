# 0055. Voice input uses the browser's Web Speech API, hold to talk

- **Status**: Accepted (Epic 39)
- **Date**: 2026-10-09
- **References**: SPEC.md sections 25.8 and 25.10; issues #1346, #1350 and #1375

## Context

Students asked to dictate to a coding agent in a terminal. There are
three ways to turn speech into text: the browser's own Web Speech API,
Whisper running in the browser, and Whisper running on the server.

## Decision

1. **Web Speech API.** Each terminal uses `SpeechRecognition` (or
   `webkitSpeechRecognition`). It adds no dependency, no model download
   and no server load.
2. **Rejected: Whisper in the browser.** A model of tens to hundreds of
   megabytes per student, slow on weak laptops, and a new bundle to
   maintain.
3. **Rejected: Whisper on the server.** It would send audio to Portikus,
   which then has to store, limit and secure it, and it takes CPU from
   the shared host (SPEC.md 24).
4. **Hold to talk only.** The microphone button and Alt+Shift+M listen only
   while held. There is no click-to-latch mode, so the microphone is never
   left open by accident. This is a recorded exception to the click
   alternative rule in SPEC.md 25.8; the product owner ruled it.
5. **Safe text.** Only final phrases are typed, with every control
   character removed, so dictation never presses Enter.
6. **No admin switch yet.** An administrator cannot turn voice off. That is
   filed as #1350 and left unbuilt.

## Consequences

- Audio goes to the browser vendor's service (Google for Chrome, Microsoft
  for Edge, Apple for Safari). Portikus sends and logs nothing about it.
  The student help says so (SPEC.md 25.10). Institutions with strict
  privacy rules need the switch from #1350.
- Firefox has no API and Brave's service fails with a network error. Both
  show no microphone.
- Safari should work but has not been confirmed on a real Mac.
- Recognition quality and languages depend on the browser vendor.

## Addendum, 2026-10-09 (issue #1375)

Decision 1 covers file editors as well as terminals. An editable text file
has the same hold-to-talk microphone in its header and the same
Alt+Shift+M. Decisions 4 and 5 apply unchanged: hold to talk only, and
final phrases only. In a file the text is inserted at the cursor, replacing
any selection, as one undo step, with a leading space when needed. The microphone is hidden for images,
view-only files, the CSV table, the diff and the conflict view.
