// Test model fixtures: shapes only, deliberately independent of the product's
// offline fallback (`staticModels` = the four tier aliases, catalog.ts).
//
// A suite that needs a model-named id states its own row here, so a product
// decision about the fallback can never silently rewrite what a wire test
// exercises. `Ultimate` and `Efficient` appear in both on purpose: a suite
// testing a tier may use the product row, but these fixtures stay stable either
// way.
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_CONTEXT_WINDOW,
  MODEL_PROMPT_CACHE,
  QODER_DEFAULT_MAX_OUTPUT_TOKENS,
  type QoderModelDef,
  toQoderModelId,
  ZERO_COST,
} from "../catalog.ts";
import { rateForUpstreamKey } from "../pricing.ts";
import { getQoderBaseUrl } from "../region.ts";

interface FixtureRow {
  name: string;
  upstreamKey: string;
  reasoning: boolean;
  supportsEffort?: boolean;
  vision?: boolean;
}

const ROWS: readonly FixtureRow[] = [
  { name: "Ultimate", upstreamKey: "ultimate", reasoning: true, supportsEffort: true, vision: true },
  { name: "Efficient", upstreamKey: "efficient", reasoning: false, vision: true },
  { name: "Lite", upstreamKey: "lite", reasoning: false },
  { name: "DeepSeek-V4-Flash", upstreamKey: "dfmodel", reasoning: true, supportsEffort: true, vision: true },
];

// Mirrors the mapping the product's static rows use, so a fixture model is
// shaped exactly like a registered one.
const FIXTURES: readonly QoderModelDef[] = ROWS.map((row) => ({
  id: toQoderModelId(row.name),
  upstreamKey: row.upstreamKey,
  name: row.name,
  api: "qoder-api",
  provider: "qoder",
  baseUrl: getQoderBaseUrl("global"),
  reasoning: row.reasoning,
  supportsEffort: row.supportsEffort ?? false,
  input: row.vision ? ["text", "image"] : ["text"],
  cost: rateForUpstreamKey(row.upstreamKey) ?? ZERO_COST,
  promptCache: MODEL_PROMPT_CACHE,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: QODER_DEFAULT_MAX_OUTPUT_TOKENS,
}));

/** One fixture model by pi-visible id. Throws, like the suite helpers it replaced. */
export function fixtureModel(id: string): Model<Api> {
  const found = FIXTURES.find((model) => model.id === id);
  if (!found) throw new Error(`model fixture missing: ${id} — add a row in src/__tests__/model-fixture.ts`);
  return found as Model<Api>;
}
