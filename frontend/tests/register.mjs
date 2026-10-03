import { register } from "node:module";

// Installs tests/resolve-hooks.mjs so Node resolves the app's own import
// conventions (`./x` -> `x.ts`, `@/x` -> `src/x`) during `node --test`.
register("./resolve-hooks.mjs", import.meta.url);