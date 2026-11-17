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
# Workflows whose Mac placement another change owns; each names why.
ALLOWED_FILES: dict[str, str] = {
    "app-ffi-release.yml": "its build's runs-on is being changed by a separate FFI-only placement override; it "
                           "already gates its Blacksmith choices behind the switch except the rescue input",
}
# Jobs that still reach Blacksmith macOS with the switch off because the side lane cannot stand in for them.
# Each is debt with its reason, not a pass: an entry that no longer reaches Blacksmith fails, so the list shrinks.
SIGNING = ("holds signing or release material: its runner stays under runner trust policy "
           "(runs_on_labels.holds_signing_material); an owned trusted route is its own change")
MACOS_15 = ("falls back to the macOS 15 image, a second Xcode or a display host; the side lane is macOS 26 with one "
            "Xcode, so moving it is a capability call no owned macOS 15 pool answers yet")
IOS = "needs installed iOS runtimes (macos_26_ios), which the side lane does not declare"
DELIVERY = "nightly delivery: placed by the nightly trusted-pool routing (test_ci_nightly_off_blacksmith.py)"
UNTRUSTED = "an untrusted ref builds on an ephemeral Blacksmith machine by design, never on an owned Mac"
MEASURES = "measures Blacksmith itself: it runs only when dispatched with a Blacksmith runner_class"
ALLOWED_JOBS: dict[tuple[str, str], str] = {
    ("agent-brands.yml", "swift-test"): MACOS_15,
    ("auth-refresh-tests.yml", "auth-refresh-tests"): MACOS_15,
    ("auto-resume-nightly-notarization.yml", "wait-and-staple"): SIGNING,
    ("auto-resume-nightly-notarization.yml", "staple-outer"): SIGNING,
    ("auto-resume-nightly-notarization.yml", "staple-stapled"): DELIVERY,
    ("auto-resume-nightly-notarization.yml", "verify-stapled"): DELIVERY,
    ("auto-resume-nightly-notarization.yml", "generate-deltas"): DELIVERY,
    ("build-ghosttykit.yml", "build-ghosttykit"): MACOS_15,
    ("ci-macos.yml", "macos-compile-admission"): MACOS_15,
    ("ci-macos.yml", "swift-package-tests"): MACOS_15,
    ("cloud-chat-proof.yml", "proof-staging"): SIGNING,
    ("cloud-chat-proof.yml", "proof-prod"): SIGNING,
    ("cmux-mobile-ffi.yml", "apple"): MACOS_15,
    ("cmux-next-daemon-macos-shadow.yml", "cmux-next-daemon-macos-shadow"): MACOS_15,
    ("cmux-next-dev-daily.yml", "sign"): SIGNING,
    ("cmux-next-dev-daily.yml", "sign-blacksmith"): SIGNING,
    ("cmux-next-dev-daily.yml", "verify"): SIGNING,
    ("cmux-next-perf-budgets.yml", "blacksmith-mac"): MEASURES,
    ("cmux-next-source-archive.yml", "archive"): MACOS_15,
    ("cmux-tui-team-signed.yml", "sign"): SIGNING,
    ("cmux-tui.yml", "macos"): MACOS_15,
    ("cmux-vnc.yml", "swift-test"): MACOS_15,
    ("coderouter-release.yml", "build"): SIGNING,
    ("dogfood-artifact-publish.yml", "capture"): MACOS_15,
    ("gateway-e2e.yml", "mac"): MACOS_15,
    ("ios-appstore-upload.yml", "upload"): SIGNING,
    ("ios-e2e.yml", "mac-ios-e2e"): IOS,
    ("ios-internal-nightly.yml", "archive"): IOS,
    ("ios-internal-nightly.yml", "upload"): SIGNING,
    ("ios-review-gate.yml", "reviewer-path"): SIGNING,
    ("ios-review-gate.yml", "asc-validate"): IOS,
    ("ios-streamed-validate.yml", "validate"): IOS,
    ("ios-testflight.yml", "upload"): SIGNING,
    ("iroh-release-gate.yml", "tailscale-version-skew"): MACOS_15,
    ("relay-publish-npm.yml", "smoke"): MACOS_15,
    ("relay-tls.yml", "diagnostic-presentation"): MACOS_15,
    ("relay-tls.yml", "system-keychain"): MACOS_15,
    ("release.yml", "build-ghostty-cli-helper"): MACOS_15,
    ("release.yml", "build-sign-notarize"): SIGNING,
    ("release.yml", "build-sign-notarize-blacksmith"): SIGNING,
    ("reload-build.yml", "build"): UNTRUSTED,
    ("remote-daemon.yml", "remote-daemon-macos-tests"): MACOS_15,
    ("repair-v0-64-25-helper-rpaths.yml", "repair"): SIGNING,
    ("repair-v0-64-25-helper-rpaths.yml", "repair-blacksmith"): SIGNING,
    ("resume-nightly-notarization.yml", "resume"): SIGNING,
    ("resume-nightly-notarization.yml", "verify-stapled"): DELIVERY,
    ("seed-swiftpm-manifests.yml", "seed"): MACOS_15,
    ("stable-next.yml", "sign"): SIGNING,
    ("terminal-hang-diagnostics.yml", "phase-attribution"): MACOS_15,
}
INDEX = re.compile(r"\[\s*(?:'([^']*)'|([0-9]+))\s*\]")
STRING = re.compile(r"'(?:[^']|'')*'")


