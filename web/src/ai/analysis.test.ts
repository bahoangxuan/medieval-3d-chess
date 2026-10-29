import { describe, expect, it } from "vitest";

import { classifyMove, flipScore, formatScoreWhite, winPct } from "./analysis";
import { parseBestmoveLine, parseUciInfoLine } from "./stockfishClient";
import { detectForksForMover, detectHangingForMover, pieceCount } from "./theory";

describe("UCI parsing", () => {
  it("parses a MultiPV info line with a centipawn score", () => {
    const line = parseUciInfoLine(
      "info depth 12 seldepth 19 multipv 2 score cp 25 nodes 70353 pv d2d4 d7d5 c2c4",
    );
    expect(line).toEqual({ multipv: 2, score: { kind: "cp", cp: 25 }, depth: 12, pv: ["d2d4", "d7d5", "c2c4"] });
  });

  it("parses a mate score", () => {
    const line = parseUciInfoLine("info depth 8 multipv 1 score mate 3 pv e2e4 e7e5");
    expect(line?.score).toEqual({ kind: "mate", mate: 3 });
  });

  it("ignores non-info lines and parses bestmove", () => {
    expect(parseUciInfoLine("uciok")).toBeNull();
    expect(parseBestmoveLine("bestmove e2e4 ponder e7e6")).toBe("e2e4");
    expect(parseBestmoveLine("bestmove (none)")).toBeNull();
  });

  it("ignores upperbound/lowerbound lines, which are not exact scores", () => {
    expect(parseUciInfoLine("info depth 12 multipv 1 score cp 25 upperbound pv d2d4")).toBeNull();
    expect(parseUciInfoLine("info depth 12 multipv 1 score cp 25 lowerbound pv d2d4")).toBeNull();
  });
});

describe("grading", () => {
  it("grades the engine's own best move as best", () => {
    const result = classifyMove({
      best: { kind: "cp", cp: 30 },
      played: { kind: "cp", cp: 30 },
      bestUci: "e2e4",
      playedUci: "e2e4",
      legalMoveCount: 20,
    });
    expect(result.label).toBe("best");
    expect(result.cpLoss).toBe(0);
  });

  it("grades a large win-percentage loss as a blunder", () => {
    const result = classifyMove({
      best: { kind: "cp", cp: 200 },
      played: { kind: "cp", cp: -200 },
      bestUci: "e2e4",
      playedUci: "d2d4",
      legalMoveCount: 20,
    });
    expect(result.label).toBe("blunder");
  });

  it("charges nothing for a same-sign mate transition", () => {
    const result = classifyMove({
      best: { kind: "mate", mate: 3 },
      played: { kind: "mate", mate: 5 },
      bestUci: "e2e4",
      playedUci: "d2d4",
      legalMoveCount: 20,
    });
    expect(result.winPctLoss).toBe(0);
    expect(result.label).not.toBe("blunder");
  });

  it("flips scores and formats mate correctly", () => {
    expect(flipScore({ kind: "cp", cp: 40 })).toEqual({ kind: "cp", cp: -40 });
    expect(formatScoreWhite({ kind: "mate", mate: 3 })).toBe("#3");
    expect(formatScoreWhite({ kind: "cp", cp: 123 })).toBe("+1.23");
    expect(winPct({ kind: "mate", mate: 1 })).toBe(100);
    expect(winPct({ kind: "cp", cp: 0 })).toBeCloseTo(50, 5);
  });
});

describe("position features", () => {
  it("counts pieces from a FEN", () => {
    expect(pieceCount("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBe(32);
    expect(pieceCount("4k3/8/8/8/8/8/8/3QK3 w - - 0 1")).toBe(3);
  });

  it("finds a hanging queen: white to move, black queen undefended on d5", () => {
    // White queen on d1, black queen on d5, kings far away. White can take
    // the queen and black has no recapture.
    const fen = "4k3/8/8/3q4/8/8/8/3QK3 w - - 0 1";
    const hanging = detectHangingForMover(fen);
    expect(hanging.some((label) => label.includes("d5"))).toBe(true);
  });

  it("finds a fork: white knight on d5 attacks black queen and rook", () => {
    // Knight d5 attacks e7 (queen) and c7 (rook). Kings are tucked away
    // (a1 / h8) so the knight is not forced to answer a check.
    const fen = "7k/2r1q3/8/3N4/8/8/8/K7 w - - 0 1";
    const forks = detectForksForMover(fen);
    expect(forks.length).toBeGreaterThan(0);
  });
});
