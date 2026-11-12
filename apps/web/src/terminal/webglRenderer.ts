/**
 * The GPU renderer for a terminal (SPEC.md §9.1). xterm.js's own DOM renderer
 * draws box and block characters from the font, which leaves gaps between rows
 * at any line height above 1.0; the WebGL addon draws them to fill the cell.
 * The DOM renderer stays the fallback, so a browser or machine without WebGL2
 * still shows a working terminal.
 */
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/**
 * Turn the WebGL renderer on for an open terminal. Returns a function that
 * turns it off again; it is safe to call after the renderer is already gone.
 *
 * A failure to start, or a lost context, leaves the terminal on the DOM
 * renderer with no retry. Chrome keeps about sixteen live WebGL contexts per
 * page and drops the oldest when a new one is made, so a student with many
 * panes open ends up with the oldest ones on the DOM renderer.
 */
export function enableWebglRenderer(term: Terminal): () => void {
	let addon: WebglAddon | null = null;
	const drop = () => {
		const current = addon;
		addon = null;
		try {
			current?.dispose();
		} catch {
			// Already torn down along with the lost context.
		}
	};
	try {
		addon = new WebglAddon();
		addon.onContextLoss(drop);
		term.loadAddon(addon);
	} catch {
		// No WebGL2 here: the DOM renderer keeps drawing.
		drop();
	}
	return drop;
}
