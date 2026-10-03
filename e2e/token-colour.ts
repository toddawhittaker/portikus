import { expect, type Locator } from "@playwright/test";

/**
 * Checks a box is filled with a theme token, resolved in the box's own
 * document so the current colour scheme applies.
 */
export async function expectTokenFill(box: Locator, token: string): Promise<void> {
	const { actual, expected } = await box.evaluate((node, name) => {
		const probe = document.createElement("span");
		probe.style.backgroundColor = `var(${name})`;
		node.append(probe);
		const colour = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return { actual: getComputedStyle(node).backgroundColor, expected: colour };
	}, token);
	expect(actual).toBe(expected);
}
