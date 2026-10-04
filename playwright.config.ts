import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { BACKUP_KEY_SOCKET, BACKUP_KEY_STATE } from "./e2e/backup-key";
import { CERTIFICATE_JOBS_DIR, CERTIFICATE_STATUS_DIR } from "./e2e/certificate-jobs";
import { FAKE_AGENT_TOKEN } from "./e2e/helpers";
import { IMAGE_JOBS_DIR, IMAGES_DIR } from "./e2e/image-jobs";
import { E2E_JOURNAL_FILE } from "./e2e/journal-file";
import {
	API_ORIGIN,
	API_PORT,
	FAKE_AGENT_PORT,
	FAKE_ALERT_WEBHOOK_PORT,
	FAKE_DEX_GRPC_PORT,
	MOCK_LMS_ORIGIN,
	MOCK_LMS_PORT,
	MOCK_ISSUER as MOCK_OIDC_ISSUER,
	OIDC_PORT,
	WEB_PORT,
	WEB_ORIGIN as WEB_URL,
} from "./e2e/ports";
import { REGISTRY_JOBS_DIR } from "./e2e/registry-jobs";
import { writeDexGrpcCerts } from "./packages/auth/dist/testing/fake-dex-grpc.js";

// The throwaway PostgreSQL from docs/WORKFLOW.md, "Local PostgreSQL for
// database tests"; CI points TEST_DATABASE_URL at its service container.
// `pnpm test:e2e` points this at a database created for the run. A direct
// `playwright test` uses the shared database, which can refuse to migrate
// when its history names a migration this checkout does not contain.
const databaseUrl =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:portikus@127.0.0.1:55432/portikus_test";

// The mock LMS registration and the tool key for this run (ADR 0025).
// Keyed by the mock's port so runs never share them; the
// config loads more than once, so the writes are idempotent.
const ltiDir = join(tmpdir(), `portikus-e2e-lti-${MOCK_LMS_PORT}`);
const ltiPlatformsFile = join(ltiDir, "lti-platforms.json");
const ltiToolKeyFile = join(ltiDir, "lti-tool-key.pem");
mkdirSync(ltiDir, { recursive: true });
writeFileSync(
	ltiPlatformsFile,
	JSON.stringify({
		version: 1,
		platforms: [
			{
				name: "mock-lms",
				issuer: MOCK_LMS_ORIGIN,
				clientId: "portikus-mock",
				authLoginUrl: `${MOCK_LMS_ORIGIN}/authorize`,
				keysetUrl: `${MOCK_LMS_ORIGIN}/.well-known/jwks.json`,
				deploymentIds: ["mock-deployment-1"],
				mock: true,
			},
		],
	}),
);
if (!existsSync(ltiToolKeyFile)) {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	writeFileSync(ltiToolKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), {
		mode: 0o600,
	});
}

// The fake Dex gRPC API's certificates for this run (ADR 0028);
// kept when present, so the config loading more than once changes nothing.
const dexCertDir = join(tmpdir(), `portikus-e2e-dex-${FAKE_DEX_GRPC_PORT}`);
const dexCerts = writeDexGrpcCerts(dexCertDir, "e2e");

// The Workspace image section's job directory and image store (e2e/image-jobs.ts).
mkdirSync(IMAGE_JOBS_DIR, { recursive: true });
mkdirSync(IMAGES_DIR, { recursive: true });
// The Certificate tab's job and status directories (e2e/certificate-jobs.ts).
mkdirSync(CERTIFICATE_JOBS_DIR, { recursive: true });
mkdirSync(CERTIFICATE_STATUS_DIR, { recursive: true });
// The Docker tab's cache helper directory (e2e/registry-jobs.ts).
mkdirSync(REGISTRY_JOBS_DIR, { recursive: true });

// The API's standard output, copied here, is the journal the fake journalctl
// reads for the Logs tab (docs/adr/0036). It is emptied when the API starts.
const journalFile = E2E_JOURNAL_FILE;
// The API starts journalctl with only PATH and LANG, so a wrapper names the
// journal file and the node binary itself.
const fakeJournalctl = join(tmpdir(), `portikus-e2e-journalctl-${API_PORT}.sh`);
writeFileSync(
	fakeJournalctl,
	`#!/bin/sh\nFAKE_JOURNAL_FILE='${journalFile}' exec '${process.execPath}' '${join(process.cwd(), "e2e/fake-journalctl.mjs")}' "$@"\n`,
	{ mode: 0o755 },
);

