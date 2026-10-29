import { memo } from "react";

import { formatScoreWhite, winPct } from "../ai/analysis";
import type { Score } from "../ai/stockfishClient";

/**
 * Vertical evaluation bar. The fill height AND the printed number both carry
 * the evaluation, so the bar stays readable without relying on colour alone.
 * White's share is drawn from the bottom, matching the usual convention.
 */
export const EvalBar = memo(function EvalBar({ score, depth }: { score: Score | null; depth: number }) {
  const pct = score ? winPct(score) : 50;
  return (
    <div className="flex flex-col items-center gap-1" aria-label="Đánh giá vị trí">
      <span className="mc-display text-[0.55rem] tracking-[0.18em] text-[#c8ab74]">ĐEN</span>
      <div
        className="relative h-32 w-4 overflow-hidden rounded-sm border border-[#8a652233] bg-[#1a1a1a]"
        role="img"
        aria-label={score ? `Trắng ${formatScoreWhite(score)}` : "Chưa có đánh giá"}
      >
        <div className="absolute inset-x-0 bottom-0 bg-[#e8ddc0]" style={{ height: `${pct}%` }} />
      </div>
      <span className="mc-display text-[0.55rem] tracking-[0.18em] text-[#c8ab74]">TRẮNG</span>
      <span className="text-[0.7rem] font-semibold text-[#f0dfb6]">
        {score ? formatScoreWhite(score) : "—"}
      </span>
      {depth > 0 ? <span className="text-[0.6rem] text-[#8a7a5c]">depth {depth}</span> : null}
    </div>
  );
});
