// Zod probes for `eval` when its schemas are built, and under this page's
// policy (no `unsafe-eval`) the probe is reported as a violation. Turn it off
// before the first schema exists; imported first, this module runs before the
// rest of the page's modules.
(globalThis as { __zod_globalConfig?: unknown }).__zod_globalConfig = { jitless: true };

export {};
