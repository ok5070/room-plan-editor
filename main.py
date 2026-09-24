from __future__ import annotations

import io
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import uuid
import re
import secrets
import shutil
from threading import RLock
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import ezdxf
from ezdxf.addons import odafc
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
PROJECT_FILE = BASE_DIR / "data" / "project.json"
GEOMETRY_FILE = BASE_DIR / "data" / "geometry.json"
PROJECTS_DIR = BASE_DIR / "data" / "projects"
PROJECTS_LOCK = RLock()
MAX_DXF_SIZE = 250 * 1024 * 1024
EQUIPMENT_TYPES = {
    "access_point", "controller", "reader", "exit_button", "emergency_release",
    "lock", "door_contact", "door_closer", "power_supply", "battery", "junction_box",
    "intercom_panel", "intercom_monitor", "network_switch", "camera",
    "data_outlet", "wifi_access_point", "patch_panel", "rack", "door",
}
EQUIPMENT_MOUNTS = {"wall", "door", "ceiling", "cabinet", "free"}
ODA_MACOS_PATHS = (
    Path("/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter"),
    Path("/Applications/ODA File Converter.app/Contents/MacOS/ODAFileConverter"),
)
REFERENCE_SHEETS = {
    "door-installation": {
        "title": "Эскиз монтажа точки доступа",
        "drawingSheet": "6",
        "filename": "reference-door-installation.png",
    },
}

app = FastAPI(
    title="Редактор плана помещения",
    version="0.2.0",
)

LAN_ACCESS_TOKEN = os.environ.get("ROOM_PLAN_ACCESS_TOKEN", "").strip()
LAN_ACCESS_COOKIE = "room_plan_access"


@app.middleware("http")
async def protect_local_network(request: Request, call_next):
    """Optionally require a temporary token for clients outside this Mac."""
    if not LAN_ACCESS_TOKEN:
        return await call_next(request)

    client_host = request.client.host if request.client else ""
    if client_host in {"127.0.0.1", "::1", "testclient"}:
        return await call_next(request)

    query_token = request.query_params.get("access_token", "")
    cookie_token = request.cookies.get(LAN_ACCESS_COOKIE, "")
    supplied_token = query_token or cookie_token
    if not secrets.compare_digest(supplied_token, LAN_ACCESS_TOKEN):
        return PlainTextResponse(
            "Доступ запрещён. Откройте временную ссылку, показанную при запуске сервера.",
            status_code=403,
        )

    if query_token:
        clean_query = urlencode([
            (key, value)
            for key, value in request.query_params.multi_items()
            if key != "access_token"
        ])
        target = request.url.path + (f"?{clean_query}" if clean_query else "")
        response = RedirectResponse(target, status_code=303)
        response.set_cookie(
            LAN_ACCESS_COOKIE,
            LAN_ACCESS_TOKEN,
            httponly=True,
            samesite="strict",
            max_age=12 * 60 * 60,
        )
        return response

    return await call_next(request)


def load_project() -> dict[str, Any]:
    return json.loads(PROJECT_FILE.read_text(encoding="utf-8"))


def load_geometry() -> dict[str, Any]:
    if GEOMETRY_FILE.exists():
        return json.loads(GEOMETRY_FILE.read_text(encoding="utf-8"))
    project_data = load_project()
    floor_plan = project_data.get("floorPlan", {})
    return {
        "version": 1,
        "canvas": {
            "width": floor_plan.get("width", 1400),
            "height": floor_plan.get("height", 820),
        },
        "walls": [],
        "doors": [],
        "windows": [],
    }


