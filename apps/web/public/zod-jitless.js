// Zod probes for eval with `new Function` when a schema is built, and the
// content security policy reports that probe as a violation even though Zod
// catches it (SPEC.md section 24.3). Zod reads this global as its config.
globalThis.__zod_globalConfig = { jitless: true };