const DOCKER_SPECS = /admin-docker(-seed)?\.spec\.ts$/;

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: "list",
	use: {
		baseURL: WEB_URL,
		trace: "on-first-retry",
	},
	projects: [
		// Runs first and stops the suite if the servers belong to another run.
		{ name: "setup", testMatch: /environment\.setup\.ts$/ },
		{
			name: "chromium",
			testIgnore: DOCKER_SPECS,
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["setup"],
		},
		{
			// The Docker specs share one settings row, the seed tables and the
			// fake cache helper's directory, so they run one file at a time.
			name: "docker",
			testMatch: DOCKER_SPECS,
			workers: 1,
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["setup"],
		},
	],
	webServer: [
		{
			// Stands in for the workspace agent, which normally runs inside a
			// container the browser tests do not start (see e2e/helpers.ts).
			command: "node e2e/fake-agent-server.mjs",
			port: FAKE_AGENT_PORT,
			env: {
				FAKE_AGENT_PORT: String(FAKE_AGENT_PORT),
				FAKE_AGENT_TOKEN: FAKE_AGENT_TOKEN,
			},
			timeout: 120_000,
		},
		{
			command: "node packages/auth/dist/testing/mock-oidc-main.js",
			url: `${MOCK_OIDC_ISSUER}/.well-known/openid-configuration`,
			env: {
				MOCK_OIDC_PORT: String(OIDC_PORT),
				MOCK_OIDC_ISSUER,
				MOCK_OIDC_CLIENT_ID: "portikus-dev",
				MOCK_OIDC_CLIENT_SECRET: "portikus-dev-secret",
				MOCK_OIDC_REDIRECT_URI: `${WEB_URL}/auth/callback`,
			},
			timeout: 120_000,
		},
		{
			// The mock LMS (packages/mock-lms), trusted by the platforms file above.
			command: `node packages/mock-lms/dist/main.js --tool-url ${WEB_URL} --port ${MOCK_LMS_PORT} --bind 127.0.0.1 --issuer ${MOCK_LMS_ORIGIN}`,
			url: `${MOCK_LMS_ORIGIN}/.well-known/jwks.json`,
			timeout: 120_000,
		},
		{
			// Stands in for Dex's gRPC API, so the Users view can manage Dex users.
			command: "node e2e/fake-dex-grpc.mjs",
			port: FAKE_DEX_GRPC_PORT,
			env: {
				FAKE_DEX_GRPC_PORT: String(FAKE_DEX_GRPC_PORT),
				FAKE_DEX_GRPC_CERT_DIR: dexCertDir,
			},
			timeout: 120_000,
		},
		{
			// The fake backup key helper runs beside the API, in its process group.
			command: `node e2e/fake-backup-key-server.mjs & : > ${journalFile} && node packages/db/dist/migrate.js && node apps/api/dist/index.js | tee -a ${journalFile}`,
			url: `${API_ORIGIN}/health`,
			env: {
				NODE_ENV: "test",
				PORT: String(API_PORT),
				AGENT_PORT: String(FAKE_AGENT_PORT),
				DATABASE_URL: databaseUrl,
				PUBLIC_URL: WEB_URL,
				OIDC_ISSUER_URL: MOCK_OIDC_ISSUER,
				OIDC_CLIENT_ID: "portikus-dev",
				OIDC_CLIENT_SECRET: "portikus-dev-secret",
				OIDC_SCOPES: "openid profile email",
				OIDC_GROUPS_CLAIM: "groups",
				OIDC_STUDENT_GROUP: "portikus-students",
				OIDC_ADMIN_GROUP: "portikus-administrators",
				LTI_PLATFORMS_FILE: ltiPlatformsFile,
				LTI_TOOL_KEY_FILE: ltiToolKeyFile,
				DEX_GRPC_ADDR: `127.0.0.1:${FAKE_DEX_GRPC_PORT}`,
				DEX_GRPC_CA: dexCerts.ca,
				DEX_GRPC_CERT: dexCerts.clientCert,
				DEX_GRPC_KEY: dexCerts.clientKey,
				SESSION_COOKIE_SECRET: "e2e-session-secret-not-for-production-0000",
				SESSION_TTL_SECONDS: "3600",
				PRESENCE_TTL_SECONDS: "60",
				// One template, so projects.spec.ts can use the template option;
				// the "no templates" case fakes an empty list in the browser.
				PROJECT_TEMPLATES: "Starter=https://example.com/starter.git",
				WORKSPACE_HOME_SIZE_GIB: "25",
				WORKSPACE_DOCKER_SIZE_GIB: "20",
				// One full local run makes more than 150 sign-in starts a minute
				// from 127.0.0.1; unit tests keep the real limit.
				SIGNIN_START_LIMIT_PER_MINUTE: "100000",
				JOURNALCTL_PATH: fakeJournalctl,
				ALERT_WEBHOOK_URL: `http://127.0.0.1:${FAKE_ALERT_WEBHOOK_PORT}/hook`,
				// A fake image job directory the admin-image tests play the root job in.
				IMAGE_JOBS_DIR,
				// A fake certificate job directory the admin-certificate tests play the root job in;
				// the API reads the status directory beside it.
				CERTIFICATE_JOBS_DIR,
				// A fake cache helper directory the admin-docker tests play the helper in.
				REGISTRY_JOBS_DIR,
				// A server that backs itself up and holds its key (ADR 0044).
				BACKUP_KEY_SOCKET,
				BACKUP_KEY_STATE,
				// The suite starts, stops and writes files for a few users far
				// faster than a person; unit tests keep the real limits.
				WORKSPACE_LIFECYCLE_LIMIT_PER_MINUTE: "100000",
				FILE_WRITE_LIMIT_PER_MINUTE: "100000",
				// admin-image.spec.ts waits for the timer's release notices.
				RELEASE_NOTICE_SECONDS: "2",
			},
			timeout: 120_000,
		},
		{
			command: "pnpm --filter @portikus/web dev",
			url: WEB_URL,
			env: { PORTIKUS_WEB_PORT: String(WEB_PORT), PORTIKUS_API_PORT: String(API_PORT) },
			timeout: 120_000,
		},
	],
});
