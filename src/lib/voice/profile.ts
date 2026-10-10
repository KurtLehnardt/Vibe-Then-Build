/**
 * Voice model.
 *
 * Not a fine-tune. The operator's own past posts are the training signal, and
 * the highest-engagement ones nearest the requested format are selected as
 * few-shot examples. This keeps the model swappable and runs on any local
 * model, which a fine-tune would not.
 */
export interface Sample {
  id: string;
  body: string;
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
}

export interface Scored extends Sample {
  /** Engagement per thousand impressions. Null when impressions are unknown. */
  engagementRate: number | null;
}

export function score(s: Sample): Scored {
  const interactions = (s.reactions ?? 0) + (s.comments ?? 0);
  const engagementRate =
    s.impressions && s.impressions > 0 ? (interactions / s.impressions) * 1000 : null;
  return { ...s, engagementRate };
}

/**
 * Picks few-shot examples.
 *
 * Samples with known engagement are ranked by it and always preferred; unrated
 * samples fill the remaining slots in their original order. Ranking unrated
 * samples as zero would push a brand-new operator's entire corpus to the back
 * and leave the prompt with no voice at all.
 */
export function selectExamples(samples: Sample[], limit = 5): Scored[] {
  const scored = samples.map(score);
  const rated = scored
    .filter((s) => s.engagementRate !== null)
    .sort((a, b) => b.engagementRate! - a.engagementRate!);
  const unrated = scored.filter((s) => s.engagementRate === null);
  return [...rated, ...unrated].slice(0, limit);
}

export interface VoicePromptInput {
  wedgeStatement: string | null;
  examples: Scored[];
  format: string;
  idea: string;
  /** Only verified proof may be cited as a number. */
  verifiedProof: string[];
}

export function buildDraftPrompt(input: VoicePromptInput): {
  system: string;
  user: string;
} {
  const examples = input.examples
    .map((e, i) => `--- Example ${i + 1} ---\n${e.body}`)
    .join("\n\n");

  const system = [
    "You draft social posts in the operator's own voice.",
    "Match the sentence length, rhythm, punctuation habits, and line breaks of the examples.",
    "Do not invent numbers, client names, or results. Use only the verified proof supplied.",
    "If the idea needs a number that is not supplied, write the sentence without one.",
    input.wedgeStatement ? `The operator's positioning: ${input.wedgeStatement}` : "",
    examples ? `Voice examples:\n\n${examples}` : "No voice examples imported yet; write plainly.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const proof = input.verifiedProof.length
    ? `Verified proof you may cite:\n${input.verifiedProof.map((p) => `- ${p}`).join("\n")}`
    : "No verified proof is available, so cite none.";

  const user = `Format: ${input.format}\n\nIdea:\n${input.idea}\n\n${proof}`;

  return { system, user };
}
