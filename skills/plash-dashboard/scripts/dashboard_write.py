#!/usr/bin/env python3
import argparse
import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, List, Optional

DATA_PATH = Path("/var/lib/openclaw/plash-data/dashboard.json")

ALLOWED_ALERT_SEVERITY = {"info", "warning", "critical"}
ALLOWED_MOTION = {"none", "subtle"}
ALLOWED_CHART_KIND = {"sparkline", "bars"}

TARGET_VIEWPORT_HEIGHT = int(os.getenv("PLASH_TARGET_VIEWPORT_HEIGHT", "1080"))
LAYOUT_SAFETY_MARGIN = max(0, int(os.getenv("PLASH_LAYOUT_SAFETY_MARGIN", "24")))
WALLPAPER_GAP = 14
SECTION_GRID_GAP = 14
CARD_GRID_GAP = 10
ALERT_HEIGHT = 52
SECTION_CHROME_HEIGHT = 46
GRID_COLUMNS = 12


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
    for key in ("id", "title"):
        if key not in card:
            fail(f"{path} missing key: {key}")

    validate_non_empty_string(card["id"], f"{path}.id")
    validate_non_empty_string(card["title"], f"{path}.title")

    if "url" in card and not isinstance(card["url"], str):
        fail(f"{path}.url must be a string")
    if "description" in card and not isinstance(card["description"], str):
        fail(f"{path}.description must be a string")
    if "long_description" in card and not isinstance(card["long_description"], str):
        fail(f"{path}.long_description must be a string")
    if "chart" in card:
        validate_chart(card["chart"], f"{path}.chart")

    allowed_card_fields = {
        "id",
        "title",
        "url",
        "description",
        "long_description",
        "chart",
    }
    for key in card:
        if key not in allowed_card_fields:
            fail(f"{path}.{key} is not supported")


def compact_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())


def card_has_chart(card: dict) -> bool:
    chart = card.get("chart")
    if not isinstance(chart, dict):
        return False
    kind = chart.get("kind")
    points = chart.get("points")
    return kind in ALLOWED_CHART_KIND and isinstance(points, list) and len(points) >= 2


def estimate_text_lines(value: object, chars_per_line: int, max_lines: int) -> int:
    if not isinstance(value, str):
        return 0
    cleaned = " ".join(value.split())
    if not cleaned:
        return 0

    safe_chars_per_line = max(1, chars_per_line)
    lines = max(1, math.ceil(len(cleaned) / safe_chars_per_line))
    return min(max_lines, lines)


def estimate_card_height(card: dict, card_span: int, section_span: int) -> int:
    safe_card_span = int(clamp(card_span, 3, GRID_COLUMNS))
    safe_section_span = int(clamp(section_span, 3, GRID_COLUMNS))
    width_scale = (safe_section_span / 4) * (safe_card_span / GRID_COLUMNS)
    chars_per_line = max(14, round(58 * width_scale))

    base = 50
    base += estimate_text_lines(card.get("title"), chars_per_line, 2) * 12
    base += estimate_text_lines(card.get("description"), chars_per_line, 3) * 12
    base += estimate_text_lines(card.get("url"), chars_per_line, 2) * 11
    base += estimate_text_lines(card.get("long_description"), chars_per_line, 4) * 12

    if card_has_chart(card):
        base += 98
        if card.get("long_description"):
            base += 6

    return int(clamp(base, 82, 288))


def choose_card_span(card: dict, section_span: int) -> int:
    has_chart = card_has_chart(card)
    title_length = len(compact_text(card.get("title")))
    description_length = len(compact_text(card.get("description")))
    long_length = len(compact_text(card.get("long_description")))
    density = title_length + description_length + long_length

    if has_chart and long_length > 70:
        return 12
    if has_chart:
        return 6 if section_span >= 6 else 12
    if long_length > 120:
        return 12
    if density > 170:
        return 6
    if density < 48 and not card.get("url"):
        return 4
    return 6


def pack_rows(entries: List[dict], recalc_height_for_span: Optional[Callable[[dict, int], int]] = None) -> List[List[dict]]:
    remaining = [dict(entry) for entry in entries]
    remaining.sort(key=lambda entry: (-entry["height"], entry["importance"], entry["stable"]))
    rows: List[List[dict]] = []

    while remaining:
        row: List[dict] = []
        used = 0
        row_height = 0
        seed = remaining.pop(0)

        row.append(seed)
        used += seed["span"]
        row_height = max(row_height, seed["height"])

        while used < GRID_COLUMNS:
            space = GRID_COLUMNS - used
            best_index = -1
            best_score: Optional[float] = None

            for index, candidate in enumerate(remaining):
                if candidate["span"] > space:
                    continue

                leftover_after = space - candidate["span"]
                height_delta = abs(candidate["height"] - row_height)
                score = leftover_after * 5.0 + height_delta * 0.08 + candidate["importance"] * 0.015
                if candidate["span"] == space:
                    score -= 3.0

                if best_score is None or score < best_score:
                    best_score = score
                    best_index = index

            if best_index < 0:
                break

            picked = remaining.pop(best_index)
            row.append(picked)
            used += picked["span"]
            row_height = max(row_height, picked["height"])

        if used < GRID_COLUMNS and row:
            leftover = GRID_COLUMNS - used
            last = dict(row[-1])
            last["span"] += leftover
            if recalc_height_for_span:
                last["height"] = recalc_height_for_span(last["item"], last["span"])
            row[-1] = last

        rows.append(row)

    return rows


