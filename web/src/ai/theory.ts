/**
 * Deterministic position features. No LLM, no guessing: every tag here is
 * computed from chess.js legal moves on the given FEN.
 *
 * A "hanging" piece is one the side to move can capture on the next move
 * with no recapture available. A "fork" is one piece that can capture two
 * enemy pieces (at least one worth a minor piece or more) on its next move.
 * These are deliberately conservative — a tag that cannot be computed is
 * omitted, never invented.
 */
import { Chess } from "chess.js";

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function pieceCount(fen: string): number {
  const board = fen.split(" ")[0];
  return [...board].filter((ch) => /[pnbrqkPNBRQK]/.test(ch)).length;
}

function pieceName(kind: string): string {
  return { p: "tốt", n: "mã", b: "tượng", r: "xe", q: "hậu", k: "vua" }[kind] ?? kind;
}

/** Squares the side to move can capture on, with the captured piece kind. */
function captureMoves(fen: string): { from: string; to: string; captured: string }[] {
  const chess = new Chess(fen);
  return (chess.moves({ verbose: true }) as { from: string; to: string; captured?: string }[])
    .filter((m) => Boolean(m.captured))
    .map((m) => ({ from: m.from, to: m.to, captured: m.captured as string }));
}

/**
 * Is the piece on `square` (belonging to the side NOT to move) capturable
 * with no recapture? Evaluated by playing each capture and checking whether
 * the new side to move can recapture that square.
 */
export function isEnPrise(fen: string, square: string): boolean {
  const captures = captureMoves(fen).filter((m) => m.to === square);
  if (captures.length === 0) return false;
  return captures.some((capture) => {
    const chess = new Chess(fen);
    chess.move({ from: capture.from, to: capture.to });
    const recaptures = captureMoves(chess.fen()).filter((m) => m.to === capture.to);
    return recaptures.length === 0;
  });
}

/**
 * Tags describing the move itself and the resulting position.
 * `fenAfter` is the position after the move (side to move = opponent);
 * `moveSan` carries the capture / castle / promotion markers.
 * Hanging and fork tags for the side to move in `fenAfter` come from
 * detectHangingForMover / detectForksForMover below — they describe what
 * the opponent can now do to the mover's pieces, which is exactly the
 * warning a player needs after a hanging move.
 */
export function detectTags(fenAfter: string, moveSan: string): string[] {
  const tags: string[] = [];
  const chess = new Chess(fenAfter);
  if (chess.isCheckmate()) tags.push("chiếu hết");
  else if (chess.isCheck()) tags.push("chiếu");
  if (/O-O/.test(moveSan)) tags.push("nhập thành");
  if (moveSan.includes("=")) tags.push("phong quân");
  else if (moveSan.includes("x")) tags.push("ăn quân");
  return tags;
}

/**
 * Hanging pieces for the player to move in `fen` (side to move = mover).
 * Returns labels like "hậu đen ở d5 đang treo".
 */
export function detectHangingForMover(fen: string): string[] {
  const chess = new Chess(fen);
  const mover = chess.turn();
  const opponent = mover === "w" ? "b" : "w";
  const board = chess.board();
  const out: string[] = [];
  for (const row of board) {
    for (const cell of row) {
      if (!cell || cell.color !== opponent) continue;
      if (isEnPrise(fen, cell.square)) {
        out.push(`${pieceName(cell.type)} ${opponent === "w" ? "trắng" : "đen"} ở ${cell.square} đang treo`);
      }
    }
  }
  return out;
}

/** Fork tags for the player to move in `fen`. */
export function detectForksForMover(fen: string): string[] {
  const captures = captureMoves(fen);
  const byFrom = new Map<string, { to: string; captured: string }[]>();
  for (const capture of captures) {
    const list = byFrom.get(capture.from) ?? [];
    list.push(capture);
    byFrom.set(capture.from, list);
  }
  const out: string[] = [];
  for (const [from, list] of byFrom) {
    const valuable = list.filter((c) => VALUE[c.captured] >= 3);
    if (list.length >= 2 && valuable.length >= 1) {
      out.push(`đòn đôi từ ${from} tấn công ${list.map((c) => c.to).join(", ")}`);
    }
  }
  return out;
}

/** Material balance (White perspective, pawns) for a FEN. */
export function materialBalance(fen: string): number {
  const chess = new Chess(fen);
  let total = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      total += cell.color === "w" ? VALUE[cell.type] : -VALUE[cell.type];
    }
  }
  return total;
}
