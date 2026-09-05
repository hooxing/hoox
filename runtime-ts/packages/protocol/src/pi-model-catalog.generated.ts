// 此文件由 scripts/generate-admin-pi-model-catalog.mjs 从精确锁定的 Pi 版本生成。
// 请勿手工修改；升级 Pi 后运行 pnpm admin:pi-catalog:generate。
import type { PiModelCatalogModelDto, PiModelCatalogProviderDto } from "./admin-control.js";
export const LOCAL_PI_MODEL_CATALOG_PROVIDERS: readonly PiModelCatalogProviderDto[] = [
  {
    "providerId": "ant-ling",
    "displayName": "Ant Ling",
    "baseUrl": "https://api.ant-ling.com/v1",
    "modelCount": 3
  },
  {
    "providerId": "cerebras",
    "displayName": "Cerebras",
    "baseUrl": "https://api.cerebras.ai/v1",
    "modelCount": 3
  },
  {
    "providerId": "cloudflare-ai-gateway",
    "displayName": "Cloudflare AI Gateway",
    "baseUrl": "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat",
    "modelCount": 5
  },
  {
    "providerId": "cloudflare-workers-ai",
    "displayName": "Cloudflare Workers AI",
    "baseUrl": "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    "modelCount": 13
  },
  {
    "providerId": "deepseek",
    "displayName": "DeepSeek",
    "baseUrl": "https://api.deepseek.com",
    "modelCount": 2
  },
  {
    "providerId": "fireworks",
    "displayName": "Fireworks",
    "baseUrl": "https://api.fireworks.ai/inference",
    "modelCount": 2
  },
  {
    "providerId": "github-copilot",
    "displayName": "GitHub Copilot",
    "baseUrl": "https://api.individual.githubcopilot.com",
    "modelCount": 7
  },
  {
    "providerId": "groq",
    "displayName": "Groq",
    "baseUrl": "https://api.groq.com/openai/v1",
    "modelCount": 7
  },
  {
    "providerId": "huggingface",
    "displayName": "Hugging Face",
    "baseUrl": "https://router.huggingface.co/v1",
    "modelCount": 50
  },
  {
    "providerId": "moonshotai",
    "displayName": "Moonshot AI",
    "baseUrl": "https://api.moonshot.ai/v1",
    "modelCount": 10
  },
  {
    "providerId": "moonshotai-cn",
    "displayName": "Moonshot AI CN",
    "baseUrl": "https://api.moonshot.cn/v1",
    "modelCount": 10
  },
  {
    "providerId": "nvidia",
    "displayName": "NVIDIA",
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "modelCount": 18
  },
  {
    "providerId": "opencode",
    "displayName": "OpenCode Zen",
    "baseUrl": "https://opencode.ai/zen/v1",
    "modelCount": 19
  },
  {
    "providerId": "opencode-go",
    "displayName": "OpenCode Zen Go",
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "modelCount": 12
  },
  {
    "providerId": "openrouter",
    "displayName": "OpenRouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "modelCount": 276
  },
  {
    "providerId": "qwen-token-plan",
    "displayName": "Qwen Token Plan",
    "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "modelCount": 15
  },
  {
    "providerId": "qwen-token-plan-cn",
    "displayName": "Qwen Token Plan CN",
    "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "modelCount": 15
  },
  {
    "providerId": "together",
    "displayName": "Together",
    "baseUrl": "https://api.together.ai/v1",
    "modelCount": 16
  },
  {
    "providerId": "xai",
    "displayName": "xAI",
    "baseUrl": "https://api.x.ai/v1",
    "modelCount": 2
  },
  {
    "providerId": "xiaomi",
    "displayName": "Xiaomi",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "modelCount": 6
  },
  {
    "providerId": "xiaomi-token-plan-ams",
    "displayName": "Xiaomi Token Plan AMS",
    "baseUrl": "https://token-plan-ams.xiaomimimo.com/v1",
    "modelCount": 3
  },
  {
    "providerId": "xiaomi-token-plan-cn",
    "displayName": "Xiaomi Token Plan CN",
    "baseUrl": "https://token-plan-cn.xiaomimimo.com/v1",
    "modelCount": 3
  },
  {
    "providerId": "xiaomi-token-plan-sgp",
    "displayName": "Xiaomi Token Plan SGP",
    "baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1",
    "modelCount": 3
  },
  {
    "providerId": "zai",
    "displayName": "Z.AI",
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "modelCount": 6
  },
  {
    "providerId": "zai-coding-cn",
    "displayName": "Z.AI Coding CN",
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "modelCount": 6
  }
];

