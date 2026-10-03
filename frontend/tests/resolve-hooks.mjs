/* =============================================================================
   Module resolution hook for the test runner
   -----------------------------------------------------------------------------
   Node's ESM resolver will not guess that `./endpoints` means `endpoints.ts`, and
   it has no idea that `@/lib/x` means `src/lib/x`. Both conventions belong to the
   bundler (tsconfig `paths`), not to Node.

   Rather than add a test-only bundler or a runtime dependency, this hook teaches
   Node the same two conventions the app already uses. It only ever redirects
   specifiers to files that exist on disk.
   ============================================================================= */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

/** Extensions to try, in the order a bundler would. `.ts` before `.tsx`. */
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveFile(basePath) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${basePath}${suffix}`;
    if (!existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable — try the next candidate */
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // `@/foo/bar` -> `<repo>/src/foo/bar`
  if (specifier.startsWith("@/")) {
    const hit = resolveFile(path.join(SRC_DIR, specifier.slice(2)));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }

  // Relative specifiers: retry with the bundler's candidate extensions.
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const hit = resolveFile(path.resolve(path.dirname(parentPath), specifier));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}