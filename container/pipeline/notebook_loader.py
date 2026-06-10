"""
notebook_loader.py — load a Jupyter notebook's *definition* statements into a
namespace, without running any of its orchestration / side-effecting cells.

This is lifted from the original submission's `driver.py`. It is the mechanism
that keeps the four step notebooks as the single source of truth: we import the
exact prompts (SYSTEM_PROMPT, METHODOLOGY_PROMPT), the validators
(validate_and_normalize, consistency_check) and the reducer (reduce_document)
straight out of the notebooks, so they remain byte-for-byte identical to the
graded submission. Only the LLM call site is re-implemented (Gemini -> DeepSeek).

Two-level filter so only *definitions* are exec'd — never the cells that run work:
  1. Whole-cell skip: a cell with any top-level loop / context-manager is an
     orchestration cell (convert every PDF, reduce every row, write files) — skip it.
  2. Node-level keep: from the surviving cells, exec ONLY imports / classes /
     functions / assignments / try-blocks. Bare expression-statements are dropped,
     so side effects (shutil.rmtree(...), os.makedirs(...), run_pipeline(),
     print(...)) never execute. Module-level constants and the
     `logger = logging.getLogger(...)` style assignments the functions depend on
     ARE kept (they are assignments, not bare calls).
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

_ORCHESTRATION_NODES = (ast.For, ast.While, ast.AsyncFor, ast.With, ast.AsyncWith)
_KEEP_NODES = (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef,
               ast.ClassDef, ast.Assign, ast.AnnAssign, ast.Try)


def _strip_magics(src: str) -> str:
    """Blank out Jupyter magics / shell-escape lines so the cell still compiles."""
    out = []
    for ln in src.splitlines():
        stripped = ln.lstrip()
        out.append("" if stripped[:1] in ("!", "%") else ln)
    return "\n".join(out)


def load_notebook_namespace(path: Path, required=()) -> dict:
    """Load a .ipynb, exec only its definition statements, return the namespace.

    `__name__` is a non-main sentinel so `if __name__ == "__main__"` blocks never
    run. Hardcoded absolute sample-path reads in exploratory dev cells raise
    FileNotFoundError, which is expected and ignored. After loading, every name in
    `required` must be present (otherwise we fail loudly rather than silently degrade).
    """
    path = Path(path)
    nb = json.loads(path.read_text(encoding="utf-8"))
    ns: dict = {"__name__": "_pa_pipeline_loaded", "__file__": str(path)}
    for cell in nb.get("cells", []):
        if cell.get("cell_type") != "code":
            continue
        src = _strip_magics("".join(cell.get("source", [])))
        if not src.strip():
            continue
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        if any(isinstance(n, _ORCHESTRATION_NODES) for n in tree.body):
            continue  # orchestration cell — skip entirely
        kept = [n for n in tree.body if isinstance(n, _KEEP_NODES)]
        if not kept:
            continue
        module = ast.Module(body=kept, type_ignores=[])
        ast.fix_missing_locations(module)
        try:
            exec(compile(module, str(path), "exec"), ns)
        except (FileNotFoundError, OSError):
            pass  # hardcoded sample paths in dev cells — irrelevant to the definitions
        except Exception as e:  # noqa: BLE001
            print(f"    [load {path.name}] skipped statements: {type(e).__name__}: {e}")
    missing = [name for name in required if name not in ns]
    if missing:
        raise RuntimeError(f"{path.name}: required definitions not found: {missing}")
    return ns
