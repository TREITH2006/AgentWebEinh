# One-off repository hygiene check: look for committed secrets and confirm the
# ignore rules cover local-only files. Not part of the test suite.
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKIP = {"node_modules", ".venv", ".next", "__pycache__", ".ruff_cache", ".pytest_cache", "test-tasks"}
SUFFIXES = {".py", ".ts", ".tsx", ".js", ".json", ".toml", ".md", ".yaml", ".yml", ".example"}
SECRET = re.compile(
    r"(?i)(api[_-]?key|secret|password|passwd|token|bearer|authorization)"
    r"\s*[:=]\s*[\"']?(?P<value>[A-Za-z0-9_\-/+=]{8,})"
)
BENIGN = ("process.env", "os.environ", "getenv", "ENV_PREFIX", "example",
          "placeholder", "redact", "None", "null", "${", "{{", "<", "example_")
#: ``token: CancellationToken`` is a type annotation, not a leaked credential.
CAMEL_TYPE = re.compile(r"^[A-Z][A-Za-z0-9_]*$")

files = [
    p for p in ROOT.rglob("*")
    if p.is_file()
    and p.suffix in SUFFIXES
    and not (SKIP & set(p.parts))
    and p.name != ".env.example"
]

findings = []
for path in files:
    try:
        for n, line in enumerate(path.read_text(encoding="utf-8-sig", errors="replace").splitlines(), 1):
            match = SECRET.search(line)
            if match is None or CAMEL_TYPE.match(match.group("value")):
                continue
            if not any(b in line for b in BENIGN):
                findings.append(f"{path.relative_to(ROOT)}:{n}: {line.strip()[:110]}")
    except OSError as exc:
        print(f"unreadable: {path}: {exc}", file=sys.stderr)

print(f"scanned {len(files)} files")
print("SECRETS FOUND:" if findings else "no committed secrets found")
for f in findings:
    print(" ", f)

envs = [p for p in ROOT.rglob(".env*")
        if p.is_file() and not (SKIP & set(p.parts)) and p.name != ".env.example"]
print("real .env files:", [str(p.relative_to(ROOT)) for p in envs] or "none")

gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8-sig") if (ROOT / ".gitignore").is_file() else ""
for rule in ("data/", "*.db", ".venv/", "node_modules/", ".next/", ".env"):
    print(f"  gitignore {rule!r:18} {'ok' if rule in gitignore else 'MISSING'}")
