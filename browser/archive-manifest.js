// Facts about the archive.org item shared by the browser source, the CLI and the tests. Metadata only: names, sizes and the
// whole-zip md5 that archive.org itself publishes (https://archive.org/metadata/WoW_1.12.1-5875). No game bytes live here.
export const ARCHIVE_ITEM = 'WoW_1.12.1-5875';
export const ARCHIVE_ORIGIN = 'https://archive.org';
export const DEFAULT_LOCALE = 'enUS';
export const zipName = locale => `1.12.1-5875_${locale}.zip`;

// Whole-zip facts for the default locale (CLI verifies the md5; the browser cannot read the raw zip, see design/data-hosting-research.md).
export const ZIP_FACTS = Object.freeze({ enUS: { size: 5475617875, md5: '06e2a806fb3798aa751989799816be2c' } });

// Uncompressed member sizes from the archive.org zip listing of the enUS zip. `core` is what terrain/models/UI/DBC need;
// `audio` is optional. Other locales are checked against their own live listing only.
export const PINNED_SIZES = Object.freeze({
  'dbc.MPQ': 3875834, 'fonts.MPQ': 1284223, 'interface.MPQ': 69655328, 'misc.MPQ': 6084832, 'model.MPQ': 190911084,
  'terrain.MPQ': 1099777804, 'texture.MPQ': 664940439, 'wmo.MPQ': 363565077, 'patch.MPQ': 2055856542, 'patch-2.MPQ': 9095702,
  'base.MPQ': 11202638, 'backup.MPQ': 6341628, 'sound.MPQ': 707653955, 'speech.MPQ': 229168847,
});
export const CORE_FILES = Object.freeze(['dbc.MPQ', 'fonts.MPQ', 'interface.MPQ', 'misc.MPQ', 'model.MPQ', 'terrain.MPQ', 'texture.MPQ', 'wmo.MPQ', 'patch.MPQ', 'patch-2.MPQ']);
export const AUDIO_FILES = Object.freeze(['sound.MPQ', 'speech.MPQ']);

export class ArchiveError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'ArchiveError'; this.code = code; }
}

export const listingUrl = (locale = DEFAULT_LOCALE, origin = ARCHIVE_ORIGIN) => `${origin}/download/${ARCHIVE_ITEM}/${zipName(locale)}/`;
export const memberUrl = (inner, locale = DEFAULT_LOCALE, origin = ARCHIVE_ORIGIN) =>
  `${origin}/download/${ARCHIVE_ITEM}/${zipName(locale)}/${encodeURIComponent(`Data/${inner}`)}`;

// The listing page is an HTML table: <td><a href=".../<zip>/Data%2Fdbc.MPQ">Data/dbc.MPQ</a></td> ... <td>size</td>. Returns Map(name -> bytes)
// for files directly under Data/ only.
export function parseListing(html) {
  const sizes = new Map();
  for (const [, row] of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const text = row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const match = /^Data\/([^/\s]+) \d{4}-\d\d-\d\d \d\d:\d\d (\d+)$/.exec(text);
    if (match) sizes.set(match[1], Number(match[2]));
  }
  return sizes;
}

// Throws when the live listing disagrees with the pinned size or lacks a requested file.
export function planFiles(listing, names, locale = DEFAULT_LOCALE, pinnedSizes = PINNED_SIZES) {
  return names.map(name => {
    const size = listing.get(name);
    if (!Number.isSafeInteger(size) || size <= 0) throw new ArchiveError('MISSING', `archive.org listing has no Data/${name}`);
    const pinned = locale === DEFAULT_LOCALE ? pinnedSizes[name] : undefined;
    if (pinned !== undefined && pinned !== size) throw new ArchiveError('INTEGRITY', `Data/${name}: archive.org lists ${size} bytes, expected ${pinned}`);
    return { name, size };
  });
}
