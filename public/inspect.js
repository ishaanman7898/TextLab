// Byte-level provenance inspector: C2PA / Content Credentials, EXIF, XMP, IPTC.
// Pure functions over a Uint8Array, no DOM and no dependencies, so test.js can run it in node.

const A = (u, s, e) => { let r = ''; for (let i = s; i < e && i < u.length; i++) r += String.fromCharCode(u[i]); return r; };
const be16 = (u, i) => (u[i] << 8) | u[i + 1];
const be32 = (u, i) => ((u[i] << 24) | (u[i + 1] << 16) | (u[i + 2] << 8) | u[i + 3]) >>> 0;
const row = (count, label, act) => ({ count, label, act });

export function sniff(u) {
  if (u[0] === 0xFF && u[1] === 0xD8) return 'jpeg';
  if (A(u, 1, 4) === 'PNG') return 'png';
  if (A(u, 0, 4) === 'RIFF' && A(u, 8, 12) === 'WEBP') return 'webp';
  if (A(u, 4, 8) === 'ftyp') return 'isobmff';       // avif, heic, mp4
  if (A(u, 0, 5) === '%PDF-') return 'pdf';
  if (A(u, 0, 3) === 'GIF') return 'gif';
  if (A(u, 0, 2) === 'II' || A(u, 0, 2) === 'MM') return 'tiff';
  return 'other';
}

export const isImage = kind => ['jpeg','png','webp','isobmff','gif','tiff'].includes(kind);

// --- EXIF (TIFF IFD walk) -------------------------------------------------
const EXIF_TAGS = {
  0x010E:'Image description', 0x010F:'Camera make', 0x0110:'Camera model', 0x0131:'Software',
  0x0132:'File timestamp', 0x013B:'Artist', 0x8298:'Copyright', 0x9003:'Original capture time',
  0x9004:'Digitised timestamp', 0x9286:'User comment', 0xA430:'Camera owner', 0xA431:'Body serial number',
  0xA433:'Lens make', 0xA434:'Lens model', 0xA435:'Lens serial number', 0xC614:'Unique camera model',
};
const TYPE_SIZE = [0,1,1,2,4,8,1,1,2,4,8,4,8];

function exif(u, off, found) {
  if (off + 8 > u.length) return;
  const le = A(u, off, off + 2) === 'II';
  const g16 = i => le ? (u[i] | (u[i + 1] << 8)) : be16(u, i);
  const g32 = i => le ? ((u[i] | (u[i + 1] << 8) | (u[i + 2] << 16) | (u[i + 3] << 24)) >>> 0) : be32(u, i);

  const queue = [off + g32(off + 4)];
  let other = 0, gps = false, seen = 0;
  while (queue.length && seen++ < 4) {
    const ifd = queue.shift();
    if (!ifd || ifd < off || ifd + 2 > u.length) continue;
    const n = g16(ifd);
    if (n > 512) continue;
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > u.length) break;
      const tag = g16(e), type = g16(e + 2), cnt = g32(e + 4);
      const size = cnt * (TYPE_SIZE[type] || 1);
      const at = size <= 4 ? e + 8 : off + g32(e + 8);
      if (tag === 0x8769) { queue.push(off + g32(e + 8)); continue; }              // Exif sub-IFD
      if (tag === 0x8825) { gps = true; continue; }                                 // GPS sub-IFD
      const name = EXIF_TAGS[tag];
      if (name && type === 2 && at + size <= u.length && size > 1) {
        const v = A(u, at, at + size).replace(/\0+$/, '').trim();
        if (v) { found.push(row(1, 'EXIF ' + name + ': ' + v.slice(0, 60), 'removed')); continue; }
      }
      other++;
    }
  }
  if (gps) found.push(row(1, 'EXIF GPS location tags', 'removed'));
  if (other) found.push(row(other, 'Other EXIF tags', 'removed'));
}

// --- C2PA -----------------------------------------------------------------
// Manifest bodies are CBOR, but the interesting identifiers sit in it as plain ASCII.
const C2PA_HINTS = /^(c2pa\.[a-z.\-]+|[A-Za-z][\w .+\-]{3,44})$/;

