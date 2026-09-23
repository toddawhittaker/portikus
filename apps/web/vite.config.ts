import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig } from "vite";

// The end-to-end runs pick their own ports (e2e/with-run-database.mjs).
const apiPort = process.env.PORTIKUS_API_PORT ?? "3000";
const webPort = Number(process.env.PORTIKUS_WEB_PORT ?? "5173");
const api = { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true };

/**
 * A page that closes or navigates away while a terminal or presence socket
 * is open leaves the WebSocket proxy writing to a dead socket. Vite reports
 * each one as "ws proxy error" or "ws proxy socket error" at error level,
 * which floods the dev server output and every Playwright run with EPIPE
 * and ECONNRESET lines that mean nothing. Drop those two codes on the
 * proxy messages only; every other error still prints.
 */
const logger = createLogger();
const vanillaError = logger.error.bind(logger);
logger.error = (msg, options) => {
	const code = (options?.error as NodeJS.ErrnoException | undefined)?.code;
	const isProxyLine = /ws proxy (socket )?error/.test(msg);
	if (isProxyLine && (code === "EPIPE" || code === "ECONNRESET")) return;
	vanillaError(msg, options);
};

export default defineConfig({
	customLogger: logger,
	plugins: [react(), tailwindcss()],
	// Monaco is thousands of small modules. Without pre-bundling, the first
	// file tab opened against the dev server takes over a minute to load.
	optimizeDeps: {
		include: [
			"monaco-editor/editor/editor.api.js",
			"monaco-editor/basic-languages/monaco.contribution.js",
			"monaco-editor/language/json/monaco.contribution.js",
		],
	},
	server: {
		host: "127.0.0.1",
		port: webPort,
		strictPort: true,
		proxy: {
			"/health": api,
			"/auth": api,
			// The signed-in user's own editor settings (issue #159).
			"/me": api,
			// LTI launch and the Course page's data (docs/EPIC-13.md). Anchored so
			// the web app's own /course pages stay in the bundle.
			"^/lti(/|\\?|$)": api,
			"^/courses(/|\\?|$)": api,
			// /admin is the administration screen in the bundle; /admin/*
			// is its data. Only the document navigation stays in the browser.
			"/admin": {
				...api,
				bypass: (req) => {
					const path = (req.url ?? "").split("?")[0] ?? "";
					if (path !== "/admin" && path !== "/admin/") return undefined;
					return req.headers.accept?.includes("text/html") ? "/index.html" : undefined;
				},
			},
			// The workspace routes include the WebSocket upgrade. They are also
			// where the single-page application's own screens live, so a page
			// the browser asks for as a document is served from the bundle and
			// only data and socket requests reach the API.
			"/workspaces": {
				...api,
				ws: true,
				bypass: (req) => {
					// A project download is navigated to as a document, but the zip
					// comes from the API, not the bundle.
					const path = (req.url ?? "").split("?")[0] ?? "";
					if (path.endsWith("/download")) return undefined;
					return req.headers.accept?.includes("text/html") ? "/index.html" : undefined;
				},
			},
		},
	},
});
