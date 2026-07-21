import { EMPTY_RESULT, type MutationResult, type SurvivingMutant, mutationScore } from "../types.js";

// Ground truth (mutmut 3.6.0, probed live 2026-07-03): mutmut 3 is config-driven — the
// target repo MUST carry a [mutmut] section (setup.cfg) or [tool.mutmut] (pyproject)
// with source_paths; without it the CLI crashes at import time (that crash surfaces as
// a non-zero exit that reconcileResult turns into a gate error). There is no JSON
// results output; `mutmut results --all true` prints one line per mutant:
//     <module.path>.x_<function>__mutmut_<n>: <status>
// or, for class methods in newer 3.6 output:
//     <module.path>.xǁ<Class>ǁ<method>____mutmut_<n>: <status>
// with statuses killed / survived / no tests / timeout / suspicious / skipped /
// segfault / not checked. The module path maps back to a file (dots -> slashes + .py).
// mutmut mutates everything under source_paths, so parseMutmut filters mutants down to
// the changed files and recomputes counts from the filtered lines.
const STATUS_LINE = /^\s+([\w.-]+)\.x(.+?)__mutmut_(\d+): (.+)$/;

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
    const [, modulePath, rawFunc, index, status] = m;
    const func = rawFunc.replace(/^_/, "").replaceAll("ǁ", ".").replace(/^\./, "");
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

export function buildMutmutCommand(sourceFiles: string[], workDir: string, testCommand?: string): string {
  const scopedFiles = Array.from(
    new Set(
      sourceFiles
        .map((f) => f.replace(/:\d+(?:-\d+)?$/, ""))
        .filter((f) => f.endsWith(".py")),
    ),
  );
  const sourcePaths = JSON.stringify(scopedFiles);

  // mutmut 3 has no per-invocation CLI path flag; swap in a temporary scoped config
  // so `run` only mutates the intended files, then restore repository config.
  // `mutants/` is mutmut's working dir — scrub it before (stale state) and after
  // (clean tree). Progress/emoji UI goes to stderr; stdout carries only the
  // `results --all true` lines. A `run` failure exits with the run's code so
  // reconcileResult fails closed.
  const wd = shellEscape(workDir);
  return (
    `cd '${wd}' && rm -rf mutants && backup=$(mktemp) && has_setup_cfg=0; ` +
    `if [ -f setup.cfg ]; then has_setup_cfg=1; cp setup.cfg \"$backup\"; fi; ` +
    `export MUTMUT_SOURCE_PATHS='${shellEscape(sourcePaths)}'; ` +
    `export MUTMUT_TEST_COMMAND='${shellEscape(testCommand ?? "")}'; ` +
    `python3 - <<'PY'\n` +
    `import configparser\n` +
    `import json\n` +
    `import os\n` +
    `import shlex\n` +
    `from pathlib import Path\n\n` +
    `cfg = Path('setup.cfg')\n` +
    `paths = json.loads(os.environ['MUTMUT_SOURCE_PATHS'])\n` +
    `parser = configparser.ConfigParser(interpolation=None)\n\n` +
    `if cfg.exists():\n` +
    `    parser.read_file(cfg.open())\n` +
    `if not parser.has_section('mutmut'):\n` +
    `    parser['mutmut'] = {}\n` +
    `parser['mutmut']['source_paths'] = '\\n'.join(paths)\n` +
    `test_command = os.environ['MUTMUT_TEST_COMMAND'].strip()\n` +
    `if test_command:\n` +
    `    argv = shlex.split(test_command)\n` +
    `    executable = Path(argv[0]).name if argv else ''\n` +
    `    if executable.startswith('python') and argv[1:3] == ['-m', 'pytest']:\n` +
    `        pytest_args = argv[3:]\n` +
    `    elif executable in {'pytest', 'py.test'}:\n` +
    `        pytest_args = argv[1:]\n` +
    `    else:\n` +
    `        raise SystemExit('mutmut --test-command must invoke pytest directly or as python -m pytest')\n` +
    `    parser['mutmut']['pytest_add_cli_args_test_selection'] = '\\n'.join(pytest_args)\n` +
    `with cfg.open('w') as f:\n` +
    `    parser.write(f)\n` +
    `PY\n` +
    `config_code=$?; ` +
    `if [ $config_code -ne 0 ]; then ` +
    `if [ $has_setup_cfg -eq 1 ]; then mv "$backup" setup.cfg; else rm -f setup.cfg; fi; ` +
    `rm -rf mutants; exit $config_code; fi; ` +
    `mutmut run 1>&2; code=$?; ` +
    `if [ $code -eq 0 ]; then mutmut results --all true; code=$?; fi; ` +
    `if [ $has_setup_cfg -eq 1 ]; then mv \"$backup\" setup.cfg; else rm -f setup.cfg; fi; ` +
    `rm -rf mutants; exit $code`
  );
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
