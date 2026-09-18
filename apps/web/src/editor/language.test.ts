import { describe, expect, it } from "vitest";
import { detectLanguage } from "./language.js";

/** Language guessing from the first line and the file name (SPEC.md §13.2). */
describe("detectLanguage", () => {
	it("reads a plain shebang", () => {
		expect(detectLanguage("pre-applypatch.sample", "#!/bin/sh")).toBe("shell");
		expect(detectLanguage("run", "#!/bin/bash -eu")).toBe("shell");
		expect(detectLanguage("run", "#!/usr/bin/zsh")).toBe("shell");
		expect(detectLanguage("script", "#!/usr/bin/perl")).toBe("perl");
		expect(detectLanguage("script", "#!/usr/bin/ruby")).toBe("ruby");
	});

	it("reads a shebang that goes through env", () => {
		expect(detectLanguage("tool", "#!/usr/bin/env python3")).toBe("python");
		expect(detectLanguage("tool", "#!/usr/bin/env node")).toBe("javascript");
		expect(detectLanguage("tool", "#! /usr/bin/env  bash")).toBe("shell");
	});

	it("gives nothing for a shebang it does not know", () => {
		expect(detectLanguage("tool", "#!/usr/bin/env fortran")).toBeNull();
		expect(detectLanguage("tool", "#!/opt/weird/thing")).toBeNull();
	});

	it("reads markup and JSON openings", () => {
		expect(detectLanguage("data", '<?xml version="1.0"?>')).toBe("xml");
		expect(detectLanguage("page", "<!DOCTYPE html>")).toBe("html");
		expect(detectLanguage("page", '<html lang="en">')).toBe("html");
		expect(detectLanguage("feed", "<rss>")).toBe("xml");
		expect(detectLanguage("config", '{ "a": 1 }')).toBe("json");
		expect(detectLanguage("list", "[1, 2, 3]")).toBe("json");
	});

	it("reads well-known file names", () => {
		expect(detectLanguage("Makefile", "all:")).toBe("makefile");
		expect(detectLanguage("GNUmakefile", "")).toBe("makefile");
		expect(detectLanguage("Dockerfile.dev", "FROM debian")).toBe("dockerfile");
		expect(detectLanguage(".bashrc", "")).toBe("shell");
		expect(detectLanguage(".profile", "")).toBe("shell");
	});

	it("prefers the file name over the first line", () => {
		expect(detectLanguage("Makefile", "#!/bin/sh")).toBe("makefile");
	});

	it("ignores leading whitespace and a byte order mark", () => {
		expect(detectLanguage("data", "﻿{}")).toBe("json");
		expect(detectLanguage("page", "   <?xml ?>")).toBe("xml");
	});

	it("gives nothing for ordinary prose", () => {
		expect(detectLanguage("notes", "Hello there.")).toBeNull();
		expect(detectLanguage("empty", "")).toBeNull();
	});
});
