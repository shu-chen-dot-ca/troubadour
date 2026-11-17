"""Signing in to the desktop with the passkey a device already has for Seraph (~/dev/github_searcher, remote_access/).

Seraph's remote access already puts this computer at its domain (REMOTE_ACCESS_DOMAIN, through its Caddy), and its
devices made their passkeys for that domain. The desktop lives on the same domain under /desktop/, so the same
passkeys work here, read from Seraph's own remote_access.json (never written: Seraph owns it). Removing a device in
Seraph (Settings → Remote access) ends its desktop sessions too.

The desktop keeps its own sessions, apart from Seraph's: a device signs in here once more (Face ID), and a desktop
session lasts SESSION_DAYS, less than Seraph's, since it controls the whole computer. data/sessions.json:

    {"sessions": [{"hash" (sha256 of its cookie), "device" (Seraph's device id), "expires_at"}]}

The passkey checks are Seraph's (github_searcher/remote_access.py sign_in): the challenge given out here in the last
CHALLENGE_SECONDS, the domain's origin and hash, "user verified", and the signature with the device's public key.
"""

import base64
import hashlib
import json
import os
import secrets
import time
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding
from cryptography.hazmat.primitives.serialization import load_der_public_key
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent
# override: what .env says wins over what the shell had, so a change applies at the next start.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
SERAPH_ENV = Path(os.environ["SERAPH_ENV"]).expanduser()
COOKIE = "desktop_session"
SESSION_DAYS = int(os.environ["SESSION_DAYS"])
CHALLENGE_SECONDS = 300
CHALLENGES_MAX = 1000
USER_PRESENT = 0x01
USER_VERIFIED = 0x04


def seraph_setting(name: str) -> str:
    """A value from Seraph's .env (the live copy's, ~/seraph/.env)."""
    for line in SERAPH_ENV.read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip()
    return ""


DOMAIN = seraph_setting("REMOTE_ACCESS_DOMAIN")
ORIGIN = f"https://{DOMAIN}"
SERAPH_DATA = Path(seraph_setting("DATA_DIR"))
if not SERAPH_DATA.is_absolute():
    SERAPH_DATA = SERAPH_ENV.parent / SERAPH_DATA


class SignInError(Exception):
    pass


class SignIn:
    def __init__(self):
        self.path = DATA_DIR / "sessions.json"
        self.challenges = {}
        if self.path.is_file():
            self.sessions = json.loads(self.path.read_text())["sessions"]
        else:
            self.sessions = []

    def save(self) -> None:
        now = time.time()
        self.sessions = [session for session in self.sessions if session["expires_at"] > now]
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        # Readable by this computer's user only. Write, then rename.
        temporary = self.path.with_name("sessions.json.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(json.dumps({"sessions": self.sessions}, indent=2))
        temporary.replace(self.path)

    def devices(self) -> list[dict]:
        """Seraph's devices, read fresh each time so a removed device is out at once."""
        path = SERAPH_DATA / "remote_access.json"
        if not path.is_file():
            return []
        return json.loads(path.read_text())["devices"]

    def from_outside(self, headers) -> bool:
        """Whether a request came through the domain (Caddy always adds X-Forwarded-For) rather than this computer."""
        host = headers.get("Host", "").split(":")[0]
        return (DOMAIN != "" and host == DOMAIN) or "X-Forwarded-For" in headers

    def device_for(self, cookie: str | None) -> dict | None:
        """The Seraph device a desktop session cookie belongs to, or None."""
        if not cookie:
            return None
        hashed = hashlib.sha256(cookie.encode()).hexdigest()
        now = time.time()
        device_id = None
        for session in self.sessions:
            if session["hash"] == hashed and session["expires_at"] > now:
                device_id = session["device"]
        if device_id is None:
            return None
        for device in self.devices():
            if device["id"] == device_id:
                return device
        return None

    def new_challenge(self) -> str:
        now = time.time()
        self.challenges = {challenge: given for challenge, given in self.challenges.items() if now - given < CHALLENGE_SECONDS}
        if len(self.challenges) >= CHALLENGES_MAX:
            raise SignInError("Too many sign ins at once. Try again in a few minutes.")
        challenge = secrets.token_urlsafe(32)
        self.challenges[challenge] = now
        return challenge

    def sign_in(self, assertion: dict) -> str:
        """Checks a passkey's answer and starts a desktop session. Returns its cookie.

        assertion: {"id", "client_data", "authenticator_data", "signature"}, all base64url.
        """
        device = None
        for each in self.devices():
            if each["credential_id"] == assertion["id"]:
                device = each
        if device is None:
            raise SignInError("This passkey isn't one of Seraph's devices. On the computer, Seraph → Settings → Remote access → Add a device.")
        client_data_bytes = base64.urlsafe_b64decode(assertion["client_data"] + "==")
        client_data = json.loads(client_data_bytes)
        if client_data.get("type") != "webauthn.get" or client_data.get("origin") != ORIGIN:
            raise SignInError("The passkey answered for another address. Try again.")
        given = self.challenges.pop(client_data.get("challenge"), None)
        if given is None or time.time() - given > CHALLENGE_SECONDS:
            raise SignInError("That took too long. Try again.")
        authenticator_data = base64.urlsafe_b64decode(assertion["authenticator_data"] + "==")
        if len(authenticator_data) < 37 or authenticator_data[:32] != hashlib.sha256(DOMAIN.encode()).digest():
            raise SignInError("The passkey answered for another address. Try again.")
        if (authenticator_data[32] & USER_PRESENT) == 0 or (authenticator_data[32] & USER_VERIFIED) == 0:
            raise SignInError("The passkey didn't check it's you (Face ID, fingerprint or PIN). Try again.")
        public_key = load_der_public_key(base64.urlsafe_b64decode(device["public_key"] + "=="))
        signed = authenticator_data + hashlib.sha256(client_data_bytes).digest()
        signature = base64.urlsafe_b64decode(assertion["signature"] + "==")
        try:
            if device["algorithm"] == -7:
                public_key.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
            else:
                public_key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
        except InvalidSignature:
            raise SignInError("That passkey's answer doesn't check out. Try again.")
        cookie = secrets.token_urlsafe(32)
        self.sessions.append({"hash": hashlib.sha256(cookie.encode()).hexdigest(), "device": device["id"], "expires_at": time.time() + SESSION_DAYS * 86400})
        self.save()
        return cookie

    def sign_out(self, cookie: str | None) -> None:
        if not cookie:
            return
        hashed = hashlib.sha256(cookie.encode()).hexdigest()
        self.sessions = [session for session in self.sessions if session["hash"] != hashed]
        self.save()
