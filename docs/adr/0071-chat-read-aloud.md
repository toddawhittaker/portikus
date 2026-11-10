# 0071. Chat replies are read aloud through the browser's speechSynthesis

- **Status**: Accepted (Epic 59)
- **Date**: 2026-11-09
- **References**: SPEC.md sections 24, 25.8 and 25.10; STACK.md section 15; ADR 0012, ADR 0055, ADR 0069

## Context

Students asked for the Claude Code (GUI) chat tab (ADR 0069) to read the
agent's replies aloud. There are three ways to turn text into speech: the
browser's own `speechSynthesis`, a speech model running in the browser, and
speech made on the server.

## Decision

1. **`speechSynthesis`.** The web app speaks with the browser's Web Speech
   API, as ADR 0055 does for dictation. It adds no dependency, no model
   download and no server load. Where the API is missing the controls are
   hidden.
2. **Prefer voices on the device.** Some browser voices are online voices
   that send the text to the browser vendor (Chrome's "Google" voices, for
   example). The app chooses a voice with `localService` set in the page's
   language, then one in the same base language, and otherwise leaves the
   browser's default voice. The choice is redone when the voice list
   changes, since Chrome fills it after the page loads.
3. **Speak the words, not the Markdown.** The reply is parsed with the
   same react-markdown and GFM plugin the chat renders with. Links read as
   their text, inline code as its text, headings, list items and table rows
   each as a sentence, and a code block as the words "code block", so a long
   listing is never spoken.
4. **Short utterances, one reply at a time.** Chrome stops a long
   utterance partway, so a reply is spoken as sentences grouped up to 200
   characters, one utterance after another. Starting another reply, or
   stopping, cancels the current one at once.
5. **Rejected: a speech model in the browser.** Tens to hundreds of
   megabytes per student, slow on weak laptops, and a new bundle to
   maintain.
6. **Rejected: speech on the server.** Portikus would receive reply text,
   which it must not read or keep (ADR 0012), and synthesis would take CPU
   from the shared host (SPEC.md 24). A hosted speech service would send
   the text to another vendor.

## Consequences

- When the only voice in the page's language is an online one, the reply
  text goes to the browser vendor. Portikus sends, stores and logs none of
  it. The student help says where the text may go (SPEC.md 25.10).
- Voice quality and languages depend on the browser and the operating
  system.
- Speech is separate from a screen reader; the controls need clear names
  and states so the two do not clash (SPEC.md 25.8).
