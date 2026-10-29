import { useCallback, useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Lightbulb, X } from "lucide-react";

import { classifyMove, explainMove, flipScore, formatScoreWhite, MOVE_LABEL_VI, toWhiteScore, type MoveLabel } from "../ai/analysis";
import { AiClient } from "../ai/aiClient";
import { fetchOpening, fetchTablebase } from "../ai/lichess";
import { StockfishClient, type AnalysisResult, type Score } from "../ai/stockfishClient";
import { detectForksForMover, detectHangingForMover, detectTags, isEnPrise, pieceCount } from "../ai/theory";
import type { Faction, LedgerMove } from "../core/types";
import { EvalBar } from "./EvalBar";

interface CoachPanelProps {
  fen: string;
  moves: LedgerMove[];
  turn: Faction;
  /** False while the opponent is thinking, in a timed game the coach is off, etc. */
  canHint: boolean;
  /**
   * False while the opponent is thinking or the board is busy. Grading is
   * allowed after game over (post-game review) and on the player's turn, but
   * never while the game engine is mid-search, or Coach + game AI + 3D all
   * compete for CPU at once.
   */
  canGrade: boolean;
  onPreviewMove: (move: LedgerMove | null) => void;
}

/**
 * One Stockfish worker for the whole session, shared across CoachPanel
 * mounts. Previously the worker was terminated on every unmount, so
 * toggling cinema mode or leaving play forced a ~1.8MB WASM reload plus
 * the uci handshake before the next hint. The worker is deliberately not
 * disposed here; the browser reclaims it when the page closes.
 */
let sharedClient: StockfishClient | null = null;

interface HintLine {
  rank: number;
  san: string;
  from: string;
  to: string;
  scoreWhite: Score;
  pvSans: string[];
}

function uciParts(uci: string): { from: string; to: string; promotion?: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

/** Convert a UCI PV to SANs by replaying it on a fresh Chess instance. */
function pvToSans(fen: string, pv: string[]): string[] {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of pv.slice(0, 5)) {
    try {
      const move = chess.move(uciParts(uci));
      sans.push(move.san);
    } catch {
      break;
    }
  }
  return sans;
}

function replayFenBeforeLast(moves: LedgerMove[]): string | null {
  try {
    const chess = new Chess();
    for (const move of moves.slice(0, -1)) chess.move(move.san);
    return chess.fen();
  } catch {
    return null;
  }
}

function depthForDevice(): number {
  return typeof window !== "undefined" && window.innerWidth < 768 ? 14 : 16;
}

