import { describe, test, expect } from "bun:test"
import {
	getModelTier,
	sortModelsByPreference,
	collectAvailableModels,
	ModelTier,
} from "./model-order"
import { getFallbackModelsForSession } from "./config-reader"

describe("model-order", () => {
	describe("#given getModelTier", () => {
		describe("#when model is a Claude product", () => {
			test("#then returns Claude tier regardless of host provider", () => {
				expect(getModelTier("anthropic/claude-opus-4-6")).toBe(ModelTier.Claude)
				expect(getModelTier("google/antigravity-claude-opus-4-6-thinking")).toBe(
					ModelTier.Claude
				)
				expect(getModelTier("github-copilot/claude-opus-4.6")).toBe(
					ModelTier.Claude
				)
			})
		})

		describe("#when model is a GPT product", () => {
			test("#then returns GPT tier", () => {
				expect(getModelTier("openai/gpt-5.4")).toBe(ModelTier.GPT)
				expect(getModelTier("openai/gpt-4o")).toBe(ModelTier.GPT)
				expect(getModelTier("github-copilot/gpt-5.3-codex")).toBe(ModelTier.GPT)
			})
		})

		describe("#when model is Muse", () => {
			test("#then returns Muse tier", () => {
				expect(getModelTier("muse-spark/spark-1")).toBe(ModelTier.Muse)
				expect(getModelTier("provider/my-spark-model")).toBe(ModelTier.Muse)
			})
		})

		describe("#when model is another American model", () => {
			test("#then returns American tier", () => {
				expect(getModelTier("google/gemini-3-pro")).toBe(ModelTier.American)
				expect(getModelTier("xai/grok-4")).toBe(ModelTier.American)
				expect(getModelTier("meta/llama-3.3-70b")).toBe(ModelTier.American)
				expect(getModelTier("groq/llama-3.3-70b-versatile")).toBe(
					ModelTier.American
				)
			})
		})

		describe("#when model is GLM, MiMo or DeepSeek", () => {
			test("#then returns the matching tier", () => {
				expect(getModelTier("zhipu/glm-4.5")).toBe(ModelTier.GLM)
				expect(getModelTier("xiaomi/mimo-7b")).toBe(ModelTier.MiMo)
				expect(getModelTier("deepseek/deepseek-chat")).toBe(ModelTier.DeepSeek)
			})
		})

		describe("#when model matches nothing", () => {
			test("#then returns Other tier", () => {
				expect(getModelTier("kimi-for-coding/k2p5")).toBe(ModelTier.Other)
				expect(getModelTier("qwen/qwen3-coder-30b")).toBe(ModelTier.Other)
				expect(getModelTier("google/model-a")).toBe(ModelTier.American)
			})
		})

		describe("#when model is copilot-hosted claude or gpt", () => {
			test("#then claude/gpt win over American classification", () => {
				// Tier 1/2 are checked before tier 4 on purpose
				expect(getModelTier("github-copilot/claude-opus-4.6")).toBe(
					ModelTier.Claude
				)
				expect(getModelTier("github-copilot/gpt-5.3-codex")).toBe(ModelTier.GPT)
			})
		})
	})

	describe("#given sortModelsByPreference", () => {
		describe("#when given models from every tier in reverse order", () => {
			test("#then orders claude -> gpt -> muse -> american -> glm -> mimo -> deepseek -> other", () => {
				const input = [
					"qwen/qwen3-coder-30b",
					"deepseek/deepseek-chat",
					"xiaomi/mimo-7b",
					"zhipu/glm-4.5",
					"google/gemini-3-pro",
					"muse-spark/spark-1",
					"openai/gpt-5.4",
					"anthropic/claude-opus-4-6",
				]

				expect(sortModelsByPreference(input)).toEqual([
					"anthropic/claude-opus-4-6",
					"openai/gpt-5.4",
					"muse-spark/spark-1",
					"google/gemini-3-pro",
					"zhipu/glm-4.5",
					"xiaomi/mimo-7b",
					"deepseek/deepseek-chat",
					"qwen/qwen3-coder-30b",
				])
			})
		})

		describe("#when models share a tier", () => {
			test("#then preserves their relative order (stable sort)", () => {
				const input = [
					"openai/gpt-4o",
					"anthropic/claude-sonnet-4-6",
					"github-copilot/gpt-5.3-codex",
					"anthropic/claude-opus-4-6",
				]

				expect(sortModelsByPreference(input)).toEqual([
					"anthropic/claude-sonnet-4-6",
					"anthropic/claude-opus-4-6",
					"openai/gpt-4o",
					"github-copilot/gpt-5.3-codex",
				])
			})
		})

		describe("#when trailing models match no tier", () => {
			test("#then keeps them last in original order (not shuffled)", () => {
				const input = [
					"qwen/qwen-b",
					"anthropic/claude-opus-4-6",
					"kimi-for-coding/k2p5",
					"qwen/qwen-a",
				]

				const first = sortModelsByPreference(input)
				const second = sortModelsByPreference(input)
				expect(first).toEqual([
					"anthropic/claude-opus-4-6",
					"qwen/qwen-b",
					"kimi-for-coding/k2p5",
					"qwen/qwen-a",
				])
				// Deterministic — never randomly shuffled
				expect(second).toEqual(first)
			})
		})

		describe("#when input contains duplicates", () => {
			test("#then de-duplicates keeping first occurrence", () => {
				expect(
					sortModelsByPreference([
						"openai/gpt-4o",
						"openai/gpt-4o",
						"anthropic/claude-opus-4-6",
					])
				).toEqual(["anthropic/claude-opus-4-6", "openai/gpt-4o"])
			})
		})

		describe("#when input is empty or single", () => {
			test("#then returns a copy unchanged", () => {
				expect(sortModelsByPreference([])).toEqual([])
				expect(sortModelsByPreference(["openai/gpt-4o"])).toEqual([
					"openai/gpt-4o",
				])
			})
		})
	})

	describe("#given collectAvailableModels", () => {
		describe("#when opencode config has providers, root model and agents", () => {
			test("#then collects every referenced model de-duplicated", () => {
				const config = {
					model: "anthropic/claude-opus-4-6",
					provider: {
						openai: {
							models: {
								"gpt-5.4": {},
								"gpt-4o": {},
							},
						},
						"muse-spark": {
							models: {
								"spark-1": {},
							},
						},
					},
					agents: {
						coder: {
							model: "kimi-for-coding/k2p5",
							fallback_models: ["openai/gpt-4o"],
						},
					},
				}

				expect(collectAvailableModels(config)).toEqual([
					"anthropic/claude-opus-4-6",
					"openai/gpt-5.4",
					"openai/gpt-4o",
					"muse-spark/spark-1",
					"kimi-for-coding/k2p5",
				])
			})
		})

		describe("#when provider models use already-qualified keys", () => {
			test("#then does not double-prefix them", () => {
				const config = {
					provider: {
						custom: {
							models: {
								"other-provider/some-model": {},
							},
						},
					},
				}

				expect(collectAvailableModels(config)).toEqual([
					"other-provider/some-model",
				])
			})
		})

		describe("#when a provider model is disabled", () => {
			test("#then skips it", () => {
				const config = {
					provider: {
						openai: {
							models: {
								"gpt-5.4": {},
								"gpt-4o": { disabled: true },
							},
						},
					},
				}

				expect(collectAvailableModels(config)).toEqual(["openai/gpt-5.4"])
			})
		})

		describe("#when a provider has a blacklist", () => {
			test("#then skips blacklisted models", () => {
				const config = {
					provider: {
						anthropic: {
							blacklist: ["claude-opus-4-20250514"],
							models: {
								"claude-opus-4-20250514": {},
								"claude-sonnet-4-6": {},
							},
						},
					},
				}

				expect(collectAvailableModels(config)).toEqual([
					"anthropic/claude-sonnet-4-6",
				])
			})
		})

		describe("#when a provider has a whitelist", () => {
			test("#then keeps only whitelisted models", () => {
				const config = {
					provider: {
						anthropic: {
							whitelist: ["claude-sonnet-4-6"],
							models: {
								"claude-opus-4-20250514": {},
								"claude-sonnet-4-6": {},
							},
						},
					},
				}

				expect(collectAvailableModels(config)).toEqual([
					"anthropic/claude-sonnet-4-6",
				])
			})
		})

		describe("#when config is empty", () => {
			test("#then returns empty array", () => {
				expect(collectAvailableModels({})).toEqual([])
			})
		})

		describe("#when provider/agent sections are malformed", () => {
			test("#then skips them without throwing", () => {
				expect(
					collectAvailableModels({
						provider: "not-an-object",
						agents: { broken: "not-an-object" },
						model: 42,
					} as any)
				).toEqual([])
			})
		})
	})

	describe("#given getFallbackModelsForSession with auto-discovery", () => {
		describe("#when no per-agent or global models exist but scan found models", () => {
			test("#then returns the auto-discovered chain", () => {
				const autoDiscovered = sortModelsByPreference([
					"qwen/qwen3-coder-30b",
					"deepseek/deepseek-chat",
					"openai/gpt-4o",
					"anthropic/claude-opus-4-6",
				])

				const result = getFallbackModelsForSession(
					"ses_123",
					undefined,
					undefined,
					[],
					autoDiscovered
				)

				expect(result).toEqual([
					"anthropic/claude-opus-4-6",
					"openai/gpt-4o",
					"deepseek/deepseek-chat",
					"qwen/qwen3-coder-30b",
				])
			})
		})

		describe("#when explicit global models exist alongside auto-discovered", () => {
			test("#then explicit config wins over auto-discovery", () => {
				const result = getFallbackModelsForSession(
					"ses_123",
					undefined,
					undefined,
					["openai/gpt-4o"],
					["anthropic/claude-opus-4-6", "openai/gpt-4o"]
				)

				expect(result).toEqual(["openai/gpt-4o"])
			})
		})

		describe("#when nothing is configured and nothing was discovered", () => {
			test("#then returns empty array", () => {
				expect(
					getFallbackModelsForSession("ses_123", undefined, undefined, [], [])
				).toEqual([])
			})
		})
	})
})
