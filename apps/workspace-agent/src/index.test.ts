import { expect, test } from "vitest";
import { describeService } from "./index.js";

test("describes itself", () => {
	expect(describeService()).toBe("portikus workspace-agent");
});
