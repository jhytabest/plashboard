#!/usr/bin/env python3
import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

DATA_PATH = Path("/var/lib/openclaw/plash-data/dashboard.json")

ALLOWED_CARD_STATUS = {"healthy", "warning", "critical", "unknown"}
ALLOWED_ALERT_SEVERITY = {"info", "warning", "critical"}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fail(msg: str) -> None:
    raise SystemExit(f"validation failed: {msg}")


def validate(payload: dict) -> None:
    if not isinstance(payload, dict):
        fail("root must be an object")

    for key in ("version", "generated_at", "title", "sections"):
        if key not in payload:
            fail(f"missing required key: {key}")

    version = payload["version"]
    if not isinstance(version, str) or not version.startswith("1."):
        fail('version must be a string starting with "1."')

    if not isinstance(payload["title"], str) or not payload["title"].strip():
        fail("title must be a non-empty string")

    sections = payload["sections"]
    if not isinstance(sections, list):
        fail("sections must be a list")

    for i, section in enumerate(sections):
        if not isinstance(section, dict):
            fail(f"sections[{i}] must be an object")
        for key in ("id", "label", "cards"):
            if key not in section:
                fail(f"sections[{i}] missing key: {key}")
        if not isinstance(section["cards"], list):
            fail(f"sections[{i}].cards must be a list")
        for j, card in enumerate(section["cards"]):
            if not isinstance(card, dict):
                fail(f"sections[{i}].cards[{j}] must be an object")
            for key in ("id", "type", "title", "status"):
                if key not in card:
                    fail(f"sections[{i}].cards[{j}] missing key: {key}")
            if card["status"] not in ALLOWED_CARD_STATUS:
                fail(f'sections[{i}].cards[{j}].status invalid: {card["status"]}')

    alerts = payload.get("alerts", [])
    if not isinstance(alerts, list):
        fail("alerts must be a list")
    for i, alert in enumerate(alerts):
        if not isinstance(alert, dict):
            fail(f"alerts[{i}] must be an object")
        for key in ("id", "severity", "message"):
            if key not in alert:
                fail(f"alerts[{i}] missing key: {key}")
        if alert["severity"] not in ALLOWED_ALERT_SEVERITY:
            fail(f'alerts[{i}].severity invalid: {alert["severity"]}')


def atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as tmp:
        json.dump(payload, tmp, indent=2)
        tmp.write("\n")
        tmp_path = Path(tmp.name)

    os.replace(tmp_path, path)
    os.chmod(path, 0o664)


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate and atomically replace dashboard.json")
    parser.add_argument("--input", required=True, help="Path to next dashboard JSON")
    parser.add_argument(
        "--touch-generated-at",
        action="store_true",
        help="Set generated_at to current UTC time",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    payload = json.loads(input_path.read_text(encoding="utf-8"))

    if args.touch_generated_at:
        payload["generated_at"] = now_iso()

    validate(payload)
    atomic_write(DATA_PATH, payload)

    sections = payload.get("sections", [])
    cards = sum(len(section.get("cards", [])) for section in sections if isinstance(section, dict))
    alerts = len(payload.get("alerts", [])) if isinstance(payload.get("alerts", []), list) else 0
    print(f"wrote {DATA_PATH} (sections={len(sections)} cards={cards} alerts={alerts})")


if __name__ == "__main__":
    main()
