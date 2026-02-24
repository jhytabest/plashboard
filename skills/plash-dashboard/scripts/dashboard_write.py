#!/usr/bin/env python3
import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DATA_PATH = Path("/var/lib/openclaw/plash-data/dashboard.json")

ALLOWED_CARD_STATUS = {"healthy", "warning", "critical", "unknown"}
ALLOWED_ALERT_SEVERITY = {"info", "warning", "critical"}
ALLOWED_DENSITY = {"sparse", "compact"}
ALLOWED_MOTION = {"none", "subtle"}
ALLOWED_CHART_KIND = {"sparkline", "bars"}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fail(msg: str) -> None:
    raise SystemExit(f"validation failed: {msg}")


def validate_non_empty_string(value: object, path: str) -> None:
    if not isinstance(value, str) or not value.strip():
        fail(f"{path} must be a non-empty string")


def validate_int(value: object, path: str, minimum: Optional[int] = None, maximum: Optional[int] = None) -> None:
    if not isinstance(value, int):
        fail(f"{path} must be an integer")
    if minimum is not None and value < minimum:
        fail(f"{path} must be >= {minimum}")
    if maximum is not None and value > maximum:
        fail(f"{path} must be <= {maximum}")


def validate_number(value: object, path: str) -> None:
    if not isinstance(value, (int, float)):
        fail(f"{path} must be a number")


def validate_layout(value: object, path: str) -> None:
    if not isinstance(value, dict):
        fail(f"{path} must be an object")

    allowed = {"span", "priority"}
    for key in value:
        if key not in allowed:
            fail(f"{path}.{key} is not supported")

    if "span" in value:
        validate_int(value["span"], f"{path}.span", minimum=1, maximum=12)
    if "priority" in value:
        validate_int(value["priority"], f"{path}.priority")


def validate_chart(value: object, path: str) -> None:
    if not isinstance(value, dict):
        fail(f"{path} must be an object")

    for key in ("kind", "points"):
        if key not in value:
            fail(f"{path} missing key: {key}")

    kind = value["kind"]
    if kind not in ALLOWED_CHART_KIND:
        fail(f"{path}.kind invalid: {kind}")

    points = value["points"]
    if not isinstance(points, list) or len(points) < 2:
        fail(f"{path}.points must be a list with at least 2 values")

    for i, point in enumerate(points):
        validate_number(point, f"{path}.points[{i}]")

    if "unit" in value and not isinstance(value["unit"], str):
        fail(f"{path}.unit must be a string")
    if "label" in value and not isinstance(value["label"], str):
        fail(f"{path}.label must be a string")
    if "min" in value:
        validate_number(value["min"], f"{path}.min")
    if "max" in value:
        validate_number(value["max"], f"{path}.max")

    for key in value:
        if key not in {"kind", "points", "unit", "label", "min", "max"}:
            fail(f"{path}.{key} is not supported")


def validate_ui(payload: dict) -> None:
    ui = payload["ui"]
    if not isinstance(ui, dict):
        fail("ui must be an object")

    for key in ("timezone", "density", "motion", "gutters"):
        if key not in ui:
            fail(f"ui missing key: {key}")

    validate_non_empty_string(ui["timezone"], "ui.timezone")

    if ui["density"] not in ALLOWED_DENSITY:
        fail(f"ui.density invalid: {ui['density']}")

    if ui["motion"] not in ALLOWED_MOTION:
        fail(f"ui.motion invalid: {ui['motion']}")

    gutters = ui["gutters"]
    if not isinstance(gutters, dict):
        fail("ui.gutters must be an object")

    for key in ("top", "bottom", "side"):
        if key not in gutters:
            fail(f"ui.gutters missing key: {key}")
        validate_int(gutters[key], f"ui.gutters.{key}", minimum=0)

    for key in ui:
        if key not in {"timezone", "density", "motion", "gutters"}:
            fail(f"ui.{key} is not supported")

    for key in gutters:
        if key not in {"top", "bottom", "side"}:
            fail(f"ui.gutters.{key} is not supported")


