/**
 * Cost ledger.
 *
 * Local inference is priced at zero because no money leaves your account for
 * it. Electricity and hardware are real but belong in the hardware TCO model,
 * not in a per-call ledger, and mixing them here would make the per-engagement
 * margin number impossible to reconcile against a bank statement.
 *
 * Rates are dollars per million tokens and are configuration, not constants —
 * provider pricing changes, and a stale hard-coded rate silently corrupts
 * every margin report downstream.
 */
export interface Rate {
  inPerMillion: number;
  outPerMillion: number;
}

export const LOCAL_RATE: Rate = { inPerMillion: 0, outPerMillion: 0 };

export function costUsd(tokensIn: number, tokensOut: number, rate: Rate): number {
  const cost =
    (tokensIn / 1_000_000) * rate.inPerMillion + (tokensOut / 1_000_000) * rate.outPerMillion;
  // Six decimals matches the numeric(10,6) column; rounding here keeps the
  // value written and the value displayed identical.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function rateFor(provider: "ollama" | "anthropic", rates: Record<string, Rate>): Rate {
  if (provider === "ollama") return LOCAL_RATE;
  return rates[provider] ?? LOCAL_RATE;
}
