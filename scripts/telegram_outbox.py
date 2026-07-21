#!/usr/bin/env python3
"""Small durable Telegram outbox shared by Conviction's local operators."""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Mapping


MAX_MESSAGE_LENGTH = 3900
MAX_DELIVERED_IDS = 500
MAX_RETRY_SECONDS = 300

TelegramSender = Callable[[str], bool]
Logger = Callable[[str], None]


def read_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def telegram_config(
    env_path: Path,
    environ: Mapping[str, str] | None = None,
) -> tuple[str, str] | None:
    source = os.environ if environ is None else environ
    dotenv = read_dotenv(env_path)
    token = source.get("TELEGRAM_BOT_TOKEN") or dotenv.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = (
        source.get("TELEGRAM_HOME_CHANNEL")
        or source.get("TELEGRAM_CHAT_ID")
        or dotenv.get("TELEGRAM_HOME_CHANNEL", "")
    )
    if not chat_id:
        allowed = source.get("TELEGRAM_ALLOWED_USERS") or dotenv.get("TELEGRAM_ALLOWED_USERS", "")
        chat_id = allowed.split(",", 1)[0].strip()
    return (token, chat_id) if token and chat_id else None


def send_telegram(env_path: Path, message: str, logger: Logger) -> bool:
    config = telegram_config(env_path)
    if not config:
        logger("telegram unavailable: configuration is incomplete")
        return False

    token, chat_id = config
    data = urllib.parse.urlencode(
        {
            "chat_id": chat_id,
            "text": message[:MAX_MESSAGE_LENGTH],
            "disable_web_page_preview": "true",
        }
    ).encode()
    try:
        with urllib.request.urlopen(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=data,
            timeout=10,
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("ok"):
            return True
        logger("telegram delivery failed: API returned ok=false")
    except Exception as error:
        # Do not stringify URL-layer exceptions: some implementations include
        # the request URL, which contains the bot credential.
        logger(f"telegram delivery failed: {type(error).__name__}")
    return False


def normalize_outbox_state(state: dict) -> None:
    if not isinstance(state.get("telegram_outbox"), list):
        state["telegram_outbox"] = []
    if not isinstance(state.get("telegram_delivered"), list):
        state["telegram_delivered"] = []


def queue_notification(state: dict, event_id: str, message: str) -> bool:
    """Persist a unique notification without putting secrets in process arguments."""
    normalize_outbox_state(state)
    delivered = set(str(value) for value in state["telegram_delivered"])
    pending = {
        str(item.get("id"))
        for item in state["telegram_outbox"]
        if isinstance(item, dict) and item.get("id")
    }
    if event_id in delivered or event_id in pending:
        return False
    state["telegram_outbox"].append(
        {
            "id": event_id,
            "message": message[:MAX_MESSAGE_LENGTH],
            "attempts": 0,
            "nextAttemptAt": 0,
        }
    )
    return True


def flush_notifications(
    state: dict,
    sender: TelegramSender,
    *,
    now: float | None = None,
) -> bool:
    """Try due messages and retain failures for later runs or process restarts."""
    normalize_outbox_state(state)
    current_time = time.time() if now is None else now
    changed = False
    remaining: list[dict] = []

    for raw_item in state["telegram_outbox"]:
        if not isinstance(raw_item, dict):
            changed = True
            continue
        item = dict(raw_item)
        event_id = str(item.get("id", ""))
        message = str(item.get("message", ""))
        if not event_id or not message:
            changed = True
            continue
        if float(item.get("nextAttemptAt", 0) or 0) > current_time:
            remaining.append(item)
            continue

        if sender(message):
            state["telegram_delivered"].append(event_id)
            changed = True
            continue

        attempts = int(item.get("attempts", 0) or 0) + 1
        retry_seconds = min(MAX_RETRY_SECONDS, 2 ** min(attempts, 8))
        item["attempts"] = attempts
        item["nextAttemptAt"] = current_time + retry_seconds
        remaining.append(item)
        changed = True

    state["telegram_outbox"] = remaining
    state["telegram_delivered"] = state["telegram_delivered"][-MAX_DELIVERED_IDS:]
    return changed
