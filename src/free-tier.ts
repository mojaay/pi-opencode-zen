const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const GATE_UA = "opencode/latest/2.0.28/cli";

export function freeTierSessionId(): string {
	const current = BigInt(Date.now()) * 0x1000n + 1n;
	const value = (~current) & ((1n << 48n) - 1n);
	const time = value.toString(16).padStart(12, "0").slice(-12);
	const bytes = new Uint8Array(14);
	crypto.getRandomValues(bytes);
	return `ses_${time}${Array.from(bytes, (byte) => B62[byte % 62]).join("")}`;
}

export function freeTierHeaders(session = freeTierSessionId()): Record<string, string> {
	return {
		"User-Agent": GATE_UA,
		"x-opencode-client": "cli",
		"x-opencode-session": session,
	};
}

export function isZeroCostModel(model: { cost?: { input?: number; output?: number } }): boolean {
	const cost = model.cost;
	return cost !== undefined && (cost.input ?? 0) <= 0 && (cost.output ?? 0) <= 0;
}

// Zen's free tier rejects a request that carries no tools at all with
// `403 FreeTierError`, unless the body carries opencode's title-generator
// marker (see src/v2-gate.ts). pi's compaction is tool-less by construction —
// `generateSummary` sends just a system prompt plus one user message — and its
// summarization prompt is far too short to satisfy the marker, so every
// `/compact` and every automatic compaction answers FreeTierError on a
// zero-cost model. Declaring a read + exec tool pair is enough to pass; the
// stubs are named after pi's real tools so a call would still resolve.
//
// Verified against the live gateway with pi's own summarization prompt:
// 403 as shipped, 200 with this pair added back.

// Chat Completions nests the schema under `function`; the Responses API and
// the Anthropic Messages API both use flat entries (with `parameters` vs
// `input_schema` respectively). Sending the wrong shape makes the gateway see
// tools with no name at all, so the pair it is looking for never appears.
const COMPLETION_STUBS = {
	read: {
		type: "function" as const,
		function: {
			name: "read",
			description: "Read a file from disk.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	},
	bash: {
		type: "function" as const,
		function: {
			name: "bash",
			description: "Run a shell command.",
			parameters: { type: "object", properties: { command: { type: "string" } } },
		},
	},
};

const READ_NAMES = ["read"];
const EXEC_NAMES = ["bash", "shell"];

function toolName(tool: unknown): string | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const fn = (tool as { function?: { name?: unknown } }).function;
	const name = fn?.name ?? (tool as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

function hasExecPair(tools: unknown[]): boolean {
	const names = new Set(tools.map(toolName).filter((n): n is string => Boolean(n)));
	return READ_NAMES.some((r) => names.has(r)) && EXEC_NAMES.some((e) => names.has(e));
}

/** Anthropic-wire variant: flat `{name, description, input_schema}` entries. */
const ANTHROPIC_STUBS = {
	read: { name: "read", description: "Read a file from disk.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	bash: { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
};

/** Responses-wire variant: flat `{type: "function", name, description, parameters}`. */
const RESPONSES_STUBS = {
	read: { type: "function" as const, name: "read", description: "Read a file from disk.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	bash: { type: "function" as const, name: "bash", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
};

/**
 * Give a tool-less zero-cost request the tool pair the gateway wants, in the
 * wire format the named route speaks. Returns undefined when nothing needs to
 * change (paid model, or a payload that already carries a read + exec pair).
 */
export function applyToolPairGate(
	payload: Record<string, unknown>,
	api: string | undefined,
	model: { cost?: { input?: number; output?: number } },
): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	if (!isZeroCostModel(model)) return undefined;

	const existing: unknown[] = Array.isArray(payload.tools) ? (payload.tools as unknown[]) : [];
	if (hasExecPair(existing)) return undefined; // agent turns already qualify

	const names = new Set(existing.map(toolName));
	const needsRead = !READ_NAMES.some((r) => names.has(r));
	const needsExec = !EXEC_NAMES.some((e) => names.has(e));
	if (!needsRead && !needsExec) return undefined;

	const next: Record<string, unknown> = { ...payload };
	const tools: unknown[] = [...existing];
	if (api === "anthropic-messages") {
		if (needsRead) tools.push(ANTHROPIC_STUBS.read);
		if (needsExec) tools.push(ANTHROPIC_STUBS.bash);
		next.tools = tools;
		return next;
	}

	if (api === "openai-responses") {
		if (needsRead) tools.push(RESPONSES_STUBS.read);
		if (needsExec) tools.push(RESPONSES_STUBS.bash);
		next.tools = tools;
		return next;
	}

	if (needsRead) tools.push(COMPLETION_STUBS.read);
	if (needsExec) tools.push(COMPLETION_STUBS.bash);
	next.tools = tools;

	// Nothing real to call, so forbid calls when the route supports muting.
	// (`tool_choice: "none"` is only valid on Chat Completions; on the Responses
	// API a missing value keeps the endpoint default.)
	if (existing.length === 0 && api === "openai-completions" && next.tool_choice === undefined) {
		next.tool_choice = "none";
	}
	return next;
}
