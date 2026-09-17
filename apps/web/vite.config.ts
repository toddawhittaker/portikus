import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = { target: "http://127.0.0.1:3000", changeOrigin: true };

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: {
			"/health": api,
			"/auth": api,
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