def visible_cards(section: dict) -> List[dict]:
    raw_cards = section.get("cards", [])
    if not isinstance(raw_cards, list):
        return []

    cards = []
    for index, card in enumerate(raw_cards):
        if not isinstance(card, dict):
            continue
        if not isinstance(card.get("title"), str) or not card.get("title"):
            continue

        next_card = dict(card)
        next_card["_importance"] = 100
        next_card["_stable"] = f"{index:04d}"
        cards.append(next_card)
    return cards


def pack_cards(cards: List[dict], section_span: int) -> dict:
    entries = []
    for index, card in enumerate(cards):
        span = choose_card_span(card, section_span)
        entries.append(
            {
                "item": card,
                "span": span,
                "height": estimate_card_height(card, span, section_span),
                "importance": card["_importance"],
                "stable": f"{card['_stable']}-{index}",
            }
        )

    card_rows = pack_rows(entries, lambda card, next_span: estimate_card_height(card, next_span, section_span))
    row_heights = [max(entry["height"] for entry in row) for row in card_rows]
    cards_height = sum(row_heights) + CARD_GRID_GAP * max(0, len(row_heights) - 1)
    packed_cards = []

    for row in card_rows:
        for entry in row:
            packed = dict(entry["item"])
            packed["_computed_span"] = entry["span"]
            packed_cards.append(packed)

    return {
        "cards": packed_cards,
        "row_count": len(card_rows),
        "estimated_height": SECTION_CHROME_HEIGHT + cards_height,
    }


def section_span_candidates(cards: List[dict]) -> List[int]:
    chart_count = sum(1 for card in cards if card_has_chart(card))
    long_count = sum(1 for card in cards if len(compact_text(card.get("long_description"))) > 70)
    candidates = {4, 6}

    if len(cards) <= 2 and chart_count == 0 and long_count == 0:
        candidates.add(3)
    if len(cards) >= 5 or chart_count >= 2 or long_count >= 2:
        candidates.add(8)
    if len(cards) >= 7:
        candidates.add(12)

    return sorted(candidates)


def choose_section_layout(section: dict, section_index: int) -> Optional[dict]:
    cards = visible_cards(section)
    if not cards:
        return None

    section_importance = min((card["_importance"] for card in cards), default=100)
    section_stable = f"{section_index:04d}"
    best_layout: Optional[dict] = None
    best_score: Optional[float] = None

    for section_span in section_span_candidates(cards):
        packed = pack_cards(cards, section_span)
        score = packed["estimated_height"] * (1 + section_span / 18) + packed["row_count"] * 8
        candidate = {
            "section": section,
            "span": section_span,
            "height": packed["estimated_height"],
            "importance": section_importance,
            "stable": section_stable,
        }

        if best_score is None or score < best_score:
            best_score = score
            best_layout = candidate

    return best_layout


def pack_sections(sections: List[dict]) -> List[List[dict]]:
    return pack_rows(sections)


def estimate_layout_height(payload: dict) -> int:
    alerts = payload.get("alerts", []) if isinstance(payload.get("alerts"), list) else []
    visible_alerts = [alert for alert in alerts if isinstance(alert, dict) and alert.get("message")]
    alerts_height = ALERT_HEIGHT if visible_alerts else 0

    sections = payload.get("sections", []) if isinstance(payload.get("sections"), list) else []
    section_layouts = []
    for section_index, section in enumerate(sections):
        if not isinstance(section, dict):
            continue
        section_layout = choose_section_layout(section, section_index)
        if section_layout:
            section_layouts.append(section_layout)

    if not section_layouts:
        return alerts_height

    section_rows = pack_sections(section_layouts)
    section_row_heights = [max(entry["height"] for entry in row) for row in section_rows]

    sections_height = sum(section_row_heights) + SECTION_GRID_GAP * max(0, len(section_row_heights) - 1)
    between = WALLPAPER_GAP if alerts_height and sections_height else 0
    return alerts_height + between + sections_height


def drop_candidate_ids(payload: dict, limit: int = 8) -> List[str]:
    candidates = []
    sections = payload.get("sections", []) if isinstance(payload.get("sections"), list) else []

    for section in sections:
        if not isinstance(section, dict):
            continue
        for card in visible_cards(section):
            card_id = card.get("id")
            if not isinstance(card_id, str) or not card_id:
                continue
            candidates.append(card_id)

    return list(reversed(candidates))[:limit]


def validate_layout_budget(payload: dict) -> None:
    ui = payload.get("ui", {}) if isinstance(payload.get("ui"), dict) else {}
    gutters = ui.get("gutters", {}) if isinstance(ui.get("gutters"), dict) else {}

    top = int(as_number(gutters.get("top"), 72))
    bottom = int(as_number(gutters.get("bottom"), 106))
    available = max(0, TARGET_VIEWPORT_HEIGHT - top - bottom - LAYOUT_SAFETY_MARGIN)
    required = estimate_layout_height(payload)

    if required <= available:
        return

    overflow = required - available
    candidates = drop_candidate_ids(payload)
    candidate_text = ", ".join(candidates) if candidates else "(none)"
    fail(
        f"layout budget exceeded by {overflow}px (required={required}px, available={available}px, safety={LAYOUT_SAFETY_MARGIN}px). "
        f"Reduce card volume or shorten card content. Suggested drop candidates: {candidate_text}"
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

        cards = section["cards"]
        if not isinstance(cards, list):
            fail(f"{section_path}.cards must be a list")

        for j, card in enumerate(cards):
            card_path = f"{section_path}.cards[{j}]"
            if not isinstance(card, dict):
                fail(f"{card_path} must be an object")
            validate_card(card, card_path)

        for key in section:
            if key not in {"id", "label", "cards"}:
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
