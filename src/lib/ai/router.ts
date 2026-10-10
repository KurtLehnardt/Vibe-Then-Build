/**
 * Model router.
 *
 * Every inference call names the job it is doing, not the model it wants.
 * The router maps jobs to models, prefers local inference, and escalates to a
 * frontier API only when one is configured and the job is marked "hard".
 *
 * With no cloud key present the system still works end to end: a hard job
 * falls back to the local drafting model and the fallback is recorded, so the
 * cost of running fully local is visible rather than hidden.
 */
export type Job = "draft" | "classify" | "enrich" | "embed" | "hard";

export interface RouteChoice {
  model: string;
  provider: "ollama" | "anthropic";
  /** Set when a hard job was served locally because no cloud key exists. */
  fellBackToLocal: boolean;
}

export interface RouterConfig {
  gatewayUrl: string;
  gatewayKey: string;
  drafting: string;
  classify: string;
  enrich: string;
  embed: string;
  hard: string | null;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  return {
    gatewayUrl: env.LLM_GATEWAY_URL ?? "http://localhost:4000",
    gatewayKey: env.LLM_GATEWAY_KEY ?? "sk-local-no-secret",
    drafting: env.MODEL_DRAFTING ?? "ollama/qwen3:14b",
    classify: env.MODEL_CLASSIFY ?? "ollama/qwen3:4b",
    enrich: env.MODEL_ENRICH ?? "ollama/qwen3:4b",
    embed: env.MODEL_EMBED ?? "ollama/nomic-embed-text",
    hard: env.MODEL_HARD && env.ANTHROPIC_API_KEY ? env.MODEL_HARD : null,
  };
}

export function route(job: Job, cfg: RouterConfig): RouteChoice {
  switch (job) {
    case "draft":
      return { model: cfg.drafting, provider: "ollama", fellBackToLocal: false };
    case "classify":
      return { model: cfg.classify, provider: "ollama", fellBackToLocal: false };
    case "enrich":
      return { model: cfg.enrich, provider: "ollama", fellBackToLocal: false };
    case "embed":
      return { model: cfg.embed, provider: "ollama", fellBackToLocal: false };
    case "hard":
      return cfg.hard
        ? { model: cfg.hard, provider: "anthropic", fellBackToLocal: false }
        : { model: cfg.drafting, provider: "ollama", fellBackToLocal: true };
  }
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: RouteChoice["provider"];
  tokensIn: number;
  tokensOut: number;
  fellBackToLocal: boolean;
}

/** Calls the gateway with an OpenAI-shaped request, which LiteLLM normalizes. */
export async function complete(
  job: Job,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  cfg: RouterConfig = configFromEnv(),
): Promise<CompletionResult> {
  const choice = route(job, cfg);

  const res = await fetch(`${cfg.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.gatewayKey}`,
    },
    body: JSON.stringify({ model: choice.model, messages }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `Inference gateway returned ${res.status} for model ${choice.model}. ` +
        `Check that LiteLLM and Ollama are running, then pull the model with ` +
        `"ollama pull ${choice.model.replace(/^ollama\//, "")}". Gateway said: ${detail}`,
    );
  }

  const body = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  return {
    text: body.choices[0]?.message.content ?? "",
    model: choice.model,
    provider: choice.provider,
    tokensIn: body.usage?.prompt_tokens ?? 0,
    tokensOut: body.usage?.completion_tokens ?? 0,
    fellBackToLocal: choice.fellBackToLocal,
  };
}
