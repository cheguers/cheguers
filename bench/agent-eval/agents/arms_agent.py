import atexit
import os
import tempfile
from pathlib import Path

from terminal_bench.agents.installed_agents.claude_code import claude_code_agent
from terminal_bench.agents.installed_agents.claude_code.claude_code_agent import ClaudeCodeAgent
from terminal_bench.utils.template_utils import render_setup_script

CHEGUERS_REPO = "https://github.com/cheguers/cheguers.git"
CHEGUERS_REF = "69ca4b2"

CHEGUERS_CLI = f"""
apt-get install -y git >/dev/null 2>&1
(
git clone {CHEGUERS_REPO} /opt/cheguers && cd /opt/cheguers && git checkout {CHEGUERS_REF}
npm install -g pnpm@11 && pnpm install --frozen-lockfile --filter @cheguers/cli... || echo CHEGUERS_INSTALL_FAIL
)
printf '#!/bin/sh\\nexec pnpm --dir /opt/cheguers --filter @cheguers/cli cheguers "$@"\\n' > /usr/local/bin/cheguers
chmod +x /usr/local/bin/cheguers
mkdir -p /app/work && rm -f /app/work/kb.db
cp /opt/store/load_cheguers.ts /opt/cheguers/packages/cli/
cd /opt/cheguers/packages/cli && pnpm exec tsx load_cheguers.ts /opt/store /app/work/kb.db
rm -rf /opt/store
"""

SQLITE_LOAD = """
mkdir -p /app/work && python3 /opt/store/load_sqlite.py /opt/store /app/work/kb.db
rm -rf /opt/store
"""

FILES_HINT = (
    "The knowledge base is the file /app/data/corpus.jsonl: one record per line with id, labels, data and text. "
    "The text states each record's facts, including its relations to other records. Use the files in /app/data "
    "directly, with any tools you like (grep, python, and so on). There is no database for this task.\n\n"
)

SQLITE_HINT = (
    "The data is loaded into a SQLite database at /app/work/kb.db with tables records(id, label, data), "
    "edges(id, type, source_id, target_id) and vectors(record_id, dimensions, vector). Use the sqlite3 "
    "Python module to query it. You must answer from this database.\n\n"
)

CHEGUERS_FULL_HINT = (
    "MANDATORY: the CheguersDB CLI `cheguers` is installed, and the same data is loaded into the database "
    "/app/work/kb.db. You must use it to answer. Commands (each prints JSON on stdout):\n"
    "- `cheguers get /app/work/kb.db <id>` reads one record.\n"
    "- `cheguers query /app/work/kb.db --labels paper --where '<json>'` filters records. The query DSL "
    "allows {\"property\":\"name\",\"op\":\"eq\",\"value\":\"...\"} and related predicates.\n"
    "- `cheguers traverse /app/work/kb.db --start <id> --direction outgoing --types AUTHORED_BY,AFFILIATED_WITH --max-depth 2 --paths` "
    "follows typed edges.\n"
    "- `cheguers vec-search /app/work/kb.db --vector <csv> --top-k 10` runs vector search. The query vector comes from "
    "`python3 /app/data/embed.py \"<text>\"`.\n"
    "- `cheguers hybrid /app/work/kb.db --vector <csv> --seeds 10 --expand-depth 1 --top-n 20 --provenance` "
    "combines vector seeds with graph expansion.\n\n"
)

CHEGUERS_VECTOR_HINT = (
    "MANDATORY: the CheguersDB CLI `cheguers` is installed, and the same data is loaded into the database "
    "/app/work/kb.db. You must use it to answer, with vector search only: `cheguers vec-search "
    "/app/work/kb.db --vector <csv> --top-k 10` and `cheguers hybrid /app/work/kb.db --vector <csv> --seeds 10 "
    "--expand-depth 0 --top-n 20 --provenance`. Get the query vector from `python3 /app/data/embed.py \"<text>\"`. "
    "Do not use `traverse`.\n\n"
)

HINTS = {
    "files": FILES_HINT,
    "sqlite3": SQLITE_HINT,
    "cheguers-full": CHEGUERS_FULL_HINT,
    "cheguers-vector": CHEGUERS_VECTOR_HINT,
    "closed-book": "",
    "gold-context": "",
}


class SubscriptionClaudeCodeAgent(ClaudeCodeAgent):
    @property
    def _install_agent_script_path(self) -> Path:
        template = Path(claude_code_agent.__file__).parent / "claude-code-setup.sh.j2"
        content = render_setup_script(template, self._get_template_variables())
        script = tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False)
        script.write(content)
        script.close()
        os.chmod(script.name, 0o755)
        atexit.register(os.unlink, script.name)
        return Path(script.name)

    @property
    def _env(self) -> dict[str, str]:
        env = {
            "CLAUDE_CODE_OAUTH_TOKEN": os.environ["CLAUDE_CODE_OAUTH_TOKEN"],
            "FORCE_AUTO_BACKGROUND_TASKS": "1",
            "ENABLE_BACKGROUND_TASKS": "1",
        }
        if self._model_name:
            env["ANTHROPIC_MODEL"] = self._model_name.removeprefix("anthropic/")
        return env


MAX_TURNS = int(os.environ.get("ARM_MAX_TURNS", "12"))


class ArmAgent(SubscriptionClaudeCodeAgent):
    arm = "files"
    install = ""

    @property
    def _install_agent_script_path(self) -> Path:
        base = Path(super()._install_agent_script_path).read_text()
        script = tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False)
        script.write(base + self.install)
        script.close()
        os.chmod(script.name, 0o755)
        atexit.register(os.unlink, script.name)
        return Path(script.name)

    def _run_agent_commands(self, instruction: str):
        commands = super()._run_agent_commands(HINTS[self.arm] + instruction)
        for c in commands:
            if "claude --verbose" in c.command:
                c.command = c.command.replace("claude --verbose", f"claude --max-turns {MAX_TURNS} --verbose", 1)
                assert f"--max-turns {MAX_TURNS}" in c.command
        return commands


class FilesAgent(ArmAgent):
    arm = "files"


class Sqlite3Agent(ArmAgent):
    arm = "sqlite3"
    install = SQLITE_LOAD


class CheguersFullAgent(ArmAgent):
    arm = "cheguers-full"
    install = CHEGUERS_CLI


class CheguersVectorAgent(ArmAgent):
    arm = "cheguers-vector"
    install = CHEGUERS_CLI


class ClosedBookAgent(ArmAgent):
    arm = "closed-book"


class GoldContextAgent(ArmAgent):
    arm = "gold-context"