export const LOCAL_PI_MODEL_CATALOG_MODELS: readonly PiModelCatalogModelDto[] = [
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/google/gemma-4-26b-a4b-it",
    "name": "Gemma 4 26B A4B IT",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 16384
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/ibm-granite/granite-4.0-h-micro",
    "name": "Granite 4.0 H Micro",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131000,
    "maxTokens": 131000
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "name": "Llama 3.3 70B Instruct fp8 Fast",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 24000,
    "maxTokens": 24000
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/meta/llama-4-scout-17b-16e-instruct",
    "name": "Llama 4 Scout 17B 16E Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131000,
    "maxTokens": 16384
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "name": "Mistral Small 3.1 24B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 128000
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/moonshotai/kimi-k2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 256000
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/moonshotai/kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/nvidia/nemotron-3-120b-a12b",
    "name": "Nemotron 3 Super 120B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 256000
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/openai/gpt-oss-120b",
    "name": "GPT OSS 120B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/openai/gpt-oss-20b",
    "name": "GPT OSS 20B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/qwen/qwen3-30b-a3b-fp8",
    "name": "Qwen3 30B A3b fp8",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 32768,
    "maxTokens": 32768
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/zai-org/glm-4.7-flash",
    "name": "GLM-4.7-Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "cloudflare-workers-ai",
    "providerName": "Cloudflare Workers AI",
    "id": "@cf/zai-org/glm-5.2",
    "name": "Glm 5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~anthropic/claude-fable-latest",
    "name": "Anthropic: Claude Fable Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~anthropic/claude-haiku-latest",
    "name": "Anthropic Claude Haiku Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 64000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~anthropic/claude-opus-latest",
    "name": "Anthropic: Claude Opus Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~anthropic/claude-sonnet-latest",
    "name": "Anthropic Claude Sonnet Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~google/gemini-flash-latest",
    "name": "Google Gemini Flash Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~google/gemini-pro-latest",
    "name": "Google Gemini Pro Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~moonshotai/kimi-latest",
    "name": "MoonshotAI Kimi Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~openai/gpt-latest",
    "name": "OpenAI GPT Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~openai/gpt-mini-latest",
    "name": "OpenAI GPT Mini Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "~x-ai/grok-latest",
    "name": "xAI: Grok Latest",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 500000,
    "maxTokens": 4096
  },
  {
    "providerId": "fireworks",
    "providerName": "Fireworks",
    "id": "accounts/fireworks/models/glm-5p2",
    "name": "GLM 5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048575,
    "maxTokens": 131072
  },
  {
    "providerId": "fireworks",
    "providerName": "Fireworks",
    "id": "accounts/fireworks/routers/glm-5p2-fast",
    "name": "GLM 5.2 Fast",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048575,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "ai21/jamba-large-1.7",
    "name": "AI21: Jamba Large 1.7",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "aion-labs/aion-2.0",
    "name": "AionLabs: Aion-2.0",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "aion-labs/aion-3.0",
    "name": "AionLabs: Aion-3.0",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "aion-labs/aion-3.0-mini",
    "name": "AionLabs: Aion-3.0-Mini",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "amazon/nova-2-lite-v1",
    "name": "Amazon: Nova 2 Lite",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65535
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "amazon/nova-lite-v1",
    "name": "Amazon: Nova Lite 1.0",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 300000,
    "maxTokens": 5120
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "amazon/nova-micro-v1",
    "name": "Amazon: Nova Micro 1.0",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 5120
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "amazon/nova-premier-v1",
    "name": "Amazon: Nova Premier 1.0",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 32000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "amazon/nova-pro-v1",
    "name": "Amazon: Nova Pro 1.0",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 300000,
    "maxTokens": 5120
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-3-haiku",
    "name": "Anthropic: Claude 3 Haiku",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-fable-5",
    "name": "Anthropic: Claude Fable 5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-haiku-4.5",
    "name": "Anthropic: Claude Haiku 4.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 64000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-4",
    "name": "Anthropic: Claude Opus 4",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 32000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-4.1",
    "name": "Anthropic: Claude Opus 4.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 32000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-4.5",
    "name": "Anthropic: Claude Opus 4.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 64000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-4.6",
    "name": "Anthropic: Claude Opus 4.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-4.7",
    "name": "Anthropic: Claude Opus 4.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-4.7-fast",
    "name": "Anthropic: Claude Opus 4.7 (Fast)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-4.8",
    "name": "Anthropic: Claude Opus 4.8",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-4.8-fast",
    "name": "Anthropic: Claude Opus 4.8 (Fast)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-5",
    "name": "Claude Opus 5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-opus-5-fast",
    "name": "Claude Opus 5 (Fast)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-sonnet-4",
    "name": "Anthropic: Claude Sonnet 4",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 64000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-sonnet-4.5",
    "name": "Anthropic: Claude Sonnet 4.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 64000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-sonnet-4.6",
    "name": "Anthropic: Claude Sonnet 4.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "anthropic/claude-sonnet-5",
    "name": "Anthropic: Claude Sonnet 5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "arcee-ai/trinity-large-thinking",
    "name": "Arcee AI: Trinity Large Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "arcee-ai/virtuoso-large",
    "name": "Arcee AI: Virtuoso Large",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 64000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "auto",
    "name": "Auto",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 2000000,
    "maxTokens": 30000
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "big-pickle",
    "name": "Big Pickle",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 32000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "bytedance-seed/seed-1.6",
    "name": "ByteDance Seed: Seed 1.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "bytedance-seed/seed-1.6-flash",
    "name": "ByteDance Seed: Seed 1.6 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "bytedance-seed/seed-2.0-lite",
    "name": "ByteDance Seed: Seed-2.0-Lite",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "bytedance-seed/seed-2.0-mini",
    "name": "ByteDance Seed: Seed-2.0-Mini",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 131072
  },
  {
    "providerId": "github-copilot",
    "providerName": "GitHub Copilot",
    "id": "claude-fable-5",
    "name": "Claude Fable 5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "cohere/command-r-08-2024",
    "name": "Cohere: Command R (08-2024)",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 4000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "cohere/command-r-plus-08-2024",
    "name": "Cohere: Command R+ (08-2024)",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 4000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "cohere/north-mini-code:free",
    "name": "Cohere: North Mini Code (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 64000
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "deepseek-ai/DeepSeek-R1",
    "name": "DeepSeek-R1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 64000,
    "maxTokens": 32768
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "deepseek-ai/DeepSeek-R1-0528",
    "name": "DeepSeek-R1-0528",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 163840,
    "maxTokens": 163840
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "deepseek-ai/DeepSeek-V3.2",
    "name": "DeepSeek-V3.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 163840,
    "maxTokens": 65536
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "deepseek-ai/DeepSeek-V4-Flash",
    "name": "DeepSeek V4 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 384000
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "deepseek-ai/DeepSeek-V4-Pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 393216
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "deepseek-ai/DeepSeek-V4-Pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 512000,
    "maxTokens": 384000
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "deepseek-v3.2",
    "name": "DeepSeek V3.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "deepseek-v3.2",
    "name": "DeepSeek V3.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 65536
  },
  {
    "providerId": "deepseek",
    "providerName": "DeepSeek",
    "id": "deepseek-v4-flash",
    "name": "DeepSeek V4 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "deepseek-v4-flash",
    "name": "DeepSeek V4 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "deepseek-v4-flash",
    "name": "DeepSeek V4 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "deepseek-v4-flash",
    "name": "DeepSeek V4 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "deepseek-v4-flash",
    "name": "DeepSeek V4 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "deepseek-v4-flash-free",
    "name": "DeepSeek V4 Flash Free",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 128000
  },
  {
    "providerId": "deepseek",
    "providerName": "DeepSeek",
    "id": "deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-chat",
    "name": "DeepSeek: DeepSeek V3",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 16000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-chat-v3-0324",
    "name": "DeepSeek: DeepSeek V3 0324",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 163840,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-chat-v3.1",
    "name": "DeepSeek: DeepSeek V3.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 163840,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-r1",
    "name": "DeepSeek: R1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 64000,
    "maxTokens": 16000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-r1-0528",
    "name": "DeepSeek: R1 0528",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 163840,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-v3.1-terminus",
    "name": "DeepSeek: DeepSeek V3.1 Terminus",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-v3.2",
    "name": "DeepSeek: DeepSeek V3.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 163840,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-v3.2-exp",
    "name": "DeepSeek: DeepSeek V3.2 Exp",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 163840,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-v4-flash",
    "name": "DeepSeek: DeepSeek V4 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048575,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "deepseek/deepseek-v4-pro",
    "name": "DeepSeek: DeepSeek V4 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 384000
  },
  {
    "providerId": "github-copilot",
    "providerName": "GitHub Copilot",
    "id": "gemini-2.5-pro",
    "name": "Gemini 2.5 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 64000
  },
  {
    "providerId": "github-copilot",
    "providerName": "GitHub Copilot",
    "id": "gemini-3-flash-preview",
    "name": "Gemini 3 Flash Preview",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 64000
  },
  {
    "providerId": "github-copilot",
    "providerName": "GitHub Copilot",
    "id": "gemini-3.1-pro-preview",
    "name": "Gemini 3.1 Pro Preview",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 64000
  },
  {
    "providerId": "github-copilot",
    "providerName": "GitHub Copilot",
    "id": "gemini-3.5-flash",
    "name": "Gemini 3.5 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 64000
  },
  {
    "providerId": "cerebras",
    "providerName": "Cerebras",
    "id": "gemma-4-31b",
    "name": "Gemma 4 31B IT",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 40960
  },
  {
    "providerId": "zai",
    "providerName": "Z.AI",
    "id": "glm-4.5-air",
    "name": "GLM-4.5-Air",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 98304
  },
  {
    "providerId": "zai-coding-cn",
    "providerName": "Z.AI Coding CN",
    "id": "glm-4.5-air",
    "name": "GLM-4.5-Air",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 98304
  },
  {
    "providerId": "zai",
    "providerName": "Z.AI",
    "id": "glm-4.7",
    "name": "GLM-4.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "zai-coding-cn",
    "providerName": "Z.AI Coding CN",
    "id": "glm-4.7",
    "name": "GLM-4.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "glm-5",
    "name": "GLM-5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "glm-5",
    "name": "GLM-5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 16384
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "glm-5",
    "name": "GLM-5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 16384
  },
  {
    "providerId": "zai",
    "providerName": "Z.AI",
    "id": "glm-5-turbo",
    "name": "GLM-5-Turbo",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 131072
  },
  {
    "providerId": "zai-coding-cn",
    "providerName": "Z.AI Coding CN",
    "id": "glm-5-turbo",
    "name": "GLM-5-Turbo",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "glm-5.1",
    "name": "GLM-5.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "glm-5.1",
    "name": "GLM-5.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 32768
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "glm-5.1",
    "name": "GLM-5.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 128000
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "glm-5.1",
    "name": "GLM-5.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 128000
  },
  {
    "providerId": "zai",
    "providerName": "Z.AI",
    "id": "glm-5.1",
    "name": "GLM-5.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 131072
  },
  {
    "providerId": "zai-coding-cn",
    "providerName": "Z.AI Coding CN",
    "id": "glm-5.1",
    "name": "GLM-5.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "zai",
    "providerName": "Z.AI",
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "zai-coding-cn",
    "providerName": "Z.AI Coding CN",
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "zai",
    "providerName": "Z.AI",
    "id": "glm-5v-turbo",
    "name": "GLM-5V-Turbo",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 131072
  },
  {
    "providerId": "zai-coding-cn",
    "providerName": "Z.AI Coding CN",
    "id": "glm-5v-turbo",
    "name": "GLM-5V-Turbo",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-2.5-flash",
    "name": "Google: Gemini 2.5 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65535
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-2.5-flash-lite",
    "name": "Google: Gemini 2.5 Flash Lite",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65535
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-2.5-pro",
    "name": "Google: Gemini 2.5 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-2.5-pro-preview",
    "name": "Google: Gemini 2.5 Pro Preview 06-05",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-2.5-pro-preview-05-06",
    "name": "Google: Gemini 2.5 Pro Preview 05-06",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65535
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-3-flash-preview",
    "name": "Google: Gemini 3 Flash Preview",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65535
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-3-pro-image",
    "name": "Google: Nano Banana Pro (Gemini 3 Pro Image)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 65536,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-3.1-flash-lite",
    "name": "Google: Gemini 3.1 Flash Lite",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-3.1-flash-lite-preview",
    "name": "Google: Gemini 3.1 Flash Lite Preview",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-3.1-pro-preview",
    "name": "Google: Gemini 3.1 Pro Preview",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-3.1-pro-preview-customtools",
    "name": "Google: Gemini 3.1 Pro Preview Custom Tools",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-3.5-flash",
    "name": "Google: Gemini 3.5 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-3.5-flash-lite",
    "name": "Google: Gemini 3.5 Flash Lite",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemini-3.6-flash",
    "name": "Google: Gemini 3.6 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemma-3-12b-it",
    "name": "Google: Gemma 3 12B",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemma-3-27b-it",
    "name": "Google: Gemma 3 27B",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemma-4-26b-a4b-it",
    "name": "Google: Gemma 4 26B A4B ",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "google/gemma-4-26B-A4B-it",
    "name": "Gemma 4 26B A4B IT",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemma-4-26b-a4b-it:free",
    "name": "Google: Gemma 4 26B A4B  (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemma-4-31b-it",
    "name": "Google: Gemma 4 31B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "google/gemma-4-31B-it",
    "name": "Gemma 4 31B IT",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "google/gemma-4-31B-it",
    "name": "Gemma 4 31B Instruct",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "google/gemma-4-31b-it:free",
    "name": "Google: Gemma 4 31B (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "github-copilot",
    "providerName": "GitHub Copilot",
    "id": "gpt-4.1",
    "name": "GPT-4.1",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "cerebras",
    "providerName": "Cerebras",
    "id": "gpt-oss-120b",
    "name": "GPT OSS 120B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 40960
  },
  {
    "providerId": "xai",
    "providerName": "xAI",
    "id": "grok-4.3",
    "name": "Grok 4.3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 30000
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "grok-build-0.1",
    "name": "Grok Build 0.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 256000
  },
  {
    "providerId": "xai",
    "providerName": "xAI",
    "id": "grok-build-0.1",
    "name": "Grok Build 0.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 256000
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "hy3",
    "name": "Hy3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 64000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "ibm-granite/granite-4.1-8b",
    "name": "IBM: Granite 4.1 8B",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "inception/mercury-2",
    "name": "Inception: Mercury 2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 50000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "inclusionai/ling-2.6-1t",
    "name": "inclusionAI: Ling-2.6-1T",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "inclusionai/ling-2.6-flash",
    "name": "inclusionAI: Ling-2.6-flash",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "inclusionai/ling-3.0-flash:free",
    "name": "Ling-3.0-flash (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "inclusionai/ring-2.6-1t",
    "name": "inclusionAI: Ring-2.6-1T",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k2-0711-preview",
    "name": "Kimi K2 0711",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 16384
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k2-0711-preview",
    "name": "Kimi K2 0711",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 16384
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k2-0905-preview",
    "name": "Kimi K2 0905",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k2-0905-preview",
    "name": "Kimi K2 0905",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k2-thinking",
    "name": "Kimi K2 Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k2-thinking",
    "name": "Kimi K2 Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k2-thinking-turbo",
    "name": "Kimi K2 Thinking Turbo",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k2-thinking-turbo",
    "name": "Kimi K2 Thinking Turbo",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k2-turbo-preview",
    "name": "Kimi K2 Turbo",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k2-turbo-preview",
    "name": "Kimi K2 Turbo",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k2.5",
    "name": "Kimi K2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k2.5",
    "name": "Kimi K2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "kimi-k2.5",
    "name": "Kimi K2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "kimi-k2.5",
    "name": "Kimi K2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 98304
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "kimi-k2.5",
    "name": "Kimi K2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 98304
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "kimi-k2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "kimi-k2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "kimi-k2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "kimi-k2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "github-copilot",
    "providerName": "GitHub Copilot",
    "id": "kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 32000
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k2.7-code-highspeed",
    "name": "Kimi K2.7 Code HighSpeed",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k2.7-code-highspeed",
    "name": "Kimi K2.7 Code HighSpeed",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "moonshotai",
    "providerName": "Moonshot AI",
    "id": "kimi-k3",
    "name": "Kimi K3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "moonshotai-cn",
    "providerName": "Moonshot AI CN",
    "id": "kimi-k3",
    "name": "Kimi K3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "kimi-k3",
    "name": "Kimi K3 (2x usage)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "kwaipilot/kat-coder-air-v2.5",
    "name": "Kwaipilot: KAT-Coder-Air V2.5",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 80000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "kwaipilot/kat-coder-pro-v2",
    "name": "Kwaipilot: KAT-Coder-Pro V2",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 80000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "kwaipilot/kat-coder-pro-v2.5",
    "name": "Kwaipilot: KAT-Coder-Pro V2.5",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 80000
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "laguna-s-2.1-free",
    "name": "Laguna S 2.1 Free",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 32000
  },
  {
    "providerId": "ant-ling",
    "providerName": "Ant Ling",
    "id": "Ling-2.6-1T",
    "name": "Ling 2.6 1T",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "ant-ling",
    "providerName": "Ant Ling",
    "id": "Ling-2.6-flash",
    "name": "Ling 2.6 Flash",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "ling-3.0-flash-free",
    "name": "Ling-3.0-flash Free",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "groq",
    "providerName": "Groq",
    "id": "llama-3.1-8b-instant",
    "name": "Llama 3.1 8B",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "groq",
    "providerName": "Groq",
    "id": "llama-3.3-70b-versatile",
    "name": "Llama 3.3 70B",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "meituan/longcat-2.0",
    "name": "Meituan: LongCat 2.0",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048756,
    "maxTokens": 262144
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "meta-llama/llama-3.1-70b-instruct",
    "name": "Meta: Llama 3.1 70B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "meta-llama/llama-3.1-8b-instruct",
    "name": "Meta: Llama 3.1 8B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "meta-llama/llama-3.3-70b-instruct",
    "name": "Meta: Llama 3.3 70B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 128000
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "meta-llama/Llama-3.3-70B-Instruct",
    "name": "Llama-3.3-70B-Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 4096
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    "name": "Llama 3.3 70B",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "meta-llama/llama-4-maverick",
    "name": "Meta: Llama 4 Maverick",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "meta-llama/llama-4-scout",
    "name": "Meta: Llama 4 Scout",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 327680,
    "maxTokens": 16384
  },
  {
    "providerId": "groq",
    "providerName": "Groq",
    "id": "meta-llama/llama-4-scout-17b-16e-instruct",
    "name": "Llama 4 Scout 17B 16E",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 8192
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "meta/llama-3.1-70b-instruct",
    "name": "Llama 3.1 70b Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 4096
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "meta/llama-3.1-8b-instruct",
    "name": "Llama 3.1 8B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 16000,
    "maxTokens": 4096
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "meta/llama-3.2-11b-vision-instruct",
    "name": "Llama 3.2 11b Vision Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 4096
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "meta/llama-3.2-90b-vision-instruct",
    "name": "Llama-3.2-90B-Vision-Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 8192
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "meta/llama-3.3-70b-instruct",
    "name": "Llama 3.3 70b Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "meta/muse-spark-1.1",
    "name": "Meta: Muse Spark 1.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 4096
  },
  {
    "providerId": "xiaomi",
    "providerName": "Xiaomi",
    "id": "mimo-v2-flash",
    "name": "MiMo-V2-Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "xiaomi",
    "providerName": "Xiaomi",
    "id": "mimo-v2-omni",
    "name": "MiMo-V2-Omni",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi",
    "providerName": "Xiaomi",
    "id": "mimo-v2-pro",
    "name": "MiMo-V2-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi-token-plan-ams",
    "providerName": "Xiaomi Token Plan AMS",
    "id": "mimo-v2-pro",
    "name": "MiMo-V2-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi-token-plan-cn",
    "providerName": "Xiaomi Token Plan CN",
    "id": "mimo-v2-pro",
    "name": "MiMo-V2-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi-token-plan-sgp",
    "providerName": "Xiaomi Token Plan SGP",
    "id": "mimo-v2-pro",
    "name": "MiMo-V2-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "mimo-v2.5",
    "name": "MiMo V2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "xiaomi",
    "providerName": "Xiaomi",
    "id": "mimo-v2.5",
    "name": "MiMo-V2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi-token-plan-ams",
    "providerName": "Xiaomi Token Plan AMS",
    "id": "mimo-v2.5",
    "name": "MiMo-V2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi-token-plan-cn",
    "providerName": "Xiaomi Token Plan CN",
    "id": "mimo-v2.5",
    "name": "MiMo-V2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi-token-plan-sgp",
    "providerName": "Xiaomi Token Plan SGP",
    "id": "mimo-v2.5",
    "name": "MiMo-V2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "mimo-v2.5-free",
    "name": "MiMo V2.5 Free",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 32000
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "mimo-v2.5-pro",
    "name": "MiMo V2.5 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 128000
  },
  {
    "providerId": "xiaomi",
    "providerName": "Xiaomi",
    "id": "mimo-v2.5-pro",
    "name": "MiMo-V2.5-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi-token-plan-ams",
    "providerName": "Xiaomi Token Plan AMS",
    "id": "mimo-v2.5-pro",
    "name": "MiMo-V2.5-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi-token-plan-cn",
    "providerName": "Xiaomi Token Plan CN",
    "id": "mimo-v2.5-pro",
    "name": "MiMo-V2.5-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi-token-plan-sgp",
    "providerName": "Xiaomi Token Plan SGP",
    "id": "mimo-v2.5-pro",
    "name": "MiMo-V2.5-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "xiaomi",
    "providerName": "Xiaomi",
    "id": "mimo-v2.5-pro-ultraspeed",
    "name": "MiMo-V2.5-Pro-UltraSpeed",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "minimax-m2.5",
    "name": "MiniMax-M2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "MiniMax-M2.5",
    "name": "MiniMax-M2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 196608,
    "maxTokens": 32768
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "MiniMax-M2.5",
    "name": "MiniMax-M2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 196608,
    "maxTokens": 32768
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "minimax-m2.7",
    "name": "MiniMax-M2.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "minimax-m2.7",
    "name": "MiniMax-M2.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "minimax-m3",
    "name": "MiniMax-M3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 512000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "minimax/minimax-m1",
    "name": "MiniMax: MiniMax M1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 40000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "minimax/minimax-m2",
    "name": "MiniMax: MiniMax M2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "minimax/minimax-m2.1",
    "name": "MiniMax: MiniMax M2.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "minimax/minimax-m2.5",
    "name": "MiniMax: MiniMax M2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 196608,
    "maxTokens": 196608
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "minimax/minimax-m2.7",
    "name": "MiniMax: MiniMax M2.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 196608,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "minimax/minimax-m3",
    "name": "MiniMax: MiniMax M3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 524288,
    "maxTokens": 512000
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "MiniMaxAI/MiniMax-M2",
    "name": "MiniMax-M2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 128000
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "MiniMaxAI/MiniMax-M2.1",
    "name": "MiniMax-M2.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "MiniMaxAI/MiniMax-M2.5",
    "name": "MiniMax-M2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "MiniMaxAI/MiniMax-M2.7",
    "name": "MiniMax-M2.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "MiniMaxAI/MiniMax-M2.7",
    "name": "MiniMax-M2.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 131072
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "minimaxai/minimax-m3",
    "name": "MiniMax-M3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 16384
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "MiniMaxAI/MiniMax-M3",
    "name": "MiniMax-M3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 524288,
    "maxTokens": 128000
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "MiniMaxAI/MiniMax-M3",
    "name": "MiniMax-M3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 524288,
    "maxTokens": 250000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/codestral-2508",
    "name": "Mistral: Codestral 2508",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/devstral-2512",
    "name": "Mistral: Devstral 2 2512",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/ministral-14b-2512",
    "name": "Mistral: Ministral 3 14B 2512",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/ministral-3b-2512",
    "name": "Mistral: Ministral 3 3B 2512",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/ministral-8b-2512",
    "name": "Mistral: Ministral 3 8B 2512",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-large",
    "name": "Mistral Large",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-large-2407",
    "name": "Mistral Large 2407",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-large-2512",
    "name": "Mistral: Mistral Large 3 2512",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-medium-3",
    "name": "Mistral: Mistral Medium 3",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-medium-3-5",
    "name": "Mistral: Mistral Medium 3.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-medium-3.1",
    "name": "Mistral: Mistral Medium 3.1",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-nemo",
    "name": "Mistral: Mistral Nemo",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-saba",
    "name": "Mistral: Saba",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 32768,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-small-2603",
    "name": "Mistral: Mistral Small 4",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mistral-small-3.2-24b-instruct",
    "name": "Mistral: Mistral Small 3.2 24B",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 4096
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "mistralai/mistral-small-4-119b-2603",
    "name": "mistral-small-4-119b-2603",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 8192
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/mixtral-8x22b-instruct",
    "name": "Mistral: Mixtral 8x22B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 65536,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "mistralai/voxtral-small-24b-2507",
    "name": "Mistral: Voxtral Small 24B 2507",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 32000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "moonshotai/kimi-k2",
    "name": "MoonshotAI: Kimi K2 0711",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 100352
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "moonshotai/kimi-k2-0905",
    "name": "MoonshotAI: Kimi K2 0905",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 100352
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "moonshotai/Kimi-K2-Instruct",
    "name": "Kimi-K2-Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 16384
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "moonshotai/Kimi-K2-Instruct-0905",
    "name": "Kimi-K2-Instruct-0905",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "moonshotai/kimi-k2-thinking",
    "name": "MoonshotAI: Kimi K2 Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 100352
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "moonshotai/Kimi-K2-Thinking",
    "name": "Kimi-K2-Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "moonshotai/kimi-k2.5",
    "name": "MoonshotAI: Kimi K2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "moonshotai/Kimi-K2.5",
    "name": "Kimi-K2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "moonshotai/kimi-k2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "moonshotai/kimi-k2.6",
    "name": "MoonshotAI: Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "moonshotai/Kimi-K2.6",
    "name": "Kimi-K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "moonshotai/Kimi-K2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 131000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "moonshotai/kimi-k2.7-code",
    "name": "MoonshotAI: Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "moonshotai/Kimi-K2.7-Code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "moonshotai/Kimi-K2.7-Code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "moonshotai/kimi-k3",
    "name": "MoonshotAI: Kimi K3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "nemotron-3-ultra-free",
    "name": "Nemotron 3 Ultra Free",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nex-agi/nex-n2-mini",
    "name": "Nex AGI: Nex-N2-Mini",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nex-agi/nex-n2-pro",
    "name": "Nex AGI: Nex-N2-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "opencode",
    "providerName": "OpenCode Zen",
    "id": "north-mini-code-free",
    "name": "North Mini Code Free",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 64000
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "nvidia/nemotron-3-nano-30b-a3b",
    "name": "nemotron-3-nano-30b-a3b",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nvidia/nemotron-3-nano-30b-a3b",
    "name": "NVIDIA: Nemotron 3 Nano 30B A3B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 228000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nvidia/nemotron-3-nano-30b-a3b:free",
    "name": "NVIDIA: Nemotron 3 Nano 30B A3B (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 4096
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "name": "Nemotron 3 Nano Omni",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "name": "NVIDIA: Nemotron 3 Nano Omni (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 65536
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "nvidia/nemotron-3-super-120b-a12b",
    "name": "Nemotron 3 Super",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nvidia/nemotron-3-super-120b-a12b",
    "name": "NVIDIA: Nemotron 3 Super",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nvidia/nemotron-3-super-120b-a12b:free",
    "name": "NVIDIA: Nemotron 3 Super (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "nvidia/nemotron-3-ultra-550b-a55b",
    "name": "Nemotron 3 Ultra 550B A55B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nvidia/nemotron-3-ultra-550b-a55b",
    "name": "NVIDIA: Nemotron 3 Ultra",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 512288,
    "maxTokens": 4096
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "nvidia/nemotron-3-ultra-550b-a55b",
    "name": "Nemotron 3 Ultra 550B A55B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 512300,
    "maxTokens": 512300
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nvidia/nemotron-3-ultra-550b-a55b:free",
    "name": "NVIDIA: Nemotron 3 Ultra (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nvidia/nemotron-nano-12b-v2-vl:free",
    "name": "NVIDIA: Nemotron Nano 12B 2 VL (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "nvidia/nemotron-nano-9b-v2:free",
    "name": "NVIDIA: Nemotron Nano 9B V2 (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 4096
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "nvidia/nvidia-nemotron-nano-9b-v2",
    "name": "nvidia-nemotron-nano-9b-v2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-3.5-turbo",
    "name": "OpenAI: GPT-3.5 Turbo",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 16385,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-3.5-turbo-0613",
    "name": "OpenAI: GPT-3.5 Turbo (older v0613)",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 4095,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-3.5-turbo-16k",
    "name": "OpenAI: GPT-3.5 Turbo 16k",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 16385,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4",
    "name": "OpenAI: GPT-4",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 8191,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4-turbo",
    "name": "OpenAI: GPT-4 Turbo",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4-turbo-preview",
    "name": "OpenAI: GPT-4 Turbo Preview",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4.1",
    "name": "OpenAI: GPT-4.1",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1047576,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4.1-mini",
    "name": "OpenAI: GPT-4.1 Mini",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1047576,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4.1-nano",
    "name": "OpenAI: GPT-4.1 Nano",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1047576,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4o",
    "name": "OpenAI: GPT-4o",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4o-2024-05-13",
    "name": "OpenAI: GPT-4o (2024-05-13)",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4o-2024-08-06",
    "name": "OpenAI: GPT-4o (2024-08-06)",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4o-2024-11-20",
    "name": "OpenAI: GPT-4o (2024-11-20)",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4o-mini",
    "name": "OpenAI: GPT-4o-mini",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-4o-mini-2024-07-18",
    "name": "OpenAI: GPT-4o-mini (2024-07-18)",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5",
    "name": "OpenAI: GPT-5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5-codex",
    "name": "OpenAI: GPT-5 Codex",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5-mini",
    "name": "OpenAI: GPT-5 Mini",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5-nano",
    "name": "OpenAI: GPT-5 Nano",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5-pro",
    "name": "OpenAI: GPT-5 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.1",
    "name": "OpenAI: GPT-5.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.1-chat",
    "name": "OpenAI: GPT-5.1 Chat",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.1-codex",
    "name": "OpenAI: GPT-5.1-Codex",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.1-codex-max",
    "name": "OpenAI: GPT-5.1-Codex-Max",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.1-codex-mini",
    "name": "OpenAI: GPT-5.1-Codex-Mini",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.2",
    "name": "OpenAI: GPT-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.2-chat",
    "name": "OpenAI: GPT-5.2 Chat",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.2-codex",
    "name": "OpenAI: GPT-5.2-Codex",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.2-pro",
    "name": "OpenAI: GPT-5.2 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.3-chat",
    "name": "OpenAI: GPT-5.3 Chat",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.3-codex",
    "name": "OpenAI: GPT-5.3-Codex",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.4",
    "name": "OpenAI: GPT-5.4",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.4-mini",
    "name": "OpenAI: GPT-5.4 Mini",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.4-nano",
    "name": "OpenAI: GPT-5.4 Nano",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.4-pro",
    "name": "OpenAI: GPT-5.4 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.5",
    "name": "OpenAI: GPT-5.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.5-pro",
    "name": "OpenAI: GPT-5.5 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.6-luna",
    "name": "OpenAI: GPT-5.6 Luna",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.6-luna-pro",
    "name": "OpenAI: GPT-5.6 Luna Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.6-sol",
    "name": "OpenAI: GPT-5.6 Sol",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.6-sol-pro",
    "name": "OpenAI: GPT-5.6 Sol Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.6-terra",
    "name": "OpenAI: GPT-5.6 Terra",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-5.6-terra-pro",
    "name": "OpenAI: GPT-5.6 Terra Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1050000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-audio",
    "name": "OpenAI: GPT Audio",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-audio-mini",
    "name": "OpenAI: GPT Audio Mini",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-chat-latest",
    "name": "OpenAI: GPT Chat Latest",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 400000,
    "maxTokens": 128000
  },
  {
    "providerId": "groq",
    "providerName": "Groq",
    "id": "openai/gpt-oss-120b",
    "name": "GPT OSS 120B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 65536
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "openai/gpt-oss-120b",
    "name": "GPT OSS 120B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "openai/gpt-oss-120b",
    "name": "GPT-OSS-120B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 8192
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-oss-120b",
    "name": "OpenAI: gpt-oss-120b",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "openai/gpt-oss-120b",
    "name": "GPT OSS 120B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "groq",
    "providerName": "Groq",
    "id": "openai/gpt-oss-20b",
    "name": "GPT OSS 20B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 65536
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "openai/gpt-oss-20b",
    "name": "GPT OSS 20B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "openai/gpt-oss-20b",
    "name": "GPT OSS 20B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-oss-20b",
    "name": "OpenAI: gpt-oss-20b",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "openai/gpt-oss-20b",
    "name": "GPT OSS 20B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-oss-20b:free",
    "name": "OpenAI: gpt-oss-20b (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "groq",
    "providerName": "Groq",
    "id": "openai/gpt-oss-safeguard-20b",
    "name": "Safety GPT OSS 20B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/gpt-oss-safeguard-20b",
    "name": "OpenAI: gpt-oss-safeguard-20b",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/o1",
    "name": "OpenAI: o1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/o3",
    "name": "OpenAI: o3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/o3-deep-research",
    "name": "OpenAI: o3 Deep Research",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/o3-mini",
    "name": "OpenAI: o3 Mini",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/o3-mini-high",
    "name": "OpenAI: o3 Mini High",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/o3-pro",
    "name": "OpenAI: o3 Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/o4-mini",
    "name": "OpenAI: o4 Mini",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/o4-mini-deep-research",
    "name": "OpenAI: o4 Mini Deep Research",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openai/o4-mini-high",
    "name": "OpenAI: o4 Mini High",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 100000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openrouter/auto",
    "name": "Auto Router",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 2000000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openrouter/auto-beta",
    "name": "Auto Router (Beta)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 2000000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openrouter/free",
    "name": "Free Models Router",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 200000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "openrouter/fusion",
    "name": "OpenRouter: Fusion",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 30000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "poolside/laguna-m.1",
    "name": "Poolside: Laguna M.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "poolside/laguna-m.1:free",
    "name": "Poolside: Laguna M.1 (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "poolside/laguna-s-2.1",
    "name": "Poolside: Laguna S 2.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "poolside/laguna-s-2.1:free",
    "name": "Poolside: Laguna S 2.1 (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "poolside/laguna-xs-2.1",
    "name": "Poolside: Laguna XS 2.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "poolside/laguna-xs-2.1:free",
    "name": "Poolside: Laguna XS 2.1 (free)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen-2.5-72b-instruct",
    "name": "Qwen2.5 72B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 32768,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen-2.5-7b-instruct",
    "name": "Qwen: Qwen2.5 7B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 32768,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen-plus",
    "name": "Qwen: Qwen-Plus",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen-plus-2025-07-28",
    "name": "Qwen: Qwen Plus 0728",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen-plus-2025-07-28:thinking",
    "name": "Qwen: Qwen Plus 0728 (thinking)",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "Qwen/Qwen2.5-7B-Instruct-Turbo",
    "name": "Qwen 2.5 7B Instruct Turbo",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 32768,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-14b",
    "name": "Qwen: Qwen3 14B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 8192
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-235b-a22b",
    "name": "Qwen: Qwen3 235B A22B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 8192
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3-235B-A22B",
    "name": "Qwen3 235B-A22B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 40960,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-235b-a22b-2507",
    "name": "Qwen: Qwen3 235B A22B Instruct 2507",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-235b-a22b-thinking-2507",
    "name": "Qwen: Qwen3 235B A22B Thinking 2507",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3-235B-A22B-Thinking-2507",
    "name": "Qwen3-235B-A22B-Thinking-2507",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-30b-a3b",
    "name": "Qwen: Qwen3 30B A3B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 8192
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-30b-a3b-instruct-2507",
    "name": "Qwen: Qwen3 30B A3B Instruct 2507",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-30b-a3b-thinking-2507",
    "name": "Qwen: Qwen3 30B A3B Thinking 2507",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 81920,
    "maxTokens": 32768
  },
  {
    "providerId": "groq",
    "providerName": "Groq",
    "id": "qwen/qwen3-32b",
    "name": "Qwen3-32B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 40960
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-32b",
    "name": "Qwen: Qwen3 32B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 40960,
    "maxTokens": 16384
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3-32B",
    "name": "Qwen3 32B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-8b",
    "name": "Qwen: Qwen3 8B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 8192
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-coder",
    "name": "Qwen: Qwen3 Coder 480B A35B",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-coder-30b-a3b-instruct",
    "name": "Qwen: Qwen3 Coder 30B A3B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 160000,
    "maxTokens": 32768
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    "name": "Qwen3-Coder 30B-A3B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "name": "Qwen3-Coder-480B-A35B-Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 66536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-coder-flash",
    "name": "Qwen: Qwen3 Coder Flash",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-coder-next",
    "name": "Qwen: Qwen3 Coder Next",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3-Coder-Next",
    "name": "Qwen3-Coder-Next",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-coder-plus",
    "name": "Qwen: Qwen3 Coder Plus",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-max",
    "name": "Qwen: Qwen3 Max",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-max-thinking",
    "name": "Qwen: Qwen3 Max Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-next-80b-a3b-instruct",
    "name": "Qwen: Qwen3 Next 80B A3B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3-Next-80B-A3B-Instruct",
    "name": "Qwen3-Next-80B-A3B-Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 66536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-next-80b-a3b-thinking",
    "name": "Qwen: Qwen3 Next 80B A3B Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3-Next-80B-A3B-Thinking",
    "name": "Qwen3-Next-80B-A3B-Thinking",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-vl-235b-a22b-instruct",
    "name": "Qwen: Qwen3 VL 235B A22B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-vl-235b-a22b-thinking",
    "name": "Qwen: Qwen3 VL 235B A22B Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-vl-30b-a3b-instruct",
    "name": "Qwen: Qwen3 VL 30B A3B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-vl-30b-a3b-thinking",
    "name": "Qwen: Qwen3 VL 30B A3B Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-vl-32b-instruct",
    "name": "Qwen: Qwen3 VL 32B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-vl-8b-instruct",
    "name": "Qwen: Qwen3 VL 8B Instruct",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3-vl-8b-thinking",
    "name": "Qwen: Qwen3 VL 8B Thinking",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.5-122b-a10b",
    "name": "Qwen: Qwen3.5-122B-A10B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3.5-122B-A10B",
    "name": "Qwen3.5 122B-A10B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.5-27b",
    "name": "Qwen: Qwen3.5-27B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3.5-27B",
    "name": "Qwen3.5 27B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.5-35b-a3b",
    "name": "Qwen: Qwen3.5-35B-A3B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3.5-35B-A3B",
    "name": "Qwen3.5 35B-A3B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.5-397b-a17b",
    "name": "Qwen: Qwen3.5 397B A17B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3.5-397B-A17B",
    "name": "Qwen3.5-397B-A17B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.5-9b",
    "name": "Qwen: Qwen3.5-9B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3.5-9B",
    "name": "Qwen3.5 9B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "Qwen/Qwen3.5-9B",
    "name": "Qwen3.5 9B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.5-flash-02-23",
    "name": "Qwen: Qwen3.5-Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.5-plus-02-15",
    "name": "Qwen: Qwen3.5 Plus 2026-02-15",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.5-plus-20260420",
    "name": "Qwen: Qwen3.5 Plus 2026-04-20",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.6-27b",
    "name": "Qwen: Qwen3.6 27B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3.6-27B",
    "name": "Qwen3.6 27B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.6-35b-a3b",
    "name": "Qwen: Qwen3.6 35B A3B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "Qwen/Qwen3.6-35B-A3B",
    "name": "Qwen3.6 35B-A3B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.6-flash",
    "name": "Qwen: Qwen3.6 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.6-max-preview",
    "name": "Qwen: Qwen3.6 Max Preview",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.6-plus",
    "name": "Qwen: Qwen3.6 Plus",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "Qwen/Qwen3.6-Plus",
    "name": "Qwen3.6 Plus",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 500000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.7-max",
    "name": "Qwen: Qwen3.7 Max",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "Qwen/Qwen3.7-Max",
    "name": "Qwen3.7 Max",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 500000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "qwen/qwen3.7-plus",
    "name": "Qwen: Qwen3.7 Plus",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "qwen3.6-flash",
    "name": "Qwen3.6 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "qwen3.6-flash",
    "name": "Qwen3.6 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "opencode-go",
    "providerName": "OpenCode Zen Go",
    "id": "qwen3.6-plus",
    "name": "Qwen3.6 Plus",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "qwen3.6-plus",
    "name": "Qwen3.6 Plus",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "qwen3.6-plus",
    "name": "Qwen3.6 Plus",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "qwen3.7-max",
    "name": "Qwen3.7 Max",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "qwen3.7-max",
    "name": "Qwen3.7 Max",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "qwen3.7-plus",
    "name": "Qwen3.7 Plus",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "qwen3.7-plus",
    "name": "Qwen3.7 Plus",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "providerId": "qwen-token-plan",
    "providerName": "Qwen Token Plan",
    "id": "qwen3.8-max-preview",
    "name": "Qwen3.8 Max Preview",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "qwen-token-plan-cn",
    "providerName": "Qwen Token Plan CN",
    "id": "qwen3.8-max-preview",
    "name": "Qwen3.8 Max Preview",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "rekaai/reka-edge",
    "name": "Reka Edge",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 16384,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "relace/relace-search",
    "name": "Relace: Relace Search",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 128000
  },
  {
    "providerId": "ant-ling",
    "providerName": "Ant Ling",
    "id": "Ring-2.6-1T",
    "name": "Ring 2.6 1T",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "sakana/fugu-ultra",
    "name": "Sakana: Fugu Ultra",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "sao10k/l3.1-euryale-70b",
    "name": "Sao10K: Llama 3.1 Euryale 70B v2.2",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 16384
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "stepfun-ai/step-3.5-flash",
    "name": "Step 3.5 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 16384
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "stepfun-ai/Step-3.5-Flash",
    "name": "Step 3.5 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 256000
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "stepfun-ai/step-3.7-flash",
    "name": "Step 3.7 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 16384
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "stepfun-ai/Step-3.7-Flash",
    "name": "Step 3.7 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 262144,
    "maxTokens": 256000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "stepfun/step-3.5-flash",
    "name": "StepFun: Step 3.5 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 65536
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "stepfun/step-3.7-flash",
    "name": "StepFun: Step 3.7 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 256000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "tencent/hy3",
    "name": "Tencent: Hy3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 128000
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "tencent/hy3-preview",
    "name": "Tencent: Hy3 preview",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "thedrummer/unslopnemo-12b",
    "name": "TheDrummer: UnslopNemo 12B",
    "api": "openai-completions",
    "reasoning": false,
    "input": [
      "text"
    ],
    "contextWindow": 32768,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "thinkingmachines/inkling",
    "name": "Thinking Machines: Inkling",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 524288,
    "maxTokens": 4096
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "thinkingmachines/Inkling",
    "name": "Inkling",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 524288,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "upstage/solar-pro-3",
    "name": "Upstage: Solar Pro 3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 128000,
    "maxTokens": 4096
  },
  {
    "providerId": "cloudflare-ai-gateway",
    "providerName": "Cloudflare AI Gateway",
    "id": "workers-ai/@cf/moonshotai/kimi-k2.5",
    "name": "Kimi K2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 256000
  },
  {
    "providerId": "cloudflare-ai-gateway",
    "providerName": "Cloudflare AI Gateway",
    "id": "workers-ai/@cf/moonshotai/kimi-k2.6",
    "name": "Kimi K2.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 256000
  },
  {
    "providerId": "cloudflare-ai-gateway",
    "providerName": "Cloudflare AI Gateway",
    "id": "workers-ai/@cf/nvidia/nemotron-3-120b-a12b",
    "name": "Nemotron 3 Super 120B",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 256000,
    "maxTokens": 256000
  },
  {
    "providerId": "cloudflare-ai-gateway",
    "providerName": "Cloudflare AI Gateway",
    "id": "workers-ai/@cf/zai-org/glm-4.7-flash",
    "name": "GLM-4.7-Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 131072
  },
  {
    "providerId": "cloudflare-ai-gateway",
    "providerName": "Cloudflare AI Gateway",
    "id": "workers-ai/@cf/zai-org/glm-5.2",
    "name": "Glm 5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 262144
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "x-ai/grok-4.20",
    "name": "xAI: Grok 4.20",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 2000000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "x-ai/grok-4.3",
    "name": "xAI: Grok 4.3",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1000000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "x-ai/grok-4.5",
    "name": "xAI: Grok 4.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 500000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "x-ai/grok-build-0.1",
    "name": "xAI: Grok Build 0.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 256000,
    "maxTokens": 4096
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "xiaomi/mimo-v2.5",
    "name": "Xiaomi: MiMo-V2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "xiaomi/mimo-v2.5-pro",
    "name": "Xiaomi: MiMo-V2.5-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "XiaomiMiMo/MiMo-V2-Flash",
    "name": "MiMo-V2-Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 4096
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "XiaomiMiMo/MiMo-V2.5",
    "name": "MiMo-V2.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 131072
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "XiaomiMiMo/MiMo-V2.5-Pro",
    "name": "MiMo-V2.5-Pro",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-4.5",
    "name": "Z.ai: GLM 4.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 98304
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-4.5-air",
    "name": "Z.ai: GLM 4.5 Air",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 98304
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-4.5v",
    "name": "Z.ai: GLM 4.5V",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 65536,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-4.6",
    "name": "Z.ai: GLM 4.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-4.6v",
    "name": "Z.ai: GLM 4.6V",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 131072,
    "maxTokens": 32768
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-4.7",
    "name": "Z.ai: GLM 4.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-4.7-flash",
    "name": "Z.ai: GLM 4.7 Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 16384
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-5",
    "name": "Z.ai: GLM 5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-5-turbo",
    "name": "Z.ai: GLM 5 Turbo",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-5.1",
    "name": "Z.ai: GLM 5.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 128000
  },
  {
    "providerId": "nvidia",
    "providerName": "NVIDIA",
    "id": "z-ai/glm-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1000000,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-5.2",
    "name": "Z.ai: GLM 5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 1048576,
    "maxTokens": 131072
  },
  {
    "providerId": "openrouter",
    "providerName": "OpenRouter",
    "id": "z-ai/glm-5v-turbo",
    "name": "Z.ai: GLM 5V Turbo",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 202752,
    "maxTokens": 131072
  },
  {
    "providerId": "cerebras",
    "providerName": "Cerebras",
    "id": "zai-glm-4.7",
    "name": "Z.AI GLM-4.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 40960
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "zai-org/GLM-4.5",
    "name": "GLM-4.5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 98304
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "zai-org/GLM-4.5-Air",
    "name": "GLM-4.5-Air",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 131072,
    "maxTokens": 98304
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "zai-org/GLM-4.5V",
    "name": "GLM-4.5V",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "contextWindow": 65536,
    "maxTokens": 16384
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "zai-org/GLM-4.6",
    "name": "GLM-4.6",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "zai-org/GLM-4.7",
    "name": "GLM-4.7",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 204800,
    "maxTokens": 131072
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "zai-org/GLM-4.7-Flash",
    "name": "GLM-4.7-Flash",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 200000,
    "maxTokens": 128000
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "zai-org/GLM-5",
    "name": "GLM-5",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 131072
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "zai-org/GLM-5.1",
    "name": "GLM-5.1",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 202752,
    "maxTokens": 131072
  },
  {
    "providerId": "huggingface",
    "providerName": "Hugging Face",
    "id": "zai-org/GLM-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 131072
  },
  {
    "providerId": "together",
    "providerName": "Together",
    "id": "zai-org/GLM-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "reasoning": true,
    "input": [
      "text"
    ],
    "contextWindow": 262144,
    "maxTokens": 164000
  }
];
