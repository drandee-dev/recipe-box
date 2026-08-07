"""What the CORS config allows, and what it must keep refusing.

Worth having as a test rather than a one-off check: this is the only rule in the
backend whose failure mode is invisible from the server side. Too tight and every
preview deployment fails every request as "Failed to fetch"; too loose and any
page anywhere can drive the API through someone's browser. Neither shows up in a
log until someone hits it.

Stdlib unittest and fastapi's TestClient, which is httpx — both already present.
Run from `backend/`:

    python -m unittest discover -s tests
"""

import importlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

PRODUCTION = "https://recipe-box-coral.vercel.app"


def build_client(*, deployed: bool, origins: str = PRODUCTION) -> TestClient:
    """A client whose app was built under the given environment.

    The CORS config is read once, at import, so switching environments means
    reloading the modules that read it rather than just setting a variable.
    """
    os.environ["RECIPE_CORS_ORIGINS"] = origins
    if deployed:
        os.environ["VERCEL_ENV"] = "production"
    else:
        os.environ.pop("VERCEL_ENV", None)

    from app import config, main

    importlib.reload(config)
    importlib.reload(main)
    return TestClient(main.app)


def preflight(client: TestClient, origin: str):
    return client.options(
        "/api/recipes/extract",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )


def allowed(client: TestClient, origin: str) -> bool:
    return "access-control-allow-origin" in preflight(client, origin).headers


class DeployedCors(unittest.TestCase):
    def setUp(self):
        self.client = build_client(deployed=True)

    def test_production_frontend_is_allowed(self):
        self.assertTrue(allowed(self.client, PRODUCTION))

    def test_preview_hostnames_are_allowed(self):
        # Vercel names a preview after the branch, and each deployment after a
        # hash. Both are real origins a browser will send.
        for origin in (
            "https://recipe-box-git-audit-fixes-drandee.vercel.app",
            "https://recipe-box-git-some-other-branch-drandee.vercel.app",
            "https://recipe-box-a1b2c3d4-drandee.vercel.app",
            "https://recipe-box-api-git-audit-fixes-drandee.vercel.app",
        ):
            with self.subTest(origin=origin):
                self.assertTrue(allowed(self.client, origin))

    def test_localhost_is_not_allowed_on_a_deployment(self):
        # It was, unconditionally, purely because it was the default.
        self.assertFalse(allowed(self.client, "http://localhost:5173"))

    def test_another_vercel_account_is_refused(self):
        # The account slug is what keeps the preview pattern narrow. Without it,
        # anyone could deploy a project of the same name and be trusted.
        self.assertFalse(allowed(self.client, "https://recipe-box-git-x-mallory.vercel.app"))

    def test_a_lookalike_suffix_is_refused(self):
        # The failure an unanchored pattern gives you: our whole preview host,
        # then somebody else's domain glued to the end of it.
        self.assertFalse(
            allowed(self.client, "https://recipe-box-git-x-drandee.vercel.app.evil.com")
        )

    def test_an_unrelated_origin_is_refused(self):
        self.assertFalse(allowed(self.client, "https://evil.example.com"))

    def test_credentials_are_not_granted(self):
        # Auth is a bearer token, which is an ordinary header. Nothing reads a
        # cookie, so the browser is never told cross-origin credentials are ok.
        resp = preflight(self.client, PRODUCTION)
        self.assertNotIn("access-control-allow-credentials", resp.headers)

    def test_a_real_response_carries_the_header_too(self):
        # The preflight passing is only half of it; the browser also checks the
        # actual response before handing the body to JavaScript.
        resp = self.client.get("/api/health", headers={"Origin": PRODUCTION})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("access-control-allow-origin"), PRODUCTION)


class LocalCors(unittest.TestCase):
    def setUp(self):
        self.client = build_client(deployed=False)

    def test_localhost_is_allowed_off_a_deployment(self):
        self.assertTrue(allowed(self.client, "http://localhost:5173"))
        self.assertTrue(allowed(self.client, "http://localhost:4173"))

    def test_unrelated_origins_are_still_refused(self):
        self.assertFalse(allowed(self.client, "https://evil.example.com"))


class MisconfiguredDeployment(unittest.TestCase):
    def test_no_named_origins_does_not_crash_and_still_serves_previews(self):
        # Production reaches this API by being named in RECIPE_CORS_ORIGINS and
        # nothing else, so an empty value means the API is refusing its own site.
        # It should warn rather than fail to start.
        client = build_client(deployed=True, origins="")
        self.assertFalse(allowed(client, PRODUCTION))
        self.assertTrue(allowed(client, "https://recipe-box-git-x-drandee.vercel.app"))


if __name__ == "__main__":
    unittest.main()
