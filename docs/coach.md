# Coach: Stockfish analysis, hints, and move grading

Branch: `feature/coach-stockfish-promotion`

## What this adds

- **Stockfish 19 (lite, single-threaded) in a separate Web Worker**
  (`web/src/ai/stockfishClient.ts`). It never touches the opponent engine
  (`web/src/ai/aiClient.ts` + `engine.worker.ts`), so analysis cannot cancel
  or be cancelled by a game move. Single-threaded means no COOP/COEP
  headers are required and the game stays a plain static site.
- **Coach panel** (`web/src/ui/CoachPanel.tsx`, bottom-left in game):
  - Eval bar (`web/src/ui/EvalBar.tsx`) with both a fill height and a
    printed number, so it does not rely on colour alone.
  - Top-3 hints (MultiPV 3). Clicking a hint highlights its squares on the
    board via the existing `SceneEngine.previewMove()` "hint" highlight.
  - Last-move grading in Vietnamese: Best / Excellent / Good / Inaccuracy /
    Mistake / Blunder, plus Book / Forced / Brilliant / Great / MissedWin
    (see `web/src/ai/analysis.ts` for the exact thresholds).
- **Theory references, not invented theory** (`web/src/ai/lichess.ts`,
  `web/src/ai/theory.ts`):
  - Lichess Opening Explorer (masters) for opening names and book moves.
  - Lichess endgame tablebase for positions with 7 pieces or fewer.
  - Deterministic tactic tags computed with chess.js (check, mate, capture,
    castling, promotion, hanging pieces, forks). Explanations are templates
    built only from those verified inputs.
- **Promotion ceremony** (`runMove()` in `web/src/scene/sceneEngine.ts`):
  the pawn dissolves in faction light, then the new piece descends onto
  the square. Queen gets the full beat, knight gets a short one, and
  tactical view skips the camera work and descent so the board stays
  readable. The old scale-pop is gone.

## How Stockfish files get into the build

The engine is the npm package `stockfish@19.0.1` (GPL-3.0, see its
`Copying.txt`). Only the lite-single pair is used:

- `stockfish-19-lite-single.js` (worker script)
- `stockfish-19-lite-single.wasm` (must sit next to the script)

`web/scripts/copy-stockfish.mjs` copies that pair from `node_modules`
into `web/public/stockfish/` on `predev` and `prebuild`. The files are
gitignored build output — they appear in `web/dist/stockfish/` after a
build, but they are not committed. The worker URL respects Vite's
`BASE_URL`, so a sub-path deployment still finds them.

If Stockfish fails to load, the Coach panel falls back to the game's own
engine for a single hint and labels it clearly as a reference hint
without an accurate eval, instead of pretending it is Stockfish.

## Run and verify

```sh
cd web
bun install
bun run dev        # http://localhost:5173 (or the port Vite prints)
bun x vitest run   # unit tests, including src/ai/analysis.test.ts
bun x tsc --noEmit -p tsconfig.app.json
bun run build      # check that dist/stockfish/ contains .js + .wasm
```

Manual QA checklist (not automated yet):

1. Open Coach, press "Gợi ý top 3" at the start position: expect e4/d4/Nf3
   style lines with evals, and clicking one highlights its squares.
2. Play a move, press "Chấm nước vừa đi": expect a Vietnamese label and
   explanation with the engine's best move and PV.
3. Promote a pawn (test FEN: `4k3/1P6/8/8/8/8/8/4K3 w - - 0 1`): expect the
   dissolve + descend ceremony, and a shorter one for underpromotion to
   knight.
4. Toggle to tactical view and to the Low preset mid-game: promotion must
   stay short and readable, and no figure may be left stranded.

## Deliberately not in this branch

- Full-game post-game analysis (accuracy chart, worst-moves list) — the
  per-move grading pieces are in place, but the batch replay UI is not.
- LLM coach — explanations are templates over verified facts only.
- Asset mirroring — 3D/audio assets still load from the R2 host in
  `web/src/assets/generated.ts`; see the spec for why that is Phase 0
  follow-up work, not something this branch silently changes.
- Coach in clock games — hints are disabled while the opponent is
  thinking, and the panel warns that hints do not stop the clock.
