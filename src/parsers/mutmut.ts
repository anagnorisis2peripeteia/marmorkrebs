import { EMPTY_RESULT, type MutationResult, type SurvivingMutant, mutationScore } from "../types.js";

// Ground truth (mutmut 3.6.0, probed live 2026-07-03): mutmut 3 is config-driven — the
// target repo MUST carry a [mutmut] section (setup.cfg) or [tool.mutmut] (pyproject)
// with source_paths; without it the CLI crashes at import time (that crash surfaces as
// a non-zero exit that reconcileResult turns into a gate error). There is no JSON
// results output; `mutmut results --all true` prints one line per mutant:
//     <module.path>.x_<function>__mutmut_<n>: <status>
// with statuses killed / survived / no tests / timeout / suspicious / skipped /
// segfault / not checked. The module path maps back to a file (dots -> slashes + .py).
// mutmut mutates everything under source_paths, so parseMutmut filters mutants down to
// the changed files and recomputes counts from the filtered lines.
const STATUS_LINE = /^\s+([\w.-]+)\.x_(\w+?)__mutmut_(\d+): (.+)$/;

function moduleToFile(modulePath: string): string {
  return `${modulePath.replace(/\./g, "/")}.py`;
}

export function parseMutmut(output: string, changedFiles: string[] = []): MutationResult {
  const wanted = changedFiles
    .map((f) => f.replace(/:\d+(?:-\d+)?$/, ""))
    .filter((f) => f.endsWith(".py"));
  const mutants: SurvivingMutant[] = [];
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let noCoverage = 0;
  let ignored = 0;
  let sawAny = false;

  for (const line of output.split("\n")) {
    const m = line.match(STATUS_LINE);
    if (!m) continue;
    const [, modulePath, func, index, status] = m;
    const file = moduleToFile(modulePath);
    if (wanted.length && !wanted.some((cf) => cf === file || cf.endsWith(`/${file}`) || file.endsWith(`/${cf}`))) {
      continue;
    }
    sawAny = true;
    const survivor = (st: SurvivingMutant["status"]) =>
      mutants.push({
        file,
        line: 0,
        mutator: "mutmut",
        description: `${func} mutant ${index} (${status})`,
        status: st,
      });
    switch (status) {
      case "killed":
        killed++;
        break;
      case "survived":
      case "suspicious": // untrusted result — count against the diff, fail closed
      case "segfault":
        survived++;
        survivor("survived");
        break;
      case "no tests":
        noCoverage++;
        survivor("no_coverage");
        break;
      case "timeout":
        timeout++;
        break;
      default: // skipped / not checked
        ignored++;
        break;
    }
  }

  if (!sawAny) {
    return {
      ...EMPTY_RESULT,
      tool: "mutmut",
      error: `no mutmut result lines parsed${wanted.length ? " for the changed files" : ""}: ${output.trim().slice(0, 200)}`,
    };
  }


  return {
    tool: "mutmut",
    totalMutants: killed + survived + timeout + noCoverage + ignored,
    killed,
    survived,
    timeout,
    noCoverage,
    ignored,
    score: mutationScore(killed, timeout, survived, noCoverage),
    survivingMutants: mutants,
    error: null,
    elapsedMs: 0,
  };
}

export function buildMutmutCommand(sourceFiles: string[], workDir: string): string {
  // mutmut 3 has no per-file CLI scoping worth trusting; run per repo config, then let
  // parseMutmut filter to the changed files. `mutants/` is mutmut's working dir — scrub
  // it before (stale state) and after (clean tree). Progress/emoji UI goes to stderr;
  // stdout carries only the `results --all true` lines. A `run` failure exits with the
  // run's code so reconcileResult fails closed.
  const wd = shellEscape(workDir);
  return (
    `cd '${wd}' && rm -rf mutants && mutmut run 1>&2; code=$?; ` +
    `if [ $code -eq 0 ]; then mutmut results --all true; code=$?; fi; ` +
    `rm -rf mutants; exit $code`
  );
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
