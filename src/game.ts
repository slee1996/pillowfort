export type RpsPick = "rock" | "paper" | "scissors";

export const RPS_PICKS: RpsPick[] = ["rock", "paper", "scissors"];
export const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

export function isRpsPick(value: unknown): value is RpsPick {
  return typeof value === "string" && RPS_PICKS.includes(value as RpsPick);
}

export function rpsWinner(p1: string, p2: string, pick1: RpsPick, pick2: RpsPick): string | null {
  if (pick1 === pick2) return null;
  const wins: Record<RpsPick, RpsPick> = { rock: "scissors", scissors: "paper", paper: "rock" };
  return wins[pick1] === pick2 ? p1 : p2;
}

export function tttWinner(board: string[], mark: string): boolean {
  return TTT_WINS.some((combo) => combo.every((i) => board[i] === mark));
}
