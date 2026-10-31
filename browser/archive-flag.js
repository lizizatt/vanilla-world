// Deploy-time lever. Tracked value is always false. `ARCHIVE_DATA_SOURCE=1` at server start or `build-dist` stamps this to true
// (see shell-manifest.mjs archiveStamp). While false, the optional data-source modules are not part of the shell and nothing here connects anywhere.
export const ARCHIVE_DATA_SOURCE = false;
