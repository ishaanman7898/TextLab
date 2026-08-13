# TextLab

Paste text or drop a file, get back plain text with nothing hiding in it: https://textlab.ishman.workers.dev

- Strips invisible characters (zero-width, bidi controls, variation selectors, Unicode tag chars, soft hyphens, control chars) and reports the count of each.
- Reports and drops provenance metadata: PDF Author/Producer/CreationDate/XMP, Google Docs / Word / Notion paste markers, link tracking parameters.
- Inspects images for **C2PA Content Credentials** (APP11/JUMBF in JPEG, `caBX` in PNG, `jumb` boxes in WebP/AVIF/HEIC), EXIF (including GPS, camera serials, software), XMP, IPTC and ICC — itemises every record, then re-encodes the pixels through a canvas so all of it is gone, and re-inspects the output to prove it. The ledger also states plainly that soft bindings (invisible watermarks like SynthID) and fingerprint-based C2PA lookups survive re-encoding, which is the part the "just convert the format" advice leaves out.
- Replaces semicolons and every dash flavour with ", ".
- Round-trips the text through two randomly chosen languages and back to English (Workers AI, `@cf/meta/m2m100-1.2b`).
- Runs the text down a five-file conversion chain (extracted TXT → three random intermediates → your chosen destination: Word, TXT, MD, HTML or RTF). Every step is downloadable.

Reads `.pdf` (pdf.js), `.txt`, `.md`, `.html`, `.csv`, `.rtf`. Everything except the translation happens in the browser.

`node test.js` runs the cleaning and format round-trips straight out of `public/index.html`.
`npx wrangler deploy` ships it.
