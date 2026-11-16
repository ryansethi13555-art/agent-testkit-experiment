#!/usr/bin/env node
// E0 step 1: enumerate generic mutation points in every src/*.ts of both apps (TypeScript compiler API) and write each
// mutant as a unified diff (a/ b/ prefixes relative to the app dir, `patch -p1`). Output: <out>/candidates.json and
// <out>/patches/<id>.patch. Operators: AOR ROR LCR UOD LIT COND SDL STR SQL (see the task spec; nothing app-specific).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPS, EXP, MI, OUT, requireFromMI, sha256 } from "./common.mjs";

const ts = requireFromMI("typescript");
const outDir = process.argv[2] ?? join(OUT, "candidates");
mkdirSync(join(outDir, "patches"), { recursive: true });

const STATUS = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
  "paid",
  "partially_refunded",
  "refunded",
  "authorized",
  "requires_capture",
];
const SK = ts.SyntaxKind;

/** Is the node inside an argument list of an *Error(...) constructor/call or console.* call (error/log messages)? */
function inMessageContext(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isNewExpression(n) || ts.isCallExpression(n)) {
      const callee = n.expression.getText();
      const argsHit = n.arguments?.some((a) => a.pos <= node.pos && node.end <= a.end);
      if (argsHit && (/Error$/.test(callee) || /^console\./.test(callee))) return true;
    }
    if (ts.isTypeNode(n)) return true;
  }
  return false;
}

