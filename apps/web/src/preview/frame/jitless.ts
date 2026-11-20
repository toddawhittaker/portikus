// Zod probes for `eval` when its schemas are built, and under this page's
// policy (no `unsafe-eval`) the probe is reported as a violation. Turn it off
// before the first schema exists; imported first, this module runs before the
// rest of the page's modules.
import { z } from "zod";

z.config({ jitless: true });
