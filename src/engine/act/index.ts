// Act station entry: runs every act generator for one surface and returns the
// structured results. Used by the CLI `answerable act` and by `answerable tick`; per-generator
// failures are notes, never a throw that kills the pass (generators enforce this).

import { generateToolSpecs, type ToolSpecResult } from "./tool-spec";
import { generateOutreachDrafts, type OutreachResult } from "./outreach";
import { generateBrandDefensePages, type BrandDefenseResult } from "./brand-defense";
import { generateComparisonPages, type ComparisonResult } from "./comparison";
import { generateAeoBlocks, type AeoBlocksResult } from "./aeo-blocks";
import { generateSurfaceFixSpecs, type FixSpecsResult } from "./fix-spec";

export interface ActResult {
  surfaceId: string;
  toolSpecs: ToolSpecResult;
  outreach: OutreachResult;
  brandDefense: BrandDefenseResult;
  comparison: ComparisonResult;
  aeoBlocks: AeoBlocksResult;
  // Technical/eligibility bets (hreflang, site-basics, bot-block, ssr) -> change specs.
  fixSpecs: FixSpecsResult;
}

export function act(surfaceId: string): ActResult {
  return {
    surfaceId,
    toolSpecs: generateToolSpecs(surfaceId),
    outreach: generateOutreachDrafts(surfaceId),
    brandDefense: generateBrandDefensePages(surfaceId),
    comparison: generateComparisonPages(surfaceId),
    aeoBlocks: generateAeoBlocks(surfaceId),
    fixSpecs: generateSurfaceFixSpecs(surfaceId),
  };
}
