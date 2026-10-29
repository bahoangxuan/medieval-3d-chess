/**
 * Lichess public data sources, used only as theory references, never as a
 * replacement for the local engine. Every call is cached, time-boxed, and
 * allowed to fail: a missing opening name or tablebase result is shown as
 * "no data", never invented.
 *
 * Endpoints (no token required for basic use):
 * - Opening Explorer (masters): https://explorer.lichess.ovh/masters?fen=...
 * - Endgame tablebase: https://tablebase.lichess.ovh/standard?fen=...
 */
import { pieceCount } from "./theory";

export interface OpeningInfo {
  eco: string;
  name: string;
  white: number;
  draws: number;
  black: number;
  /** Moves from this position, in UCI, with master-game counts. */
  moves: { uci: string; san: string; white: number; draws: number; black: number }[];
}

export interface TablebaseInfo {
  /** -2 = mated, -1 = losing, 0 = drawn, 1 = winning, 2 = mate. */
  wdl: number;
  dtz: number | null;
  bestUci: string | null;
}

const openingCache = new Map<string, OpeningInfo | null>();
const tablebaseCache = new Map<string, TablebaseInfo | null>();

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOpening(fen: string): Promise<OpeningInfo | null> {
  const cached = openingCache.get(fen);
  if (cached !== undefined) return cached;
  const data = (await fetchJson(
    `https://explorer.lichess.ovh/masters?fen=${encodeURIComponent(fen)}&moves=5&topGames=0`,
  )) as {
    opening?: { eco: string; name: string };
    white?: number;
    draws?: number;
    black?: number;
    moves?: { uci: string; san: string; white: number; draws: number; black: number }[];
  } | null;
  const info: OpeningInfo | null =
    data?.opening && data.moves
      ? {
          eco: data.opening.eco,
          name: data.opening.name,
          white: data.white ?? 0,
          draws: data.draws ?? 0,
          black: data.black ?? 0,
          moves: data.moves,
        }
      : null;
  openingCache.set(fen, info);
  return info;
}

/** Tablebase is only defined for 7 pieces or fewer; otherwise returns null. */
export async function fetchTablebase(fen: string): Promise<TablebaseInfo | null> {
  if (pieceCount(fen) > 7) return null;
  const cached = tablebaseCache.get(fen);
  if (cached !== undefined) return cached;
  const data = (await fetchJson(
    `https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen)}`,
  )) as {
    wdl?: number;
    dtz?: number;
    moves?: { uci: string; wdl: number }[];
  } | null;
  let info: TablebaseInfo | null = null;
  if (data && typeof data.wdl === "number") {
    const best = (data.moves ?? []).reduce<{ uci: string; wdl: number } | null>((acc, m) => {
      return !acc || m.wdl > acc.wdl ? m : acc;
    }, null);
    info = { wdl: data.wdl, dtz: typeof data.dtz === "number" ? data.dtz : null, bestUci: best?.uci ?? null };
  }
  tablebaseCache.set(fen, info);
  return info;
}
