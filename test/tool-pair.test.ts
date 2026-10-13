import { describe, expect, test } from "bun:test";
import { applyToolPairGate } from "../src/free-tier.ts";

const ZERO = { cost: { input: 0, output: 0 } };
const PAID = { cost: { input: 0.15, output: 0.5 } };

const READ = { type: "function", function: { name: "read", description: "r", parameters: { type: "object", properties: { path: { type: "string" } } } } };
const BASH = { type: "function", function: { name: "bash", description: "b", parameters: { type: "object", properties: { command: { type: "string" } } } } };
const SHELL = { type: "function", function: { name: "shell", description: "s", parameters: { type: "object", properties: { command: { type: "string" } } } } };

describe("applyToolPairGate", () => {
	test("a tool-less compaction-style request gets the read + exec pair, muted", () => {
		const next = applyToolPairGate(
			{ model: "big-pickle", stream: true, messages: [{ role: "system", content: "summarize" }] },
			"openai-completions",
			ZERO,
		);
		const names = (next?.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(names).toEqual(["read", "bash"]);
		expect(next?.tool_choice).toBe("none");
	});

	test("an existing read + exec pair is left alone (agent turns)", () => {
		const payload = { model: "big-pickle", stream: true, tools: [READ, BASH] };
		expect(applyToolPairGate(payload, "openai-completions", ZERO)).toBeUndefined();
	});

	test("a partial pair is completed rather than duplicated", () => {
		const next = applyToolPairGate(
			{ model: "big-pickle", stream: true, tools: [READ] },
			"openai-completions",
			ZERO,
		);
		const names = (next?.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(names).toEqual(["read", "bash"]);
		// real tools are present, so the caller's choice stands
		expect(next?.tool_choice).toBeUndefined();
	});

	test("shell counts as the exec half of the pair", () => {
		expect(applyToolPairGate({ tools: [READ, SHELL] }, "openai-completions", ZERO)).toBeUndefined();
	});

	test("the anthropic route gets flat {name, input_schema} entries and no tool_choice", () => {
		const next = applyToolPairGate({ model: "big-pickle", stream: true }, "anthropic-messages", ZERO);
		const tools = next?.tools as Array<{ name: string; input_schema: unknown }>;
		expect(tools.map((t) => t.name)).toEqual(["read", "bash"]);
		expect(tools[0]?.input_schema).toBeDefined();
		expect(next?.tool_choice).toBeUndefined();
	});

	test("the responses route gets flat {type, name, parameters} entries", () => {
		const next = applyToolPairGate({ model: "big-pickle", stream: true }, "openai-responses", ZERO);
		const tools = next?.tools as Array<{ type: string; name: string }>;
		expect(tools.map((t) => `${t.type}:${t.name}`)).toEqual(["function:read", "function:bash"]);
		// tool_choice "none" is not valid on the Responses API
		expect(next?.tool_choice).toBeUndefined();
	});

	test("paid models are never modified", () => {
		const payload = { model: "gpt-5", stream: true };
		expect(applyToolPairGate(payload, "openai-completions", PAID)).toBeUndefined();
	});

	test("a model with no cost metadata is not assumed free", () => {
		expect(applyToolPairGate({ stream: true }, "openai-completions", {})).toBeUndefined();
	});
});