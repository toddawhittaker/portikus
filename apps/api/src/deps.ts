import type { DexApi, OidcClient } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import type { PreflightNet } from "./certificate/preflight.js";
import type { LtiDeps } from "./lti/deps.js";

/** What the control-plane server is built from (SPEC.md §2.8). */
export interface ServerDeps {
	db: Kysely<Database>;
	config: ApiConfig;
	/** The one root logger of this process (ADR 0012). */
	logger: Logger;
	/** Tests inject a client bound to the mock provider. */
	oidc?: OidcClient;
	/** The registered LMS platforms; absent means LTI is off and /lti/* is 404. */
	lti?: LtiDeps;
	/** Dex's gRPC API; absent means the Dex user routes answer 404. */
	dex?: DexApi;
	/** How often the listening registry looks for workspaces; tests go faster. */
	previewPollIntervalMs?: number;
	/** DNS and probes for the certificate pre-flight; tests fake them. */
	certificateNet?: PreflightNet;
}