function mutantsForFile(_app, file, program, checker) {
  const sf = program.getSourceFile(file);
  const text = sf.text;
  const out = [];
  const add = (operator, start, end, repl, desc, _node) => {
    const line = sf.getLineAndCharacterOfPosition(start).line + 1;
    out.push({ operator, start, end, repl, line, desc });
  };
  // classify an operand: "num" (number/bigint typed), "any" (untyped DB rows etc.), "other"
  const kindOf = (e) => {
    const t = checker.getTypeAtLocation(e);
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "any";
    const parts = t.isUnion() ? t.types : [t];
    return parts.every((p) => p.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike))
      ? "num"
      : "other";
  };
  const strLike = (e) => {
    if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e)) return true;
    const t = checker.getTypeAtLocation(e);
    const parts = t.isUnion() ? t.types : [t];
    return parts.some((p) => p.flags & ts.TypeFlags.StringLike);
  };

  function sqlMutations(node, rawStart, raw) {
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(raw)) return;
    const rules = [
      [/(?<![<>=!])>=(?![=>])/g, ">", ">="],
      [/(?<![<>=!])<=(?![=>])/g, "<", "<="],
      [/(?<![<>=!-])>(?![=>])/g, ">=", ">"],
      [/(?<![<>=!])<(?![=>@>])/g, "<=", "<"],
      [/ = /g, " <> ", " = "],
      [/-amount\b/g, "amount", "-amount"],
      [/\bNOT /g, "", "NOT "],
    ];
    for (const [re, repl, from] of rules) {
      for (const m of raw.matchAll(re)) {
        if (from === " = ") {
          // an assignment in an UPDATE ... SET clause is not a comparison: `SET a <> b` is not valid SQL
          const before = raw.slice(0, m.index);
          const setAt = before.lastIndexOf("SET ");
          if (setAt >= 0 && !/\b(WHERE|FROM|RETURNING)\b/.test(before.slice(setAt))) continue;
        }
        const at = rawStart + m.index;
        add(
          "SQL",
          at,
          at + m[0].length,
          repl,
          `SQL ${JSON.stringify(m[0])} -> ${JSON.stringify(repl)}`,
          node,
        );
      }
    }
  }

  function visit(node) {
    if (inMessageContext(node) && !ts.isSourceFile(node)) {
      // still descend: an enclosing message context never contains separately mutable program logic
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken;
      const s = op.getStart(sf);
      const k = op.kind;
      const swap = {
        [SK.LessThanToken]: "<=",
        [SK.LessThanEqualsToken]: "<",
        [SK.GreaterThanToken]: ">=",
        [SK.GreaterThanEqualsToken]: ">",
        [SK.EqualsEqualsEqualsToken]: "!==",
        [SK.ExclamationEqualsEqualsToken]: "===",
        [SK.EqualsEqualsToken]: "!=",
        [SK.ExclamationEqualsToken]: "==",
      }[k];
      if (swap) add("ROR", s, op.end, swap, `${op.getText(sf)} -> ${swap}`);
      else if (k === SK.AmpersandAmpersandToken) add("LCR", s, op.end, "||", "&& -> ||");
      else if (k === SK.BarBarToken) add("LCR", s, op.end, "&&", "|| -> &&");
      else if (k === SK.PlusToken || k === SK.MinusToken) {
        const kl = kindOf(node.left),
          kr = kindOf(node.right);
        const ok =
          !strLike(node.left) &&
          !strLike(node.right) &&
          kl !== "other" &&
          kr !== "other" &&
          (k === SK.MinusToken || kl === "num" || kr === "num");
        if (ok)
          add(
            "AOR",
            s,
            op.end,
            k === SK.PlusToken ? "-" : "+",
            `${op.getText(sf)} -> ${k === SK.PlusToken ? "-" : "+"}`,
          );
      }
    } else if (ts.isPrefixUnaryExpression(node) && node.operator === SK.ExclamationToken) {
      add("UOD", node.getStart(sf), node.operand.getStart(sf), "", "remove !");
    } else if (ts.isBigIntLiteral(node)) {
      const raw = node.text.replace(/n$/, "");
      let v;
      try {
        v = BigInt(raw.replace(/_/g, ""));
      } catch {
        v = null;
      }
      if (v !== null) {
        const s = node.getStart(sf);
        add("LIT", s, node.end, `${v + 1n}n`, `${node.getText(sf)} -> ${v + 1n}n`);
        if (v !== 0n) add("LIT", s, node.end, "0n", `${node.getText(sf)} -> 0n`);
      }
    } else if (ts.isIfStatement(node)) {
      const e = node.expression;
      const s = e.getStart(sf);
      add("COND", s, e.end, "true", "if-condition -> true");
      add("COND", s, e.end, "false", "if-condition -> false");
    } else if (ts.isExpressionStatement(node)) {
      const e = node.expression;
      const isAwaitCall = ts.isAwaitExpression(e) && ts.isCallExpression(ts.skipParentheses(e.expression));
      const isAssign =
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind >= SK.FirstAssignment &&
        e.operatorToken.kind <= SK.LastAssignment;
      if (isAwaitCall || isAssign) {
        const s = node.getStart(sf);
        let end = node.end;
        const blockish =
          ts.isBlock(node.parent) ||
          ts.isSourceFile(node.parent) ||
          ts.isCaseClause(node.parent) ||
          ts.isDefaultClause(node.parent) ||
          ts.isModuleBlock(node.parent);
        const repl = blockish ? "" : "{}";
        let start = s;
        if (blockish) {
          // drop the whole line(s) when the statement stands alone on them
          const ls = text.lastIndexOf("\n", s - 1) + 1;
          let le = text.indexOf("\n", end);
          if (le < 0) le = text.length;
          if (/^\s*$/.test(text.slice(ls, s)) && /^\s*$/.test(text.slice(end, le))) {
            start = ls;
            end = Math.min(le + 1, text.length);
          }
        }
        add("SDL", start, end, repl, "delete statement", node);
        out[out.length - 1].line = sf.getLineAndCharacterOfPosition(s).line + 1;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent;
      const skipPos =
        ts.isImportDeclaration(p) ||
        ts.isExportDeclaration(p) ||
        ts.isLiteralTypeNode(p) ||
        (ts.isPropertyAssignment(p) && p.name === node) ||
        ts.isExternalModuleReference(p);
      if (!skipPos) {
        const i = STATUS.indexOf(node.text);
        if (i >= 0) {
          const nx = STATUS[(i + 1) % STATUS.length];
          const q = text[node.getStart(sf)];
          add("STR", node.getStart(sf), node.end, `${q}${nx}${q}`, `"${node.text}" -> "${nx}"`);
        }
        sqlMutations(node, node.getStart(sf) + 1, text.slice(node.getStart(sf) + 1, node.end - 1));
      }
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head, ...node.templateSpans.map((x) => x.literal)];
      for (const lit of parts) {
        const a = lit.getStart(sf) + 1;
        const b = lit.end - (lit.kind === SK.TemplateTail ? 1 : 2);
        sqlMutations(node, a, text.slice(a, b));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

function unifiedDiff(rel, oldText, newText) {
  const d = mkdtempSync(join(tmpdir(), "e0gen-"));
  writeFileSync(join(d, "a"), oldText);
  writeFileSync(join(d, "b"), newText);
  const r = spawnSync("diff", ["-u", join(d, "a"), join(d, "b")], { encoding: "utf8", maxBuffer: 1 << 26 });
  rmSync(d, { recursive: true, force: true });
  const lines = r.stdout.split("\n");
  lines[0] = `--- a/${rel}`;
  lines[1] = `+++ b/${rel}`;
  return lines.join("\n");
}

const candidates = [];
for (const [app, cfg] of Object.entries(APPS)) {
  const appDir = join(MI, cfg.dir);
  const srcFiles = readdirSync(join(appDir, "src"))
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => join(appDir, "src", f));
  const program = ts.createProgram(srcFiles, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    types: ["node"],
    typeRoots: [join(MI, "node_modules/@types")],
    lib: ["lib.es2023.d.ts"],
  });
  const checker = program.getTypeChecker();
  for (const f of srcFiles) {
    const rel = `src/${f.split("/").pop()}`;
    const oldText = readFileSync(f, "utf8");
    for (const m of mutantsForFile(app, f, program, checker)) {
      if (m.start < 0 || m.end < m.start) continue;
      const newText = oldText.slice(0, m.start) + m.repl + oldText.slice(m.end);
      if (newText === oldText) continue;
      const patch = unifiedDiff(rel, oldText, newText);
      const id = `${app}-${sha256(patch).slice(0, 10)}`;
      candidates.push({
        id,
        app,
        operator: m.operator,
        file: rel,
        line: m.line,
        desc: m.desc,
        patchSha256: sha256(patch),
        _patch: patch,
      });
    }
  }
}

// dedupe by id; check each patch applies cleanly to the app copy and to the agent-suite workspace copies
const seen = new Set();
const final = [];
let notApplicable = 0;
for (const c of candidates) {
  if (seen.has(c.id)) continue;
  seen.add(c.id);
  const pf = join(outDir, "patches", `${c.id}.patch`);
  writeFileSync(pf, c._patch);
  const targets = [join(MI, APPS[c.app].dir)];
  for (const e of Object.values(EXP)) targets.push(join(e, APPS[c.app].ws));
  c.applies = targets.map(
    (t) =>
      spawnSync("patch", ["-p1", "--dry-run", "--silent", "--forward", "-i", pf], { cwd: t }).status === 0,
  );
  if (!c.applies.every(Boolean)) notApplicable++;
  delete c._patch;
  final.push(c);
}
const good = final.filter((c) => c.applies.every(Boolean));
writeFileSync(
  join(outDir, "candidates.json"),
  `${JSON.stringify({ generatedFrom: MI, notApplicable, candidates: good }, null, 1)}\n`,
);
const tally = {};
for (const c of good) {
  tally[c.app] ??= {};
  tally[c.app][c.operator] = (tally[c.app][c.operator] ?? 0) + 1;
}
console.log(JSON.stringify({ total: good.length, notApplicable, tally }, null, 1));
