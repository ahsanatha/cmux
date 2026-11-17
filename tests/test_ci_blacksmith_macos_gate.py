#!/usr/bin/env python3
"""No runs-on reaches a Blacksmith macOS label while `vars.CI_BLACKSMITH_MACOS` keeps Mac jobs off Blacksmith.

On 2026-11-11 the team asked to "just stop using blacksmith temporarily"; the switch is
`vars.CI_BLACKSMITH_MACOS` (`on` sends Mac jobs to Blacksmith, `pr-rescue` only a pull request's
re-runs, anything else none). A runs-on that names a Blacksmith macOS label without reading the switch
still schedules there: on 2026-11-17 two cmux-next jobs sat queued for over half an hour on
`blacksmith-6vcpu-macos-26`, a label with no runner behind it. The pattern every Mac fallback follows
is app-ffi-release.yml's build: `vars.CI_BLACKSMITH_MACOS != 'on' && vars.CI_SIDE_LANE_RUNNER || <Blacksmith>`.

This evaluates every job's runs-on (each matrix cell and reusable-workflow input expanded) with the
switch off and the side lane set, and fails on any label that is still Blacksmith macOS: a literal
`blacksmith-*-macos-*`, a `fromJSON(vars.RUNNER_POOLS).macos_*` read (every member is Blacksmith), or a
`vars.MACOS_RUNNER_*` read (each holds a Blacksmith label). Conditions on unknown contexts (the event, the
attempt, a picker's output) go both ways, so a gate has to sit on the Blacksmith alternative itself.

A fork's pull request gets no repository variables, so the switch cannot reach it; its routing is
test_ci_fork_runner_routing.py's, and its predicate reads false here.
"""

from __future__ import annotations

import re
import sys
import unittest
from collections.abc import Mapping
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
import gh_expressions  # noqa: E402
import runs_on_labels  # noqa: E402
import workflow_jobs  # noqa: E402

WORKFLOWS = ROOT / ".github" / "workflows"
SWITCH = "CI_BLACKSMITH_MACOS"
# Values of the switch that keep every Mac job off Blacksmith: unset and the explicit off.
OFF_STATES = ("", "off")
SIDE_LANE = "glaeda-side-std-xcode-26.6"
BLACKSMITH_MACOS = re.compile(r"blacksmith-.*macos")
MACOS_RUNNER_VAR = re.compile(r"\bvars\.(MACOS_RUNNER_[A-Z0-9_]+)\b")
FORK_PREDICATES = (
    "github.event.pull_request.head.repo.full_name != github.repository",
    "github.event.pull_request.head.repo.fork",
)
# Files whose Mac placement is changed by another pull request; each names why.
ALLOWED: dict[str, str] = {}


def blacksmith_macos_labels(runs_on: str, switch: str = "") -> list[str]:
    """Every Blacksmith macOS label `runs_on` can select with the switch at `switch` and the side lane set."""
    text = runs_on.strip()
    whole = gh_expressions.EXPRESSION.fullmatch(text)
    if whole is None:
        if "${{" in text:
            raise ValueError(f"runs-on mixes text and an expression: {text!r}")
        return [text] if BLACKSMITH_MACOS.match(text) else []
    body = whole.group(1)
    for predicate in FORK_PREDICATES:
        body = body.replace(predicate, "false")
    variables = {SWITCH: switch, "CI_SIDE_LANE_RUNNER": SIDE_LANE}
    for name in MACOS_RUNNER_VAR.findall(body):
        variables[name] = f"blacksmith-macos (vars.{name})"
    tree = runs_on_labels._Parser(body).parse()
    labels = runs_on_labels._Evaluator(runs_on_labels.OWNER, variables)(tree)
    return sorted(label for label in labels if isinstance(label, str) and BLACKSMITH_MACOS.match(label))


def offenders(documents: Mapping[str, Mapping]) -> list[str]:
    workflows = workflow_jobs.Workflows(documents)
    out = []
    for name, document in sorted(documents.items()):
        if name in ALLOWED:
            continue
        for job_id, job in ((document or {}).get("jobs") or {}).items():
            if not isinstance(job, Mapping) or "runs-on" not in job:
                continue
            cells = workflow_jobs.runs_on_label_cells(job, name, workflows)
            if cells is None:
                cells = [tuple(item for item in workflow_jobs.runs_on_items(job) if isinstance(item, str))]
            found: set[str] = set()
            for cell in cells:
                for item in cell:
                    for state in OFF_STATES:
                        found.update(blacksmith_macos_labels(item, state))
            if found:
                out.append(f"{name} {job_id}: {', '.join(sorted(found))}")
    return out


