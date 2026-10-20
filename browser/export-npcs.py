"""Private, offline export from the provisioned 2021 VMaNGOS SQL snapshot. Never bundle rows."""
import argparse
import csv
import hashlib
import json
import re
from pathlib import Path


def rows(path):
    table, columns = None, None
    with path.open(encoding="utf-8-sig") as source:
        for line in source:
            if line.startswith("INSERT INTO "):
                match = re.match(r"INSERT INTO `(creature|creature_template|game_event|game_event_creature)` \((.+)\) VALUES\s*$", line)
                table = match[1] if match else None
                columns = re.findall(r"`([^`]+)`", match[2]) if match else None
            elif table and line.lstrip().startswith("("):
                text = line.strip()
                if not text.endswith(("),", ");")):
                    raise ValueError("Unsupported SQL row framing; expected one tuple per line")
                values = next(csv.reader([text[1:-2]], quotechar="'", escapechar="\\", skipinitialspace=True))
                if len(values) != len(columns):
                    raise ValueError(f"Wrong column count in {table}")
                yield table, dict(zip(columns, values))
                if text.endswith(";"):
                    table = None


def export(path):
    templates, spawns, events, memberships = {}, [], {}, {}
    for table, row in rows(path):
        if table == "creature_template":
            entry, patch = int(row["entry"]), int(row["patch"])
            if patch <= 10 and (entry not in templates or patch > int(templates[entry]["patch"])):
                templates[entry] = row
        elif table == "game_event":
            entry = int(row["entry"])
            minimum, maximum = int(row["patch_min"]), int(row["patch_max"])
            if not 0 <= minimum <= maximum <= 10:
                raise ValueError(f"Invalid event patch range for event {entry}")
            events[entry] = not int(row["disabled"]) and minimum <= 10 <= maximum
        elif table == "game_event_creature":
            memberships.setdefault(int(row["guid"]), set()).add(int(row["event"]))
        elif table == "creature" and int(row["map"]) in (0, 1) and int(row["patch_min"]) <= 10 <= int(row["patch_max"]):
            spawns.append(row)
    for linked in memberships.values():
        for event in linked:
            if not event or abs(event) not in events:
                raise ValueError(f"Unknown creature event reference {event}")
    output, missing = [], 0
    filtered = {"inactiveEvents": 0, "disabledOrInvisible": 0}
    for row in spawns:
        # A server may randomize these alternatives; the offline snapshot chooses the first authored one.
        entry = next((int(row[key]) for key in ("id", "id2", "id3", "id4") if int(row[key])), 0)
        template = templates.get(entry)
        if not template:
            missing += 1
            continue
        display = next((i for i in range(1, 5) if int(template[f"display_id{i}"])), None)
        if display is None:
            missing += 1
            continue
        if int(row["spawn_flags"]) & (0x02 | 0x40):  # DISABLED | NOT_VISIBLE
            filtered["disabledOrInvisible"] += 1
            continue
        linked = memberships.get(int(row["guid"]), set())
        # Negative membership makes a spawn eligible while that event is inactive.
        if linked and all(event > 0 and not events[event] for event in linked):
            filtered["inactiveEvents"] += 1
            continue
        output.append({
            "id": int(row["guid"]), "entry": entry, "map": int(row["map"]),
            "displayId": int(template[f"display_id{display}"]),
            "position": [float(row[f"position_{axis}"]) for axis in "xyz"],
            "orientation": float(row["orientation"]),
            "scale": float(template[f"display_scale{display}"]) or 1.0,
        })
    if not output:
        raise ValueError("Snapshot contains no usable overworld NPC spawns")
    with path.open("rb") as source:
        digest = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
        digest = digest.hexdigest()
    return {
        "version": 1,
        "provenance": {
            "source": path.name, "sha256": digest, "redistribution": "private-local-only",
            "kind": "offline-vmangos-snapshot", "patch": 10,
            "visibility": "Exclude disabled/invisible spawns and positive-only memberships whose events are all disabled or patch-ineligible; preserve negative memberships and ordinary pools",
            "filteredSpawns": filtered,
            "limitations": "Static authored placements; first template/display alternative; no calendar/hardcoded event or pool scheduling, aura/script visibility, movement, equipment or live state",
            "unresolvedTemplates": missing,
        },
        "spawns": output,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("output", type=Path, help="Private ignored output path, never committed")
    args = parser.parse_args()
    result = export(args.snapshot)
    with args.output.open("x", encoding="utf-8") as target:
        json.dump(result, target, separators=(",", ":"), allow_nan=False)
    print(f"Exported {len(result['spawns'])} static local spawns; unresolved templates {result['provenance']['unresolvedTemplates']}")
