import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


PLUGIN = Path(__file__).resolve().parents[1]
SCRIPT = PLUGIN / "scripts/jev_router.py"
spec = importlib.util.spec_from_file_location("jev_router", SCRIPT)
router = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router)


def answer(profiles, choice="build"):
    probabilities = {key: 0.0 for key in (*profiles, "defer")}
    probabilities[choice] = 1.0
    return {"model": router.MODEL, "answers": {"route": {
        "type": "choice", "choice": choice, "probabilities": probabilities,
        "confidence": 0.85,
    }}, "usage": {"input_tokens": 10, "output_tokens": 2}}


def event(tool_input=None, **changes):
    return {"hook_event_name": "PreToolUse", "tool_name": "spawn_agent",
            "model": "active-parent-is-not-a-pin", "tool_input": tool_input or {"message": "Run tests"}, **changes}


class CatalogCase:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / "subagent-router"
        self.directory.mkdir()
        env = patch.dict(os.environ, {"CODEX_HOME": self.temp.name,
                                   "TYPESAFE_API_KEY": "key", "JEV_API_KEY": ""})
        env.start()
        self.addCleanup(env.stop)
        self.add_profile("build", "Implement or test code", "custom/model-42", "high")
        self.add_profile("observe", "Read files and run checks", "other/provider", "max")

    def add_profile(self, name, description, model, effort):
        (self.directory / f"{name}.json").write_text(json.dumps({
            "description": description, "model": model, "reasoning_effort": effort,
        }))