class Expressions(unittest.TestCase):
    def test_a_bare_label_fails(self) -> None:
        self.assertEqual(blacksmith_macos_labels("blacksmith-6vcpu-macos-26"), ["blacksmith-6vcpu-macos-26"])
        self.assertEqual(blacksmith_macos_labels(
            "${{ github.repository_owner != 'manaflow-ai' && 'macos-26' || 'blacksmith-12vcpu-macos-26' }}"),
            ["blacksmith-12vcpu-macos-26"])

    def test_a_pool_or_runner_variable_read_fails(self) -> None:
        self.assertEqual(blacksmith_macos_labels("${{ fromJSON(vars.RUNNER_POOLS).macos_26_large }}"),
                         ["blacksmith-12vcpu-macos-26"])
        self.assertEqual(blacksmith_macos_labels("${{ vars.MACOS_RUNNER_26 || 'x' }}"),
                         ["blacksmith-macos (vars.MACOS_RUNNER_26)"])

    def test_a_condition_on_an_unknown_does_not_gate(self) -> None:
        self.assertEqual(blacksmith_macos_labels(
            "${{ github.run_attempt == 1 && needs.p.outputs.runner || fromJSON(vars.RUNNER_POOLS).macos_26 }}"),
            ["blacksmith-6vcpu-macos-26"])

    def test_the_switch_gate_passes(self) -> None:
        gated = ("${{ github.repository_owner != 'manaflow-ai' && 'macos-26' || "
                 "vars.CI_BLACKSMITH_MACOS != 'on' && vars.CI_SIDE_LANE_RUNNER || vars.MACOS_RUNNER_26 || "
                 "fromJSON(vars.RUNNER_POOLS).macos_26 }}")
        for state in OFF_STATES:
            self.assertEqual(blacksmith_macos_labels(gated, state), [])
        self.assertNotEqual(blacksmith_macos_labels(gated, "on"), [])
        # cmux-next's pull-request rescue form: off keeps the side lane; only `pr-rescue` reaches Blacksmith.
        rescue = ("${{ (vars.CI_BLACKSMITH_MACOS != 'pr-rescue' || github.run_attempt < 2) && "
                  "vars.CI_BLACKSMITH_MACOS != 'on' && vars.CI_SIDE_LANE_RUNNER || vars.MACOS_RUNNER_26 }}")
        self.assertEqual(blacksmith_macos_labels(rescue), [])
        self.assertNotEqual(blacksmith_macos_labels(rescue, "pr-rescue"), [])

    def test_a_fork_branch_is_not_this_check_s(self) -> None:
        self.assertEqual(blacksmith_macos_labels(
            "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != "
            "github.repository && 'blacksmith-6vcpu-macos-26' || vars.CI_SIDE_LANE_RUNNER }}"), [])

    def test_linux_and_owned_labels_pass(self) -> None:
        self.assertEqual(blacksmith_macos_labels("${{ vars.LINUX_RUNNER || 'blacksmith-4vcpu-ubuntu-2404' }}"), [])
        self.assertEqual(blacksmith_macos_labels("glaeda-side-std-xcode-26.6"), [])


class Tree(unittest.TestCase):
    def test_no_workflow_reaches_blacksmith_macos_with_the_switch_off(self) -> None:
        documents = {path.name: workflow_jobs.document(path) for path in sorted(WORKFLOWS.glob("*.yml"))}
        found = offenders(documents)
        self.assertEqual(found, [], "runs-on that reach Blacksmith macOS with CI_BLACKSMITH_MACOS off; gate each "
                         "Blacksmith alternative with `vars.CI_BLACKSMITH_MACOS != 'on' && "
                         "vars.CI_SIDE_LANE_RUNNER || ...`:\n" + "\n".join(found))

    def test_every_allowance_names_a_workflow(self) -> None:
        for name in ALLOWED:
            self.assertTrue((WORKFLOWS / name).is_file(), name)


if __name__ == "__main__":
    unittest.main()
