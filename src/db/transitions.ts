// Application-level bet lifecycle guards (directed and verified, never autonomous:
// go-live and outcome are separate checks):
// placed -> shipped -> exec-verified -> outcome-assessed -> settled, plus the single
// off-ramp placed -> cancelled (terminal). Each forward
// transition requires the prior state AND the timestamp evidence that state claims to
// carry (exec-verified requires shipped_at; settled requires outcome_assessed_at).
// Used by the publish / verify / settle paths; matching SQLite CHECK constraints live in
// schema.ts. No triggers, no key redesign: a violated transition throws here, loudly.

export type BetState =
  | "placed"
  | "shipped"
  | "exec-verified"
  | "outcome-assessed"
  | "settled"
  | "cancelled";

export interface TransitionableBet {
  id: string;
  state: BetState;
  shippedAt: number | null;
  outcomeAssessedAt: number | null;
}

// `cancelled` is the one off-ramp: only a placed bet can take it (anything shipped is
// already in the world and is judged, not cancelled), and nothing leaves it. It carries
// no timestamp evidence of its own beyond the reason recorded on the row.
const PREDECESSOR: Record<BetState, BetState | null> = {
  placed: null,
  cancelled: "placed",
  shipped: "placed",
  "exec-verified": "shipped",
  "outcome-assessed": "exec-verified",
  settled: "outcome-assessed",
};

export function assertTransition(bet: TransitionableBet, to: BetState): void {
  const from = PREDECESSOR[to];
  if (from === null) throw new Error(`bet ${bet.id}: "${to}" is not a transition target`);
  if (bet.state !== from) {
    throw new Error(`bet ${bet.id}: cannot move to "${to}" from "${bet.state}" (requires "${from}")`);
  }
  if ((to === "exec-verified" || to === "outcome-assessed") && bet.shippedAt === null) {
    throw new Error(`bet ${bet.id}: cannot move to "${to}" without shipped_at`);
  }
  if (to === "settled" && bet.outcomeAssessedAt === null) {
    throw new Error(`bet ${bet.id}: cannot settle without outcome_assessed_at`);
  }
}
