/**
 * Automatic model ordering for fallback chains.
 *
 * Scans the models OpenCode knows about and sorts them into a fixed
 * preference order so users don't have to hand-maintain `fallback_models`:
 *
 *   1. Claude products
 *   2. GPT products
 *   3. Muse
 *   4. Other American models (Gemini/Google, Grok/xAI, Llama/Meta, Copilot/Microsoft, …)
 *   5. GLM (Zhipu)
 *   6. MiMo (Xiaomi)
 *   7. DeepSeek
 *   8. Anything else (original relative order preserved — not shuffled)
 *
 * Sorting is stable: models within the same tier keep their input order.
 * Output is de-duplicated (first occurrence wins).
 */

export enum ModelTier {
	Claude = 1,
	GPT = 2,
	Muse = 3,
	American = 4,
	GLM = 5,
	MiMo = 6,
	DeepSeek = 7,
	Other = 8,
}

/** Providers owned by big American labs / infra. Matched by provider ID. */
const AMERICAN_PROVIDERS = new Set([
	"google",
	"vertex",
	"vertex-ai",
	"xai",
	"meta",
	"github",
	"github-copilot",
	"microsoft",
	"azure",
	"amazon",
	"bedrock",
	"nvidia",
])

function splitProvider(model: string): { providerID: string; modelID: string } {
	const idx = model.indexOf("/")
	if (idx === -1) return { providerID: "", modelID: model }
	return {
		providerID: model.slice(0, idx).toLowerCase(),
		modelID: model.slice(idx + 1),
	}
}

export function getModelTier(model: string): ModelTier {
	const lower = model.toLowerCase()
	const { providerID } = splitProvider(model)

	// Tier 1 — Claude products (any host: anthropic, google antigravity, copilot, …)
	if (lower.includes("claude") || providerID === "anthropic") {
		return ModelTier.Claude
	}

	// Tier 2 — GPT products
	if (
		lower.includes("gpt") ||
		lower.includes("openai") ||
		lower.includes("codex") ||
		providerID === "openai"
	) {
		return ModelTier.GPT
	}

	// Tier 3 — Muse (dedicated provider/family only — copilot-hosted
	// Claude/GPT are already claimed by tiers 1-2 above on purpose)
	if (
		providerID.includes("spark") ||
		providerID.includes("muse") ||
		lower.includes("muse-spark") ||
		lower.includes("musespark") ||
		lower.includes("muse spark") ||
		lower.includes("spark")
	) {
		return ModelTier.Muse
	}

	// Tier 4 — Other American models: big-lab families regardless of host
	// (Gemini, Grok, Llama) or big-tech providers themselves.
	if (
		AMERICAN_PROVIDERS.has(providerID) ||
		lower.includes("gemini") ||
		lower.includes("google") ||
		lower.includes("vertex") ||
		lower.includes("grok") ||
		lower.includes("xai") ||
		lower.includes("llama") ||
		lower.includes("copilot")
	) {
		return ModelTier.American
	}

	// Tier 5 — GLM (Zhipu)
	if (
		providerID === "glm" ||
		providerID === "zhipu" ||
		lower.includes("glm") ||
		lower.includes("zhipu")
	) {
		return ModelTier.GLM
	}

	// Tier 6 — MiMo (Xiaomi)
	if (
		providerID === "mimo" ||
		providerID === "xiaomi" ||
		lower.includes("mimo")
	) {
		return ModelTier.MiMo
	}

	// Tier 7 — DeepSeek
	if (providerID === "deepseek" || lower.includes("deepseek")) {
		return ModelTier.DeepSeek
	}

	return ModelTier.Other
}

/** Stable sort by tier + de-dupe (first occurrence wins). No-op for 0-1 items. */
export function sortModelsByPreference(models: string[]): string[] {
	if (models.length <= 1) return [...models]

	const seen = new Set<string>()
	const deduped: string[] = []
	for (const m of models) {
		if (typeof m !== "string" || seen.has(m)) continue
		seen.add(m)
		deduped.push(m)
	}

	return deduped
		.map((model, index) => ({ model, index, tier: getModelTier(model) }))
		.sort((a, b) => a.tier - b.tier || a.index - b.index)
		.map((entry) => entry.model)
}

