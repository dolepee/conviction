#!/usr/bin/env python3
"""Fast OKX.AI A2A responder for Conviction's non-custodial execution service.

Ordinary pre-acceptance buyers receive the strict request schema once. Known
platform reviewers receive a market-specific execution-card sample. The
responder never signs, broadcasts, or accepts wallet secrets.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Callable

from telegram_outbox import (
    flush_notifications,
    normalize_outbox_state,
    queue_notification,
    send_telegram,
    telegram_config,
)


AGENT_ID = os.environ.get("CONVICTION_AGENT_ID", "7034").strip()
AGENT_NAME = "Conviction"
SERVICE_NAME = "Bounded YES/NO Position Card"
PUBLIC_URL = os.environ.get(
    "CONVICTION_PUBLIC_URL", "https://conviction-bay.vercel.app"
).rstrip("/")
PLATFORM_REVIEW_AGENT_IDS = {
    value.strip()
    for value in os.environ.get("OKX_PLATFORM_REVIEW_AGENT_IDS", "1791").split(",")
    if value.strip()
}

HOME = Path.home()
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TASK_HOME = Path(os.environ.get("OKX_AGENT_TASK_HOME", HOME / ".okx-agent-task"))
LISTENER_LOG = Path(os.environ.get("CONVICTION_A2A_LOG", TASK_HOME / "logs" / "listener.log"))
STATE_PATH = Path(
    os.environ.get("CONVICTION_FAST_RESPONDER_STATE", TASK_HOME / "conviction-fast-responder.json")
)
LOG_PATH = Path(
    os.environ.get("CONVICTION_FAST_RESPONDER_LOG", TASK_HOME / "logs" / "conviction-fast-responder.log")
)
TELEGRAM_ENV_PATH = Path(
    os.environ.get("CONVICTION_TELEGRAM_ENV", HOME / ".hermes" / ".env")
)
COMMAND_DB = TASK_HOME / "sqlite" / "command-store.sqlite"
SESSION_DB = TASK_HOME / "sqlite" / "session-store.sqlite"

SESSION_KEY_RE = re.compile(
    r"^job:(?P<job_id>[^:]+):my:(?P<my_agent_id>[^:]+):to:(?P<to_agent_id>[^:]+)$"
)
CONTENT_RE = re.compile(r' content="(?P<content>.*)"$')
ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
SECRET_TERMS = re.compile(
    r"\b(seed phrase|mnemonic|private key|api secret|bearer token|clob credential|reusable signature)\b",
    re.I,
)
def session_regex() -> re.Pattern[str]:
    return re.compile(
        rf"session dispatch queued route=group "
        rf"session=(?P<session>job:[^ ]+:my:{re.escape(AGENT_ID)}:to:(?P<to_agent>[^ ]+)) "
        rf"message=(?P<message>[^ ]+) "
        rf"type=a2a-agent-chat job=[^ ]+ "
        rf"fromAgent=(?P<from_agent>[^ ]+) toAgent={re.escape(AGENT_ID)}(?= content=)"
    )


def log(message: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n"
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(line)
    print(line, end="", flush=True)


def telegram_sender(message: str) -> bool:
    return send_telegram(TELEGRAM_ENV_PATH, message, log)


def queue_session_notification(
    state: dict,
    *,
    job_id: str,
    peer_agent_id: str,
    message_id: str,
    reviewer: bool,
) -> bool:
    event_id = f"session|{job_id}|{message_id}"
    route = "platform review probe" if reviewer else "buyer request"
    return queue_notification(
        state,
        event_id,
        "Conviction request handled\n"
        f"agent=#{AGENT_ID}\n"
        f"service={SERVICE_NAME}\n"
        f"route={route}\n"
        f"job={job_id}\n"
        f"peerAgent={peer_agent_id}\n"
        "reply=queued",
    )


def session_parts(session_key: str) -> dict[str, str] | None:
    match = SESSION_KEY_RE.match(session_key)
    return match.groupdict() if match else None


def bound_session_parts(match: re.Match[str] | None) -> dict[str, str] | None:
    if match is None:
        return None
    parts = session_parts(match.group("session"))
    if parts is None:
        return None
    from_agent = match.group("from_agent")
    if (
        from_agent == AGENT_ID
        or match.group("to_agent") != from_agent
        or parts.get("to_agent_id") != from_agent
        or parts.get("my_agent_id") != AGENT_ID
    ):
        return None
    return parts


def parse_request(content: str) -> tuple[dict[str, str] | None, list[str]]:
    if SECRET_TERMS.search(content):
        return None, ["wallet secrets are prohibited"]
    try:
        body = json.loads(content)
        if isinstance(body, dict) and isinstance(body.get("input"), dict):
            body = body["input"]
    except Exception:
        body = {}
        for key in ("market", "outcome", "spend", "maxPrice", "wallet", "rationale"):
            pattern = re.compile(rf"(?:^|[\n;])\s*{re.escape(key)}\s*[:=]\s*([^\n;]+)", re.I)
            match = pattern.search(content)
            if match:
                body[key] = match.group(1).strip().strip('"').strip("'")

    required = ("market", "spend", "maxPrice", "wallet", "rationale")
    missing = [key for key in required if not str(body.get(key, "")).strip()]
    if str(body.get("outcome", "")).lower() not in {"yes", "no"}:
        missing.append("outcome must be yes or no")
    if body.get("wallet") and not ADDRESS_RE.match(str(body["wallet"])):
        missing.append("wallet must be a 20-byte EVM address")
    if missing:
        return None, missing
    return {
        "market": str(body["market"]).strip(),
        "outcome": str(body["outcome"]).strip().lower(),
        "spend": str(body["spend"]).strip(),
        "maxPrice": str(body["maxPrice"]).strip(),
        "wallet": str(body["wallet"]).strip(),
        "rationale": str(body["rationale"]).strip(),
    }, []


def compile_request(request: dict[str, str]) -> dict:
    command = [
        "node",
        str(PROJECT_ROOT / "scripts" / "compile-live-intent.mjs"),
        request["market"],
        request["outcome"],
        request["spend"],
        request["maxPrice"],
        request["wallet"],
        request["rationale"],
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=15, cwd=PROJECT_ROOT)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "market compilation failed").strip()
        raise RuntimeError(message[:500])
    return json.loads(result.stdout)


def request_schema(missing: list[str] | None = None) -> str:
    note = f" Missing/invalid: {', '.join(missing)}." if missing else ""
    return (
        f"{AGENT_NAME} requires exact JSON before {SERVICE_NAME}: "
        '{"market":"polymarket-slug-or-url","outcome":"yes|no","spend":"1.35",'
        '"maxPrice":"0.27","wallet":"0x…","rationale":"20-500 user-authored characters"}. '
        "spend is the total pUSD risk budget including the conservative venue-fee reserve. "
        "Never send a seed phrase, private key, token, credential, or signature. "
        f"The buyer wallet must perform the official confirmation flow.{note}"
    )


def format_card(compiled: dict) -> str:
    intent = compiled["intent"]
    card = compiled["executionCard"]
    compact = {
        "intentHash": compiled["intentHash"],
        "market": {
            "question": intent["market"]["question"],
            "conditionId": intent["market"]["conditionId"],
            "outcome": intent["market"]["outcome"],
            "outcomeTokenId": intent["market"]["outcomeTokenId"],
        },
        "order": intent["order"],
        "exposure": intent["exposure"],
        "wallet": intent["buyer"]["wallet"],
        "snapshot": intent["snapshot"],
        "execution": {
            "tool": card["tool"],
            "argv": card["argv"],
            "requiresUserConfirmation": True,
            "nonCustodial": True,
        },
    }
    return (
        "CONVICTION EXECUTION CARD\n"
        + json.dumps(compact, separators=(",", ":"), sort_keys=True)
        + "\nNo transaction was signed or broadcast. The buyer's own Agentic Wallet must confirm. "
        + f"After execution, verify the Polygon receipt at {PUBLIC_URL}/api/receipt."
    )


Compiler = Callable[[dict[str, str]], dict]


def build_reply(
    content: str,
    session_key: str,
    state: dict,
    compiler: Compiler = compile_request,
) -> str | None:
    parts = session_parts(session_key) or {}
    peer_agent_id = parts.get("to_agent_id", "")
    counts = state.setdefault("session_replies", {})
    reply_index = int(counts.get(session_key, 0))
    counts[session_key] = reply_index + 1

    if peer_agent_id not in PLATFORM_REVIEW_AGENT_IDS:
        if reply_index > 0:
            return None
        return request_schema()

    request, missing = parse_request(content)
    if not request:
        return request_schema(missing)
    try:
        return format_card(compiler(request))
    except Exception as error:
        return (
            "Conviction refused this execution card before signing or payment. "
            f"Reason: {str(error)[:500]}"
        )


def resolve_to_xmtp_address(session_key: str, to_agent_id: str) -> str | None:
    if not SESSION_DB.exists():
        return None
    try:
        with sqlite3.connect(str(SESSION_DB), timeout=1.0) as connection:
            connection.execute("PRAGMA busy_timeout = 1000")
            row = connection.execute(
                """
                SELECT to_agent_xmtp_address FROM session_metadata
                WHERE session_key = ? AND to_agent_xmtp_address IS NOT NULL
                  AND to_agent_xmtp_address != '' LIMIT 1
                """,
                (session_key,),
            ).fetchone()
            if row and row[0]:
                return str(row[0])
            row = connection.execute(
                """
                SELECT to_agent_xmtp_address FROM session_metadata
                WHERE to_agent_id = ? AND to_agent_xmtp_address IS NOT NULL
                  AND to_agent_xmtp_address != '' ORDER BY updated_at DESC LIMIT 1
                """,
                (to_agent_id,),
            ).fetchone()
            return str(row[0]) if row and row[0] else None
    except Exception as error:
        log(f"resolve xmtp failed session={session_key} error={type(error).__name__}")
        return None


def enqueue_reply(session_key: str, message: str) -> bool:
    parts = session_parts(session_key)
    if not parts:
        return False
    to_xmtp_address = resolve_to_xmtp_address(session_key, parts["to_agent_id"])
    if not to_xmtp_address:
        return False
    now = int(time.time() * 1000)
    command_id = str(uuid.uuid4())
    command = {
        "id": command_id,
        "type": "xmtp-send",
        "jobId": parts["job_id"],
        "message": message,
        "myAgentId": parts["my_agent_id"],
        "toAgentId": parts["to_agent_id"],
        "toXmtpAddress": to_xmtp_address,
        "createdAt": now,
    }
    try:
        with sqlite3.connect(str(COMMAND_DB), timeout=1.0) as connection:
            connection.execute("PRAGMA busy_timeout = 1000")
            connection.execute(
                """
                INSERT INTO command_queue (
                  id, type, status, command_json, result_json,
                  created_at_ms, updated_at_ms, processing_started_at_ms, completed_at_ms
                ) VALUES (?, ?, 'pending', ?, NULL, ?, ?, NULL, NULL)
                """,
                (command_id, "xmtp-send", json.dumps(command, separators=(",", ":")), now, now),
            )
            connection.commit()
        return True
    except Exception as error:
        log(f"queue reply failed session={session_key} error={type(error).__name__}")
        return False


def load_state() -> dict:
    if not STATE_PATH.exists():
        state = {"handled": [], "offset": None, "session_replies": {}}
        normalize_outbox_state(state)
        return state
    try:
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if not isinstance(state, dict):
            state = {"handled": [], "offset": None, "session_replies": {}}
    except Exception:
        state = {"handled": [], "offset": None, "session_replies": {}}
    normalize_outbox_state(state)
    return state


def save_state(state: dict) -> None:
    state["handled"] = state.get("handled", [])[-500:]
    state["session_replies"] = dict(list(state.get("session_replies", {}).items())[-100:])
    normalize_outbox_state(state)
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    temporary.replace(STATE_PATH)


def fetch_full_content(job_id: str, to_agent_id: str, snippet: str) -> str:
    try:
        result = subprocess.run(
            [
                "okx-a2a",
                "session",
                "history",
                "--job-id",
                job_id,
                "--toAgentId",
                to_agent_id,
                "--limit",
                "10",
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=8,
        )
        messages = json.loads(result.stdout)
        inbound: list[str] = []
        for message in messages:
            raw = message.get("content", "") if isinstance(message, dict) else ""
            try:
                envelope = json.loads(raw)
            except Exception:
                envelope = None
            if isinstance(envelope, dict):
                if str((envelope.get("sender") or {}).get("agentId", "")) == str(to_agent_id):
                    inbound.append(str(envelope.get("content", "")))
            elif raw:
                inbound.append(str(raw))
        return inbound[-1] if inbound else snippet
    except Exception:
        return snippet


def process_line(line: str, state: dict, pattern: re.Pattern[str]) -> None:
    match = pattern.search(line)
    parts = bound_session_parts(match)
    if match is None or parts is None:
        return
    session_key = match.group("session")
    key = f"{session_key}|{match.group('message')}"
    if key in set(state.get("handled", [])):
        return
    snippet_match = CONTENT_RE.search(line)
    snippet = snippet_match.group("content") if snippet_match else ""
    content = fetch_full_content(parts.get("job_id", ""), parts.get("to_agent_id", ""), snippet)
    reply = build_reply(content, session_key, state)
    reply_queued = reply is not None and enqueue_reply(session_key, reply)
    if reply is None or reply_queued:
        state.setdefault("handled", []).append(key)
        if reply_queued:
            queue_session_notification(
                state,
                job_id=parts.get("job_id", "unknown"),
                peer_agent_id=parts.get("to_agent_id", "unknown"),
                message_id=match.group("message"),
                reviewer=parts.get("to_agent_id", "") in PLATFORM_REVIEW_AGENT_IDS,
            )
        save_state(state)


def follow() -> None:
    if not AGENT_ID.isdigit():
        raise RuntimeError("CONVICTION_AGENT_ID must be set after agent registration")
    pattern = session_regex()
    state = load_state()
    log(f"starting Conviction responder agent={AGENT_ID} listener={LISTENER_LOG}")
    if queue_notification(
        state,
        f"startup|{AGENT_ID}|v1",
        f"Conviction #{AGENT_ID} responder is online\nservice={SERVICE_NAME}\nlistener=ready",
    ):
        save_state(state)
    if flush_notifications(state, telegram_sender):
        save_state(state)
    while True:
        if not LISTENER_LOG.exists():
            if flush_notifications(state, telegram_sender):
                save_state(state)
            time.sleep(1)
            continue
        with LISTENER_LOG.open("r", encoding="utf-8", errors="replace") as handle:
            if state.get("offset") is None:
                handle.seek(0, os.SEEK_END)
            else:
                size = LISTENER_LOG.stat().st_size
                offset = int(state.get("offset") or 0)
                handle.seek(0 if offset > size else offset)
            while True:
                line = handle.readline()
                if not line:
                    state["offset"] = handle.tell()
                    flush_notifications(state, telegram_sender)
                    save_state(state)
                    time.sleep(0.25)
                    continue
                process_line(line, state, pattern)
                if flush_notifications(state, telegram_sender):
                    save_state(state)


def run_self_test() -> None:
    ordinary_state: dict = {}
    ordinary = "job:ordinary:my:9999:to:5632"
    first = build_reply("buy yes", ordinary, ordinary_state)
    assert first and "exact JSON" in first and "Never send" in first
    assert build_reply("send it now", ordinary, ordinary_state) is None

    compiled = {
        "intentHash": "0x" + "11" * 32,
        "intent": {
            "market": {
                "question": "Will the test pass?",
                "conditionId": "0x" + "22" * 32,
                "outcome": "YES",
                "outcomeTokenId": "123",
            },
            "order": {
                "side": "BUY",
                "outcome": "YES",
                "orderType": "FAK",
                "requestedBudget": "1.35",
                "requestedBudgetRaw": "1350000",
                "maximumSpend": "1.35",
                "maximumSpendRaw": "1350000",
                "maximumOrderPrincipal": "1.35",
                "maximumOrderPrincipalRaw": "1350000",
                "maximumFee": "0",
                "maximumFeeRaw": "0",
                "maximumTotalDebit": "1.35",
                "maximumTotalDebitRaw": "1350000",
                "unusedBudget": "0",
                "maxPrice": "0.27",
                "fullFillSharesAtCap": "5",
                "fullFillSharesAtCapRaw": "5000000",
                "feeBps": 0,
            },
            "exposure": {
                "maximumLoss": "1.35",
                "fullFillPayoutAtCap": "5",
                "grossProfitAtCap": "3.65",
                "grossBreakEvenPrice": "0.27",
                "priceCapCushion": "0",
                "boundedLiquidityCoverageBps": "200000",
                "feesIncluded": True,
                "maximumFee": "0",
                "maximumTotalDebit": "1.35",
                "unusedBudget": "0",
                "assumesFullFillAtCap": True,
            },
            "buyer": {"wallet": "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe"},
            "snapshot": {
                "capturedAt": "2026-07-21T00:00:00Z",
                "expiresAt": "2026-07-21T00:00:30Z",
                "bestAsk": "0.27",
                "boundedAskDepth": "100",
            },
        },
        "executionCard": {
            "tool": "polymarket-plugin",
            "argv": ["buy", "--market-id", "test", "--outcome", "yes"],
        },
    }
    reviewer_state: dict = {}
    request = json.dumps(
        {
            "market": "test-market",
            "outcome": "yes",
            "spend": "1.35",
            "maxPrice": "0.27",
            "wallet": "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
            "rationale": "This is a sufficiently long user-authored rationale.",
        }
    )
    reply = build_reply(request, "job:review:my:9999:to:1791", reviewer_state, lambda _: compiled)
    assert reply and "CONVICTION EXECUTION CARD" in reply
    assert '"requiresUserConfirmation":true' in reply and '"nonCustodial":true' in reply
    secret = build_reply(
        request + "\nprivate key: 0xdeadbeef",
        "job:secret:my:9999:to:1791",
        {},
        lambda _: compiled,
    )
    assert secret and "wallet secrets are prohibited" in secret

    pattern = session_regex()
    valid_dispatch = pattern.search(
        "session dispatch queued route=group "
        "session=job:review:my:7034:to:1791 message=message-valid "
        "type=a2a-agent-chat job=review fromAgent=1791 toAgent=7034 "
        'content="review request"'
    )
    valid_parts = bound_session_parts(valid_dispatch)
    assert valid_parts and valid_parts["to_agent_id"] == "1791"
    mismatched_dispatch = pattern.search(
        "session dispatch queued route=group "
        "session=job:review:my:7034:to:1791 message=message-spoofed "
        "type=a2a-agent-chat job=review fromAgent=2222 toAgent=7034 "
        'content="fromAgent=1791 toAgent=7034"'
    )
    assert mismatched_dispatch and mismatched_dispatch.group("from_agent") == "2222"
    assert bound_session_parts(mismatched_dispatch) is None

    with tempfile.TemporaryDirectory() as temporary_directory:
        telegram_env = Path(temporary_directory) / ".env"
        telegram_env.write_text(
            "TELEGRAM_BOT_TOKEN=test-token\n"
            "TELEGRAM_CHAT_ID=-100correct\n"
            "TELEGRAM_ALLOWED_USERS=wrong-recipient\n",
            encoding="utf-8",
        )
        assert telegram_config(telegram_env, {}) == ("test-token", "-100correct")
        telegram_env.write_text(
            "TELEGRAM_BOT_TOKEN=test-token\n"
            "TELEGRAM_ALLOWED_USERS=wrong-recipient\n",
            encoding="utf-8",
        )
        assert telegram_config(telegram_env, {}) is None

    assert AGENT_ID == "7034"
    assert SERVICE_NAME == "Bounded YES/NO Position Card"
    notification_state: dict = {}
    queue_session_notification(
        notification_state,
        job_id="job-metadata-only",
        peer_agent_id="1791",
        message_id="message-metadata-only",
        reviewer=True,
    )
    session_alert = notification_state["telegram_outbox"][0]["message"]
    assert "platform review probe" in session_alert
    assert "rationale" not in session_alert and "0x6a355" not in session_alert

    attempts: list[str] = []

    def fail_once(message: str) -> bool:
        attempts.append(message)
        return False

    assert flush_notifications(notification_state, fail_once, now=100)
    assert len(attempts) == 1
    assert all(item["attempts"] == 1 for item in notification_state["telegram_outbox"])
    assert not flush_notifications(notification_state, fail_once, now=101)
    assert len(attempts) == 1
    assert flush_notifications(notification_state, lambda _: True, now=103)
    assert notification_state["telegram_outbox"] == []
    assert len(notification_state["telegram_delivered"]) == 1

    print(
        "Conviction responder gate passed: buyer schema, reviewer card, secret refusal, "
        "bound peer identity, metadata-only Telegram alerts, and durable retry verified."
    )


if __name__ == "__main__":
    try:
        if "--self-test" in sys.argv:
            run_self_test()
        else:
            follow()
    except KeyboardInterrupt:
        sys.exit(0)
