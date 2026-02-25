#!/usr/bin/env python3
import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, List, Optional

DATA_PATH = Path("/var/lib/openclaw/plash-data/dashboard.json")

ALLOWED_ALERT_SEVERITY = {"info", "warning", "critical"}
ALLOWED_MOTION = {"none", "subtle"}
ALLOWED_CHART_KIND = {"sparkline", "bars"}

TARGET_VIEWPORT_HEIGHT = 1080
WALLPAPER_GAP = 14
SECTION_GRID_GAP = 14
CARD_GRID_GAP = 10
ALERT_HEIGHT = 52
SECTION_CHROME_HEIGHT = 46


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


def as_number(value: object, fallback: float) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


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

    for key in value:
        if key not in {"kind", "points", "unit", "label"}:
            fail(f"{path}.{key} is not supported")


def validate_ui(payload: dict) -> None:
    ui = payload["ui"]
    if not isinstance(ui, dict):
        fail("ui must be an object")

    for key in ("timezone", "motion", "gutters"):
        if key not in ui:
            fail(f"ui missing key: {key}")

    validate_non_empty_string(ui["timezone"], "ui.timezone")

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
        if key not in {"timezone", "motion", "gutters"}:
            fail(f"ui.{key} is not supported")

    for key in gutters:
        if key not in {"top", "bottom", "side"}:
            fail(f"ui.gutters.{key} is not supported")


def validate_card(card: dict, path: str) -> None:
    for key in ("id", "type", "title"):
        if key not in card:
            fail(f"{path} missing key: {key}")

    validate_non_empty_string(card["id"], f"{path}.id")
    validate_non_empty_string(card["title"], f"{path}.title")
    if not isinstance(card["type"], str):
        fail(f"{path}.type must be a string")

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

    allowed_card_fields = {
        "id",
        "type",
        "title",
        "url",
        "description",
        "hidden",
        "priority",
        "layout",
        "metrics",
        "chart",
    }
    for key in card:
        if key not in allowed_card_fields:
            fail(f"{path}.{key} is not supported")


def card_priority(card: dict) -> int:
    layout = card.get("layout") if isinstance(card.get("layout"), dict) else {}
    from_layout = layout.get("priority")
    if isinstance(from_layout, int):
        return from_layout
    from_card = card.get("priority")
    if isinstance(from_card, int):
        return from_card
    return 100


def section_span(section: dict) -> int:
    layout = section.get("layout") if isinstance(section.get("layout"), dict) else {}
    configured = as_number(layout.get("span"), 4)
    return int(clamp(configured, 3, 12))


def card_span(card: dict) -> int:
    layout = card.get("layout") if isinstance(card.get("layout"), dict) else {}
    configured = as_number(layout.get("span"), 6)
    return int(clamp(configured, 3, 12))


def balance_rows(items: List[dict], span_for: Callable[[dict], int]) -> List[List[dict]]:
    rows: List[List[dict]] = []
    row: List[dict] = []
    used = 0

    for item in items:
        preferred_span = span_for(item)
        if row and used + preferred_span > 12:
            rows.append(row)
            row = []
            used = 0

        next_span = max(1, min(12, preferred_span, 12 - used))
        row.append({"item": item, "span": next_span})
        used += next_span

        if used == 12:
            rows.append(row)
            row = []
            used = 0

    if row:
        rows.append(row)

    for next_row in rows:
        used_cols = sum(entry["span"] for entry in next_row)
        leftover = 12 - used_cols
        if leftover <= 0:
            continue
        if len(next_row) == 1:
            next_row[0]["span"] += leftover
            continue
        next_row[-1]["span"] += leftover

    return rows


def estimate_card_height(card: dict) -> int:
    base = 104
    if card.get("description"):
        base += 14
    if card.get("chart"):
        base += 92
    if card.get("type") or card.get("url"):
        base += 12

    metrics = card.get("metrics") if isinstance(card.get("metrics"), list) else []
    metric_rows = min(len(metrics), 6)
    base += metric_rows * 13

    return int(clamp(base, 96, 260))


