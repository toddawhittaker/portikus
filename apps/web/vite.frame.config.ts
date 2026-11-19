import { defineConfig, type Plugin } from "vite";

// The preview wrapper page (BROWSER-HANDLING.md section 12.1). Caddy serves
// dist/preview-frame at /__portikus/frame/ under a CSP that allows no inline
// script or style, so nothing may be inlined into the page.
const PAGE = "preview-frame.html";

/** Caddy serves the directory, so the page must be index.html. */
function pageAsIndex(): Plugin {
	return {
		name: "portikus-preview-frame-index",
		enforce: "post",
		generateBundle(_options, bundle) {
			const page = bundle[PAGE];
			if (page) page.fileName = "index.html";
		},
	};
}

export default defineConfig({
	base: "/__portikus/frame/",
	publicDir: false,
	plugins: [pageAsIndex()],
	build: {
		outDir: "dist/preview-frame",
		emptyOutDir: true,
		assetsInlineLimit: 0,
		modulePreload: { polyfill: false },
		rolldownOptions: { input: PAGE },
	},
});