def _indexes_as_properties(body: str) -> str:
    """`x['a-b']` and `x[0]` as `x.a_b` and `x.i0` outside string literals: runs_on_labels reads no index, and an
    index only ever selects a picker's output here (`fromJSON(needs.p.outputs.runners)['job']`), an unknown."""
    out, at = [], 0
    while at < len(body):
        index = INDEX.match(body, at) if body[at] == "[" else None
        literal = STRING.match(body, at) if body[at] == "'" else None
        if index is not None:
            key = index.group(1) if index.group(1) is not None else f"i{index.group(2)}"
            out.append("." + re.sub(r"\W", "_", key))
            at = index.end()
        elif literal is not None:
            out.append(literal.group(0))
            at = literal.end()
        else:
            out.append(body[at])
            at += 1
    return "".join(out)


def blacksmith_macos_labels(runs_on: str, switch: str = "") -> list[str]:
    """Every Blacksmith macOS label `runs_on` can select with the switch at `switch` and the side lane set."""
    text = runs_on.strip()
    whole = gh_expressions.EXPRESSION.fullmatch(text)
    if whole is None:
        if "${{" in text:
            raise ValueError(f"runs-on mixes text and an expression: {text!r}")
        return [text] if BLACKSMITH_MACOS.match(text) else []
    body = _indexes_as_properties(whole.group(1))
    for predicate in FORK_PREDICATES:
        body = body.replace(predicate, "false")
    variables = {SWITCH: switch, "CI_SIDE_LANE_RUNNER": SIDE_LANE}
    for name in MACOS_RUNNER_VAR.findall(body):
        variables[name] = f"blacksmith-macos (vars.{name})"
    tree = runs_on_labels._Parser(body).parse()
    labels = runs_on_labels._Evaluator(runs_on_labels.OWNER, variables)(tree)
    return sorted(label for label in labels if isinstance(label, str) and BLACKSMITH_MACOS.match(label))


def reaching(documents: Mapping[str, Mapping]) -> dict[tuple[str, str], list[str]]:
    """(workflow, job) -> the Blacksmith macOS labels its runs-on reaches with the switch off, for every job that
    reaches one."""
    workflows = workflow_jobs.Workflows(documents)
    out: dict[tuple[str, str], list[str]] = {}
    for name, document in sorted(documents.items()):
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
                out[(name, job_id)] = sorted(found)
    return out


def offenders(documents: Mapping[str, Mapping]) -> list[str]:
    return [f"{name} {job_id}: {', '.join(labels)}" for (name, job_id), labels in reaching(documents).items()
            if name not in ALLOWED_FILES and (name, job_id) not in ALLOWED_JOBS]


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
    @classmethod
    def setUpClass(cls) -> None:
        cls.documents = {path.name: workflow_jobs.document(path) for path in sorted(WORKFLOWS.glob("*.yml"))}

    def test_no_workflow_reaches_blacksmith_macos_with_the_switch_off(self) -> None:
        found = offenders(self.documents)
        self.assertEqual(found, [], "runs-on that reach Blacksmith macOS with CI_BLACKSMITH_MACOS off; gate each "
                         "Blacksmith alternative with `vars.CI_BLACKSMITH_MACOS != 'on' && "
                         "vars.CI_SIDE_LANE_RUNNER || ...`:\n" + "\n".join(found))

    def test_every_allowance_is_still_needed(self) -> None:
        reached = reaching(self.documents)
        for name in ALLOWED_FILES:
            self.assertTrue((WORKFLOWS / name).is_file(), name)
        stale = sorted(f"{name} {job_id}" for name, job_id in ALLOWED_JOBS if (name, job_id) not in reached)
        self.assertEqual(stale, [], "these jobs no longer reach Blacksmith macOS with the switch off; drop their "
                         "ALLOWED_JOBS entries")


if __name__ == "__main__":
    unittest.main()
