/**
 * Move grading: centipawn loss, win-percentage loss, and labels.
 *
 * All scores entering this module must already be in the mover's perspective
 * (positive = good for the player who just moved). Stockfish reports scores
 * in side-to-move perspective, so callers flip the post-move score first.
 *
 * Mate scores are never silently converted to a fixed centipawn number for
 * classification: a mate in 3 and a mate in 5 are both 100% won, so a
 * same-sign mate transition costs nothing, matching the spec.
 */
import type { Score } from "./stockfishClient";

export type MoveLabel =
  | "book"
  | "forced"
  | "brilliant"
  | "great"
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "missedWin";

export const MOVE_LABEL_VI: Record<MoveLabel, string> = {
  book: "Nước trong sách khai cuộc",
  forced: "Nước bắt buộc",
  brilliant: "Nước tuyệt vời !!",
  great: "Nước hay !",
  best: "Nước tốt nhất",
  excellent: "Rất tốt",
  good: "Tốt",
  inaccuracy: "Chưa chính xác ?!",
  mistake: "Sai lầm ?",
  blunder: "Sai lầm nghiêm trọng ??",
  missedWin: "Bỏ lỡ nước thắng",
};

/** Flip a score to the opponent's perspective. */
export function flipScore(score: Score): Score {
  return score.kind === "cp" ? { kind: "cp", cp: -score.cp } : { kind: "mate", mate: -score.mate };
}

/** Convert a Stockfish side-to-move score to White's perspective. */
export function toWhiteScore(score: Score, turn: "w" | "b"): Score {
  return turn === "w" ? score : flipScore(score);
}

/** Lichess-style win percentage for a score already in the mover's perspective. */
export function winPct(score: Score): number {
  if (score.kind === "mate") return score.mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * score.cp)) - 1);
}

/**
 * Approximate centipawn value used only for display / secondary guards.
 * Mate in N becomes 10000 - 100*N (same sign), so a longer mate still reads
 * as slightly worse without pretending a mate is worth a fixed pawn count.
 */
export function scoreToCpApprox(score: Score): number {
  return score.kind === "cp" ? score.cp : Math.sign(score.mate) * (10000 - 100 * Math.abs(score.mate));
}

