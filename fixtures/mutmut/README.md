# mutmut validation fixture

Python package for `scripts/validate-provider.mjs mutmut` (mutmut 3.x, config-driven —
see setup.cfg [mutmut] source_paths):
- `calclib/tested.py` — changed + tested: mutant killed
- `calclib/untested.py` — changed + untested: reported as `no tests` -> no_coverage survivor
- `calclib/neighbor.py` — UNCHANGED + untested: must be filtered out of scoring