def validate_geometry(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Геометрия должна быть JSON-объектом")

    walls = payload.get("walls", [])
    doors = payload.get("doors", [])
    windows = payload.get("windows", [])
    if not isinstance(walls, list) or not isinstance(doors, list) or not isinstance(windows, list):
        raise ValueError("Поля walls, doors и windows должны быть массивами")
    if len(walls) > 10000 or len(doors) > 5000 or len(windows) > 5000:
        raise ValueError("Слишком много элементов геометрии")

    wall_ids: set[str] = set()
    normalized_walls: list[dict[str, Any]] = []
    for index, wall in enumerate(walls):
        if not isinstance(wall, dict):
            raise ValueError(f"Стена {index + 1}: нужен объект")
        wall_id = str(wall.get("id", "")).strip()
        if not wall_id or wall_id in wall_ids:
            raise ValueError(f"Стена {index + 1}: пустой или повторяющийся id")
        wall_ids.add(wall_id)
        values = []
        for key in ("x1", "y1", "x2", "y2"):
            value = float(wall.get(key))
            if not math.isfinite(value):
                raise ValueError(f"Стена {wall_id}: некорректная координата {key}")
            values.append(round(value, 3))
        thickness = float(wall.get("thickness", 12))
        wall_type = str(wall.get("type", "wall"))
        if wall_type not in {"wall", "partition"}:
            raise ValueError(f"Стена {wall_id}: неизвестный тип")
        normalized_walls.append({
            "id": wall_id,
            "type": wall_type,
            "x1": values[0], "y1": values[1], "x2": values[2], "y2": values[3],
            "thickness": round(max(2.0, min(thickness, 80.0)), 3),
        })

    door_ids: set[str] = set()
    access_point_codes: set[str] = set()
    normalized_doors: list[dict[str, Any]] = []
    for index, door in enumerate(doors):
        if not isinstance(door, dict):
            raise ValueError(f"Дверь {index + 1}: нужен объект")
        door_id = str(door.get("id", "")).strip()
        if not door_id or door_id in door_ids:
            raise ValueError(f"Дверь {index + 1}: пустой или повторяющийся id")
        door_ids.add(door_id)
        wall_id = str(door.get("wallId", "")).strip()
        if wall_id not in wall_ids:
            raise ValueError(f"Дверь {door_id}: не найдена несущая стена {wall_id}")
        x, y = float(door.get("x")), float(door.get("y"))
        width, rotation = float(door.get("width", 48)), float(door.get("rotation", 0))
        if not all(math.isfinite(value) for value in (x, y, width, rotation)):
            raise ValueError(f"Дверь {door_id}: некорректные параметры")
        access_point_id = door.get("accessPointId")
        raw_access_point_code = door.get("accessPointCode")
        access_point_code = str(raw_access_point_code).strip() if raw_access_point_code not in (None, "") else None
        if access_point_code is not None:
            if not re.fullmatch(r"ТД\.\d+\.\d+", access_point_code):
                raise ValueError(f"Дверь {door_id}: код точки доступа должен иметь вид ТД.1.1")
            if access_point_code in access_point_codes:
                raise ValueError(f"Точка доступа {access_point_code} назначена нескольким дверям")
            access_point_codes.add(access_point_code)
        normalized_doors.append({
            "id": door_id,
            "wallId": wall_id,
            "x": round(x, 3), "y": round(y, 3),
            "width": round(max(12.0, min(width, 300.0)), 3),
            "rotation": round(rotation, 6),
            "swing": door.get("swing") if door.get("swing") in {"left", "right", "unknown"} else "left",
            "openingSide": 1 if door.get("openingSide") == 1 else -1,
            "leafCount": 2 if door.get("leafCount") == 2 else 1,
            "readerCount": 2 if door.get("readerCount") == 2 else 1,
            "accessPointId": str(access_point_id).strip() if access_point_id not in (None, "") else None,
            "accessPointCode": access_point_code,
            **({"confidence": str(door["confidence"])} if door.get("confidence") else {}),
            **({"reviewHint": str(door["reviewHint"])} if door.get("reviewHint") else {}),
        })

    window_ids: set[str] = set()
    normalized_windows: list[dict[str, Any]] = []
    for index, window in enumerate(windows):
        if not isinstance(window, dict):
            raise ValueError(f"Окно {index + 1}: нужен объект")
        window_id = str(window.get("id", "")).strip()
        if not window_id or window_id in window_ids:
            raise ValueError(f"Окно {index + 1}: пустой или повторяющийся id")
        window_ids.add(window_id)
        wall_id = str(window.get("wallId", "")).strip()
        if wall_id not in wall_ids:
            raise ValueError(f"Окно {window_id}: не найдена несущая стена {wall_id}")
        x, y = float(window.get("x")), float(window.get("y"))
        width, rotation = float(window.get("width", 70)), float(window.get("rotation", 0))
        if not all(math.isfinite(value) for value in (x, y, width, rotation)):
            raise ValueError(f"Окно {window_id}: некорректные параметры")
        normalized_windows.append({
            "id": window_id,
            "wallId": wall_id,
            "x": round(x, 3), "y": round(y, 3),
            "width": round(max(20.0, min(width, 500.0)), 3),
            "rotation": round(rotation, 6),
        })

    canvas = payload.get("canvas", {})
    return {
        "version": max(2, int(payload.get("version", 1))),
        "canvas": {
            "width": float(canvas.get("width", load_project()["floorPlan"]["width"])),
            "height": float(canvas.get("height", load_project()["floorPlan"]["height"])),
        },
        "walls": normalized_walls,
        "doors": normalized_doors,
        "windows": normalized_windows,
    }


def validate_equipment(payload: Any, geometry: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise ValueError("Оборудование должно быть массивом")
    if len(payload) > 10000:
        raise ValueError("Слишком много единиц оборудования")
    ids: set[str] = set()
    codes: set[str] = set()
    door_ids = {item["id"] for item in geometry.get("doors", [])}
    wall_ids = {item["id"] for item in geometry.get("walls", [])}
    result: list[dict[str, Any]] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"Оборудование {index + 1}: нужен объект")
        item_id = str(item.get("id", "")).strip()
        if not item_id or item_id in ids or len(item_id) > 80:
            raise ValueError(f"Оборудование {index + 1}: пустой, длинный или повторяющийся id")
        ids.add(item_id)
        item_type = str(item.get("type", "")).strip()
        if item_type not in EQUIPMENT_TYPES:
            raise ValueError(f"Оборудование {item_id}: неизвестный тип")
        x, y = float(item.get("x")), float(item.get("y"))
        rotation = float(item.get("rotation", 0))
        mounting_height = float(item.get("mountingHeight", 1200))
        if not all(math.isfinite(value) for value in (x, y, rotation, mounting_height)):
            raise ValueError(f"Оборудование {item_id}: некорректные координаты или высота")
        code = str(item.get("code", item_id)).strip()[:80] or item_id
        if code in codes:
            raise ValueError(f"Оборудование {item_id}: обозначение {code} уже используется")
        codes.add(code)
        mount = str(item.get("mount", "free"))
        if mount not in EQUIPMENT_MOUNTS:
            raise ValueError(f"Оборудование {item_id}: неизвестный способ монтажа")
        host_door_id = item.get("hostDoorId") or None
        host_wall_id = item.get("hostWallId") or None
        if host_door_id is not None and str(host_door_id) not in door_ids:
            raise ValueError(f"Оборудование {item_id}: дверь {host_door_id} не найдена")
        if host_wall_id is not None and str(host_wall_id) not in wall_ids:
            raise ValueError(f"Оборудование {item_id}: стена {host_wall_id} не найдена")
        normalized = {
            "id": item_id, "system": equipment_system(item_type), "type": item_type, "code": code,
            "x": round(x, 3), "y": round(y, 3), "rotation": round(rotation, 6),
            "mount": mount, "mountingHeight": round(max(0, min(mounting_height, 10000)), 1),
            "hostDoorId": str(host_door_id) if host_door_id is not None else None,
            "hostWallId": str(host_wall_id) if host_wall_id is not None else None,
            "status": "confirmed" if item.get("status") == "confirmed" else "proposed",
        }
        if item_type == "controller":
            door_capacity = int(item.get("controllerDoorCapacity", 4))
            reader_capacity = int(item.get("controllerReaderCapacity", door_capacity * 2))
            if door_capacity not in {1, 2, 4, 8} or not 1 <= reader_capacity <= 32:
                raise ValueError(f"Контроллер {item_id}: некорректная ёмкость")
            served = item.get("servedDoorIds", [])
            if not isinstance(served, list) or len(served) != len(set(served)):
                raise ValueError(f"Контроллер {item_id}: список дверей должен быть уникальным")
            if any(str(door_id) not in door_ids for door_id in served):
                raise ValueError(f"Контроллер {item_id}: обслуживаемая дверь не найдена")
            readers_by_door = {door["id"]: door.get("readerCount", 1) for door in geometry.get("doors", [])}
            reader_load = sum(readers_by_door[str(door_id)] for door_id in served)
            if len(served) > door_capacity or reader_load > reader_capacity:
                raise ValueError(f"Контроллер {item_id}: превышена ёмкость дверей или считывателей")
            normalized["controllerDoorCapacity"] = door_capacity
            normalized["controllerReaderCapacity"] = reader_capacity
            normalized["servedDoorIds"] = [str(door_id) for door_id in served]
            normalized["formFactor"] = "din_rail" if item.get("formFactor") == "din_rail" else "wall_enclosure"
        if item.get("doorMount") is not None:
            dm = item["doorMount"]
            if not isinstance(dm, dict) or not host_door_id:
                raise ValueError("Монтаж требует связанной двери")
            offset = float(dm.get("offset"))
            if dm.get("side") not in (-1, 1) or dm.get("surface") not in {"wall", "frame", "leaf"} or not math.isfinite(offset) or abs(offset) > 105:
                raise ValueError("Некорректная поверхность или координаты монтажа")
            normalized["doorMount"] = {"side": dm["side"], "surface": dm["surface"], "offset": round(offset, 3)}
        for key in ("model", "manufacturer", "source", "layer", "block", "templateSource"):
            if item.get(key) not in (None, ""):
                normalized[key] = str(item[key])[:240]
        result.append(normalized)
    door_owners: dict[str, str] = {}
    for controller in (item for item in result if item["type"] == "controller"):
        for door_id in controller.get("servedDoorIds", []):
            if door_id in door_owners:
                raise ValueError(
                    f"Дверь {door_id} назначена контроллерам {door_owners[door_id]} и {controller['id']}"
                )
            door_owners[door_id] = controller["id"]
    return result


EQUIPMENT_SYSTEMS = {
    "camera": "cctv",
    "data_outlet": "sks", "wifi_access_point": "sks", "network_switch": "sks",
    "patch_panel": "sks", "rack": "sks",
}


def equipment_system(item_type: str) -> str:
    return EQUIPMENT_SYSTEMS.get(item_type, "architecture" if item_type == "door" else "skud_intercom")


def classify_entity(layer: str, block_name: str = "") -> str | None:
    haystack = f"{layer} {block_name}".lower()
    rules = (
        ("camera", ("camera", "cctv", "video surveillance", "видеонаблю", "видеокамер", "камера", "сот")),
        ("wifi_access_point", ("wi-fi", "wifi", "wlan", "wireless ap", "точка wi")),
        ("network_switch", ("network switch", "ethernet switch", "коммутатор")),
        ("patch_panel", ("patch panel", "патч-панел")),
        ("rack", ("telecom rack", "network rack", "шкаф скс", "стойка скс")),
        ("data_outlet", ("rj45", "data outlet", "lan outlet", "розетка скс", "инф. розетка")),
    )
    for item_type, words in rules:
        if any(word in haystack for word in words):
            return item_type
    controller_words = ("controller", "skud", "скуд", "контроллер")
    door_words = ("door", "gate", "turnstile", "двер", "калитк", "турникет")
    if any(word in haystack for word in controller_words):
        return "controller"
    if any(word in haystack for word in door_words):
        return "door"
    return None


def classify_architecture_layer(layer: str) -> str | None:
    """Classify common Russian/international CAD layer names without project-specific equality checks."""
    value = re.sub(r"[^a-zа-я0-9]+", "-", layer.lower()).strip("-")
    partition_words = ("partition", "перегород", "i-wall", "int-wall", "interior-wall", "внутр-стен")
    wall_words = ("wall", "walls", "a-wall", "ar-wall", "архит-стен", "арх-стен", "стен", "несущ")
    if any(word in value for word in partition_words):
        return "partition"
    if any(word in value for word in wall_words):
        return "wall"
    return None


def extract_equipment(document: ezdxf.document.Drawing) -> list[dict[str, Any]]:
    equipment: list[dict[str, Any]] = []

    for entity in document.modelspace():
        entity_type = entity.dxftype()
        if entity_type not in {"INSERT", "POINT", "CIRCLE"}:
            continue

        layer = str(entity.dxf.get("layer", "0"))
        block_name = str(entity.dxf.get("name", "")) if entity_type == "INSERT" else ""
        item_type = classify_entity(layer, block_name)
        if item_type is None:
            continue

        point = entity.dxf.get({"INSERT": "insert", "POINT": "location", "CIRCLE": "center"}[entity_type])
        if point is None:
            continue

        prefix = {"controller": "AC", "door": "D", "camera": "CAM", "data_outlet": "RJ",
                  "wifi_access_point": "AP", "network_switch": "SW", "patch_panel": "PP",
                  "rack": "RACK"}.get(item_type, "EQ")
        sequence = sum(item["type"] == item_type for item in equipment) + 1
        equipment.append(
            {
                "id": f"{prefix}-{sequence:02d}",
                "type": item_type,
                "x": round(float(point.x), 3),
                "y": round(float(point.y), 3),
                "z": round(float(point.z), 3),
                "layer": layer,
                "block": block_name or entity_type,
                "status": "not_configured", "system": equipment_system(item_type),
            }
        )

    return equipment


def collapse_wall_face_pairs(walls: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int, int]:
    """Replace two CAD wall faces with one editable centerline.

    Architectural DWGs commonly draw a wall as a narrow closed polygon.  The
    editor model, however, stores a wall as one axis.  Pair only long, nearly
    parallel faces on the same CAD layer and remove the short end caps that
    merely close that polygon.  Mutual-best matching keeps crowded or
    ambiguous parallel linework unchanged instead of inventing a wall.
    """
    if not walls:
        return walls, 0, 0
    xs = [float(value) for wall in walls for value in (wall["x1"], wall["x2"])]
    ys = [float(value) for wall in walls for value in (wall["y1"], wall["y2"])]
    extent = max(max(xs) - min(xs), max(ys) - min(ys), 1.0)
    unit = 0.001 if extent < 100 else 1.0
    min_length, min_gap, max_gap = 500 * unit, 60 * unit, 800 * unit
    candidates: list[dict[str, Any]] = []

    for first_index, first in enumerate(walls):
        ax, ay = float(first["x1"]), float(first["y1"])
        adx, ady = float(first["x2"]) - ax, float(first["y2"]) - ay
        first_length = math.hypot(adx, ady)
        if first_length < min_length:
            continue
        ux, uy = adx / first_length, ady / first_length
        for second_index in range(first_index + 1, len(walls)):
            second = walls[second_index]
            if str(second.get("layer", "")).lower() != str(first.get("layer", "")).lower():
                continue
            bx, by = float(second["x1"]), float(second["y1"])
            bdx, bdy = float(second["x2"]) - bx, float(second["y2"]) - by
            second_length = math.hypot(bdx, bdy)
            if second_length < min_length:
                continue
            parallel_error = abs(abs((bdx * ux + bdy * uy) / second_length) - 1)
            if parallel_error > 0.003:
                continue
            signed_gap = (bx - ax) * -uy + (by - ay) * ux
            gap = abs(signed_gap)
            if gap < min_gap or gap > max_gap:
                continue
            projected = sorted(((bx - ax) * ux + (by - ay) * uy,
                                (float(second["x2"]) - ax) * ux + (float(second["y2"]) - ay) * uy))
            overlap = max(0.0, min(first_length, projected[1]) - max(0.0, projected[0]))
            overlap_ratio = overlap / max(first_length, second_length)
            overhang = max(0.0, -projected[0], projected[1] - first_length)
            if overlap_ratio < 0.75 or overhang > 400 * unit:
                continue
            endpoint_error = abs(projected[0]) + abs(projected[1] - first_length)
            candidates.append({"a": first_index, "b": second_index, "gap": gap,
                               "overlap": overlap_ratio, "endpointError": endpoint_error})

    by_wall: dict[int, list[dict[str, Any]]] = {}
    for candidate in candidates:
        by_wall.setdefault(candidate["a"], []).append(candidate)
        by_wall.setdefault(candidate["b"], []).append(candidate)

    def score(candidate: dict[str, Any]) -> tuple[float, float, float]:
        return (-candidate["overlap"], candidate["endpointError"], candidate["gap"])

    best = {index: min(items, key=score) for index, items in by_wall.items()}
    pairs = [candidate for candidate in candidates
             if best.get(candidate["a"]) is candidate and best.get(candidate["b"]) is candidate]
    paired_indexes = {index for pair in pairs for index in (pair["a"], pair["b"])}
    removed_caps: set[int] = set()
    replacements: dict[int, dict[str, Any]] = {}

    def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
        return math.hypot(a[0] - b[0], a[1] - b[1])

    for pair in pairs:
        first, second = walls[pair["a"]], walls[pair["b"]]
        a1 = (float(first["x1"]), float(first["y1"]))
        a2 = (float(first["x2"]), float(first["y2"]))
        b1 = (float(second["x1"]), float(second["y1"]))
        b2 = (float(second["x2"]), float(second["y2"]))
        if distance(a1, b1) + distance(a2, b2) > distance(a1, b2) + distance(a2, b1):
            b1, b2 = b2, b1
        replacements[pair["a"]] = {
            **first,
            "id": f'{first["id"]}-CL',
            "x1": (a1[0] + b1[0]) / 2,
            "y1": (a1[1] + b1[1]) / 2,
            "x2": (a2[0] + b2[0]) / 2,
            "y2": (a2[1] + b2[1]) / 2,
            "thickness": 2.0,
            "source": "cad_face_pair_centerline",
            "pairedGap": pair["gap"],
        }
        cap_tolerance = max(20 * unit, pair["gap"] * 0.12)
        for index, candidate in enumerate(walls):
            if index in paired_indexes or index in removed_caps:
                continue
            if str(candidate.get("layer", "")).lower() != str(first.get("layer", "")).lower():
                continue
            c1 = (float(candidate["x1"]), float(candidate["y1"]))
            c2 = (float(candidate["x2"]), float(candidate["y2"]))
            closes_start = (distance(c1, a1) <= cap_tolerance and distance(c2, b1) <= cap_tolerance) or (
                distance(c2, a1) <= cap_tolerance and distance(c1, b1) <= cap_tolerance)
            closes_end = (distance(c1, a2) <= cap_tolerance and distance(c2, b2) <= cap_tolerance) or (
                distance(c2, a2) <= cap_tolerance and distance(c1, b2) <= cap_tolerance)
            if closes_start or closes_end:
                removed_caps.add(index)

    output = []
    second_faces = {pair["b"] for pair in pairs}
    for index, wall in enumerate(walls):
        if index in second_faces or index in removed_caps:
            continue
        output.append(replacements.get(index, wall))
    return output, len(pairs), len(removed_caps)


def extract_cad_geometry(document: ezdxf.document.Drawing) -> dict[str, Any]:
    """Build editable plan geometry from explicitly named CAD layers.

    This is intentionally deterministic: only line/polyline entities on layers
    that look architectural are promoted to walls, and door blocks/points are
    attached to the nearest detected wall. The full CAD preview remains the
    source of truth for anything that is not confidently classified.
    """
    door_words = ("door", "doors", "двер", "gate", "калит", "турникет")
    segments: list[tuple[float, float, float, float, str]] = []

    def is_wall_layer(layer: str) -> bool:
        return classify_architecture_layer(layer) is not None

    def add_segment(start: Any, end: Any, layer: str) -> None:
        x1, y1 = float(start.x), float(start.y)
        x2, y2 = float(end.x), float(end.y)
        if not all(math.isfinite(value) for value in (x1, y1, x2, y2)):
            return
        if math.hypot(x2 - x1, y2 - y1) < 0.01:
            return
        segments.append((x1, y1, x2, y2, layer))

    def visit(entity: Any, inherited_layer: str | None = None, depth: int = 0) -> None:
        if depth > 4:
            return
        kind = entity.dxftype()
        own_layer = str(entity.dxf.get("layer", inherited_layer or "0"))
        layer = inherited_layer if own_layer == "0" and inherited_layer else own_layer
        if not is_wall_layer(layer):
            if kind in {"INSERT", "DIMENSION"}:
                try:
                    for child in entity.virtual_entities():
                        visit(child, layer, depth + 1)
                except (AttributeError, ValueError, TypeError):
                    pass
            return
        if kind == "LINE":
            add_segment(entity.dxf.start, entity.dxf.end, layer)
        elif kind == "LWPOLYLINE":
            points = [(point[0], point[1]) for point in entity.get_points("xy")]
            for start, end in zip(points, points[1:]):
                add_segment(type("Point", (), {"x": start[0], "y": start[1]})(),
                            type("Point", (), {"x": end[0], "y": end[1]})(), layer)
            if entity.closed and len(points) > 2:
                add_segment(type("Point", (), {"x": points[-1][0], "y": points[-1][1]})(),
                            type("Point", (), {"x": points[0][0], "y": points[0][1]})(), layer)
        elif kind == "POLYLINE":
            points = [v.dxf.location for v in entity.vertices]
            for start, end in zip(points, points[1:]):
                add_segment(start, end, layer)
            if entity.is_closed and len(points) > 2:
                add_segment(points[-1], points[0], layer)
        elif kind in {"INSERT", "DIMENSION"}:
            try:
                for child in entity.virtual_entities():
                    visit(child, layer, depth + 1)
            except (AttributeError, ValueError, TypeError):
                pass

    for entity in document.modelspace():
        visit(entity)

    # Remove exact/reversed duplicates often present in exported polylines.
    unique: list[tuple[float, float, float, float, str]] = []
    seen: set[tuple[float, float, float, float, str]] = set()
    for segment in segments:
        x1, y1, x2, y2, layer = segment
        key = (round(x1, 3), round(y1, 3), round(x2, 3), round(y2, 3), layer.lower())
        reverse = (key[2], key[3], key[0], key[1], key[4])
        if key in seen or reverse in seen:
            continue
        seen.add(key)
        unique.append(segment)

    if not unique:
        return {"version": 2, "canvas": {}, "walls": [], "doors": [], "windows": [],
                "metadata": {"architectureMode": "manual_blank", "wallLayers": [],
                             "message": "Архитектурные слои не найдены; доступно ручное построение"}}

    min_x = min(min(item[0], item[2]) for item in unique)
    max_x = max(max(item[0], item[2]) for item in unique)
    min_y = min(min(item[1], item[3]) for item in unique)
    max_y = max(max(item[1], item[3]) for item in unique)
    extent = max(max_x - min_x, max_y - min_y, 1.0)
    # The sample CAD plans use metres (for example 20 x 14). Keep the
    # architectural dimensions in source units and convert them together with
    # the coordinates below; otherwise the validator's 80-unit ceiling makes
    # walls visibly heavier than doors.
    default_thickness = 0.18 if extent < 100 else 180.0
    walls: list[dict[str, Any]] = []
    for index, (x1, y1, x2, y2, layer) in enumerate(unique, 1):
        wall_type = classify_architecture_layer(layer) or "wall"
        walls.append({"id": f"CAD-W-{index:04d}", "type": wall_type,
                      "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                      "thickness": default_thickness, "layer": layer})
    walls, merged_face_pairs, removed_face_caps = collapse_wall_face_pairs(walls)

    def nearest_wall(x: float, y: float) -> tuple[dict[str, Any] | None, float, float, float]:
        best: tuple[dict[str, Any] | None, float, float, float] = (None, float("inf"), x, y)
        for wall in walls:
            dx, dy = wall["x2"] - wall["x1"], wall["y2"] - wall["y1"]
            length_sq = dx * dx + dy * dy or 1.0
            t = max(0.0, min(1.0, ((x - wall["x1"]) * dx + (y - wall["y1"]) * dy) / length_sq))
            px, py = wall["x1"] + t * dx, wall["y1"] + t * dy
            distance = math.hypot(x - px, y - py)
            if distance < best[1]:
                best = (wall, distance, px, py)
        return best

    tolerance = max(25.0, min(120.0, extent * 0.02))
    doors: list[dict[str, Any]] = []
    unmatched_doors = 0
    for item in extract_equipment(document):
        descriptor = f'{item.get("layer", "")} {item.get("block", "")}'.lower()
        if item["type"] != "door" or not any(word in descriptor for word in door_words):
            continue
        wall, distance, x, y = nearest_wall(item["x"], item["y"])
        if wall is None or distance > tolerance:
            unmatched_doors += 1
            continue
        rotation = math.atan2(wall["y2"] - wall["y1"], wall["x2"] - wall["x1"])
        doors.append({"id": f"CAD-D-{len(doors) + 1:04d}", "wallId": wall["id"],
                      "x": x, "y": y, "width": 48, "rotation": rotation,
                      "swing": "unknown", "openingSide": -1, "leafCount": 1,
                      "readerCount": 1, "source": item.get("block")})

    return {"version": 2, "canvas": {}, "walls": walls, "doors": doors, "windows": [],
            "metadata": {"wallLayers": sorted({item["layer"] for item in walls}),
                         "architectureMode": "explicit_layers",
                         "unmatchedDoors": unmatched_doors,
                         "mergedWallFacePairs": merged_face_pairs,
                         "removedWallFaceCaps": removed_face_caps}}


def normalize_cad_geometry(geometry: dict[str, Any], preview: dict[str, Any], floor: dict[str, Any]) -> dict[str, Any]:
    """Apply the exact CAD-preview transform to editable geometry."""
    source = preview.get("sourceBounds") or preview.get("bounds")
    transform = preview.get("transform")
    if not source or not transform:
        return geometry
    scale, padding = float(transform["scale"]), float(transform["padding"])

    def point(x: float, y: float) -> tuple[float, float]:
        return (padding + (x - source["minX"]) * scale,
                float(floor["height"]) - padding - (y - source["minY"]) * scale)

    result = {**geometry, "canvas": {"width": floor["width"], "height": floor["height"]}}
    source_extent = max(source["maxX"] - source["minX"], source["maxY"] - source["minY"])
    source_wall_thickness = 0.18 if source_extent < 100 else 180.0
    source_door_width = 0.9 if source_extent < 100 else 900.0
    wall_thickness = max(6.0, min(32.0, source_wall_thickness * scale))
    door_width = max(36.0, min(140.0, source_door_width * scale))
    result["walls"] = [{**wall, "x1": point(wall["x1"], wall["y1"])[0], "y1": point(wall["x1"], wall["y1"])[1],
                        "x2": point(wall["x2"], wall["y2"])[0], "y2": point(wall["x2"], wall["y2"])[1],
                        "thickness": 2.0 if wall.get("source") == "cad_face_pair_centerline" else wall_thickness}
                       for wall in geometry.get("walls", [])]
    result["doors"] = [{**door, "x": point(door["x"], door["y"])[0], "y": point(door["x"], door["y"])[1],
                        "rotation": -door["rotation"], "width": door_width} for door in geometry.get("doors", [])]
    return result


def read_text_dxf(payload: bytes) -> ezdxf.document.Drawing:
    for encoding in ("utf-8", "cp1251", "latin-1"):
        try:
            return ezdxf.read(io.StringIO(payload.decode(encoding)))
        except (UnicodeDecodeError, ezdxf.DXFError):
            continue
    # ODA can emit a valid ASCII DXF whose section structure is accepted by
    # ezdxf.readfile() but not by the StringIO reader (notably after DWG export).
    # Use the same parser against a temporary file before reporting a bad DXF.
    with tempfile.NamedTemporaryFile(suffix=".dxf") as stream:
        stream.write(payload)
        stream.flush()
        try:
            return ezdxf.readfile(stream.name)
        except (OSError, ezdxf.DXFError):
            pass
    raise ValueError("Файл DXF не удалось прочитать")


def configure_oda_converter() -> Path | None:
    """Teach ezdxf where the macOS ODA app keeps its CLI executable."""
    configured_path = odafc.get_unix_exec_path()
    if configured_path and Path(configured_path).is_file():
        return Path(configured_path)

    for candidate in ODA_MACOS_PATHS:
        if candidate.is_file():
            ezdxf.options.set("odafc-addon", "unix_exec_path", str(candidate))
            return candidate
    return None


def read_dwg(payload: bytes) -> ezdxf.document.Drawing:
    """Convert DWG through a locally installed ODA File Converter."""
    if configure_oda_converter() is None and not odafc.is_installed():
        raise RuntimeError(
            "DWG требует бесплатный ODA File Converter, "
            "установленный на этом компьютере."
        )
    with tempfile.TemporaryDirectory(prefix="sibest-cad-") as temp_dir:
        source = Path(temp_dir) / "uploaded.dwg"
        source.write_bytes(payload)
        try:
            return odafc.readfile(source)
        except Exception as error:  # odafc exceptions differ between platforms
            raise RuntimeError(
                "DWG требует бесплатный ODA File Converter, "
                "установленный на этом компьютере."
            ) from error


def calculate_bounds(items: list[dict[str, Any]]) -> dict[str, float] | None:
    if not items:
        return None
    xs = [float(item["x"]) for item in items]
    ys = [float(item["y"]) for item in items]
    return {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}


def extract_cad_preview(document: ezdxf.document.Drawing, limit: int = 20000) -> dict[str, Any]:
    """Extract a deterministic, non-editable CAD preview without guessing walls."""
    paths: list[dict[str, Any]] = []
    labels: list[dict[str, Any]] = []
    all_points: list[tuple[float, float]] = []

    def add_path(points: list[tuple[float, float]], layer: str, closed: bool = False) -> None:
        clean = [[round(float(x), 3), round(float(y), 3)] for x, y in points
                 if math.isfinite(float(x)) and math.isfinite(float(y))]
        if len(clean) < 2 or len(paths) >= limit:
            return
        paths.append({"layer": layer, "points": clean, "closed": bool(closed)})
        all_points.extend((p[0], p[1]) for p in clean)

    def sample_arc(center: Any, radius: float, start: float, end: float) -> list[tuple[float, float]]:
        sweep = (end - start) % 360 or 360
        count = max(8, min(96, math.ceil(sweep / 7.5)))
        return [(center.x + radius * math.cos(math.radians(start + sweep * i / count)),
                 center.y + radius * math.sin(math.radians(start + sweep * i / count)))
                for i in range(count + 1)]

    def visit(entity: Any, inherited_layer: str | None = None, depth: int = 0) -> None:
        if depth > 4 or len(paths) >= limit:
            return
        kind = entity.dxftype()
        own_layer = str(entity.dxf.get("layer", inherited_layer or "0"))
        layer = inherited_layer if own_layer == "0" and inherited_layer else own_layer
        if kind == "LINE":
            add_path([(entity.dxf.start.x, entity.dxf.start.y), (entity.dxf.end.x, entity.dxf.end.y)], layer)
        elif kind == "LWPOLYLINE":
            try:
                points = [(point.x, point.y) for point in entity.flattening(0.5)]
            except (AttributeError, TypeError):
                points = [(point[0], point[1]) for point in entity.get_points("xy")]
            add_path(points, layer, entity.closed)
        elif kind == "POLYLINE":
            add_path([(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices], layer, bool(entity.is_closed))
        elif kind == "ARC":
            add_path(sample_arc(entity.dxf.center, float(entity.dxf.radius),
                                float(entity.dxf.start_angle), float(entity.dxf.end_angle)), layer)
        elif kind == "CIRCLE":
            add_path(sample_arc(entity.dxf.center, float(entity.dxf.radius), 0, 360), layer, True)
        elif kind in {"INSERT", "DIMENSION"}:
            try:
                for child in entity.virtual_entities():
                    visit(child, layer, depth + 1)
            except (AttributeError, ValueError, TypeError):
                pass
        elif kind in {"TEXT", "MTEXT"} and len(labels) < 2000:
            point = entity.dxf.get("insert")
            if point is not None:
                raw = entity.plain_text() if kind == "MTEXT" else str(entity.dxf.text)
                text = " ".join(raw.replace("\\P", " ").split())[:240]
                if text:
                    height = entity.dxf.get("char_height", 3) if kind == "MTEXT" else entity.dxf.get("height", 3)
                    labels.append({"layer": layer, "text": text, "x": float(point.x), "y": float(point.y),
                                   "height": float(height), "rotation": float(entity.dxf.get("rotation", 0))})
                    all_points.append((float(point.x), float(point.y)))

    for source in document.modelspace():
        visit(source)
    if not all_points:
        return {"paths": [], "labels": [], "layers": [], "bounds": None, "truncated": False}
    xs, ys = zip(*all_points)
    bounds = {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}
    return {"paths": paths, "labels": labels,
            "layers": sorted({p["layer"] for p in paths} | {t["layer"] for t in labels}),
            "bounds": bounds, "truncated": len(paths) >= limit}


def normalize_cad_preview(preview: dict[str, Any], floor: dict[str, Any]) -> dict[str, Any]:
    bounds = preview.get("bounds")
    if not bounds:
        return preview
    width = max(bounds["maxX"] - bounds["minX"], 1)
    height = max(bounds["maxY"] - bounds["minY"], 1)
    padding = 70
    factor = min((float(floor["width"]) - padding * 2) / width,
                 (float(floor["height"]) - padding * 2) / height)

    def point(x: float, y: float) -> list[float]:
        return [round(padding + (x - bounds["minX"]) * factor, 3),
                round(float(floor["height"]) - padding - (y - bounds["minY"]) * factor, 3)]

    return {**preview, "sourceBounds": bounds,
            "bounds": {"minX": padding, "minY": padding,
                       "maxX": padding + width * factor, "maxY": padding + height * factor},
            "transform": {"scale": factor, "padding": padding},
            "paths": [{**path, "points": [point(*p) for p in path["points"]]} for path in preview["paths"]],
            "labels": [{**label, "x": point(label["x"], label["y"])[0],
                        "y": point(label["x"], label["y"])[1],
                        "height": max(5, min(28, label["height"] * factor)),
                        "rotation": -label["rotation"]} for label in preview["labels"]]}


def detect_cad_areas(preview: dict[str, Any]) -> list[dict[str, Any]]:
    """Find separate drawing clusters in Model space for sheet selection."""
    paths = preview.get("paths", [])
    if not paths or not preview.get("bounds"):
        return []
    bounds = preview["bounds"]
    width = max(bounds["maxX"] - bounds["minX"], 1)
    height = max(bounds["maxY"] - bounds["minY"], 1)
    cell = max(80.0, min(width, height) / 18.0)
    cells: dict[tuple[int, int], int] = {}
    path_cells: list[set[tuple[int, int]]] = []
    for path in paths:
        points = path.get("points", [])
        if len(points) < 2:
            path_cells.append(set())
            continue
        xs, ys = zip(*points)
        touched = {(int((x - bounds["minX"]) / cell), int((y - bounds["minY"]) / cell))
                   for x, y in ((min(xs), min(ys)), (max(xs), max(ys)))}
        path_cells.append(touched)
        for key in touched:
            cells[key] = cells.get(key, 0) + 1
    occupied = {key for key, count in cells.items() if count >= 3}
    groups: list[set[tuple[int, int]]] = []
    while occupied:
        seed = occupied.pop(); group = {seed}; stack = [seed]
        while stack:
            x, y = stack.pop()
            for neighbor in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if neighbor in occupied:
                    occupied.remove(neighbor); group.add(neighbor); stack.append(neighbor)
        if len(group) >= 2:
            groups.append(group)
    areas = []
    for index, group in enumerate(sorted(groups, key=lambda g: (min(y for _, y in g), min(x for x, _ in g))), 1):
        members = [i for i, touched in enumerate(path_cells) if touched & group]
        if len(members) < 5:
            continue
        xs = [x for i in members for x, _ in paths[i]["points"]]
        ys = [y for i in members for _, y in paths[i]["points"]]
        areas.append({"name": f"Model · область {index}", "bounds": {
            "minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)},
            "pathIndexes": members})
    return areas


def select_cad_area(record: dict[str, Any], area: dict[str, Any]) -> dict[str, Any]:
    """Crop the persisted master CAD model to one detected Model-space area."""
    floor = record["project"]["floorPlan"]
    master_preview = record.get("cadPreviewMaster") or record.get("cadPreview")
    master_geometry = record.get("cadGeometryMaster") or record.get("geometry")
    master_equipment = record.get("cadEquipmentMaster")
    if not master_preview or not master_preview.get("transform") or not master_preview.get("sourceBounds"):
        raise ValueError("В проекте нет исходной CAD-подложки для выбранной области")

    transform = master_preview["transform"]
    source_bounds = master_preview["sourceBounds"]
    scale = float(transform["scale"])
    padding = float(transform["padding"])
    floor_height = float(floor["height"])

    def to_source(x: float, y: float) -> tuple[float, float]:
        return (
            float(source_bounds["minX"]) + (float(x) - padding) / scale,
            float(source_bounds["minY"]) + (floor_height - padding - float(y)) / scale,
        )

    indexes = [int(index) for index in area.get("pathIndexes", [])]
    selected_paths = [master_preview["paths"][index] for index in indexes
                      if 0 <= index < len(master_preview.get("paths", []))]
    if not selected_paths:
        raise ValueError("Выбранная область CAD не содержит линий")
    bounds = area["bounds"]
    selected_labels = [label for label in master_preview.get("labels", [])
                       if bounds["minX"] <= label["x"] <= bounds["maxX"]
                       and bounds["minY"] <= label["y"] <= bounds["maxY"]]
    raw_preview = {
        "paths": [{**path, "points": [list(to_source(*point)) for point in path["points"]]}
                  for path in selected_paths],
        "labels": [{**label, "x": to_source(label["x"], label["y"])[0],
                    "y": to_source(label["x"], label["y"])[1],
                    "height": max(0.001, float(label["height"]) / scale),
                    "rotation": -float(label.get("rotation", 0))}
                   for label in selected_labels],
        "layers": sorted({path["layer"] for path in selected_paths}
                         | {label["layer"] for label in selected_labels}),
        "bounds": None,
        "truncated": bool(master_preview.get("truncated")),
    }
    points = [point for path in raw_preview["paths"] for point in path["points"]]
    if raw_preview["labels"]:
        points.extend([[label["x"], label["y"]] for label in raw_preview["labels"]])
    xs, ys = zip(*points)
    raw_preview["bounds"] = {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}
    selected_preview = normalize_cad_preview(raw_preview, floor)
    selected_source = selected_preview["sourceBounds"]
    selected_transform = selected_preview["transform"]

    def inside_source(x: float, y: float) -> bool:
        return (selected_source["minX"] <= x <= selected_source["maxX"]
                and selected_source["minY"] <= y <= selected_source["maxY"])

    def selected_point(x: float, y: float) -> tuple[float, float]:
        return (
            selected_transform["padding"] + (x - selected_source["minX"]) * selected_transform["scale"],
            floor_height - selected_transform["padding"]
            - (y - selected_source["minY"]) * selected_transform["scale"],
        )

    walls = []
    kept_wall_ids: set[str] = set()
    for wall in master_geometry.get("walls", []):
        source_a = to_source(wall["x1"], wall["y1"])
        source_b = to_source(wall["x2"], wall["y2"])
        midpoint = ((source_a[0] + source_b[0]) / 2, (source_a[1] + source_b[1]) / 2)
        if not inside_source(*midpoint):
            continue
        a = selected_point(*source_a); b = selected_point(*source_b)
        walls.append({**wall, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
        kept_wall_ids.add(str(wall["id"]))

    doors = []
    for door in master_geometry.get("doors", []):
        source = to_source(door["x"], door["y"])
        if str(door.get("wallId", "")) not in kept_wall_ids or not inside_source(*source):
            continue
        point = selected_point(*source)
        width = float(door.get("width", 48)) / scale * float(selected_transform["scale"])
        doors.append({**door, "x": point[0], "y": point[1], "width": width})

    selected_geometry = validate_geometry({
        "version": 2,
        "canvas": {"width": floor["width"], "height": floor["height"]},
        "walls": walls,
        "doors": doors,
        "windows": [],
    })

    if master_equipment is None:
        master_equipment = []
        for item in record.get("project", {}).get("equipment", []):
            if "originalX" in item and "originalY" in item:
                master_equipment.append({**item, "x": item["originalX"], "y": item["originalY"]})
    selected_equipment = []
    for item in master_equipment:
        x, y = float(item["x"]), float(item["y"])
        if not inside_source(x, y):
            continue
        point = selected_point(x, y)
        selected_equipment.append({**item, "originalX": x, "originalY": y,
                                   "x": point[0], "y": point[1]})

    return {"preview": selected_preview, "geometry": selected_geometry,
            "equipment": selected_equipment}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/project")
def project() -> dict[str, Any]:
    return load_project()


@app.get("/api/geometry")
def geometry() -> dict[str, Any]:
    return load_geometry()


@app.put("/api/geometry")
def save_geometry(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        normalized = validate_geometry(payload)
    except (TypeError, ValueError, KeyError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = GEOMETRY_FILE.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(GEOMETRY_FILE)
    return {
        "status": "saved",
        "walls": len(normalized["walls"]),
        "doors": len(normalized["doors"]),
        "windows": len(normalized["windows"]),
        "geometry": normalized,
    }


@app.post("/api/parse-dxf")
@app.post("/api/parse-cad")
async def parse_cad(file: UploadFile = File(...), project_id: str | None = None) -> dict[str, Any]:
    if project_id is not None:
        read_record(project_id)
    filename = file.filename or ""
    suffix = Path(filename).suffix.lower()
    if suffix not in {".dxf", ".dwg"}:
        raise HTTPException(status_code=400, detail="Нужен файл с расширением .dxf или .dwg")

    payload = await file.read(MAX_DXF_SIZE + 1)
    if len(payload) > MAX_DXF_SIZE:
        raise HTTPException(status_code=413, detail="Файл больше 250 МБ")

    try:
        document = read_dwg(payload) if suffix == ".dwg" else read_text_dxf(payload)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error

    equipment = extract_equipment(document)
    raw_geometry = extract_cad_geometry(document)
    cad_preview = None
    layout_names = [name for name in document.layout_names() if name != "Model"]
    if project_id is not None:
        with PROJECTS_LOCK:
            record = read_record(project_id)
            ensure_contract_fields(record)
            source_entry = source_entry_for_payload(record, project_id, filename, suffix, payload)
            raw_preview = extract_cad_preview(document)
            cad_preview = normalize_cad_preview(raw_preview, record["project"]["floorPlan"])
            cad_areas = detect_cad_areas(cad_preview)
            extracted_geometry = validate_geometry(
                normalize_cad_geometry(raw_geometry, cad_preview, record["project"]["floorPlan"])
            )
            bounds = calculate_bounds(equipment)
            placed = []
            if bounds:
                floor = record["project"]["floorPlan"]
                factor = min((floor["width"]-200)/max(bounds["maxX"]-bounds["minX"], 1),
                             (floor["height"]-200)/max(bounds["maxY"]-bounds["minY"], 1))
                placed = [{**e, "originalX": e["x"], "originalY": e["y"],
                           "x": 100+(e["x"]-bounds["minX"])*factor,
                           "y": floor["height"]-100-(e["y"]-bounds["minY"])*factor} for e in equipment]
            record["cadEquipmentMaster"] = equipment
            record["cadSource"] = filename
            record["cadAreas"] = cad_areas
            # Never show paper-space names as duplicate thumbnails of the
            # global Model preview. Real detected Model areas are selectable.
            record["cadLayouts"] = ([area["name"] for area in cad_areas]
                                    if cad_areas else layout_names)
            selected_layout = record.get("cadSelectedLayout")
            if selected_layout not in record["cadLayouts"]:
                record.pop("cadSelectedLayout", None)
                record.pop("cadAppliedLayout", None)
                if record["cadLayouts"]:
                    record["project"]["floorPlan"]["name"] = "План CAD — выберите лист"
            record["cadPreviewMaster"] = cad_preview
            record["cadGeometryMaster"] = extracted_geometry
            selected_area = next((area for area in cad_areas
                                  if area["name"] == record.get("cadSelectedLayout")), None)
            if selected_area is not None:
                selected = select_cad_area(record, selected_area)
                record["cadPreview"] = selected["preview"]
                run = create_recognition_run(record, project_id, source_entry,
                                             selected_area["name"], selected["preview"],
                                             selected["geometry"], selected["equipment"])
                record["project"]["floorPlan"]["name"] = selected_area["name"]
            else:
                record["cadPreview"] = cad_preview
                run = create_recognition_run(record, project_id, source_entry, "Model",
                                             cad_preview, extracted_geometry, placed)
            write_record(record)
    return {
        "source": filename,
        "format": suffix.removeprefix("."),
        "equipment": equipment,
        "bounds": calculate_bounds(equipment),
        "preview": {"paths": len(cad_preview["paths"]), "labels": len(cad_preview["labels"]),
                    "layers": cad_preview["layers"], "truncated": cad_preview["truncated"]} if cad_preview else None,
        "layouts": layout_names,
        "recognitionRun": run if project_id is not None else None,
        "summary": {
            "controllers": sum(item["type"] == "controller" for item in equipment),
            "doors": sum(item["type"] == "door" for item in equipment),
            "walls": len(raw_geometry["walls"]),
            "recognizedDoors": len(raw_geometry["doors"]),
            "unmatchedDoors": raw_geometry.get("metadata", {}).get("unmatchedDoors", 0),
        },
    }


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def project_path(project_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]{1,64}", project_id):
        raise HTTPException(404, "Проект не найден")
    return PROJECTS_DIR / project_id / "project.json"


def write_record(record: dict) -> None:
    target = project_path(record["id"])
    target.parent.mkdir(parents=True, exist_ok=True)
    record["updatedAt"] = datetime.now(timezone.utc).isoformat()
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
        temporary = Path(stream.name)
    temporary.replace(target)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def content_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def ensure_contract_fields(record: dict[str, Any]) -> dict[str, Any]:
    """Add the 0.1 lifecycle containers without migrating legacy content yet."""
    record.setdefault("schema_version", "0.1")
    record.setdefault("model_version", 0)
    record.setdefault("sheet_sources", [])
    record.setdefault("recognition_runs", [])
    record.setdefault("recognition_artifacts", [])
    record.setdefault("observation_index", [])
    record.setdefault("proposals", [])
    record.setdefault("proposal_decisions", [])
    return record


def recognition_artifact_path(project_id: str, run_id: str, filename: str) -> Path:
    if not re.fullmatch(r"run-[a-f0-9]{32}", run_id):
        raise ValueError("Некорректный идентификатор запуска")
    if filename not in {"candidates.json", "observations.json"}:
        raise ValueError("Некорректное имя артефакта")
    return project_path(project_id).parent / "recognition" / run_id / filename


def write_recognition_artifact(project_id: str, run_id: str, filename: str,
                               value: Any) -> tuple[str, int]:
    target = recognition_artifact_path(project_id, run_id, filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    with tempfile.NamedTemporaryFile(mode="wb", dir=target.parent, delete=False) as stream:
        stream.write(encoded)
        temporary = Path(stream.name)
    temporary.replace(target)
    return content_hash(value), len(encoded)


def source_entry_for_payload(record: dict[str, Any], project_id: str, filename: str,
                             suffix: str, payload: bytes) -> dict[str, Any]:
    checksum = hashlib.sha256(payload).hexdigest()
    existing = next((item for item in record.get("files", [])
                     if item.get("checksum") == checksum), None)
    if existing is not None:
        existing.setdefault("source_file_id", existing["id"])
        existing.setdefault("kind", suffix.removeprefix("."))
        existing.setdefault("checksum", checksum)
        return existing
    file_id = uuid.uuid4().hex + suffix
    target = project_path(project_id).parent / file_id
    target.write_bytes(payload)
    entry = {
        "id": file_id,
        "source_file_id": file_id,
        "name": filename,
        "kind": suffix.removeprefix("."),
        "size": len(payload),
        "checksum": checksum,
        "created_at": utc_now(),
        "url": f"/api/projects/{project_id}/files/{file_id}",
    }
    record.setdefault("files", []).append(entry)
    return entry


def proposal_label(entity_type: str, candidate: dict[str, Any]) -> str:
    names = {"wall": "Стена", "partition": "Перегородка", "door": "Дверной проём",
             "window": "Окно", "equipment": "Оборудование"}
    return f"{names.get(entity_type, entity_type)} · {candidate.get('id', 'без id')}"


def create_recognition_run(record: dict[str, Any], project_id: str,
                           source_entry: dict[str, Any], sheet_name: str,
                           preview: dict[str, Any], geometry: dict[str, Any],
                           equipment: list[dict[str, Any]]) -> dict[str, Any]:
    """Persist recognition output as proposals; never mutate the working model."""
    ensure_contract_fields(record)
    now = utc_now()
    locator = {"kind": "cad-layout", "name": sheet_name}
    sheet = next((item for item in record["sheet_sources"]
                  if item.get("source_file_id") == source_entry["source_file_id"]
                  and item.get("locator") == locator), None)
    if sheet is None:
        sheet = {
            "sheet_source_id": f"sheet-{uuid.uuid4().hex}",
            "source_file_id": source_entry["source_file_id"],
            "name": sheet_name,
            "locator": locator,
            "coordinate_transform": preview.get("transform"),
            "source_bounds": preview.get("sourceBounds"),
            "created_at": now,
        }
        record["sheet_sources"].append(sheet)

    run_id = f"run-{uuid.uuid4().hex}"
    candidates: list[tuple[str, dict[str, Any]]] = []
    for wall in geometry.get("walls", []):
        candidates.append(("partition" if wall.get("type") == "partition" else "wall", wall))
    candidates.extend(("door", item) for item in geometry.get("doors", []))
    candidates.extend(("window", item) for item in geometry.get("windows", []))
    candidates.extend(("equipment", item) for item in equipment)

    observations = [{
        "observation_id": f"obs-{uuid.uuid4().hex}",
        "run_id": run_id,
        "kind": entity_type,
        "geometry_fingerprint": content_hash(candidate),
        "source": "cad-vector",
    } for entity_type, candidate in candidates]
    proposals = []
    for (entity_type, candidate), observation in zip(candidates, observations):
        proposals.append({
            "proposal_id": f"proposal-{uuid.uuid4().hex}",
            "run_id": run_id,
            "source_file_id": source_entry["source_file_id"],
            "sheet_source_id": sheet["sheet_source_id"],
            "operation": "create",
            "entity_type": entity_type,
            "target_id": None,
            "target_content_hash": None,
            "geometry_fingerprint": observation["geometry_fingerprint"],
            "candidate": candidate,
            "label": proposal_label(entity_type, candidate),
            "evidence_ids": [observation["observation_id"]],
            "status": "pending",
            "created_at": now,
        })

    candidate_payload = {"geometry": geometry, "equipment": equipment,
                         "preview": preview, "sheet_name": sheet_name}
    candidate_hash, candidate_size = write_recognition_artifact(
        project_id, run_id, "candidates.json", candidate_payload)
    observations_hash, observations_size = write_recognition_artifact(
        project_id, run_id, "observations.json", observations)
    artifact_id = f"artifact-{uuid.uuid4().hex}"
    record["recognition_artifacts"].extend([
        {"artifact_id": artifact_id, "run_id": run_id, "kind": "candidates",
         "path": f"recognition/{run_id}/candidates.json", "content_hash": candidate_hash,
         "size": candidate_size},
        {"artifact_id": f"artifact-{uuid.uuid4().hex}", "run_id": run_id,
         "kind": "observations", "path": f"recognition/{run_id}/observations.json",
         "content_hash": observations_hash, "size": observations_size},
    ])
    record["observation_index"].append({"run_id": run_id, "count": len(observations),
                                        "content_hash": observations_hash})
    run = {
        "run_id": run_id,
        "source_file_id": source_entry["source_file_id"],
        "sheet_source_id": sheet["sheet_source_id"],
        "algorithm_version": "cad-vector-0.1",
        "execution_status": "completed",
        "acceptance_status": "accepted" if not proposals else "pending",
        "proposal_count": len(proposals),
        "created_at": now,
        "completed_at": now,
    }
    record["recognition_runs"].append(run)
    record["proposals"].extend(proposals)
    return run


def pending_staging(record: dict[str, Any], run_id: str) -> dict[str, Any]:
    proposals = [item for item in record.get("proposals", [])
                 if item.get("run_id") == run_id and item.get("status") in {"pending", "deferred", "conflict"}]
    geometry = {"version": 2,
                "canvas": dict(record.get("geometry", {}).get("canvas", {})),
                "walls": [], "doors": [], "windows": []}
    equipment: list[dict[str, Any]] = []
    for proposal in proposals:
        candidate = proposal.get("candidate", {})
        entity_type = proposal.get("entity_type")
        if entity_type in {"wall", "partition"}:
            geometry["walls"].append(candidate)
        elif entity_type == "door":
            geometry["doors"].append(candidate)
        elif entity_type == "window":
            geometry["windows"].append(candidate)
        elif entity_type == "equipment":
            equipment.append(candidate)
    run = next((item for item in record.get("recognition_runs", [])
                if item.get("run_id") == run_id), None)
    if run is None:
        raise HTTPException(404, "Запуск распознавания не найден")
    return {"run": run, "geometry": geometry, "equipment": equipment,
            "proposals": proposals, "model_version": record.get("model_version", 0)}


def read_record(project_id: str) -> dict:
    target = project_path(project_id)
    if not target.is_file():
        raise HTTPException(404, "Проект не найден")
    return json.loads(target.read_text(encoding="utf-8"))


def ensure_initial_project() -> None:
    with PROJECTS_LOCK:
        if not project_path("initial").exists():
            project_data = load_project()
            record = {"id": "initial", "name": project_data["project"]["object"],
                      "project": project_data, "geometry": load_geometry(), "files": []}
            write_record(ensure_contract_fields(record))


@app.get("/api/projects")
def list_projects() -> list[dict]:
    ensure_initial_project()
    with PROJECTS_LOCK:
        records = [json.loads(p.read_text(encoding="utf-8")) for p in PROJECTS_DIR.glob("*/project.json")]
    return sorted([{"id": r["id"], "name": r["name"], "updatedAt": r["updatedAt"],
                    "archived": bool(r.get("archivedAt")), "archivedAt": r.get("archivedAt")}
                   for r in records],
                  key=lambda r: r["updatedAt"], reverse=True)


@app.post("/api/projects", status_code=201)
def create_project(payload: dict[str, Any]) -> dict:
    name = payload.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
        raise HTTPException(422, "Укажите название проекта (1–120 символов)")
    ensure_initial_project()
    record = {"id": uuid.uuid4().hex, "name": name.strip(), "files": [],
              "project": {"project": {"object": name.strip(), "address": "", "revision": "Новый проект"},
                          "floorPlan": {"width": 2650, "height": 1850, "rooms": []}, "equipment": []},
              "geometry": {"version": 2, "canvas": {"width": 2650, "height": 1850},
                           "walls": [], "doors": [], "windows": []}}
    ensure_contract_fields(record)
    with PROJECTS_LOCK:
        write_record(record)
    return record


@app.get("/api/projects/{project_id}")
def get_project_record(project_id: str) -> dict:
    return read_record(project_id)


@app.put("/api/projects/{project_id}/archive")
def set_project_archived(project_id: str, payload: dict[str, Any]) -> dict:
    if project_id == "initial":
        raise HTTPException(422, "Системный проект нельзя архивировать")
    archived = payload.get("archived")
    if not isinstance(archived, bool):
        raise HTTPException(422, "Поле archived должно быть true или false")
    with PROJECTS_LOCK:
        record = read_record(project_id)
        if archived:
            record["archivedAt"] = datetime.now(timezone.utc).isoformat()
        else:
            record.pop("archivedAt", None)
        write_record(record)
    return {"id": project_id, "name": record["name"], "archived": archived,
            "archivedAt": record.get("archivedAt")}


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str, payload: dict[str, Any]) -> dict:
    if project_id == "initial":
        raise HTTPException(422, "Системный проект нельзя удалить")
    with PROJECTS_LOCK:
        record = read_record(project_id)
        if not record.get("archivedAt"):
            raise HTTPException(409, "Сначала перенесите проект в архив")
        if payload.get("confirmName") != record["name"]:
            raise HTTPException(422, "Для удаления введите точное название проекта")
        folder = project_path(project_id).parent
        shutil.rmtree(folder)
    return {"status": "deleted", "id": project_id}


@app.put("/api/projects/{project_id}/cad-layout")
def select_cad_layout(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    layout = str(payload.get("layout", "")).strip()
    with PROJECTS_LOCK:
        record = read_record(project_id)
        ensure_contract_fields(record)
        layouts = record.get("cadLayouts", [])
        if layout not in layouts:
            raise HTTPException(422, "Выберите лист из списка CAD")
        area = next((item for item in record.get("cadAreas", []) if item.get("name") == layout), None)
        if area is not None:
            try:
                selected = select_cad_area(record, area)
            except (KeyError, TypeError, ValueError, IndexError) as error:
                raise HTTPException(422, str(error)) from error
            record.setdefault("cadPreviewMaster", record.get("cadPreview"))
            record["cadPreview"] = selected["preview"]
            record["cadLayouts"] = [item["name"] for item in record.get("cadAreas", [])]
            layouts = record["cadLayouts"]
            source_entry = next((item for item in reversed(record.get("files", []))
                                 if item.get("name") == record.get("cadSource")), None)
            if source_entry is None:
                raise HTTPException(409, "Исходный CAD-файл не найден в проекте")
            source_entry.setdefault("source_file_id", source_entry["id"])
            run = create_recognition_run(record, project_id, source_entry, layout,
                                         selected["preview"], selected["geometry"],
                                         selected["equipment"])
        else:
            raise HTTPException(422, "Для этого листа пока нет отдельной геометрии")
        record["cadSelectedLayout"] = layout
        record["project"]["floorPlan"]["name"] = layout
        write_record(record)
    return {"layout": layout, "appliedLayout": record.get("cadAppliedLayout"), "cadLayouts": layouts,
            "cadPreview": record.get("cadPreview"),
            "cadPreviewMaster": record.get("cadPreviewMaster"),
            "cadAreas": record.get("cadAreas", []),
            "staging": pending_staging(record, run["run_id"]),
            "summary": {"walls": len(selected["geometry"].get("walls", [])),
                        "doors": len(selected["geometry"].get("doors", [])),
                        "windows": len(selected["geometry"].get("windows", [])),
                        "equipment": len(selected["equipment"])}}


@app.put("/api/projects/{project_id}/geometry")
def save_project_geometry(project_id: str, payload: dict[str, Any]) -> dict:
    try:
        normalized = validate_geometry(payload)
    except (TypeError, ValueError, KeyError, OverflowError) as error:
        raise HTTPException(422, str(error)) from error
    with PROJECTS_LOCK:
        record = read_record(project_id)
        ensure_contract_fields(record)
        record["geometry"] = normalized
        record["model_version"] += 1
        write_record(record)
    return {"geometry": normalized, "walls": len(normalized["walls"]),
            "doors": len(normalized["doors"]), "windows": len(normalized["windows"]),
            "model_version": record["model_version"]}


@app.put("/api/projects/{project_id}/equipment")
def save_project_equipment(project_id: str, payload: dict[str, Any]) -> dict:
    with PROJECTS_LOCK:
        record = read_record(project_id)
        ensure_contract_fields(record)
        try:
            normalized = validate_equipment(payload.get("equipment"), record["geometry"])
        except (TypeError, ValueError, KeyError, OverflowError) as error:
            raise HTTPException(422, str(error)) from error
        record["project"]["equipment"] = normalized
        record["model_version"] += 1
        write_record(record)
    return {"status": "saved", "count": len(normalized), "equipment": normalized,
            "model_version": record["model_version"]}


def apply_dot_path_changes(candidate: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(changes, dict):
        raise ValueError("changes должен быть объектом с dot-path ключами")
    result = json.loads(json.dumps(candidate))
    for path, value in changes.items():
        if not isinstance(path, str) or not path or any(
                part in {"__proto__", "prototype", "constructor"} for part in path.split(".")):
            raise ValueError("Некорректный путь изменения")
        parts = path.split(".")
        cursor: dict[str, Any] = result
        for part in parts[:-1]:
            nested = cursor.get(part)
            if not isinstance(nested, dict):
                raise ValueError(f"Путь {path} не указывает на существующий объект")
            cursor = nested
        # Assignment is deliberately replacing: object values are not recursively merged.
        cursor[parts[-1]] = json.loads(json.dumps(value))
    return result


def find_working_entity(record: dict[str, Any], entity_type: str,
                        entity_id: str) -> tuple[list[dict[str, Any]], int] | None:
    if entity_type in {"wall", "partition"}:
        collection = record["geometry"]["walls"]
    elif entity_type == "door":
        collection = record["geometry"]["doors"]
    elif entity_type == "window":
        collection = record["geometry"]["windows"]
    elif entity_type == "equipment":
        collection = record["project"]["equipment"]
    else:
        raise ValueError(f"Неизвестный тип объекта: {entity_type}")
    for index, item in enumerate(collection):
        if item.get("id") == entity_id:
            return collection, index
    return None


def normalize_candidate_for_model(record: dict[str, Any], entity_type: str,
                                  candidate: dict[str, Any]) -> dict[str, Any]:
    geometry = json.loads(json.dumps(record["geometry"]))
    if entity_type in {"wall", "partition"}:
        geometry["walls"].append(candidate)
        return validate_geometry(geometry)["walls"][-1]
    if entity_type == "door":
        geometry["doors"].append(candidate)
        return validate_geometry(geometry)["doors"][-1]
    if entity_type == "window":
        geometry["windows"].append(candidate)
        return validate_geometry(geometry)["windows"][-1]
    if entity_type == "equipment":
        equipment = [*record["project"]["equipment"], candidate]
        return validate_equipment(equipment, record["geometry"])[-1]
    raise ValueError(f"Неизвестный тип объекта: {entity_type}")


def update_run_acceptance_status(record: dict[str, Any], run_id: str) -> None:
    relevant = [item for item in record.get("proposals", []) if item.get("run_id") == run_id]
    run = next((item for item in record.get("recognition_runs", [])
                if item.get("run_id") == run_id), None)
    if run is None:
        return
    if not relevant:
        run["acceptance_status"] = "accepted"
    elif any(item.get("status") in {"pending", "deferred", "conflict"} for item in relevant):
        run["acceptance_status"] = "partial" if any(
            item.get("status") == "accepted" for item in relevant) else "pending"
    elif any(item.get("status") == "accepted" for item in relevant):
        run["acceptance_status"] = "accepted"
    else:
        run["acceptance_status"] = "rejected"


def supersede_older_proposals(record: dict[str, Any], accepted: dict[str, Any]) -> None:
    for proposal in record.get("proposals", []):
        if proposal is accepted or proposal.get("status") not in {"pending", "deferred", "conflict"}:
            continue
        same_source = proposal.get("source_file_id") == accepted.get("source_file_id")
        same_target = (accepted.get("target_id") is not None
                       and proposal.get("target_id") == accepted.get("target_id"))
        same_create_geometry = (accepted.get("operation") == proposal.get("operation") == "create"
                                and proposal.get("geometry_fingerprint")
                                == accepted.get("geometry_fingerprint"))
        if same_source and (same_target or same_create_geometry):
            proposal["status"] = "superseded"
            proposal["superseded_by"] = accepted["proposal_id"]
            update_run_acceptance_status(record, proposal["run_id"])


def project_point_to_wall(x: float, y: float, wall: dict[str, Any]) -> tuple[float, float, float, float]:
    dx = float(wall["x2"]) - float(wall["x1"])
    dy = float(wall["y2"]) - float(wall["y1"])
    length_squared = dx * dx + dy * dy
    if length_squared <= 1e-9:
        return float(wall["x1"]), float(wall["y1"]), math.inf, 0.0
    t = max(0.0, min(1.0, ((x - float(wall["x1"])) * dx
                            + (y - float(wall["y1"])) * dy) / length_squared))
    px = float(wall["x1"]) + t * dx
    py = float(wall["y1"]) + t * dy
    return px, py, math.hypot(x - px, y - py), math.atan2(dy, dx)


def nearest_working_wall(record: dict[str, Any], x: float, y: float) -> tuple[dict[str, Any], float, float, float, float] | None:
    best = None
    for wall in record.get("geometry", {}).get("walls", []):
        px, py, distance, rotation = project_point_to_wall(x, y, wall)
        if best is None or distance < best[4]:
            best = (wall, px, py, rotation, distance)
    return best


def cad_preview_segments(preview: dict[str, Any]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for path_index, path in enumerate(preview.get("paths", [])):
        points = path.get("points", [])
        pairs = list(zip(points, points[1:]))
        if path.get("closed") and len(points) > 2:
            pairs.append((points[-1], points[0]))
        for segment_index, (start, end) in enumerate(pairs):
            x1, y1 = float(start[0]), float(start[1])
            x2, y2 = float(end[0]), float(end[1])
            length = math.hypot(x2 - x1, y2 - y1)
            if length < 3:
                continue
            segments.append({
                "path_index": path_index,
                "segment_index": segment_index,
                "layer": str(path.get("layer", "")),
                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                "mx": (x1 + x2) / 2, "my": (y1 + y2) / 2,
                "length": length,
                "angle": math.atan2(y2 - y1, x2 - x1),
            })
    return segments


def angle_difference(first: float, second: float) -> float:
    difference = abs((first - second) % math.pi)
    return min(difference, math.pi - difference)


def likely_door_leaf(record: dict[str, Any], segment: dict[str, Any]) -> tuple[dict[str, Any], float, float, float, float] | None:
    nearest = nearest_working_wall(record, segment["mx"], segment["my"])
    if nearest is None:
        return None
    wall, px, py, rotation, distance = nearest
    relative_angle = angle_difference(segment["angle"], rotation)
    # Several real project templates draw the leaf as a shallow diagonal across
    # the opening (7-16 degrees from the host wall), rather than as a 45/90°
    # swing line.  Keep truly parallel wall fragments and perpendicular jambs
    # out, but allow those shallow project-specific symbols to become samples.
    if not math.radians(4) <= relative_angle <= math.radians(86):
        return None
    if distance > max(24.0, segment["length"] * 0.72):
        return None
    return wall, px, py, rotation, distance


def door_leaf_signature(record: dict[str, Any], segment: dict[str, Any]) -> dict[str, float] | None:
    """Describe a possible leaf relative to its host wall.

    Length alone is not enough on architectural drawings: dimensions,
    equipment and hatching often contain equally sized lines on the same CAD
    layer.  The relative angle and both endpoint distances preserve the local
    shape demonstrated by the engineer's selected sample.
    """
    nearest = likely_door_leaf(record, segment)
    if nearest is None:
        return None
    wall, _px, _py, rotation, distance = nearest
    length = max(float(segment["length"]), 1e-9)
    endpoint_distances = sorted((
        project_point_to_wall(segment["x1"], segment["y1"], wall)[2] / length,
        project_point_to_wall(segment["x2"], segment["y2"], wall)[2] / length,
    ))
    return {
        "relative_angle": angle_difference(segment["angle"], rotation),
        "midpoint_distance_ratio": distance / length,
        "near_endpoint_ratio": endpoint_distances[0],
        "far_endpoint_ratio": endpoint_distances[1],
    }


def door_leaf_signatures_match(sample: dict[str, float], candidate: dict[str, float]) -> bool:
    # A little latitude is necessary because repeated symbols in DWG files are
    # frequently stretched or snapped imperfectly.  These limits are still
    # much stricter than matching every similarly sized line on the layer.
    if abs(sample["relative_angle"] - candidate["relative_angle"]) > math.radians(10):
        return False
    if abs(sample["midpoint_distance_ratio"]
           - candidate["midpoint_distance_ratio"]) > .22:
        return False
    if abs(sample["near_endpoint_ratio"] - candidate["near_endpoint_ratio"]) > .18:
        return False
    if abs(sample["far_endpoint_ratio"] - candidate["far_endpoint_ratio"]) > .28:
        return False
    return True


def segment_endpoint_distance(first: dict[str, Any], second: dict[str, Any]) -> float:
    first_points = ((first["x1"], first["y1"]), (first["x2"], first["y2"]))
    second_points = ((second["x1"], second["y1"]), (second["x2"], second["y2"]))
    return min(math.hypot(ax - bx, ay - by)
               for ax, ay in first_points for bx, by in second_points)


def door_candidate_from_segments(record: dict[str, Any], segments: list[dict[str, Any]],
                                 leaf_count: int) -> dict[str, Any] | None:
    center_x = sum(item["mx"] for item in segments) / len(segments)
    center_y = sum(item["my"] for item in segments) / len(segments)
    nearest = nearest_working_wall(record, center_x, center_y)
    if nearest is None:
        return None
    wall, px, py, rotation, distance = nearest
    if distance > max(35.0, max(item["length"] for item in segments) * 0.75):
        return None
    ux, uy = math.cos(rotation), math.sin(rotation)
    projections = [point[0] * ux + point[1] * uy for segment in segments
                   for point in ((segment["x1"], segment["y1"]),
                                 (segment["x2"], segment["y2"]))]
    width = max(projections) - min(projections)
    fallback = sum(item["length"] for item in segments) * (0.92 if leaf_count == 2 else 1.0)
    width = max(24.0, min(300.0, width if width >= 20 else fallback))
    existing = min(record.get("geometry", {}).get("doors", []),
                   key=lambda door: math.hypot(float(door["x"]) - px, float(door["y"]) - py),
                   default=None)
    target_id = None
    target_hash = None
    if existing is not None and math.hypot(float(existing["x"]) - px,
                                           float(existing["y"]) - py) <= max(24, width * .45):
        target_id = existing["id"]
        target_hash = content_hash(existing)
    return {
        "candidate_id": f"door-candidate-{uuid.uuid4().hex}",
        "wallId": wall["id"],
        "x": round(px, 3), "y": round(py, 3),
        "width": round(width, 3), "rotation": round(rotation, 6),
        "swing": "unknown", "openingSide": -1,
        "leafCount": leaf_count, "readerCount": 1,
        "accessPointId": None, "accessPointCode": None,
        "target_door_id": target_id,
        "target_content_hash": target_hash,
        "evidence": [{"path_index": item["path_index"],
                      "segment_index": item["segment_index"],
                      "layer": item["layer"]} for item in segments],
        "confidence": "project_template",
        "reviewHint": "confirm_hinge_and_opening_side",
    }


def detect_doors_from_sample(record: dict[str, Any], bounds: dict[str, float],
                             leaf_count: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    preview = record.get("cadPreview")
    if not isinstance(preview, dict) or not preview.get("paths"):
        raise ValueError("Для выбранного листа нет векторной CAD-подложки")
    segments = cad_preview_segments(preview)
    selected = [segment for segment in segments
                if bounds["minX"] <= segment["mx"] <= bounds["maxX"]
                and bounds["minY"] <= segment["my"] <= bounds["maxY"]
                and likely_door_leaf(record, segment) is not None]
    if len(selected) < leaf_count:
        raise ValueError("В выделении не найдены диагональные линии дверного полотна")
    if leaf_count == 1:
        sample_segments = [max(selected, key=lambda item: item["length"])]
    else:
        pairs = [(first, second) for index, first in enumerate(selected)
                 for second in selected[index + 1:]
                 if segment_endpoint_distance(first, second)
                 <= max(first["length"], second["length"]) * .45]
        if not pairs:
            raise ValueError("Для двустворчатой двери выделите обе диагональные створки")
        sample_segments = list(min(pairs, key=lambda pair: segment_endpoint_distance(*pair)))

    sample_lengths = sorted(item["length"] for item in sample_segments)
    sample_layers = sorted({item["layer"] for item in sample_segments})
    sample_signatures = [door_leaf_signature(record, item) for item in sample_segments]
    matching = []
    for segment in segments:
        if segment["layer"] not in sample_layers:
            continue
        signature = door_leaf_signature(record, segment)
        if signature is None:
            continue
        if any(sample is not None and door_leaf_signatures_match(sample, signature)
               for sample in sample_signatures):
            matching.append(segment)
    candidates: list[dict[str, Any]] = []
    if leaf_count == 1:
        target_length = sample_lengths[0]
        for segment in matching:
            if .72 <= segment["length"] / target_length <= 1.32:
                candidate = door_candidate_from_segments(record, [segment], 1)
                if candidate is not None:
                    candidates.append(candidate)
    else:
        target_short, target_long = sample_lengths
        for index, first in enumerate(matching):
            for second in matching[index + 1:]:
                lengths = sorted((first["length"], second["length"]))
                if not (.68 <= lengths[0] / target_short <= 1.38
                        and .68 <= lengths[1] / target_long <= 1.38):
                    continue
                if segment_endpoint_distance(first, second) > max(lengths) * .48:
                    continue
                candidate = door_candidate_from_segments(record, [first, second], 2)
                if candidate is not None:
                    candidates.append(candidate)

    deduplicated: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda item: (item["y"], item["x"])):
        duplicate = next((item for item in deduplicated
                          if item["wallId"] == candidate["wallId"]
                          and math.hypot(item["x"] - candidate["x"],
                                         item["y"] - candidate["y"])
                          <= max(18, min(item["width"], candidate["width"]) * .32)), None)
        if duplicate is None:
            deduplicated.append(candidate)
        elif duplicate.get("target_door_id") is None and candidate.get("target_door_id"):
            deduplicated[deduplicated.index(duplicate)] = candidate
    pattern = {
        "pattern_id": f"door-pattern-{uuid.uuid4().hex}",
        "name": "Двустворчатая дверь" if leaf_count == 2 else "Одностворчатая дверь",
        "leaf_count": leaf_count,
        "sheet_name": record.get("cadSelectedLayout") or record.get("project", {}).get("floorPlan", {}).get("name"),
        "bounds": bounds,
        "layers": sample_layers,
        "leaf_lengths": [round(value, 3) for value in sample_lengths],
        "leaf_signatures": [{key: round(value, 6) for key, value in signature.items()}
                            for signature in sample_signatures if signature is not None],
        "created_at": utc_now(),
    }
    return pattern, deduplicated[:500]


@app.get("/api/projects/{project_id}/recognition-runs/latest")
def latest_recognition_run(project_id: str) -> dict[str, Any]:
    record = read_record(project_id)
    ensure_contract_fields(record)
    if not record["recognition_runs"]:
        return {"staging": None, "model_version": record["model_version"]}
    run = record["recognition_runs"][-1]
    return {"staging": pending_staging(record, run["run_id"]),
            "model_version": record["model_version"]}


@app.get("/api/projects/{project_id}/recognition-runs/{run_id}")
def get_recognition_run(project_id: str, run_id: str) -> dict[str, Any]:
    record = read_record(project_id)
    ensure_contract_fields(record)
    return pending_staging(record, run_id)


@app.post("/api/projects/{project_id}/proposals/{proposal_id}/decision")
def decide_proposal(project_id: str, proposal_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    decision = payload.get("decision")
    if decision not in {"accepted", "accepted_with_changes", "rejected", "deferred"}:
        raise HTTPException(422, "Неизвестное решение по предложению")
    with PROJECTS_LOCK:
        record = read_record(project_id)
        ensure_contract_fields(record)
        proposal = next((item for item in record["proposals"]
                         if item.get("proposal_id") == proposal_id), None)
        if proposal is None:
            raise HTTPException(404, "Предложение не найдено")
        if proposal.get("status") not in {"pending", "deferred", "conflict"}:
            raise HTTPException(409, "По этому предложению уже принято решение")

        if decision in {"accepted", "accepted_with_changes"}:
            expected_version = payload.get("expected_model_version")
            if expected_version != record["model_version"]:
                raise HTTPException(409, "Рабочая модель изменилась. Обновите staging перед принятием")
            try:
                candidate = apply_dot_path_changes(
                    proposal["candidate"], payload.get("changes", {}))
                operation = proposal.get("operation")
                entity_type = proposal["entity_type"]
                if operation == "create":
                    if find_working_entity(record, entity_type, str(candidate.get("id"))) is not None:
                        proposal["status"] = "conflict"
                        write_record(record)
                        raise HTTPException(409, "Объект с таким id уже существует; предложение помечено конфликтным")
                    normalized = normalize_candidate_for_model(record, entity_type, candidate)
                    if entity_type in {"wall", "partition"}:
                        record["geometry"]["walls"].append(normalized)
                    elif entity_type == "door":
                        record["geometry"]["doors"].append(normalized)
                    elif entity_type == "window":
                        record["geometry"]["windows"].append(normalized)
                    else:
                        record["project"]["equipment"].append(normalized)
                elif operation == "update":
                    found = find_working_entity(record, entity_type, str(proposal.get("target_id")))
                    if found is None:
                        raise HTTPException(409, "Целевой объект больше не существует")
                    collection, index = found
                    if content_hash(collection[index]) != proposal.get("target_content_hash"):
                        proposal["status"] = "conflict"
                        write_record(record)
                        raise HTTPException(409, "Ручные изменения имеют приоритет; предложение помечено конфликтным")
                    replacement = {**candidate, "id": collection[index]["id"]}
                    draft = json.loads(json.dumps(record))
                    draft_found = find_working_entity(draft, entity_type, collection[index]["id"])
                    assert draft_found is not None
                    draft_found[0][draft_found[1]] = replacement
                    if entity_type == "equipment":
                        normalized_all = validate_equipment(draft["project"]["equipment"], draft["geometry"])
                        collection[index] = normalized_all[index]
                    else:
                        normalized_geometry = validate_geometry(draft["geometry"])
                        collection[index] = find_working_entity(
                            {"geometry": normalized_geometry, "project": draft["project"]},
                            entity_type, collection[index]["id"])[0][index]
                else:
                    raise ValueError("В первой вертикали поддерживаются только create и update")
            except HTTPException:
                raise
            except (TypeError, ValueError, KeyError, OverflowError) as error:
                raise HTTPException(422, str(error)) from error
            record["model_version"] += 1
            proposal["candidate"] = candidate
            proposal["status"] = "accepted"
            supersede_older_proposals(record, proposal)
        else:
            proposal["status"] = decision

        decision_record = {
            "decision_id": f"decision-{uuid.uuid4().hex}",
            "proposal_id": proposal_id,
            "decision": decision,
            "changes": payload.get("changes", {}),
            "model_version": record["model_version"],
            "created_at": utc_now(),
        }
        record["proposal_decisions"].append(decision_record)
        update_run_acceptance_status(record, proposal["run_id"])
        write_record(record)
        staging = pending_staging(record, proposal["run_id"])
    return {"status": proposal["status"], "decision": decision_record,
            "model_version": record["model_version"], "geometry": record["geometry"],
            "equipment": record["project"]["equipment"], "staging": staging}


@app.post("/api/projects/{project_id}/door-patterns/detect", status_code=201)
def create_door_pattern(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    raw_bounds = payload.get("bounds")
    leaf_count = payload.get("leaf_count")
    if leaf_count not in {1, 2}:
        raise HTTPException(422, "Выберите одностворчатую или двустворчатую дверь")
    if not isinstance(raw_bounds, dict):
        raise HTTPException(422, "Выделите образец двери рамкой")
    try:
        bounds = {key: float(raw_bounds[key]) for key in ("minX", "minY", "maxX", "maxY")}
    except (TypeError, ValueError, KeyError) as error:
        raise HTTPException(422, "Некорректные границы образца") from error
    if not all(math.isfinite(value) for value in bounds.values()):
        raise HTTPException(422, "Некорректные границы образца")
    if bounds["maxX"] - bounds["minX"] < 8 or bounds["maxY"] - bounds["minY"] < 8:
        raise HTTPException(422, "Выделите весь дверной символ, а не одну точку")

    with PROJECTS_LOCK:
        record = read_record(project_id)
        ensure_contract_fields(record)
        try:
            pattern, candidates = detect_doors_from_sample(record, bounds, leaf_count)
        except (TypeError, ValueError, KeyError, OverflowError) as error:
            raise HTTPException(422, str(error)) from error
        run = {
            "run_id": f"door-run-{uuid.uuid4().hex}",
            "pattern_id": pattern["pattern_id"],
            "sheet_name": pattern["sheet_name"],
            "model_version": record["model_version"],
            "status": "pending" if candidates else "completed_no_matches",
            "candidate_count": len(candidates),
            "candidates": candidates,
            "created_at": utc_now(),
        }
        record.setdefault("door_patterns", []).append(pattern)
        record.setdefault("door_detection_runs", []).append(run)
        write_record(record)
    return {"pattern": pattern, "run": run, "model_version": record["model_version"]}


@app.get("/api/projects/{project_id}/door-detection-runs/latest")
def latest_door_detection_run(project_id: str) -> dict[str, Any]:
    record = read_record(project_id)
    ensure_contract_fields(record)
    runs = record.get("door_detection_runs", [])
    undo_run = None
    for item in reversed(runs):
        if item.get("status") not in {"accepted", "accepted_with_conflicts"}:
            continue
        if item.get("rollback") or infer_legacy_created_door_rollback(record, item):
            undo_run = item
            break
    return {"run": runs[-1] if runs else None, "undo_run": undo_run,
            "model_version": record["model_version"],
            "pattern_count": len(record.get("door_patterns", []))}


def infer_legacy_created_door_rollback(record: dict[str, Any],
                                       run: dict[str, Any]) -> dict[str, Any] | None:
    """Allow safe undo for an old run that only created, and never updated, doors."""
    candidates = run.get("candidates", [])
    if not candidates or any(item.get("target_door_id") for item in candidates):
        return None
    doors = record.get("geometry", {}).get("doors", [])
    unmatched = list(doors)
    created = []
    numeric_fields = ("x", "y", "width", "rotation")
    for candidate in candidates:
        match = next((door for door in unmatched
                      if door.get("wallId") == candidate.get("wallId")
                      and door.get("leafCount") == candidate.get("leafCount")
                      and all(abs(float(door.get(key, 0)) - float(candidate.get(key, 0))) < .01
                              for key in numeric_fields)), None)
        if match is None:
            return None
        unmatched.remove(match)
        created.append({"id": match["id"], "accepted_hash": content_hash(match)})
    return {"created": created, "updated": []}


@app.post("/api/projects/{project_id}/door-detection-runs/{run_id}/decision")
def decide_door_detection_run(project_id: str, run_id: str,
                              payload: dict[str, Any]) -> dict[str, Any]:
    decision = payload.get("decision")
    if decision not in {"accepted", "rejected"}:
        raise HTTPException(422, "Результат можно принять или отклонить")
    with PROJECTS_LOCK:
        record = read_record(project_id)
        ensure_contract_fields(record)
        run = next((item for item in record.get("door_detection_runs", [])
                    if item.get("run_id") == run_id), None)
        if run is None:
            raise HTTPException(404, "Запуск поиска дверей не найден")
        if run.get("status") != "pending":
            raise HTTPException(409, "По этому запуску уже принято решение")
        if decision == "rejected":
            run["status"] = "rejected"
            run["decided_at"] = utc_now()
            write_record(record)
            return {"status": "rejected", "geometry": record["geometry"],
                    "model_version": record["model_version"], "conflicts": []}
        if payload.get("expected_model_version") != record["model_version"]:
            raise HTTPException(409, "Рабочий план изменился. Запустите поиск по образцу ещё раз")

        all_candidates = run.get("candidates", [])
        selected_ids = payload.get("selected_candidate_ids")
        if selected_ids is None:
            selected_ids = [item.get("candidate_id") for item in all_candidates]
        if not isinstance(selected_ids, list) or not selected_ids:
            raise HTTPException(422, "Выберите хотя бы одну найденную дверь")
        if any(not isinstance(candidate_id, str) for candidate_id in selected_ids):
            raise HTTPException(422, "Некорректный список выбранных дверей")
        if len(selected_ids) != len(set(selected_ids)):
            raise HTTPException(422, "Список выбранных дверей содержит повторы")
        candidate_ids = {item.get("candidate_id") for item in all_candidates}
        if any(candidate_id not in candidate_ids for candidate_id in selected_ids):
            raise HTTPException(422, "Выбранная дверь не относится к этому запуску")
        selected_id_set = set(selected_ids)
        selected_candidates = [item for item in all_candidates
                               if item.get("candidate_id") in selected_id_set]

        doors = record["geometry"].setdefault("doors", [])
        existing_ids = {door["id"] for door in doors}
        accepted = 0
        conflicts: list[str] = []
        updated_targets: set[str] = set()
        created_ids: list[str] = []
        updated_before: dict[str, dict[str, Any]] = {}
        next_number = 1
        for candidate in selected_candidates:
            target_id = candidate.get("target_door_id")
            target = next((door for door in doors if door.get("id") == target_id), None)
            if target is not None:
                if target_id in updated_targets:
                    continue
                if content_hash(target) != candidate.get("target_content_hash"):
                    conflicts.append(target_id)
                    continue
                updated_before[target_id] = json.loads(json.dumps(target))
                target.update({
                    "wallId": candidate["wallId"], "x": candidate["x"], "y": candidate["y"],
                    "width": candidate["width"], "rotation": candidate["rotation"],
                    "leafCount": candidate["leafCount"],
                    "confidence": candidate["confidence"],
                    "reviewHint": candidate["reviewHint"],
                })
                updated_targets.add(target_id)
                accepted += 1
                continue
            while f"D-AUTO-{next_number:04d}" in existing_ids:
                next_number += 1
            door_id = f"D-AUTO-{next_number:04d}"
            existing_ids.add(door_id)
            next_number += 1
            doors.append({
                "id": door_id, "wallId": candidate["wallId"],
                "x": candidate["x"], "y": candidate["y"],
                "width": candidate["width"], "rotation": candidate["rotation"],
                "swing": "unknown", "openingSide": -1,
                "leafCount": candidate["leafCount"], "readerCount": 1,
                "accessPointId": None, "accessPointCode": None,
                "confidence": candidate["confidence"],
                "reviewHint": candidate["reviewHint"],
            })
            created_ids.append(door_id)
            accepted += 1
        try:
            record["geometry"] = validate_geometry(record["geometry"])
        except (TypeError, ValueError, KeyError, OverflowError) as error:
            raise HTTPException(422, str(error)) from error
        normalized_by_id = {door["id"]: door for door in record["geometry"]["doors"]}
        run["rollback"] = {
            "created": [{"id": door_id, "accepted_hash": content_hash(normalized_by_id[door_id])}
                        for door_id in created_ids],
            "updated": [{"id": door_id, "before": before,
                         "accepted_hash": content_hash(normalized_by_id[door_id])}
                        for door_id, before in updated_before.items()],
        }
        record["model_version"] += 1
        run["status"] = "accepted" if not conflicts else "accepted_with_conflicts"
        run["accepted_count"] = accepted
        run["excluded_count"] = len(all_candidates) - len(selected_candidates)
        run["accepted_candidate_ids"] = selected_ids
        run["excluded_candidate_ids"] = [item.get("candidate_id") for item in all_candidates
                                          if item.get("candidate_id") not in selected_id_set]
        run["accepted_model_version"] = record["model_version"]
        run["conflicts"] = conflicts
        run["decided_at"] = utc_now()
        write_record(record)
    return {"status": run["status"], "geometry": record["geometry"], "run": run,
            "model_version": record["model_version"], "accepted_count": accepted,
            "conflicts": conflicts}


@app.post("/api/projects/{project_id}/door-detection-runs/{run_id}/undo")
def undo_door_detection_run(project_id: str, run_id: str,
                            payload: dict[str, Any]) -> dict[str, Any]:
    with PROJECTS_LOCK:
        record = read_record(project_id)
        ensure_contract_fields(record)
        run = next((item for item in record.get("door_detection_runs", [])
                    if item.get("run_id") == run_id), None)
        if run is None:
            raise HTTPException(404, "Запуск поиска дверей не найден")
        if run.get("status") not in {"accepted", "accepted_with_conflicts"}:
            raise HTTPException(409, "Этот результат уже отменён или не был принят")
        rollback = run.get("rollback") or infer_legacy_created_door_rollback(record, run)
        if not isinstance(rollback, dict):
            raise HTTPException(409, "Для этого старого запуска отмена недоступна")

        doors = record["geometry"].setdefault("doors", [])
        by_id = {door["id"]: door for door in doors}
        equipment = record.get("project", {}).get("equipment", [])
        conflicts: list[str] = []
        for item in rollback.get("created", []):
            door = by_id.get(item.get("id"))
            if door is None:
                continue
            door_id = door["id"]
            linked = any(eq.get("hostDoorId") == door_id
                         or door_id in (eq.get("servedDoorIds") or []) for eq in equipment)
            if linked or content_hash(door) != item.get("accepted_hash"):
                conflicts.append(door_id)
        for item in rollback.get("updated", []):
            door = by_id.get(item.get("id"))
            if door is None or content_hash(door) != item.get("accepted_hash"):
                conflicts.append(str(item.get("id")))
        if conflicts:
            labels = ", ".join(sorted(set(conflicts))[:8])
            raise HTTPException(409, f"Сначала проверьте изменённые или связанные двери: {labels}")

        created_ids = {item.get("id") for item in rollback.get("created", [])}
        before_by_id = {item.get("id"): item.get("before")
                        for item in rollback.get("updated", [])}
        restored: list[dict[str, Any]] = []
        for door in doors:
            if door["id"] in created_ids:
                continue
            restored.append(before_by_id.get(door["id"], door))
        record["geometry"]["doors"] = restored
        try:
            record["geometry"] = validate_geometry(record["geometry"])
        except (TypeError, ValueError, KeyError, OverflowError) as error:
            raise HTTPException(422, str(error)) from error
        record["model_version"] += 1
        run["status"] = "reverted"
        run["reverted_at"] = utc_now()
        run["reverted_model_version"] = record["model_version"]
        write_record(record)
    return {"status": "reverted", "geometry": record["geometry"],
            "model_version": record["model_version"],
            "removed_count": len(created_ids), "restored_count": len(before_by_id)}


@app.post("/api/projects/{project_id}/files", status_code=201)
async def add_project_file(project_id: str, file: UploadFile = File(...)) -> dict:
    read_record(project_id)
    name = Path((file.filename or "file").replace("\\", "/")).name
    suffix = Path(name).suffix.lower()
    if suffix not in {".pdf", ".dwg", ".dxf", ".png", ".jpg", ".jpeg"}:
        raise HTTPException(400, "Поддерживаются PDF, DWG, DXF, PNG и JPG")
    payload = await file.read(MAX_DXF_SIZE + 1)
    if not payload or len(payload) > MAX_DXF_SIZE:
        raise HTTPException(413, "Нужен непустой файл до 250 МБ")
    with PROJECTS_LOCK:
        record = read_record(project_id)
        ensure_contract_fields(record)
        entry = source_entry_for_payload(record, project_id, name, suffix, payload)
        write_record(record)
    return entry


@app.get("/api/projects/{project_id}/files/{file_id}")
def get_project_file(project_id: str, file_id: str) -> FileResponse:
    record = read_record(project_id)
    entry = next((f for f in record["files"] if f["id"] == file_id), None)
    if entry is None:
        raise HTTPException(404, "Файл не найден")
    return FileResponse(project_path(project_id).parent / entry["id"], filename=entry["name"])


@app.get("/api/projects/{project_id}/reference-sheets")
def list_reference_sheets(project_id: str) -> list[dict[str, str]]:
    read_record(project_id)
    folder = project_path(project_id).parent
    return [
        {"id": sheet_id, "title": sheet["title"], "drawingSheet": sheet["drawingSheet"],
         "url": f"/api/projects/{project_id}/reference-sheets/{sheet_id}"}
        for sheet_id, sheet in REFERENCE_SHEETS.items()
        if (folder / sheet["filename"]).is_file()
    ]


@app.get("/api/projects/{project_id}/reference-sheets/{sheet_id}")
def get_reference_sheet(project_id: str, sheet_id: str) -> FileResponse:
    read_record(project_id)
    sheet = REFERENCE_SHEETS.get(sheet_id)
    if sheet is None:
        raise HTTPException(404, "Справочный лист не найден")
    target = project_path(project_id).parent / sheet["filename"]
    if not target.is_file():
        raise HTTPException(404, "Справочный лист не добавлен в этот проект")
    return FileResponse(target, media_type="image/png")