def validate_card(card: dict, path: str) -> None:
    for key in ("id", "type", "title", "status"):
        if key not in card:
            fail(f"{path} missing key: {key}")

    validate_non_empty_string(card["id"], f"{path}.id")
    validate_non_empty_string(card["title"], f"{path}.title")
    if not isinstance(card["type"], str):
        fail(f"{path}.type must be a string")

    if card["status"] not in ALLOWED_CARD_STATUS:
        fail(f"{path}.status invalid: {card['status']}")

    if "url" in card and not isinstance(card["url"], str):
        fail(f"{path}.url must be a string")
    if "description" in card and not isinstance(card["description"], str):
        fail(f"{path}.description must be a string")
    if "hidden" in card and not isinstance(card["hidden"], bool):
        fail(f"{path}.hidden must be a boolean")
    if "priority" in card:
        validate_int(card["priority"], f"{path}.priority")
    if "layout" in card:
        validate_layout(card["layout"], f"{path}.layout")
    if "chart" in card:
        validate_chart(card["chart"], f"{path}.chart")

    tags = card.get("tags", [])
    if not isinstance(tags, list):
        fail(f"{path}.tags must be a list")
    for i, tag in enumerate(tags):
        if not isinstance(tag, str):
            fail(f"{path}.tags[{i}] must be a string")

    metrics = card.get("metrics", [])
    if not isinstance(metrics, list):
        fail(f"{path}.metrics must be a list")

    for i, metric in enumerate(metrics):
        metric_path = f"{path}.metrics[{i}]"
        if not isinstance(metric, dict):
            fail(f"{metric_path} must be an object")
        if "key" not in metric or "value" not in metric:
            fail(f"{metric_path} must include key and value")
        if not isinstance(metric["key"], str):
            fail(f"{metric_path}.key must be a string")
        for key in metric:
            if key not in {"key", "value"}:
                fail(f"{metric_path}.{key} is not supported")

    if "updated_at" in card and not isinstance(card["updated_at"], str):
        fail(f"{path}.updated_at must be a string")

    allowed_card_fields = {
        "id",
        "type",
        "title",
        "status",
        "url",
        "description",
        "hidden",
        "priority",
        "layout",
        "tags",
        "metrics",
        "chart",
        "updated_at",
    }
    for key in card:
        if key not in allowed_card_fields:
            fail(f"{path}.{key} is not supported")


def validate(payload: dict) -> None:
    if not isinstance(payload, dict):
        fail("root must be an object")

    for key in ("version", "generated_at", "title", "ui", "sections"):
        if key not in payload:
            fail(f"missing required key: {key}")

    version = payload["version"]
    if not isinstance(version, str) or not version.startswith("3."):
        fail('version must be a string starting with "3."')

    if not isinstance(payload["generated_at"], str):
        fail("generated_at must be a string")

    validate_non_empty_string(payload["title"], "title")
    if "summary" in payload and not isinstance(payload["summary"], str):
        fail("summary must be a string")
    if "ttl_seconds" in payload:
        validate_int(payload["ttl_seconds"], "ttl_seconds", minimum=5)

    validate_ui(payload)

    sections = payload["sections"]
    if not isinstance(sections, list):
        fail("sections must be a list")

    for i, section in enumerate(sections):
        section_path = f"sections[{i}]"
        if not isinstance(section, dict):
            fail(f"{section_path} must be an object")

        for key in ("id", "label", "cards"):
            if key not in section:
                fail(f"{section_path} missing key: {key}")

        validate_non_empty_string(section["id"], f"{section_path}.id")
        validate_non_empty_string(section["label"], f"{section_path}.label")

        if "hidden" in section and not isinstance(section["hidden"], bool):
            fail(f"{section_path}.hidden must be a boolean")
        if "order" in section:
            validate_int(section["order"], f"{section_path}.order")
        if "layout" in section:
            validate_layout(section["layout"], f"{section_path}.layout")

        cards = section["cards"]
        if not isinstance(cards, list):
            fail(f"{section_path}.cards must be a list")

        for j, card in enumerate(cards):
            card_path = f"{section_path}.cards[{j}]"
            if not isinstance(card, dict):
                fail(f"{card_path} must be an object")
            validate_card(card, card_path)

        for key in section:
            if key not in {"id", "label", "hidden", "order", "layout", "cards"}:
                fail(f"{section_path}.{key} is not supported")

    alerts = payload.get("alerts", [])
    if not isinstance(alerts, list):
        fail("alerts must be a list")

    for i, alert in enumerate(alerts):
        path = f"alerts[{i}]"
        if not isinstance(alert, dict):
            fail(f"{path} must be an object")
        for key in ("id", "severity", "message"):
            if key not in alert:
                fail(f"{path} missing key: {key}")

        validate_non_empty_string(alert["id"], f"{path}.id")
        validate_non_empty_string(alert["message"], f"{path}.message")

        if alert["severity"] not in ALLOWED_ALERT_SEVERITY:
            fail(f"{path}.severity invalid: {alert['severity']}")
        if "updated_at" in alert and not isinstance(alert["updated_at"], str):
            fail(f"{path}.updated_at must be a string")

        for key in alert:
            if key not in {"id", "severity", "message", "updated_at"}:
                fail(f"{path}.{key} is not supported")

    for key in payload:
        if key not in {"version", "generated_at", "ttl_seconds", "title", "summary", "ui", "sections", "alerts"}:
            fail(f"{key} is not supported")


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