def visible_cards(section: dict) -> List[dict]:
    raw_cards = section.get("cards", [])
    if not isinstance(raw_cards, list):
        return []

    cards = [
        card
        for card in raw_cards
        if isinstance(card, dict) and not card.get("hidden") and isinstance(card.get("title"), str) and card.get("title")
    ]
    cards.sort(key=card_priority)
    return cards


def estimate_section_height(section: dict) -> int:
    cards = visible_cards(section)
    if not cards:
        return 0

    card_rows = balance_rows(cards, card_span)
    row_heights = []
    for row in card_rows:
        row_height = max(estimate_card_height(entry["item"]) for entry in row)
        row_heights.append(row_height)

    cards_height = sum(row_heights) + CARD_GRID_GAP * max(0, len(row_heights) - 1)
    return SECTION_CHROME_HEIGHT + cards_height


def estimate_layout_height(payload: dict) -> int:
    alerts = payload.get("alerts", []) if isinstance(payload.get("alerts"), list) else []
    visible_alerts = [alert for alert in alerts if isinstance(alert, dict) and alert.get("message")]
    alerts_height = ALERT_HEIGHT if visible_alerts else 0

    sections = payload.get("sections", []) if isinstance(payload.get("sections"), list) else []
    visible_sections_with_heights = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        if section.get("hidden"):
            continue
        section_height = estimate_section_height(section)
        if section_height <= 0:
            continue
        visible_sections_with_heights.append((section, section_height))

    if not visible_sections_with_heights:
        return alerts_height

    visible_sections = [section for section, _ in visible_sections_with_heights]
    section_height_map = {id(section): height for section, height in visible_sections_with_heights}

    section_rows = balance_rows(visible_sections, section_span)
    section_row_heights = []
    for row in section_rows:
        row_height = max(section_height_map[id(entry["item"])] for entry in row)
        section_row_heights.append(row_height)

    sections_height = sum(section_row_heights) + SECTION_GRID_GAP * max(0, len(section_row_heights) - 1)
    between = WALLPAPER_GAP if alerts_height and sections_height else 0
    return alerts_height + between + sections_height


def drop_candidate_ids(payload: dict, limit: int = 8) -> List[str]:
    candidates = []
    sections = payload.get("sections", []) if isinstance(payload.get("sections"), list) else []

    for section in sections:
        if not isinstance(section, dict) or section.get("hidden"):
            continue
        for card in visible_cards(section):
            card_id = card.get("id")
            if not isinstance(card_id, str) or not card_id:
                continue
            candidates.append((card_priority(card), card_id))

    candidates.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    return [entry[1] for entry in candidates[:limit]]


def validate_layout_budget(payload: dict) -> None:
    ui = payload.get("ui", {}) if isinstance(payload.get("ui"), dict) else {}
    gutters = ui.get("gutters", {}) if isinstance(ui.get("gutters"), dict) else {}

    top = int(as_number(gutters.get("top"), 56))
    bottom = int(as_number(gutters.get("bottom"), 106))
    available = TARGET_VIEWPORT_HEIGHT - top - bottom
    required = estimate_layout_height(payload)

    if required <= available:
        return

    overflow = required - available
    candidates = drop_candidate_ids(payload)
    candidate_text = ", ".join(candidates) if candidates else "(none)"
    fail(
        f"layout budget exceeded by {overflow}px (required={required}px, available={available}px). "
        f"Reduce visible cards or shorten card content. Suggested hide order: {candidate_text}"
    )


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

        for key in alert:
            if key not in {"id", "severity", "message"}:
                fail(f"{path}.{key} is not supported")

    for key in payload:
        if key not in {"version", "generated_at", "ttl_seconds", "title", "summary", "ui", "sections", "alerts"}:
            fail(f"{key} is not supported")

    validate_layout_budget(payload)


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