class JevRouterTests(CatalogCase, unittest.TestCase):
    def test_packaged_hook_and_main(self):
        config = json.loads((PLUGIN / "hooks/hooks.json").read_text())
        self.assertEqual(set(config["hooks"]), {"PreToolUse"})
        group, = config["hooks"]["PreToolUse"]
        self.assertEqual(group["matcher"], "^spawn_agent$")
        handler, = group["hooks"]
        self.assertEqual(handler["type"], "command")
        self.assertEqual(handler["timeout"], 15)
        self.assertIn("scripts/jev_router.py", handler["command"])
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT)], input=json.dumps(event()), text=True,
            capture_output=True, env={**os.environ, "TYPESAFE_API_KEY": "", "JEV_API_KEY": ""},
            timeout=5,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), "Jev routing unavailable; using native spawn defaults.")
        stdout = io.StringIO()
        with patch.object(router, "ask_jev", return_value=answer(("build", "observe"))) as ask, \
             patch.object(sys, "stdin", io.StringIO(json.dumps(event()))), \
             contextlib.redirect_stdout(stdout):
            router.main()
        ask.assert_called_once()
        self.assertEqual(json.loads(stdout.getvalue())["hookSpecificOutput"]["updatedInput"],
                         {"message": "Run tests", "model": "custom/model-42", "reasoning_effort": "high"})

    def test_explicit_pins_and_unrelated_inputs_never_read_catalog(self):
        cases = [
            None, [], {}, {"hook_event_name": "SubagentStart"},
            event(tool_name="Agent"), event(tool_name="multi_agent_v1__spawn_agent"),
            event({"message": " "}), event({"message": "Run", "model": "pinned"}),
            event({"message": "Run", "model": ""}),
            event({"message": "Run", "reasoning_effort": "low"}),
            event({"message": "Run", "agent_type": "reviewer"}),
            event({"items": [{"type": "image", "image_url": "data:"}]}),
            event({"items": [{"type": "text", "text": "Run"}, {"type": "image"}]}),
            event({"message": "Run", "items": [{"type": "text", "text": "Tests"}]}),
            event({"items": [{"type": "text", "text": "  "}]}),
        ]
        with patch.object(router, "load_profiles", side_effect=AssertionError("catalog read")):
            for candidate in cases:
                with self.subTest(candidate=candidate):
                    self.assertIsNone(router.route(candidate))

    def test_fresh_catalog_multiple_producers_and_preserved_arguments(self):
        original = {"items": [{"type": "text", "text": " Implement"}, {"type": "text", "text": "tests "}],
                    "model": None, "reasoning_effort": None, "fork_context": True,
                    "custom": {"keep": [1, 2]}}
        with patch.object(router, "ask_jev", return_value=answer(("build", "observe"))) as ask:
            result = router.route(event(original))
        ask.assert_called_once_with("Implement\ntests", "key", router.load_profiles())
        self.assertEqual(result["hookSpecificOutput"]["updatedInput"],
                         {**original, "model": "custom/model-42", "reasoning_effort": "high"})
        self.assertEqual(original["model"], None)

        self.add_profile("external_plugin", "Inspect logs", "new/provider", "medium")
        self.add_profile("build", "Implement or test code", "updated/model", "low")
        with patch.object(router, "ask_jev",
                          return_value=answer(("build", "external_plugin", "observe"), "external_plugin")) as ask:
            result = router.route(event())
        self.assertEqual(set(ask.call_args.args[2]), {"build", "external_plugin", "observe"})
        self.assertEqual(result["hookSpecificOutput"]["updatedInput"]["model"], "new/provider")
        with patch.object(router, "ask_jev",
                          return_value=answer(("build", "external_plugin", "observe"))):
            result = router.route(event())
        self.assertEqual(result["hookSpecificOutput"]["updatedInput"]["model"], "updated/model")

    def test_empty_invalid_reserved_and_over_limit_catalog_never_calls_provider(self):
        for path in self.directory.iterdir():
            path.unlink()
        with patch.object(router, "ask_jev", side_effect=AssertionError("provider called")):
            self.assertIsNone(router.route(event()))

        self.add_profile("valid", "Valid", "valid/model", "high")
        invalid = [
            ("defer.json", "{}", "reserved id"),
            ("bad.json", '{"model":"SECRET', "invalid JSON"),
            ("bad.json", "[]", "expected JSON object"),
            ("bad.json", '{"description":" ","model":"SECRET","reasoning_effort":"high"}',
             "description must be a nonempty string"),
            ("bad.json", '{"description":"safe","model":2,"reasoning_effort":"high"}',
             "model must be a nonempty string"),
            ("bad.json", '{"description":"safe","model":"x","reasoning_effort":null}',
             "reasoning_effort must be a nonempty string"),
        ]
        for name, content, reason in invalid:
            with self.subTest(reason=reason):
                path = self.directory / name
                path.write_text(content)
                stderr = io.StringIO()
                with patch.object(router, "ask_jev", side_effect=AssertionError("provider called")), \
                     contextlib.redirect_stderr(stderr):
                    self.assertIsNone(router.route(event()))
                self.assertIn(reason, stderr.getvalue())
                self.assertNotIn("SECRET", stderr.getvalue())
                path.unlink()

        for index in range(253):
            self.add_profile(f"p{index:03}", "Profile", "x", "high")
        profiles = router.load_profiles()
        self.assertEqual(len(profiles), 254)
        with patch.object(router, "ask_jev", return_value=answer(profiles, "p252")) as ask:
            result = router.route(event())
        self.assertEqual(len(ask.call_args.args[2]), 254)
        self.assertEqual(result["hookSpecificOutput"]["updatedInput"]["model"], "x")
        self.add_profile("one_more", "Profile", "x", "high")
        stderr = io.StringIO()
        with patch.object(router, "ask_jev", side_effect=AssertionError("provider called")), \
             contextlib.redirect_stderr(stderr):
            self.assertIsNone(router.route(event()))
        self.assertIn("more than 254 profiles", stderr.getvalue())

    def test_dynamic_response_validation_defer_and_provider_failure(self):
        profiles = router.load_profiles()
        with patch.object(router, "ask_jev", return_value=answer(profiles, "defer")):
            self.assertIsNone(router.route(event()))
        for mutate in (
            lambda a: a["answers"]["route"].update(choice="unknown"),
            lambda a: a["answers"]["route"]["probabilities"].pop("observe"),
            lambda a: a["answers"]["route"]["probabilities"].update(extra=0),
            lambda a: a["answers"]["route"]["probabilities"].update(build=float("nan")),
            lambda a: a["answers"]["route"]["probabilities"].update(build=0.2),
            lambda a: a["answers"]["route"].update(confidence=1.1),
            lambda a: a.update(model="unexpected"),
        ):
            bad = copy.deepcopy(answer(profiles))
            mutate(bad)
            with self.subTest(bad=bad), patch.object(router, "ask_jev", return_value=bad), \
                 contextlib.redirect_stderr(io.StringIO()):
                self.assertIsNone(router.route(event()))
        warning = io.StringIO()
        with patch.object(router, "ask_jev", side_effect=RuntimeError("SECRET and prompt")), \
             contextlib.redirect_stderr(warning):
            self.assertIsNone(router.route(event()))
        self.assertEqual(warning.getvalue().strip(), "Jev routing unavailable; using native spawn defaults.")

    def test_sdk_import_absence_keeps_native_input(self):
        with patch.dict(sys.modules, {"typesafe_sdk": None}), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(router.route(event()))


