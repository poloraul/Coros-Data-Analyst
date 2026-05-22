const PROVIDERS = {};

export function createLLM(config) {
  const provider = config?.provider || "anthropic";
  const ProviderClass = PROVIDERS[provider];
  if (!ProviderClass) throw new Error(`Unknown LLM provider: ${provider}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  return new ProviderClass(config);
}

class AnthropicLLM {
  constructor(config) {
    this.model = config.model || "claude-sonnet-4-20250514";
    this.apiKeyEnv = config.apiKeyEnv || "ANTHROPIC_API_KEY";
    this.maxTokens = config.maxTokens || 4096;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    const apiKey = process.env[this.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing ${this.apiKeyEnv} environment variable`);
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
}

class OpenAILLM {
  constructor(config) {
    this.model = config.model || "gpt-4o";
    this.apiKeyEnv = config.apiKeyEnv || "OPENAI_API_KEY";
    this.maxTokens = config.maxTokens || 4096;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    const apiKey = process.env[this.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing ${this.apiKeyEnv} environment variable`);
    const OpenAI = (await import("openai")).default;
    this._client = new OpenAI({ apiKey });
    return this._client;
  }

  async chat(systemPrompt, userPrompt) {
    const client = await this._getClient();
    const resp = await client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return resp.choices[0].message.content;
  }
}

class QianfanLLM {
  constructor(config) {
    this.model = config.model || "deepseek-v4-pro";
    this.apiKeyEnv = config.apiKeyEnv || "QIANFAN_API_KEY";
    this.baseURL = config.baseURL || "https://qianfan.baidubce.com/v2/coding";
    this.maxTokens = config.maxTokens || 4096;
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    const apiKey = process.env[this.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing ${this.apiKeyEnv} environment variable`);
    const OpenAI = (await import("openai")).default;
    this._client = new OpenAI({ apiKey, baseURL: this.baseURL });
    return this._client;
  }

  async chat(systemPrompt, userPrompt) {
    const client = await this._getClient();
    const resp = await client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return resp.choices[0].message.content;
  }
}

PROVIDERS.anthropic = AnthropicLLM;
PROVIDERS.openai = OpenAILLM;
PROVIDERS.qianfan = QianfanLLM;
