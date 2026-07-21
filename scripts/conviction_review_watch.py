#!/usr/bin/env python3
"""Focused marketplace review-status fallback for Conviction #7034."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from telegram_outbox import (
    flush_notifications,
    normalize_outbox_state,
    queue_notification,
    send_telegram,
)


AGENT_ID = "7034"
AGENT_NAME = "Conviction"
HOME = Path.home()
ONCHAINOS = os.environ.get("ONCHAINOS_BIN", str(HOME / ".local" / "bin" / "onchainos"))
TASK_HOME = Path(os.environ.get("OKX_AGENT_TASK_HOME", HOME / ".okx-agent-task"))
STATE_PATH = Path(
    os.environ.get("CONVICTION_REVIEW_WATCH_STATE", TASK_HOME / "conviction-review-watch.json")
)
LOG_PATH = Path(
    os.environ.get(
        "CONVICTION_REVIEW_WATCH_LOG",
        TASK_HOME / "logs" / "conviction-review-watch.log",
    )
)
TELEGRAM_ENV_PATH = Path(
    os.environ.get("CONVICTION_TELEGRAM_ENV", HOME / ".hermes" / ".env")
)


def log(message: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n"
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(line)
    print(line, end="", flush=True)


def telegram_sender(message: str) -> bool:
    return send_telegram(TELEGRAM_ENV_PATH, message, log)


def load_state() -> dict:
    if not STATE_PATH.exists():
        state: dict = {}
        normalize_outbox_state(state)
        return state
    try:
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if not isinstance(state, dict):
            state = {}
    except Exception:
        state = {}
    normalize_outbox_state(state)
    return state


def save_state(state: dict) -> None:
    normalize_outbox_state(state)
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    temporary.replace(STATE_PATH)


def normalized_status(agent: dict) -> dict[str, str | None]:
    """Keep only review-significant fields; connectivity changes are intentionally ignored."""
    return {
        "approvalLabel": agent.get("approvalLabel"),
        "statusLabel": agent.get("statusLabel"),
        "approvalRemark": agent.get("approvalRemark") or None,
    }


def extract_agent_status(payload: dict) -> dict[str, str | None] | None:
    for account in payload.get("data", {}).get("list", []):
        if not isinstance(account, dict):
            continue
        for agent in account.get("agentList", []):
            if isinstance(agent, dict) and str(agent.get("agentId")) == AGENT_ID:
                return normalized_status(agent)
    return None


def fetch_agent_status() -> dict[str, str | None] | None:
    try:
        result = subprocess.run(
            [ONCHAINOS, "agent", "get-my-agents"],
            capture_output=True,
            text=True,
            timeout=90,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "unknown CLI failure").strip()
            log(f"status check failed exit={result.returncode}: {detail[:180]}")
            return None
        payload = json.loads(result.stdout)
        status = extract_agent_status(payload)
        if status is None:
            log(f"status check returned no record for Conviction #{AGENT_ID}")
        return status
    except Exception as error:
        log(f"status check failed {type(error).__name__}: {str(error)[:180]}")
        return None


def record_status(state: dict, status: dict[str, str | None]) -> bool:
    """Queue exactly one alert for each approval/status/remark tuple."""
    if state.get("lastStatus") == status:
        return False
    state["lastStatus"] = status
    sequence = int(state.get("statusSequence", 0) or 0) + 1
    state["statusSequence"] = sequence
    canonical = json.dumps(status, separators=(",", ":"), sort_keys=True)
    status_digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    event_id = f"status|{sequence}|{status_digest}"
    remark = status.get("approvalRemark") or ""
    return queue_notification(
        state,
        event_id,
        f"Conviction #{AGENT_ID} marketplace status changed\n"
        f"approval={status.get('approvalLabel') or ''}\n"
        f"status={status.get('statusLabel') or ''}\n"
        f"remark={remark}",
    )


def run_once() -> None:
    state = load_state()
    changed = flush_notifications(state, telegram_sender)
    status = fetch_agent_status()
    if status is not None and record_status(state, status):
        changed = True
        log(f"review-significant status changed for Conviction #{AGENT_ID}")
    if flush_notifications(state, telegram_sender):
        changed = True
    if changed or status is not None:
        save_state(state)


def run_self_test() -> None:
    payload = {
        "data": {
            "list": [
                {
                    "agentList": [
                        {
                            "agentId": "9999",
                            "approvalLabel": "other",
                        },
                        {
                            "agentId": AGENT_ID,
                            "approvalLabel": "Listing under review",
                            "statusLabel": "active",
                            "approvalRemark": "",
                            "onlineStatus": 1,
                        },
                    ]
                }
            ]
        }
    }
    status = extract_agent_status(payload)
    assert status == {
        "approvalLabel": "Listing under review",
        "statusLabel": "active",
        "approvalRemark": None,
    }
    assert "onlineStatus" not in status

    state: dict = {}
    assert record_status(state, status)
    assert not record_status(state, status)
    status_with_connectivity_noise = normalized_status(
        {
            **status,
            "onlineStatus": 2,
        }
    )
    assert not record_status(state, status_with_connectivity_noise)

    changed_status = {**status, "approvalRemark": "Please clarify the endpoint."}
    assert record_status(state, changed_status)
    assert record_status(state, status)
    assert not record_status(state, status)
    assert len(state["telegram_outbox"]) == 3

    attempts: list[str] = []
    assert flush_notifications(
        state,
        lambda message: attempts.append(message) is None and False,
        now=100,
    )
    assert len(attempts) == 3
    assert all(item["attempts"] == 1 for item in state["telegram_outbox"])
    assert not flush_notifications(state, lambda _: True, now=101)
    assert flush_notifications(state, lambda _: True, now=103)
    assert state["telegram_outbox"] == []
    assert len(state["telegram_delivered"]) == 3
    print(
        "Conviction review watcher gate passed: #7034-only parsing, review-field dedupe, "
        "online-status exclusion, and durable Telegram retry verified."
    )


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        run_self_test()
    else:
        run_once()
