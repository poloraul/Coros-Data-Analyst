const PROVIDERS = {};

function getApiKey(config) {
  return config.apiKey || process.env[config.apiKeyEnv || ""];
}

class AnthropicLLM {
  constructor(config) {
    this.config = config;
    this.model = config.model || "claude-sonnet-4-20250514";
    this.maxTokens = config.maxTokens || 4096;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    const apiKey = getApiKey(this.config);
    if (!apiKey) throw new Error(`Missing API key for Anthropic (set apiKey or ${this.config.apiKeyEnv || "ANTHROPIC_API_KEY"})`);
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    this._client = new Anthropic({ apiKey });
    return this._client;
  }

  async chat(systemPrompt, userPrompt) {
    const client = await this._getClient();
    const msg = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    return msg.content[0].text;
  }

  async chatJSON(systemPrompt, userPayload) {
    const text = await this.chat(
      systemPrompt + "\n\n请输出JSON格式。",
      typeof userPayload === "string" ? userPayload : JSON.stringify(userPayload, null, 2)
    );
    if (!text) return null;
    try { return JSON.parse(text); }
    catch {
      const first = text.indexOf("{");
      const last = text.lastIndexOf("}");
      if (first !== -1 && last > first) {
        try { return JSON.parse(text.slice(first, last + 1)); } catch {}
      }
      return null;
    }
  }
}

class OpenAICompatibleLLM {
  async chat(systemPrompt, userPrompt) {
    return this._call({ systemPrompt, userPrompt, jsonMode: false });
  }

  async chatJSON(systemPrompt, userPayload) {
    const result = await this._call({
      systemPrompt,
      userPrompt: typeof userPayload === "string" ? userPayload : JSON.stringify(userPayload, null, 2),
      jsonMode: false,
    });
    if (!result) return null;
    try { return JSON.parse(result); }
    catch {
      // Try markdown code block
      const codeMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeMatch) {
        try { return JSON.parse(codeMatch[1]); } catch {}
      }
      // Try extracting first { ... } block and repair common JSON errors
      let block = null;
      const first = result.indexOf("{");
      const last = result.lastIndexOf("}");
      if (first !== -1 && last > first) {
        block = result.slice(first, last + 1);
        try { return JSON.parse(block); } catch {}
      }
      // Last resort: use jsonrepair for robust JSON fixing
      if (block) {
        try {
          const { jsonrepair } = await import("jsonrepair");
          return JSON.parse(jsonrepair(block));
        } catch {}
      }
      return null;
    }
  }

  async _call({ systemPrompt, userPrompt, jsonMode }) {
    const client = await this._getClient();
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (jsonMode) params.response_format = { type: "json_object" };
    const resp = await client.chat.completions.create(params);
    const content = resp.choices?.[0]?.message?.content;
    if (!content && resp.choices?.[0]?.finish_reason === "error") {
      throw new Error(`LLM stopped with error`);
    }
    return content;
  }
}

class OpenAILLM extends OpenAICompatibleLLM {
  constructor(config) {
    super();
    this.config = config;
    this.model = config.model || "gpt-4o";
    this.maxTokens = config.maxTokens || 4096;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    const apiKey = getApiKey(this.config);
    if (!apiKey) throw new Error(`Missing API key for OpenAI (set apiKey or ${this.config.apiKeyEnv || "OPENAI_API_KEY"})`);
    const OpenAI = (await import("openai")).default;
    this._client = new OpenAI({ apiKey });
    return this._client;
  }
}

class QianfanLLM extends OpenAICompatibleLLM {
  constructor(config) {
    super();
    this.config = config;
    this.model = config.model || "deepseek-v4-pro";
    this.baseURL = config.baseURL || "https://qianfan.baidubce.com/v2/coding";
    this.maxTokens = config.maxTokens || 4096;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    const apiKey = getApiKey(this.config);
    if (!apiKey) throw new Error(`Missing API key for Qianfan (set apiKey or ${this.config.apiKeyEnv || "QIANFAN_API_KEY"})`);
    const OpenAI = (await import("openai")).default;
    this._client = new OpenAI({ apiKey, baseURL: this.baseURL });
    return this._client;
  }
}

class DeepseekLLM extends OpenAICompatibleLLM {
  constructor(config) {
    super();
    this.config = config;
    this.model = config.model || "deepseek-chat";
    this.baseURL = config.baseURL || "https://api.deepseek.com";
    this.maxTokens = config.maxTokens || 4096;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    const apiKey = getApiKey(this.config);
    if (!apiKey) throw new Error(`Missing API key for Deepseek (set apiKey or ${this.config.apiKeyEnv || "DEEPSEEK_API_KEY"})`);
    const OpenAI = (await import("openai")).default;
    this._client = new OpenAI({ apiKey, baseURL: this.baseURL });
    return this._client;
  }
}

PROVIDERS.anthropic = AnthropicLLM;
PROVIDERS.openai = OpenAILLM;
PROVIDERS.qianfan = QianfanLLM;
PROVIDERS.deepseek = DeepseekLLM;

function instantiateProvider(config) {
  const provider = config?.provider || "anthropic";
  const ProviderClass = PROVIDERS[provider];
  if (!ProviderClass) throw new Error(`Unknown LLM provider: ${provider}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  return new ProviderClass(config);
}

function isRateLimitError(e) {
  const msg = (e.message || "").toLowerCase();
  return e.status === 429 || msg.includes("rate") || msg.includes("limit") || msg.includes("quota") || msg.includes("配额") || msg.includes("throttl");
}

function isMissingKeyError(e) {
  const msg = (e.message || "").toLowerCase();
  return msg.includes("missing api key");
}

function shouldFallback(e) {
  return isRateLimitError(e) || isMissingKeyError(e);
}

export function createLLM(config) {
  const primary = instantiateProvider(config);

  if (!config.fallback) return primary;

  const fallback = instantiateProvider(config.fallback);

  return {
    async chat(systemPrompt, userPrompt) {
      try {
        return await primary.chat(systemPrompt, userPrompt);
      } catch (e) {
        if (shouldFallback(e)) {
          console.log(`  Primary LLM unavailable (${e.message.slice(0, 80)}), switching to fallback (${config.fallback.provider}/${config.fallback.model})...`);
          return fallback.chat(systemPrompt, userPrompt);
        }
        throw e;
      }
    },

    async chatJSON(systemPrompt, userPayload) {
      try {
        return await primary.chatJSON(systemPrompt, userPayload);
      } catch (e) {
        if (shouldFallback(e)) {
          console.log(`  Primary LLM unavailable (${e.message.slice(0, 80)}), switching to fallback (${config.fallback.provider}/${config.fallback.model})...`);
          return fallback.chatJSON(systemPrompt, userPayload);
        }
        throw e;
      }
    },
  };
}