try:
    import httpx2
    import typesafe_sdk
except ImportError:
    httpx2 = None
    typesafe_sdk = None


@unittest.skipUnless(typesafe_sdk is not None, "typesafe-sdk not installed; CI installs requirements.txt")
class SdkTransportTests(CatalogCase, unittest.TestCase):
    def run_transport(self, statuses):
        requests = []
        statuses = iter(statuses)

        def handler(request):
            requests.append(request)
            status = next(statuses)
            if status == 200:
                return httpx2.Response(200, json=answer(router.load_profiles()))
            return httpx2.Response(status, json={"error": {"message": "SECRET remote failure"}})

        original_client = typesafe_sdk.TypeSafeClient

        def client_factory(**kwargs):
            self.assertEqual(kwargs["retry"].max_retries, 2)
            self.assertEqual(kwargs["retry"].timeout, 10.0)
            return original_client(**kwargs, transport=httpx2.MockTransport(handler))

        stderr = io.StringIO()
        with patch.object(typesafe_sdk, "TypeSafeClient", side_effect=client_factory), \
             contextlib.redirect_stderr(stderr):
            result = router.route(event({"message": "Run existing tests", "fork_context": False}))
        return result, requests, stderr.getvalue()

    def test_real_sdk_request_and_403_does_not_retry(self):
        result, requests, stderr = self.run_transport([200])
        self.assertEqual(len(requests), 1)
        body = json.loads(requests[0].content)
        self.assertEqual(body["state"], {"mission": "Run existing tests"})
        self.assertEqual(body["questions"], {"route": {
            "type": "choice", "instructions": router.INSTRUCTIONS,
            "criteria": {"build": "Implement or test code", "observe": "Read files and run checks",
                         "defer": router.DEFER},
        }})
        self.assertEqual(result["hookSpecificOutput"]["updatedInput"], {
            "message": "Run existing tests", "fork_context": False,
            "model": "custom/model-42", "reasoning_effort": "high"})
        self.assertEqual(stderr, "")
        result, requests, stderr = self.run_transport([403])
        self.assertIsNone(result)
        self.assertEqual(len(requests), 1)
        self.assertNotIn("SECRET", stderr)

    def test_real_sdk_transient_retry_then_success_and_exhaustion(self):
        result, requests, stderr = self.run_transport([503, 200])
        self.assertEqual(len(requests), 2)
        self.assertEqual(result["hookSpecificOutput"]["updatedInput"]["model"], "custom/model-42")
        self.assertEqual(stderr, "")
        result, requests, stderr = self.run_transport([503, 503, 503])
        self.assertIsNone(result)
        self.assertEqual(len(requests), 3)
        self.assertNotIn("SECRET", stderr)

    def test_real_sdk_sends_all_254_profiles_plus_defer(self):
        for index in range(252):
            self.add_profile(f"p{index:03}", "Profile", "x", "high")
        result, requests, stderr = self.run_transport([200])
        self.assertEqual(len(requests), 1)
        criteria = json.loads(requests[0].content)["questions"]["route"]["criteria"]
        self.assertEqual(len(criteria), 255)
        self.assertIn("p251", criteria)
        self.assertEqual(result["hookSpecificOutput"]["updatedInput"]["model"], "custom/model-42")
        self.assertEqual(stderr, "")


if __name__ == "__main__":
    unittest.main()
