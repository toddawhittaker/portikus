/**
 * The ports this end-to-end run uses. `pnpm test:e2e` (e2e/with-run-database.mjs)
 * picks free ones and passes them in the environment, so several runs on one
 * machine do not collide. A direct `playwright test` falls back to the
 * development ports.
 */
function port(name: string, fallback: number): number {
	return Number(process.env[name] ?? fallback);
}

export const WEB_PORT = port("PORTIKUS_WEB_PORT", 5173);
export const API_PORT = port("PORTIKUS_API_PORT", 3000);
export const OIDC_PORT = port("PORTIKUS_OIDC_PORT", 3002);
export const FAKE_AGENT_PORT = port("FAKE_AGENT_PORT", 7400);
export const MOCK_LMS_PORT = port("PORTIKUS_MOCK_LMS_PORT", 8765);
export const FAKE_DEX_GRPC_PORT = port("FAKE_DEX_GRPC_PORT", 5557);

export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const MOCK_ISSUER = `http://127.0.0.1:${OIDC_PORT}`;
export const FAKE_AGENT_URL = `http://127.0.0.1:${FAKE_AGENT_PORT}`;
export const MOCK_LMS_ORIGIN = `http://127.0.0.1:${MOCK_LMS_PORT}`;
