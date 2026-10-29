/**
 * Stockfish 19 (lite, single-threaded) analysis client.
 *
 * This is deliberately separate from `aiClient.ts`: the opponent engine only
 * ever runs one search at a time and cancels it on a new request, while
 * analysis must be able to run without touching the game in progress.
 *
 * The engine itself is the stockfish.js lite-single worker script, copied
 * into `public/stockfish/` by `scripts/copy-stockfish.mjs` (predev/prebuild).
 * Single-threaded means no COOP/COEP headers are required, so the game stays
 * deployable as a plain static site. The .js worker expects its .wasm file
 * to sit next to it, which is why both files live in the same directory.
 *
 * UCI scores in this module are always in side-to-move perspective, exactly
 * as Stockfish reports them. Callers that display an eval must convert to
 * White's perspective first (see `toWhiteScore` in analysis.ts).
 */

export type Score = { kind: "cp"; cp: number } | { kind: "mate"; mate: number };

export interface PvLine {
  /** 1-based MultiPV rank. */
  multipv: number;
  score: Score;
  depth: number;
  /** UCI moves, first move is the candidate move. */
  pv: string[];
}

export interface AnalysisResult {
  fen: string;
  depth: number;
  lines: PvLine[];
  /** UCI bestmove, or null when the position has no legal move. */
  bestmove: string | null;
}

export interface AnalyzeOptions {
  depth?: number;
  /** Alternative to depth: search for roughly this long. */
  movetimeMs?: number;
  multiPv?: number;
  timeoutMs?: number;
}

/** Parse one Stockfish `info ... pv ...` line. Returns null for other lines. */
export function parseUciInfoLine(line: string): PvLine | null {
  if (!line.startsWith("info ")) return null;
  const tokens = line.split(/\s+/);
  const at = (key: string): string | null => {
    const i = tokens.indexOf(key);
    return i >= 0 && i + 1 < tokens.length ? tokens[i + 1] : null;
  };
  const depth = Number(at("depth"));
  const multipv = Number(at("multipv") ?? "1");
  const pvIndex = tokens.indexOf("pv");
  if (!Number.isFinite(depth) || pvIndex < 0) return null;
  const scoreKind = at("score");
  // Tokens look like: score cp 31  |  score mate 3
  const scoreIndex = tokens.indexOf("score");
  if (scoreIndex < 0 || scoreIndex + 2 >= tokens.length) return null;
  const scoreValue = Number(tokens[scoreIndex + 2]);
  if (!Number.isFinite(scoreValue)) return null;
  const score: Score =
    scoreKind === "mate" ? { kind: "mate", mate: scoreValue } : { kind: "cp", cp: scoreValue };
  const pv = tokens.slice(pvIndex + 1).filter(Boolean);
  if (pv.length === 0) return null;
  return { multipv: Number.isFinite(multipv) ? multipv : 1, score, depth, pv };
}

/** Parse a `bestmove e2e4` (or `bestmove (none)`) line. */
export function parseBestmoveLine(line: string): string | null {
  const match = /^bestmove\s+(\S+)/.exec(line);
  if (!match) return null;
  return match[1] === "(none)" ? null : match[1];
}

function stockfishWorkerUrl(): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}stockfish/stockfish-19-lite-single.js`;
}

interface Pending {
  id: number;
  fen: string;
  resolve: (result: AnalysisResult | null) => void;
  lines: Map<number, PvLine>;
  depth: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class StockfishClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private failed = false;

  /** True once the worker has answered `uciok`, or after a hard failure. */
  get hasFailed(): boolean {
    return this.failed;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(stockfishWorkerUrl());
    worker.onmessage = (event: MessageEvent<string>) => {
      const line = typeof event.data === "string" ? event.data : "";
      const pending = this.pending;
      if (!pending) return;
      if (line.startsWith("uciok")) return;
      const best = parseBestmoveLine(line);
      if (best !== null || line.startsWith("bestmove")) {
        const result: AnalysisResult = {
          fen: pending.fen,
          depth: pending.depth,
          lines: [...pending.lines.values()].sort((a, b) => a.multipv - b.multipv),
          bestmove: best,
        };
        this.clearPending();
        pending.resolve(result);
        return;
      }
      const info = parseUciInfoLine(line);
      if (info) {
        const previous = pending.lines.get(info.multipv);
        if (!previous || info.depth >= previous.depth) pending.lines.set(info.multipv, info);
        pending.depth = Math.max(pending.depth, info.depth);
      }
    };
    worker.onerror = () => {
      this.failed = true;
      const pending = this.pending;
      this.clearPending();
      pending?.resolve(null);
    };
    this.worker = worker;
    // Handshake: Stockfish answers `uciok` to `uci`. We do not block analysis
    // on it forever — a 5s grace period is enough to notice a broken worker.
    this.ready = new Promise<void>((resolve) => {
      const done = () => resolve();
      const original = worker.onmessage;
      worker.onmessage = (event: MessageEvent<string>) => {
        if (typeof event.data === "string" && event.data.startsWith("uciok")) done();
        original?.call(worker, event);
      };
      worker.postMessage("uci");
      setTimeout(done, 5000);
    });
    return worker;
  }

  private clearPending(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  /** Cancels the in-flight analysis; its promise resolves with null. */
  cancel(): void {
    const pending = this.pending;
    if (pending) {
      try {
        this.worker?.postMessage("stop");
      } catch {
        // Worker already gone — the pending promise is resolved below anyway.
      }
      this.clearPending();
      pending.resolve(null);
    }
  }

  async analyze(fen: string, options: AnalyzeOptions = {}): Promise<AnalysisResult | null> {
    const depth = options.depth ?? 16;
    const multiPv = Math.max(1, Math.min(5, options.multiPv ?? 3));
    const timeoutMs = options.timeoutMs ?? 15000;
    this.cancel();
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      this.failed = true;
      return null;
    }
    if (this.ready) await this.ready;
    if (this.failed) return null;
    const id = this.nextId++;
    return new Promise<AnalysisResult | null>((resolve) => {
      const pending: Pending = { id, fen, resolve, lines: new Map(), depth: 0, timer: null };
      pending.timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        try {
          worker.postMessage("stop");
        } catch {
          // Ignore — the bestmove handler may still arrive and resolve.
        }
        // Give the engine a short grace period to answer `bestmove` after
        // `stop`; if nothing arrives, resolve with whatever lines we have,
        // or null when we have nothing at all.
        setTimeout(() => {
          if (this.pending?.id !== id) return;
          const lines = [...pending.lines.values()].sort((a, b) => a.multipv - b.multipv);
          this.clearPending();
          resolve(lines.length > 0 ? { fen, depth: pending.depth, lines, bestmove: lines[0]?.pv[0] ?? null } : null);
        }, 800);
      }, timeoutMs);
      this.pending = pending;
      worker.postMessage(`setoption name MultiPV value ${multiPv}`);
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(options.movetimeMs ? `go movetime ${options.movetimeMs}` : `go depth ${depth}`);
    });
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
