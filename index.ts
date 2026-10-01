// OpenCode plugin entrypoint — must ONLY export plugin function(s).
// Do NOT use `export *` here: opencode iterates over every export value
// and throws "Plugin export is not a function" on the first non-function
// export (see getLegacyPlugins in opencode's plugin loader).
// All helpers/tests import directly from "./auto-fallback".
import OpenCodeFallbackPlugin from "./auto-fallback"

export default OpenCodeFallbackPlugin