export function CoachPanel({ fen, moves, turn, canHint, canGrade, onPreviewMove }: CoachPanelProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [statusText, setStatusText] = useState("");
  const [hints, setHints] = useState<HintLine[]>([]);
  const [evalScore, setEvalScore] = useState<Score | null>(null);
  const [evalDepth, setEvalDepth] = useState(0);
  const [fallbackNote, setFallbackNote] = useState("");
  const [lastExplanation, setLastExplanation] = useState("");
  const [lastLabel, setLastLabel] = useState<MoveLabel | null>(null);
  // Tracks the position the panel is currently showing, so a result that
  // arrives after the board moved on is never displayed as current.
  const fenRef = useRef(fen);
  fenRef.current = fen;

  // A new position invalidates every result from the old one: hints, eval
  // and grading from before the move, undo or rematch must not survive into
  // the new position, and any board highlight from an old hint is cleared.
  // This runs on mount too, where it only clears already-empty state.
  useEffect(() => {
    setHints([]);
    setEvalScore(null);
    setEvalDepth(0);
    setFallbackNote("");
    setLastExplanation("");
    setLastLabel(null);
    setStatus("idle");
    setStatusText("");
    onPreviewMove(null);
    // onPreviewMove is stable (GameShell's useCallback with [] deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen]);

  const getClient = useCallback((): StockfishClient => {
    if (!sharedClient) sharedClient = new StockfishClient();
    return sharedClient;
  }, []);

  const analyze = useCallback(
    async (targetFen: string, multiPv: number): Promise<AnalysisResult | null> => {
      return getClient().analyze(targetFen, { depth: depthForDevice(), multiPv, timeoutMs: 15000 });
    },
    [getClient],
  );

  const handleHint = useCallback(async () => {
    const requestedFen = fen;
    setStatus("loading");
    setStatusText("Stockfish đang tính…");
    setFallbackNote("");
    // Old hints are for this same position until the board moves, but once a
    // new analysis is requested they are replaced, not left on screen under
    // the loading line as if they were fresh.
    setHints([]);
    const result = await analyze(fen, 3);
    if (fenRef.current !== requestedFen) return;
    if (!result || result.lines.length === 0) {
      // Fallback: the game's own engine can still give one usable move.
      // Its score is not a Stockfish eval, so no eval bar is shown for it.
      try {
        const fallback = new AiClient();
        const move = await fallback.bestMove(fen, "hard");
        fallback.dispose();
        if (move) {
          const san = pvToSans(fen, [`${move.from}${move.to}${move.promotion ?? ""}`])[0];
          if (san) {
            setHints([{ rank: 1, san, from: move.from, to: move.to, scoreWhite: { kind: "cp", cp: 0 }, pvSans: [san] }]);
            setEvalScore(null);
            setEvalDepth(0);
            setFallbackNote("Stockfish chưa tải được nên đây là gợi ý tham khảo từ engine tích hợp sẵn, chưa có đánh giá chính xác.");
            setStatus("ready");
            setStatusText("");
            return;
          }
        }
      } catch {
        // Fall through to the error state below.
      }
      setHints([]);
      setStatus("error");
      setStatusText("Không tải được Stockfish. Kiểm tra kết nối rồi bấm lại.");
      return;
    }
    const lines: HintLine[] = result.lines.map((line) => {
      const parts = uciParts(line.pv[0]);
      const sans = pvToSans(fen, line.pv);
      return {
        rank: line.multipv,
        san: sans[0] ?? line.pv[0],
        from: parts.from,
        to: parts.to,
        scoreWhite: toWhiteScore(line.score, turn),
        pvSans: sans,
      };
    });
    setHints(lines);
    setEvalScore(lines[0]?.scoreWhite ?? null);
    setEvalDepth(result.depth);
    setStatus("ready");
    setStatusText("");
  }, [analyze, fen, turn]);

  const handleAnalyzeLastMove = useCallback(async () => {
    const last = moves[moves.length - 1];
    if (!last) return;
    const beforeFen = replayFenBeforeLast(moves);
    if (!beforeFen) {
      setStatus("error");
      setStatusText("Không replay được ván để lấy vị trí trước nước đi.");
      return;
    }
    const requestedFen = fen;
    setStatus("loading");
    setStatusText("Đang chấm nước vừa đi…");
    setLastExplanation("");
    setLastLabel(null);
    const before = await analyze(beforeFen, 3);
    const after = await analyze(fen, 1);
    if (fenRef.current !== requestedFen) return;
    if (!before || before.lines.length === 0 || !after || after.lines.length === 0) {
      setStatus("error");
      setStatusText("Phân tích chưa xong hoặc Stockfish chưa sẵn sàng, bấm lại sau vài giây.");
      return;
    }
    const bestLine = before.lines[0];
    const secondLine = before.lines[1] ?? null;
    // before score is side-to-move = mover; after score is side-to-move =
    // opponent, so flip it back to the mover's perspective.
    const bestMover = bestLine.score;
    const playedMover = flipScore(after.lines[0].score);
    const playedUci = `${last.from}${last.to}${last.promotion ?? ""}`;
    const opening = await fetchOpening(beforeFen);
    const isBook = Boolean(opening && opening.moves.some((m) => m.uci === playedUci));
    const sacrifice =
      last.kind !== "p" && !last.capture && isEnPrise(fen, last.to);
    let legalCount = 20;
    try {
      legalCount = new Chess(beforeFen).moves().length;
    } catch {
      // Keep the default; forced-move detection just won't trigger.
    }
    const graded = classifyMove({
      best: bestMover,
      played: playedMover,
      secondBest: secondLine?.score ?? null,
      bestUci: bestLine.pv[0] ?? null,
      playedUci,
      legalMoveCount: legalCount,
      isBook,
      isSacrifice: sacrifice,
    });
    const bestSans = pvToSans(beforeFen, bestLine.pv);
    const tags = [
      ...detectTags(fen, last.san),
      ...detectHangingForMover(fen),
      ...detectForksForMover(fen),
    ];
    let tablebaseWdl: number | undefined;
    if (pieceCount(fen) <= 7) {
      const tb = await fetchTablebase(fen);
      if (tb) tablebaseWdl = tb.wdl;
    }
    setLastLabel(graded.label);
    setLastExplanation(
      explainMove({
        label: graded.label,
        playedSan: last.san,
        bestSan: bestSans[0] ?? null,
        bestPvSans: bestSans,
        cpLoss: graded.cpLoss,
        winPctLoss: graded.winPctLoss,
        tacticTags: tags,
        theory: {
          openingName: isBook ? opening?.name : undefined,
          eco: isBook ? opening?.eco : undefined,
          tablebaseWdl,
        },
      }),
    );
    setEvalScore(toWhiteScore(after.lines[0].score, turn));
    setEvalDepth(after.depth);
    setStatus("ready");
    setStatusText("");
  }, [analyze, fen, moves, turn]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mc-slate pointer-events-auto absolute bottom-24 left-3 z-30 flex items-center gap-2 px-3 py-2 text-xs text-[#f0dfb6]"
        aria-label="Mở bảng Coach"
      >
        <Lightbulb size={14} /> Coach
      </button>
    );
  }

  return (
    <div className="mc-slate pointer-events-auto absolute bottom-24 left-3 z-30 flex max-h-[62vh] w-[330px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[#8a652233] px-3 py-2">
        <p className="mc-display text-[0.6rem] tracking-[0.3em] text-[#c8ab74]">COACH · STOCKFISH 19</p>
        <button
          type="button"
          onClick={() => {
            onPreviewMove(null);
            setOpen(false);
          }}
          className="text-[#a89268] hover:text-[#f0dfb6]"
          aria-label="Đóng bảng Coach"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-y-auto p-3">
        <div className="shrink-0">
          <EvalBar score={evalScore} depth={evalDepth} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canHint || status === "loading"}
              onClick={handleHint}
              className="mc-coach-action"
            >
              Gợi ý top 3
            </button>
            <button
              type="button"
              disabled={!canGrade || moves.length === 0 || status === "loading"}
              onClick={handleAnalyzeLastMove}
              className="mc-coach-action"
            >
              Chấm nước vừa đi
            </button>
          </div>
          {!canHint ? (
            <p className="mt-2 text-[0.7rem] leading-relaxed text-[#8a7a5c]">
              Gợi ý chỉ chạy khi tới lượt bạn và máy không đang suy nghĩ. Đồng hồ vẫn chạy trong lúc
              Coach tính, nên đừng bấm Coach khi đang cạn giờ.
            </p>
          ) : null}
          {!canGrade && moves.length > 0 ? (
            <p className="mt-2 text-[0.7rem] leading-relaxed text-[#8a7a5c]">
              Chấm nước chờ máy nghĩ xong rồi mới chạy, để khỏi tranh CPU với ván đang đánh.
            </p>
          ) : null}
          {status === "loading" ? <p className="mt-2 text-xs text-[#c8ab74]">{statusText}</p> : null}
          {status === "error" ? <p className="mt-2 text-xs text-[#e08a7a]">{statusText}</p> : null}
          {fallbackNote ? <p className="mt-2 text-[0.7rem] leading-relaxed text-[#c8ab74]">{fallbackNote}</p> : null}
          {hints.length > 0 ? (
            <ol className="mt-3 space-y-2">
              {hints.map((hint) => (
                <li key={hint.rank}>
                  <button
                    type="button"
                    disabled={status === "loading"}
                    onClick={() => onPreviewMove({ from: hint.from, to: hint.to } as LedgerMove)}
                    className="w-full rounded-sm border border-[#8a652233] px-2 py-1.5 text-left hover:border-[#c8ab74] disabled:opacity-40"
                    title="Bấm để sáng ô gợi ý trên bàn"
                  >
                    <span className="text-xs font-semibold text-[#f0dfb6]">
                      {hint.rank}. {hint.san}
                    </span>
                    <span className="ml-2 text-[0.7rem] text-[#a89268]">
                      {hint.scoreWhite.kind === "cp" && fallbackNote ? "tham khảo" : formatScoreWhite(hint.scoreWhite)}
                    </span>
                    <span className="mt-0.5 block truncate text-[0.7rem] text-[#8a7a5c]">{hint.pvSans.join(" ")}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
          {lastExplanation ? (
            <div className="mt-3 border-t border-[#8a652233] pt-2">
              <p className="text-[0.6rem] tracking-[0.2em] text-[#a89268]">
                NƯỚC VỪA ĐI{lastLabel ? ` · ${MOVE_LABEL_VI[lastLabel]}` : ""}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[#e4d3ac]">{lastExplanation}</p>
            </div>
          ) : null}
          <p className="mt-3 text-[0.65rem] leading-relaxed text-[#6f6450]">
            Stockfish chạy ngay trong trình duyệt, không gửi ván cờ lên máy chủ. Dữ liệu khai cuộc và tàn cuộc
            (nếu có) lấy từ Lichess và được ghi rõ nguồn, không tự bịa.
          </p>
        </div>
      </div>
    </div>
  );
}
