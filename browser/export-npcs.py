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
                match = re.match(r"INSERT INTO `(creature|creature_template)` \((.+)\) VALUES\s*$", line)
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
    templates, spawns = {}, []
    for table, row in rows(path):
        if table == "creature_template":
            entry, patch = int(row["entry"]), int(row["patch"])
            if patch <= 10 and (entry not in templates or patch > int(templates[entry]["patch"])):
                templates[entry] = row
        elif int(row["map"]) in (0, 1) and int(row["patch_min"]) <= 10 <= int(row["patch_max"]):
            spawns.append(row)
    output, missing = [], 0
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
            "limitations": "Static authored placements; first template/display alternative; no event/pool scheduling, movement, equipment or live state",
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