function normalizeModelValue(value: unknown, providerID?: string): string[] {
	if (typeof value === "string" && value.length > 0) {
		// Bare model IDs inside a provider block get prefixed: { provider: { models: { "foo": … } } }
		if (providerID && !value.includes("/")) return [`${providerID}/${value}`]
		return [value]
	}
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		providerID
	) {
		const rec = value as Record<string, unknown>
		// Expanded object form: { model: "provider/id", providerID, modelID, … }
		if (typeof rec.model === "string" && rec.model.length > 0) return [rec.model]
		if (typeof rec.modelID === "string" && rec.modelID.length > 0) {
			const id = rec.modelID.includes("/")
				? rec.modelID
				: `${providerID}/${rec.modelID}`
			return [id]
		}
		if (typeof rec.id === "string" && rec.id.length > 0) {
			const id = rec.id.includes("/") ? rec.id : `${providerID}/${rec.id}`
			return [id]
		}
	}
	return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArrayField(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === "string")
}

/**
 * Scan an OpenCode config object for every model it references.
 * Covers: root `model`, `provider.<id>.models`, and per-agent
 * `model` + `fallback_models` under `agents`/`agent`.
 *
 * Models hidden via `disabled: true`, provider `blacklist`, or excluded
 * by a provider `whitelist` are skipped — they are not valid fallback
 * targets either.
 *
 * Returns models in discovery order (de-duplicated, NOT sorted —
 * call `sortModelsByPreference` on the result).
 */
export function collectAvailableModels(
	opencodeConfig: Record<string, unknown>
): string[] {
	const found: string[] = []
	const seen = new Set<string>()
	const push = (model: string) => {
		if (!seen.has(model)) {
			seen.add(model)
			found.push(model)
		}
	}

	// Root default model
	for (const m of normalizeModelValue(opencodeConfig.model)) push(m)

	// Provider catalog: provider.<providerID>.models
	const providers = opencodeConfig.provider
	if (isRecord(providers)) {
		for (const [providerID, providerConfig] of Object.entries(providers)) {
			if (!isRecord(providerConfig)) continue
			const blacklist = stringArrayField(providerConfig.blacklist)
			const whitelist = stringArrayField(providerConfig.whitelist)
			const isVisible = (modelKey: string): boolean => {
				const qualified = `${providerID}/${modelKey}`
				if (blacklist.includes(modelKey) || blacklist.includes(qualified)) {
					return false
				}
				if (
					whitelist.length > 0 &&
					!whitelist.includes(modelKey) &&
					!whitelist.includes(qualified)
				) {
					return false
				}
				return true
			}
			const models = providerConfig.models
			if (isRecord(models)) {
				for (const [modelKey, modelConfig] of Object.entries(models)) {
					if (!isVisible(modelKey)) continue
					// Hidden from the /models picker — not a fallback target
					if (isRecord(modelConfig) && modelConfig.disabled === true) {
						continue
					}
					if (isRecord(modelConfig)) {
						const explicit = normalizeModelValue(modelConfig, providerID)
						if (explicit.length > 0) {
							for (const m of explicit) push(m)
						} else {
							push(
								modelKey.includes("/") ? modelKey : `${providerID}/${modelKey}`
							)
						}
					} else if (typeof modelConfig === "string" && modelConfig.length > 0) {
						push(
							modelConfig.includes("/")
								? modelConfig
								: `${providerID}/${modelConfig}`
						)
					} else {
						push(
							modelKey.includes("/") ? modelKey : `${providerID}/${modelKey}`
						)
					}
				}
			} else if (Array.isArray(models)) {
				for (const entry of models) {
					for (const m of normalizeModelValue(entry, providerID)) push(m)
				}
			}
		}
	}

	// Per-agent models (both `agents` plural and `agent` singular keys)
	for (const key of ["agents", "agent"] as const) {
		const agents = opencodeConfig[key]
		if (!isRecord(agents)) continue
		for (const agentConfig of Object.values(agents)) {
			if (!isRecord(agentConfig)) continue
			for (const m of normalizeModelValue(agentConfig.model)) push(m)
			const fallbacks = agentConfig.fallback_models
			if (typeof fallbacks === "string") {
				for (const m of normalizeModelValue(fallbacks)) push(m)
			} else if (Array.isArray(fallbacks)) {
				for (const entry of fallbacks) {
					if (typeof entry === "string") {
						for (const m of normalizeModelValue(entry)) push(m)
					}
				}
			}
		}
	}

	return found
}
