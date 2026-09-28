// The root helper's entry, run by portikus-egress-apply.service (ADR 0038).
// It lives at the top of src so the build puts it at dist/egress-apply-main.js.
import { defaultDeps, runHelper } from "./egress/helper.js";

runHelper(defaultDeps()).then(
	(code) => process.exit(code),
	(e: unknown) => {
		process.stderr.write(
			`egress apply failed: ${e instanceof Error ? e.message : String(e)}\n`,
		);
		process.exit(1);
	},
);
