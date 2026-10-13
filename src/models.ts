import type { Model } from "@earendil-works/pi-ai";

export const INFERENCE_URL = "https://opencode.ai/inference/openai/v1";

// Wire protocols the Zen inference gateway serves per path (probed live:
// /inference/{openai,anthropic,google}/... answer 401/500 vs 404 on the rest).
export type ZenApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

const ZEN_BASE: Record<ZenApi, string> = {
	"openai-completions": INFERENCE_URL,
	"openai-responses": INFERENCE_URL,
	// the anthropic SDK appends "/v1/messages" itself, so this base carries no version
	"anthropic-messages": "https://opencode.ai/inference/anthropic",
	"google-generative-ai": "https://opencode.ai/inference/google/v1beta",
};

// Zen serves the GPT-5/grok/muse families through the Responses API; everything
// else in the openai-compatible pool speaks Chat Completions (verified against
// pi's bundled opencode catalog).
const RESPONSES_MODEL = /^(gpt|grok|muse)-/;

export interface ZenProviderOverride {
	npm?: string;
	api?: string;
}

export interface ZenModelMeta {
	name?: string;
	reasoning?: boolean;
	modalities?: { input?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; output?: number };
	disabled?: boolean;
	status?: string;
	provider?: ZenProviderOverride;
}

export interface ZenRoute {
	api: ZenApi;
	baseUrl: string;
}

function apiFromNpm(id: string, npm: string): ZenApi | undefined {
	switch (npm) {
		case "@ai-sdk/anthropic":
			return "anthropic-messages";
		case "@ai-sdk/google":
			return "google-generative-ai";
		case "@ai-sdk/openai":
			return RESPONSES_MODEL.test(id) ? "openai-responses" : "openai-completions";
		case "@ai-sdk/openai-compatible":
			return "openai-completions";
		default:
			// vertex/bedrock/azure and friends need their own auth — not routable
			// through the Zen gateway
			return undefined;
	}
}

function apiFromUrl(url: string): ZenApi {
	if (url.includes("anthropic")) return "anthropic-messages";
	if (url.includes("google")) return "google-generative-ai";
	return "openai-completions";
}

// Resolve the wire protocol + gateway base URL for a console model. Returns
// undefined when the model's provider override cannot be routed via Zen.
export function resolveZenRoute(id: string, meta: ZenModelMeta): ZenRoute | undefined {
	const override = meta.provider;
	if (!override?.npm && !override?.api) return { api: "openai-completions", baseUrl: INFERENCE_URL };
	const api = override.npm ? apiFromNpm(id, override.npm) : apiFromUrl(override.api as string);
	if (!api) return undefined;
	// console hands out ".../inference/anthropic/v1"; the anthropic SDK appends
	// "/v1/messages", so drop the version here or every request 404s
	const baseUrl =
		api === "anthropic-messages" && override.api?.endsWith("/v1")
			? override.api.slice(0, -3)
			: (override.api ?? ZEN_BASE[api]);
	return { api, baseUrl };
}

// Zero-cost models are not all served over the same protocol. The v2 content
// gate applies to the Responses API, so it is tempting to route every free
// model there — but the gateway answers `400 ModelProtocolUnsupported` for
// anything outside the gpt/grok/muse families (`big-pickle`, `cat-jam-free`,
// `space-bunny-free`, `nemotron-*` all verified). The console hands out an
// `…/inference/openai/v1` URL for them, which `apiFromUrl` cannot tell apart
// from a genuine Chat Completions entry, so pick the free-model route from the
// model id with the same rule the paid pool uses.
function freeRoute(id: string): ZenRoute {
	return RESPONSES_MODEL.test(id)
		? { api: "openai-responses", baseUrl: INFERENCE_URL }
		: { api: "openai-completions", baseUrl: INFERENCE_URL };
}

export function modelFromZen(id: string, meta: ZenModelMeta): Model<ZenApi> {
	const cost = meta.cost ?? { input: 0, output: 0, cache_read: 0 };
	const free = meta.cost !== undefined && (cost.input ?? 0) <= 0 && (cost.output ?? 0) <= 0;
	const route = free ? freeRoute(id) :
		(resolveZenRoute(id, meta) ?? { api: "openai-completions" as const, baseUrl: INFERENCE_URL });
	return {
		id,
		name: meta.name ?? id,
		api: route.api,
		provider: "opencode-zen",
		baseUrl: route.baseUrl,
		reasoning: meta.reasoning ?? false,
		input: meta.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
		cost: {
			input: cost.input ?? 0,
			output: cost.output ?? 0,
			cacheRead: cost.cache_read ?? 0,
			// ponytail: console omits cache_write; 1.25x input matches pi's own convention
			cacheWrite: cost.cache_write ?? (cost.input ?? 0) * 1.25,
		},
		contextWindow: meta.limit?.context ?? 128000,
		maxTokens: meta.limit?.output ?? 32000,
	};
}

// Baseline catalog for offline startup; fetchModels replaces it with the live workspace list.
export const MODELS: Model<ZenApi>[] = [
	modelFromZen("glm-5.3-flash", {
		name: "GLM 5.3 Flash (Zen)",
		reasoning: true,
		modalities: { input: ["text"] },
		cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
		limit: { context: 1000000, output: 131072 },
	}),
	modelFromZen("deepseek-v4.1-flash", {
		name: "DeepSeek V4.1 Flash (Zen)",
		reasoning: true,
		modalities: { input: ["text", "image"] },
		cost: { input: 0.3, output: 1.2, cache_read: 0.006 },
		limit: { context: 1000000, output: 384000 },
	}),
];