export function formatScoreWhite(score: Score): string {
  if (score.kind === "mate") {
    return score.mate > 0 ? `#${score.mate}` : `-#${Math.abs(score.mate)}`;
  }
  const pawns = score.cp / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

export interface ClassifyInput {
  /** Best score at the pre-move position, mover's perspective. */
  best: Score;
  /** Score of the played move (post-move score, flipped), mover's perspective. */
  played: Score;
  /** Second-best score at the pre-move position, mover's perspective. */
  secondBest?: Score | null;
  bestUci: string | null;
  playedUci: string | null;
  legalMoveCount: number;
  isBook?: boolean;
  /** True when the moved piece is left en prise for at least a minor piece. */
  isSacrifice?: boolean;
}

export interface ClassifyResult {
  label: MoveLabel;
  /** Null when either side is a mate score (win% already captures it). */
  cpLoss: number | null;
  winPctLoss: number;
}

export function classifyMove(input: ClassifyInput): ClassifyResult {
  const bestWin = winPct(input.best);
  const playedWin = winPct(input.played);
  const winPctLoss = Math.max(0, bestWin - playedWin);
  const cpLoss =
    input.best.kind === "cp" && input.played.kind === "cp"
      ? Math.max(0, input.best.cp - input.played.cp)
      : null;

  if (input.isBook) return { label: "book", cpLoss, winPctLoss };
  if (input.legalMoveCount <= 1) return { label: "forced", cpLoss, winPctLoss };

  const isBest = input.bestUci !== null && input.playedUci === input.bestUci;
  const alreadyCrushing = bestWin >= 95;
  if (isBest && input.isSacrifice && !alreadyCrushing) {
    return { label: "brilliant", cpLoss, winPctLoss };
  }
  if (isBest) {
    const secondWin = input.secondBest ? winPct(input.secondBest) : null;
    const gapCp =
      input.best.kind === "cp" && input.secondBest?.kind === "cp"
        ? input.best.cp - input.secondBest.cp
        : null;
    if ((gapCp !== null && gapCp >= 200) || (secondWin !== null && bestWin - secondWin >= 20)) {
      return { label: "great", cpLoss, winPctLoss };
    }
    return { label: "best", cpLoss, winPctLoss };
  }
  // A clearly winning position (or forced mate) thrown away.
  if (bestWin >= 90 && winPctLoss >= 20) return { label: "missedWin", cpLoss, winPctLoss };
  // A losing position rescued back to equality counts as a great move even
  // when it is not the engine's first choice.
  if (bestWin <= 10 && playedWin >= 45) return { label: "great", cpLoss, winPctLoss };

  if (winPctLoss < 2 && (cpLoss === null || cpLoss < 50)) return { label: "excellent", cpLoss, winPctLoss };
  if (winPctLoss < 5 && (cpLoss === null || cpLoss < 100)) return { label: "good", cpLoss, winPctLoss };
  if (winPctLoss < 10) return { label: "inaccuracy", cpLoss, winPctLoss };
  if (winPctLoss < 20) return { label: "mistake", cpLoss, winPctLoss };
  return { label: "blunder", cpLoss, winPctLoss };
}

export interface TheoryRef {
  openingName?: string;
  eco?: string;
  tablebaseWdl?: number;
}

/**
 * Vietnamese explanation built ONLY from verified inputs. Nothing here
 * invents a variation, an opening name, or a strategic plan: every sentence
 * is either a number from the engine, a PV the engine actually gave, a
 * tactic tag computed from the position, or a theory reference from
 * Lichess. Callers must pass empty tags/refs rather than guessed ones.
 */
export function explainMove(input: {
  label: MoveLabel;
  playedSan: string;
  bestSan: string | null;
  bestPvSans: string[];
  cpLoss: number | null;
  winPctLoss: number;
  tacticTags: string[];
  theory: TheoryRef;
}): string {
  const parts: string[] = [];
  parts.push(`${MOVE_LABEL_VI[input.label]}: ${input.playedSan}.`);
  if (input.cpLoss !== null) {
    parts.push(`Nước này mất khoảng ${input.cpLoss} centipawn (mất ${input.winPctLoss.toFixed(1)}% cơ hội thắng theo engine).`);
  } else if (input.winPctLoss > 0.5) {
    parts.push(`Nước này mất ${input.winPctLoss.toFixed(1)}% cơ hội thắng theo engine.`);
  }
  if (input.bestSan && input.label !== "best" && input.label !== "book") {
    const pv = input.bestPvSans.length > 0 ? ` (biến chính: ${input.bestPvSans.join(" ")})` : "";
    parts.push(`Nước tốt nhất theo engine là ${input.bestSan}${pv}.`);
  }
  if (input.theory.openingName) {
    parts.push(`Đây là nước trong khai cuộc ${input.theory.openingName}${input.theory.eco ? ` (${input.theory.eco})` : ""}.`);
  }
  if (input.theory.tablebaseWdl !== undefined) {
    const verdict =
      input.theory.tablebaseWdl === 2
        ? "thắng hoàn hảo"
        : input.theory.tablebaseWdl === 1
          ? "thắng với nước đi chính xác"
          : input.theory.tablebaseWdl === 0
            ? "hòa với nước đi chính xác"
            : input.theory.tablebaseWdl === -1
              ? "thua nếu đối phương đi chính xác"
              : "thua hoàn hảo";
    parts.push(`Theo tablebase tàn cuộc, vị trí này là ${verdict}.`);
  }
  if (input.tacticTags.length > 0) {
    parts.push(`Điểm chiến thuật đáng chú ý: ${input.tacticTags.join("; ")}.`);
  }
  return parts.join(" ");
}