function c2paDetail(u, from, found) {
  const win = A(u, from, Math.min(from + 8192, u.length));
  const strings = win.match(/[\x20-\x7E]{4,48}/g) || [];
  const keep = [], seen = new Set();
  for (const s of strings) {
    const t = s.trim();
    if (!C2PA_HINTS.test(t) || seen.has(t)) continue;
    if (/^(jumb|jumd|c2pa$|cbor|json|uuid|http|urn:)/i.test(t)) continue;
    seen.add(t); keep.push(t);
    if (keep.length === 8) break;
  }
  for (const k of keep) {
    const what = k.startsWith('c2pa.') ? 'C2PA assertion' : 'C2PA manifest field';
    found.push(row(1, what + ': ' + k, 'removed'));
  }
}

function c2paScan(u, found) {
  const hay = A(u, 0, Math.min(u.length, 3_000_000));
  const at = hay.indexOf('c2pa');
  if (at < 0) return false;
  found.push(row(1, 'C2PA Content Credentials manifest', 'removed'));
  if (hay.includes('c2pa.training-mining')) found.push(row(1, 'C2PA training and mining assertion', 'removed'));
  if (hay.includes('cawg.')) found.push(row(1, 'CAWG identity assertion', 'removed'));
  c2paDetail(u, Math.max(0, at - 512), found);
  found.push(row(0, 'Soft bindings (invisible watermarks such as SynthID) survive re-encoding, and a C2PA lookup can still match this image by fingerprint', 'not removable here'));
  return true;
}

// --- container walks ------------------------------------------------------
function jpeg(u, found) {
  let i = 2;
  while (i + 4 < u.length && u[i] === 0xFF) {
    const m = u[i + 1], len = be16(u, i + 2), body = i + 4;
    if (m === 0xDA || m === 0xD9) break;                       // start of scan: pixels from here
    const tag = A(u, body, body + 32);
    if (m === 0xE1 && tag.startsWith('Exif')) exif(u, body + 6, found);
    else if (m === 0xE1 && tag.includes('ns.adobe.com/xap')) found.push(row(1, 'XMP packet (APP1)', 'removed'));
    else if (m === 0xE2 && tag.startsWith('ICC_PROFILE')) found.push(row(1, 'ICC colour profile', 'removed'));
    else if (m === 0xED) found.push(row(1, 'Photoshop IRB / IPTC block', 'removed'));
    else if (m === 0xEB) found.push(row(1, 'JUMBF box (APP11, the C2PA carrier)', 'removed'));
    else if (m === 0xFE) found.push(row(1, 'JPEG comment: ' + A(u, body, body + Math.min(len, 60)).trim(), 'removed'));
    i = body + len - 2;
  }
}

function png(u, found) {
  let i = 8;
  while (i + 8 <= u.length) {
    const len = be32(u, i), type = A(u, i + 4, i + 8), data = i + 8;
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'caBX') found.push(row(1, 'caBX chunk (the C2PA carrier)', 'removed'));
    else if (type === 'eXIf') exif(u, data, found);
    else if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      const key = A(u, data, data + Math.min(len, 40)).split('\0')[0];
      found.push(row(1, 'Text chunk: ' + key, 'removed'));
    }
    else if (type === 'tIME') found.push(row(1, 'Last-modified timestamp chunk', 'removed'));
    if (!len && type !== 'IHDR' && !/^[a-zA-Z]{4}$/.test(type)) break;
    i = data + len + 4;
  }
}

function boxes(u, found) {   // webp RIFF chunks and isobmff boxes are close enough to scan alike
  const hay = A(u, 0, Math.min(u.length, 1_000_000));
  if (hay.includes('EXIF') || hay.includes('Exif')) {
    const at = Math.max(hay.indexOf('Exif'), hay.indexOf('EXIF'));
    exif(u, at + (A(u, at + 4, at + 6) === '\0\0' ? 6 : 4), found);
  }
  if (hay.includes('XMP ') || hay.includes('x:xmpmeta')) found.push(row(1, 'XMP packet', 'removed'));
  if (hay.includes('jumb')) found.push(row(1, 'JUMBF box (the C2PA carrier)', 'removed'));
}

/** Inspect a file's bytes. Returns ledger rows describing every provenance record found. */
export function inspect(u) {
  const kind = sniff(u), found = [];
  if (kind === 'jpeg') jpeg(u, found);
  else if (kind === 'png') png(u, found);
  else if (kind === 'tiff') exif(u, 0, found);
  else boxes(u, found);
  if (A(u, 0, Math.min(u.length, 3_000_000)).includes('<x:xmpmeta') && !found.some(f => f.label.startsWith('XMP')))
    found.push(row(1, 'XMP packet', 'removed'));
  c2paScan(u, found);
  return { kind, found };
}
