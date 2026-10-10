# The Field-Tested AI Agency Loop — slide deck

`index.html` is a single self-contained HTML slide deck covering the four-session course
"The Field-Tested AI Agency Loop: Marketing, Sales, Delivery & Local Infrastructure"
(Tue Nov 3, Tue Nov 10, Tue Nov 17, and Mon Nov 30, 2026). It has 38 slides: a title slide,
an agenda/arc slide, eight to nine slides per session (session title, objective and target
outcome, one or two slides per sub-module, SOPs and deliverables, field assignment), and a
closing slide that walks the full loop end to end.

This deck preserves the original curriculum draft exactly as written — every price band,
model name, tool name, and date from that draft is carried through unedited. The owner's
revised version of this material lives in a separate planning document; this deck is not
that document, and it is not meant to replace it.

There is no build step and no dependency. Open `index.html` directly in a browser, or serve
the `learning/` directory with any static file server.

## Presenting

- `→` / `↓` / `space` — advance one slide
- `←` / `↑` — go back one slide
- `Home` — jump to the first slide
- `End` — jump to the last slide
- `n` — toggle speaker notes (hidden by default, shown as a drawer under the slide content)
- Click the right half of the screen to advance, the left half to go back
- A slide counter is always visible in the bottom-right corner

A brief on-screen hint with these shortcuts appears on the title slide and fades out after a
few seconds.

## Exporting to PDF

Open `index.html` in a browser and print (`Cmd+P` / `Ctrl+P`) with backgrounds enabled
("More settings" → "Background graphics" in Chrome). Each slide prints as its own page.
Speaker notes are excluded from print output by design — the printed deck matches what an
audience sees on screen.

## Design notes

Palette: Charcoal, Paper, Rust, Moss, Brass, and Slate — a field-manual palette rather than a
pitch-deck one, with automatic light/dark support via `prefers-color-scheme`. Typefaces:
Fraunces for display (headlines, session numbers) and IBM Plex Sans for body text and data.
