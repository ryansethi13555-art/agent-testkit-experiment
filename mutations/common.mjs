// Shared constants for the E0 mutation baseline tools. Everything runs from the FROZEN MoneyInvariant worktree (MI),
// never from the live repository, which the engineer keeps editing while E0 runs.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export const OUT = process.env.E0_OUT ?? "/home/USER/.codex/revised-plan-a/e0";
export const MI = process.env.E0_MI ?? `${OUT}/mi`;
export const NODE = "/home/USER/.nvm/versions/node/v22.22.0/bin/node";
export const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
export const EXP = {
  exp1: "/home/USER/.codex/blind-release-v2/plan-b/exp1/r5",
  exp2: "/home/USER/.codex/blind-release-v2/plan-b/exp2/r5",
};
export const APPS = {
  inline: { dir: "bench/leakybazaar-v2", ws: "inline-marketplace", name: "leakybazaar-v2" },
  worker: { dir: "bench/queue-bazaar-v2", ws: "worker-marketplace", name: "queue-bazaar-v2" },
};
export const SEED = 20261011;
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const requireFromMI = createRequire(`${MI}/package.json`);

/** Split label (spec): holdout if int(sha256(id|split)[:8],16) % 5 != 0, else dev. */
export const splitOf = (id) =>
  Number.parseInt(sha256(`${id}|split`).slice(0, 8), 16) % 5 !== 0 ? "holdout" : "dev";

/** mulberry32 seeded PRNG + Fisher-Yates shuffle (deterministic). */
export function seededShuffle(arr, seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
