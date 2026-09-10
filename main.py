from __future__ import annotations

import io
import html
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
import re
import secrets
import zlib
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
MAX_SOURCE_SIZE = 100 * 1024 * 1024
MAX_ANALYSIS_PAGES = 40
EQUIPMENT_TYPES = {
    "access_point", "controller", "reader", "exit_button", "emergency_release",
    "lock", "lock_strike", "door_contact", "door_closer", "power_supply", "battery", "junction_box",
    "intercom_panel", "intercom_monitor", "network_switch", "door",
    "camera_ceiling", "camera_ceiling_bracket",
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
PDF_KIND_RULES = (
    ("plan", ("план прокладки", "расстановки оборудования", "план этажа", "план помещений", "план")),
    ("installation", ("эскиз монтажа", "узел монтажа", "монтаж точки доступа")),
    ("wiring", ("схема внешних соединений", "схема соединений", "кабельный журнал")),
    ("structure", ("структурная схема", "функциональная схема")),
    ("specification", ("спецификация", "ведомость", "экспликация")),
)
PDF_KIND_NAMES = {
    "plan": "План / расстановка оборудования", "installation": "Эскиз монтажа",
    "wiring": "Схема соединений", "structure": "Структурная схема",
    "specification": "Спецификация / ведомость", "other": "Не определён",
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
        "version": 3,
        "canvas": {
            "width": floor_plan.get("width", 1400),
            "height": floor_plan.get("height", 820),
        },
        "walls": [],
        "doors": [],
        "windows": [],
        "columns": [],
        "ceilingZones": [],
    }


def validate_geometry(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Геометрия должна быть JSON-объектом")

    walls = payload.get("walls", [])
    doors = payload.get("doors", [])
    windows = payload.get("windows", [])
    columns = payload.get("columns", [])
    ceiling_zones = payload.get("ceilingZones", [])
    if not all(isinstance(items, list) for items in (walls, doors, windows, columns, ceiling_zones)):
        raise ValueError("Поля walls, doors, windows, columns и ceilingZones должны быть массивами")
    if len(walls) > 10000 or len(doors) > 5000 or len(windows) > 5000 or len(columns) > 5000 or len(ceiling_zones) > 1000:
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
        height_mm = float(wall.get("heightMm", 3000))
        if not math.isfinite(thickness) or not math.isfinite(height_mm):
            raise ValueError(f"Стена {wall_id}: некорректные толщина или высота")
        height_mm = max(100.0, min(height_mm, 10000.0))
        wall_type = str(wall.get("type", "wall"))
        if wall_type not in {"wall", "partition"}:
            raise ValueError(f"Стена {wall_id}: неизвестный тип")
        top_mode = str(wall.get("topMode", "fixed"))
        if top_mode not in {"fixed", "ceiling"}:
            raise ValueError(f"Стена {wall_id}: неизвестный режим верха")
        raw_bands = wall.get("materialBands", [])
        if not isinstance(raw_bands, list) or len(raw_bands) > 20:
            raise ValueError(f"Стена {wall_id}: состав по высоте должен содержать не более 20 полос")
        normalized_bands: list[dict[str, Any]] = []
        for band_index, band in enumerate(raw_bands):
            if not isinstance(band, dict):
                raise ValueError(f"Стена {wall_id}, полоса {band_index + 1}: нужен объект")
            from_mm = float(band.get("fromMm", 0))
            to_mm = float(band.get("toMm", height_mm))
            material = str(band.get("material", "")).strip()
            if not math.isfinite(from_mm) or not math.isfinite(to_mm) or from_mm < 0 or to_mm <= from_mm or to_mm > height_mm:
                raise ValueError(f"Стена {wall_id}, полоса {band_index + 1}: некорректный диапазон высоты")
            if not material or len(material) > 80:
                raise ValueError(f"Стена {wall_id}, полоса {band_index + 1}: укажите материал до 80 символов")
            normalized_bands.append({"fromMm": round(from_mm, 1), "toMm": round(to_mm, 1), "material": material})
        normalized_bands.sort(key=lambda item: (item["fromMm"], item["toMm"]))
        for previous, current in zip(normalized_bands, normalized_bands[1:]):
            if current["fromMm"] < previous["toMm"]:
                raise ValueError(f"Стена {wall_id}: полосы материалов не должны перекрываться")
        ceiling_zone_id = wall.get("ceilingZoneId")
        normalized_walls.append({
            "id": wall_id,
            "type": wall_type,
            "x1": values[0], "y1": values[1], "x2": values[2], "y2": values[3],
            "thickness": round(max(2.0, min(thickness, 80.0)), 3),
            "topMode": top_mode,
            "heightMm": round(height_mm, 1),
            "ceilingZoneId": str(ceiling_zone_id).strip() if ceiling_zone_id not in (None, "") else None,
            "materialBands": normalized_bands,
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
        access_point_code = normalize_access_point_code(raw_access_point_code)
        if raw_access_point_code not in (None, ""):
            if access_point_code is None:
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
            "swing": "right" if door.get("swing") == "right" else "left",
            "openingSide": 1 if door.get("openingSide") == 1 else -1,
            "leafCount": 2 if door.get("leafCount") == 2 else 1,
            "readerCount": 2 if door.get("readerCount") == 2 else 1,
            "accessPointId": str(access_point_id).strip() if access_point_id not in (None, "") else None,
            "accessPointCode": access_point_code,
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

    column_ids: set[str] = set()
    normalized_columns: list[dict[str, Any]] = []
    for index, column in enumerate(columns):
        if not isinstance(column, dict):
            raise ValueError(f"Колонна {index + 1}: нужен объект")
        column_id = str(column.get("id", "")).strip()
        if not column_id or column_id in column_ids:
            raise ValueError(f"Колонна {index + 1}: пустой или повторяющийся id")
        column_ids.add(column_id)
        x, y = float(column.get("x")), float(column.get("y"))
        size, height_mm = float(column.get("size", 36)), float(column.get("heightMm", 3000))
        if not all(math.isfinite(value) for value in (x, y, size, height_mm)):
            raise ValueError(f"Колонна {column_id}: некорректные параметры")
        normalized_columns.append({"id": column_id,
                                   "shape": "round" if column.get("shape") == "round" else "square",
                                   "x": round(x, 3), "y": round(y, 3),
                                   "size": round(max(8.0, min(size, 500.0)), 3),
                                   "heightMm": round(max(100.0, min(height_mm, 10000.0)), 1)})

    zone_ids: set[str] = set()
    normalized_zones: list[dict[str, Any]] = []
    for index, zone in enumerate(ceiling_zones):
        if not isinstance(zone, dict):
            raise ValueError(f"Потолочная зона {index + 1}: нужен объект")
        zone_id = str(zone.get("id", "")).strip()
        if not zone_id or zone_id in zone_ids:
            raise ValueError(f"Потолочная зона {index + 1}: пустой или повторяющийся id")
        zone_ids.add(zone_id)
        values = [float(zone.get(key, default)) for key, default in (("x", 0), ("y", 0), ("width", 200), ("height", 160), ("heightMm", 2700))]
        if not all(math.isfinite(value) for value in values):
            raise ValueError(f"Потолочная зона {zone_id}: некорректные параметры")
        zone_type = str(zone.get("type", "flat"))
        if zone_type not in {"flat", "suspended", "open"}:
            raise ValueError(f"Потолочная зона {zone_id}: неизвестный тип")
        raw_points = zone.get("points")
        if raw_points is None:
            x, y = values[0], values[1]
            width, height = max(20.0, min(values[2], 10000.0)), max(20.0, min(values[3], 10000.0))
            raw_points = [{"x": x, "y": y}, {"x": x + width, "y": y},
                          {"x": x + width, "y": y + height}, {"x": x, "y": y + height}]
        if not isinstance(raw_points, list) or not 3 <= len(raw_points) <= 64:
            raise ValueError(f"Потолочная зона {zone_id}: нужно от 3 до 64 углов")
        points: list[dict[str, float]] = []
        for point in raw_points:
            if not isinstance(point, dict):
                raise ValueError(f"Потолочная зона {zone_id}: некорректный угол")
            point_x, point_y = float(point.get("x", math.nan)), float(point.get("y", math.nan))
            if not math.isfinite(point_x) or not math.isfinite(point_y):
                raise ValueError(f"Потолочная зона {zone_id}: некорректный угол")
            points.append({"x": round(point_x, 3), "y": round(point_y, 3)})
        area = abs(sum(point["x"] * points[(index + 1) % len(points)]["y"] -
                       points[(index + 1) % len(points)]["x"] * point["y"]
                       for index, point in enumerate(points))) / 2
        if area < 1:
            raise ValueError(f"Потолочная зона {zone_id}: контур не имеет площади")
        xs, ys = [point["x"] for point in points], [point["y"] for point in points]
        x, y = min(xs), min(ys)
        normalized_zones.append({"id": zone_id, "x": x, "y": y,
                                "width": round(max(xs) - x, 3), "height": round(max(ys) - y, 3),
                                "points": points,
                                "heightMm": round(max(100.0, min(values[4], 10000.0)), 1), "type": zone_type})

    canvas = payload.get("canvas", {})
    return {
        "version": max(3, int(payload.get("version", 1))),
        "canvas": {
            "width": float(canvas.get("width", load_project()["floorPlan"]["width"])),
            "height": float(canvas.get("height", load_project()["floorPlan"]["height"])),
        },
        "walls": normalized_walls,
        "doors": normalized_doors,
        "windows": normalized_windows,
        "columns": normalized_columns,
        "ceilingZones": normalized_zones,
    }


def normalize_access_point_code(value: Any) -> str | None:
    if value in (None, ""):
        return None
    candidate = str(value).strip().upper().replace("TD", "ТД")
    candidate = re.sub(r"\s+", "", candidate)
    match = re.fullmatch(r"ТД\.?(\d+)\.(\d+)", candidate)
    if not match:
        return None
    return f"ТД.{int(match.group(1))}.{int(match.group(2))}"


def access_points_from_geometry(geometry: dict[str, Any]) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for door in geometry.get("doors", []):
        code = normalize_access_point_code(door.get("accessPointCode"))
        if not code:
            continue
        points.append({
            "id": str(door.get("accessPointId") or f"AP-{door['id']}"),
            "code": code,
            "doorId": str(door["id"]),
            "readerCount": 2 if door.get("readerCount") == 2 else 1,
            "corridorSide": 1,
            "status": "proposed",
        })
    return points


def validate_access_points(payload: Any, geometry: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise ValueError("Точки прохода должны быть массивом")
    door_ids = {item["id"] for item in geometry.get("doors", [])}
    ids: set[str] = set()
    codes: set[str] = set()
    doors: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"Точка прохода {index + 1}: нужен объект")
        point_id = str(item.get("id", "")).strip()
        if not point_id or point_id in ids or len(point_id) > 80:
            raise ValueError(f"Точка прохода {index + 1}: пустой, длинный или повторяющийся id")
        ids.add(point_id)
        code = normalize_access_point_code(item.get("code"))
        if not code:
            raise ValueError(f"Точка прохода {point_id}: код должен иметь вид ТД.1.1")
        if code in codes:
            raise ValueError(f"Точка прохода {code} повторяется")
        codes.add(code)
        door_id = str(item.get("doorId", "")).strip()
        if door_id not in door_ids:
            raise ValueError(f"Точка прохода {code}: дверь {door_id} не найдена")
        if door_id in doors:
            raise ValueError(f"Дверь {door_id} уже связана с другой точкой прохода")
        doors.add(door_id)
        normalized.append({
            "id": point_id,
            "code": code,
            "doorId": door_id,
            "readerCount": 2 if item.get("readerCount") == 2 else 1,
            "corridorSide": -1 if item.get("corridorSide") == -1 else 1,
            "status": "confirmed" if item.get("status") == "confirmed" else "proposed",
        })
    return normalized


def validate_equipment(payload: Any, geometry: dict[str, Any], access_points: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise ValueError("Оборудование должно быть массивом")
    if len(payload) > 10000:
        raise ValueError("Слишком много единиц оборудования")
    ids: set[str] = set()
    codes: set[str] = set()
    door_ids = {item["id"] for item in geometry.get("doors", [])}
    wall_ids = {item["id"] for item in geometry.get("walls", [])}
    access_points_by_id = {item["id"]: item for item in access_points or []}
    access_points_by_door = {item["doorId"]: item for item in access_points or []}
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
        raw_access_point_id = item.get("accessPointId")
        access_point_id = str(raw_access_point_id).strip() if raw_access_point_id not in (None, "") else None
        if access_point_id is not None:
            point = access_points_by_id.get(access_point_id)
            if point is None:
                raise ValueError(f"Оборудование {item_id}: точка прохода {access_point_id} не найдена")
            if host_door_id is None or str(host_door_id) != point["doorId"]:
                raise ValueError(f"Оборудование {item_id}: точка прохода и дверь не совпадают")
        elif host_door_id is not None and str(host_door_id) in access_points_by_door:
            access_point_id = access_points_by_door[str(host_door_id)]["id"]
        normalized = {
            "id": item_id, "system": "cctv" if item_type.startswith("camera_") else "skud_intercom", "type": item_type, "code": code,
            "x": round(x, 3), "y": round(y, 3), "rotation": round(rotation, 6),
            "mount": mount, "mountingHeight": round(max(0, min(mounting_height, 10000)), 1),
            "accessPointId": access_point_id,
            "hostDoorId": str(host_door_id) if host_door_id is not None else None,
            "hostWallId": str(host_wall_id) if host_wall_id is not None else None,
            "status": "confirmed" if item.get("status") == "confirmed" else "proposed",
        }
        if item_type in {"camera_ceiling", "camera_ceiling_bracket"}:
            view_angle = float(item.get("viewAngleDeg", 90))
            view_range = float(item.get("viewRange", 420))
            down_tilt = float(item.get("downTiltDeg", 45))
            blind_zone = float(item.get("blindZone", 70))
            bracket_length = float(item.get("bracketLengthMm", 200 if item_type == "camera_ceiling_bracket" else 0))
            if not all(math.isfinite(value) for value in (view_angle, view_range, down_tilt, blind_zone, bracket_length)):
                raise ValueError(f"Камера {item_id}: некорректные параметры обзора")
            normalized.update({
                "mount": "ceiling", "viewAngleDeg": round(max(20, min(view_angle, 180)), 1),
                "viewRange": round(max(40, min(view_range, 3000)), 1),
                "downTiltDeg": round(max(0, min(down_tilt, 90)), 1),
                "cameraPreset": "cash_zone" if item.get("cameraPreset") == "cash_zone" else "custom",
                "blindZoneMode": "manual" if item.get("blindZoneMode") == "manual" else "auto",
                "blindZone": round(max(0, min(blind_zone, max(0, view_range - 1))), 1),
                "bracketLengthMm": round(max(50, min(bracket_length, 2000)), 1) if item_type == "camera_ceiling_bracket" else 0,
            })
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
            for point in access_points or []:
                readers_by_door[point["doorId"]] = point.get("readerCount", 1)
            reader_load = sum(readers_by_door[str(door_id)] for door_id in served)
            if len(served) > door_capacity or reader_load > reader_capacity:
                raise ValueError(f"Контроллер {item_id}: превышена ёмкость дверей или считывателей")
            normalized["controllerDoorCapacity"] = door_capacity
            normalized["controllerReaderCapacity"] = reader_capacity
            normalized["servedDoorIds"] = [str(door_id) for door_id in served]
            normalized["formFactor"] = "din_rail" if item.get("formFactor") == "din_rail" else "wall_enclosure"
        if item_type == "power_supply":
            normalized["servedControllerId"] = str(item.get("servedControllerId"))[:80] if item.get("servedControllerId") not in (None, "") else None
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
    controller_ids = {item["id"] for item in result if item["type"] == "controller"}
    for power_supply in (item for item in result if item["type"] == "power_supply"):
        controller_id = power_supply.get("servedControllerId")
        if controller_id is not None and controller_id not in controller_ids:
            raise ValueError(f"Блок питания {power_supply['id']}: контроллер {controller_id} не найден")
    return result


def classify_entity(layer: str, block_name: str = "") -> str | None:
    haystack = f"{layer} {block_name}".lower()
    controller_words = ("controller", "skud", "скуд", "контроллер")
    door_words = ("door", "gate", "turnstile", "двер", "калитк", "турникет")
    if any(word in haystack for word in controller_words):
        return "controller"
    if any(word in haystack for word in door_words):
        return "door"
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

        prefix = "AC" if item_type == "controller" else "D"
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
                "status": "not_configured",
            }
        )

    return equipment


def read_text_dxf(payload: bytes) -> ezdxf.document.Drawing:
    for encoding in ("utf-8", "cp1251", "latin-1"):
        try:
            return ezdxf.read(io.StringIO(payload.decode(encoding)))
        except (UnicodeDecodeError, ezdxf.DXFError):
            continue
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
            # Large production drawings can be truncated by ODA without the audit pass,
            # producing a DXF without ENDSEC/EOF even though the converter exits cleanly.
            return odafc.readfile(source, audit=True)
        except Exception as error:  # odafc exceptions differ between platforms
            raise RuntimeError(
                "ODA File Converter не смог подготовить цельный DXF из DWG. "
                "Проверьте исходный файл в AutoCAD/ODA и повторите импорт."
            ) from error


def calculate_bounds(items: list[dict[str, Any]]) -> dict[str, float] | None:
    if not items:
        return None
    xs = [float(item["x"]) for item in items]
    ys = [float(item["y"]) for item in items]
    return {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}


def classify_cad_layer(layer: str) -> str:
    """Use conservative layer-name hints; unknown layers remain reference-only."""
    name = layer.casefold().replace("ё", "е")
    if any(token in name for token in ("размер", "dim", "axis", "ось", "выноск")):
        return "annotation"
    if any(token in name for token in ("перегород", "peregor", "partition")):
        return "partition"
    if any(token in name for token in ("wall", "стен", "architect", "архитект")):
        return "architecture"
    if any(token in name for token in ("мебел", "furn", "оборуд", "equipment", "сантех")):
        return "equipment"
    return "general"


def extract_cad_preview(document: ezdxf.document.Drawing, limit: int = 20000) -> dict[str, Any]:
    """Extract a deterministic preview, keeping architectural layers ahead of clutter."""
    paths: list[dict[str, Any]] = []
    labels: list[dict[str, Any]] = []
    all_points: list[tuple[float, float]] = []
    layer_stats: dict[str, dict[str, Any]] = {}

    def add_path(points: list[tuple[float, float]], layer: str, entity_type: str,
                 closed: bool = False) -> None:
        clean = [[round(float(x), 3), round(float(y), 3)] for x, y in points
                 if math.isfinite(float(x)) and math.isfinite(float(y))]
        if len(clean) < 2 or len(paths) >= limit:
            return
        paths.append({"layer": layer, "category": classify_cad_layer(layer),
                      "entityType": entity_type, "points": clean, "closed": bool(closed)})
        all_points.extend((p[0], p[1]) for p in clean)

    def sample_arc(center: Any, radius: float, start: float, end: float) -> list[tuple[float, float]]:
        sweep = (end - start) % 360 or 360
        count = max(8, min(96, math.ceil(sweep / 7.5)))
        return [(center.x + radius * math.cos(math.radians(start + sweep * i / count)),
                 center.y + radius * math.sin(math.radians(start + sweep * i / count)))
                for i in range(count + 1)]

    def visit(entity: Any, inherited_layer: str | None = None, depth: int = 0) -> None:
        if depth > 4:
            return
        kind = entity.dxftype()
        own_layer = str(entity.dxf.get("layer", inherited_layer or "0"))
        layer = inherited_layer if own_layer == "0" and inherited_layer else own_layer
        if kind == "LINE":
            add_path([(entity.dxf.start.x, entity.dxf.start.y), (entity.dxf.end.x, entity.dxf.end.y)], layer, kind)
        elif kind == "LWPOLYLINE":
            try:
                points = [(point.x, point.y) for point in entity.flattening(0.5)]
            except (AttributeError, TypeError):
                points = [(point[0], point[1]) for point in entity.get_points("xy")]
            add_path(points, layer, kind, entity.closed)
        elif kind == "POLYLINE":
            add_path([(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices], layer, kind, bool(entity.is_closed))
        elif kind == "ARC":
            add_path(sample_arc(entity.dxf.center, float(entity.dxf.radius),
                                float(entity.dxf.start_angle), float(entity.dxf.end_angle)), layer, kind)
        elif kind == "CIRCLE":
            add_path(sample_arc(entity.dxf.center, float(entity.dxf.radius), 0, 360), layer, kind, True)
        elif kind == "INSERT":
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

    sources = list(document.modelspace())
    for source in sources:
        layer = str(source.dxf.get("layer", "0"))
        entry = layer_stats.setdefault(layer, {"layer": layer, "category": classify_cad_layer(layer),
                                               "entities": 0, "types": {}})
        kind = source.dxftype()
        entry["entities"] += 1
        entry["types"][kind] = entry["types"].get(kind, 0) + 1
    priority = {"architecture": 0, "partition": 1, "general": 2, "equipment": 3, "annotation": 4}
    sources.sort(key=lambda item: (priority[classify_cad_layer(str(item.dxf.get("layer", "0")))],
                                   str(item.dxf.get("layer", "0")), item.dxftype()))
    for source in sources:
        visit(source)
    if not all_points:
        return {"paths": [], "labels": [], "layers": [], "layerStats": list(layer_stats.values()),
                "bounds": None, "truncated": False}
    xs, ys = zip(*all_points)
    bounds = {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}
    return {"paths": paths, "labels": labels,
            "layers": sorted({p["layer"] for p in paths} | {t["layer"] for t in labels}),
            "layerStats": sorted(layer_stats.values(), key=lambda item: (-item["entities"], item["layer"])),
            "bounds": bounds, "truncated": len(paths) >= limit}


CAD_ROOM_HINTS = (
    "кухн", "зал", "сцена", "гардероб", "подсоб", "коридор", "кабинет",
    "склад", "сануз", "туалет", "цех", "моеч", "бар", "помещен",
)


def detect_cad_regions(preview: dict[str, Any], limit: int = 60) -> list[dict[str, Any]]:
    """Find spatially separate drawings without silently choosing the largest one."""
    architecture = [path for path in preview.get("paths", [])
                    if path.get("category") in {"architecture", "partition"}]
    bounds = preview.get("bounds")
    if len(architecture) < 4 or not bounds:
        return []
    diagonal = math.hypot(bounds["maxX"] - bounds["minX"], bounds["maxY"] - bounds["minY"])
    tolerance = max(diagonal * 0.001, 1.0)
    parent = list(range(len(architecture)))
    sizes = [1] * len(architecture)

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left, right = find(left), find(right)
        if left == right:
            return
        if sizes[left] < sizes[right]:
            left, right = right, left
        parent[right] = left
        sizes[left] += sizes[right]

    grid: dict[tuple[int, int], list[int]] = {}
    for index, path in enumerate(architecture):
        points = path.get("points", [])
        samples = points + [[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
                            for a, b in zip(points, points[1:])]
        cells = {(round(point[0] / tolerance), round(point[1] / tolerance)) for point in samples}
        for cell_x, cell_y in cells:
            for offset_x in (-1, 0, 1):
                for offset_y in (-1, 0, 1):
                    for other in grid.get((cell_x + offset_x, cell_y + offset_y), ()):
                        union(index, other)
            grid.setdefault((cell_x, cell_y), []).append(index)

    components: dict[int, list[dict[str, Any]]] = {}
    for index, path in enumerate(architecture):
        components.setdefault(find(index), []).append(path)

    def split_component(paths: list[dict[str, Any]], depth: int = 0) -> list[list[dict[str, Any]]]:
        """Split a connected drafting group at large empty bands between drawing centres."""
        if depth >= 1 or len(paths) < 24:
            return [paths]
        path_centers = []
        for path in paths:
            points = path.get("points", [])
            if points:
                path_centers.append((path, sum(point[0] for point in points) / len(points),
                                     sum(point[1] for point in points) / len(points)))
        if len(path_centers) < 16:
            return [paths]
        best: tuple[float, list[dict[str, Any]], list[dict[str, Any]]] | None = None
        for axis in (1, 2):
            ordered = sorted(path_centers, key=lambda item: item[axis])
            span = ordered[-1][axis] - ordered[0][axis]
            if span <= 0:
                continue
            for index in range(7, len(ordered) - 7):
                gap = ordered[index][axis] - ordered[index - 1][axis]
                if gap < max(1.0, span * 0.08):
                    continue
                score = gap / span
                if best is None or score > best[0]:
                    best = (score, [item[0] for item in ordered[:index]],
                            [item[0] for item in ordered[index:]])
        if best is None:
            return [paths]
        return split_component(best[1], depth + 1) + split_component(best[2], depth + 1)

    candidates: list[dict[str, Any]] = []
    drawing_groups = [group for component in components.values() for group in split_component(component)]
    for paths in drawing_groups:
        if len(paths) < 6:
            continue
        points = [point for path in paths for point in path.get("points", [])]
        if not points:
            continue
        xs, ys = zip(*points)
        component_bounds = {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}
        width = component_bounds["maxX"] - component_bounds["minX"]
        height = component_bounds["maxY"] - component_bounds["minY"]
        if width <= 0 or height <= 0:
            continue
        nearby_labels = [label for label in preview.get("labels", [])
            if component_bounds["minX"] - tolerance <= float(label.get("x", 0)) <= component_bounds["maxX"] + tolerance
            and component_bounds["minY"] - tolerance <= float(label.get("y", 0)) <= component_bounds["maxY"] + tolerance]
        nearby_text = " ".join(
            str(label.get("text", "")).casefold()
            for label in nearby_labels
        )
        room_hits = sum(hint in nearby_text for hint in CAD_ROOM_HINTS)
        pad_x, pad_y = max(width * 0.08, tolerance), max(height * 0.08, tolerance)
        padded = {"minX": component_bounds["minX"] - pad_x, "minY": component_bounds["minY"] - pad_y,
                  "maxX": component_bounds["maxX"] + pad_x, "maxY": component_bounds["maxY"] + pad_y}
        candidates.append({"bounds": padded, "architecturePaths": len(paths), "roomHints": room_hits,
                           "labels": len(nearby_labels), "labelPreview": [label["text"] for label in nearby_labels[:3]],
                           "score": (int(room_hits >= 2), room_hits, len(paths), width * height)})
    if not candidates:
        return []
    candidates.sort(key=lambda item: (-item["bounds"]["maxY"], item["bounds"]["minX"]))
    if len(candidates) > limit:
        strongest = sorted(candidates, key=lambda item: item["score"], reverse=True)[:limit]
        candidates = sorted(strongest, key=lambda item: (-item["bounds"]["maxY"], item["bounds"]["minX"]))
    recommended = max(candidates, key=lambda item: item["score"])
    for index, candidate in enumerate(candidates, start=1):
        candidate["id"] = f"region-{index:02d}"
        candidate["title"] = f"Схема {index}"
        candidate["recommended"] = candidate is recommended
        candidate.pop("score", None)
    return candidates


def focus_cad_preview(preview: dict[str, Any], region_id: str | None = None) -> dict[str, Any]:
    """Crop CAD preview to a user-selected spatial region."""
    regions = detect_cad_regions(preview)
    if not regions:
        return preview
    selected = next((region for region in regions if region["id"] == region_id), None)
    if selected is None:
        if region_id is not None:
            raise ValueError("Выбранная схема не найдена в DWG")
        if len(regions) != 1:
            return {**preview, "regions": regions}
        selected = regions[0]
    focus = selected["bounds"]

    def path_inside(path: dict[str, Any]) -> bool:
        points = path.get("points", [])
        return bool(points) and not (max(point[0] for point in points) < focus["minX"]
                                     or min(point[0] for point in points) > focus["maxX"]
                                     or max(point[1] for point in points) < focus["minY"]
                                     or min(point[1] for point in points) > focus["maxY"])

    focused_paths = [path for path in preview.get("paths", []) if path_inside(path)]
    focused_labels = [label for label in preview.get("labels", [])
                      if focus["minX"] <= float(label.get("x", 0)) <= focus["maxX"]
                      and focus["minY"] <= float(label.get("y", 0)) <= focus["maxY"]]
    return {**preview, "paths": focused_paths, "labels": focused_labels,
            "layers": sorted({path["layer"] for path in focused_paths} | {label["layer"] for label in focused_labels}),
            "overviewBounds": preview.get("bounds"), "bounds": focus, "regions": regions,
            "selectedRegionId": selected["id"], "focus": {
                "method": "user-selected-region", "roomHints": selected["roomHints"],
                "architecturePaths": selected["architecturePaths"], "paths": len(focused_paths),
            }}


def normalize_cad_preview(preview: dict[str, Any], floor: dict[str, Any], region_id: str | None = None) -> dict[str, Any]:
    preview = focus_cad_preview(preview, region_id)
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


def render_cad_region_svg(preview: dict[str, Any], region: dict[str, Any], output: Path) -> None:
    """Render an independently scaled thumbnail for one detected CAD region."""
    bounds = region["bounds"]
    width, height = bounds["maxX"] - bounds["minX"], bounds["maxY"] - bounds["minY"]
    canvas_width, canvas_height, padding = 360, 240, 10
    scale = min((canvas_width - padding * 2) / max(width, 1), (canvas_height - padding * 2) / max(height, 1))

    def transform(point: list[float]) -> tuple[float, float]:
        return (padding + (point[0] - bounds["minX"]) * scale,
                canvas_height - padding - (point[1] - bounds["minY"]) * scale)

    def intersects(path: dict[str, Any]) -> bool:
        points = path.get("points", [])
        return bool(points) and not (max(point[0] for point in points) < bounds["minX"]
                                     or min(point[0] for point in points) > bounds["maxX"]
                                     or max(point[1] for point in points) < bounds["minY"]
                                     or min(point[1] for point in points) > bounds["maxY"])

    colors = {"architecture": "#174a73", "partition": "#087f7a", "equipment": "#b35a18",
              "annotation": "#72808b", "general": "#69757c"}
    lines = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240">',
             '<rect width="360" height="240" fill="#f7f8f6"/>']
    for path in [item for item in preview.get("paths", []) if intersects(item)][:2500]:
        points = [transform(point) for point in path.get("points", [])]
        if len(points) < 2:
            continue
        data = "M " + " L ".join(f"{x:.2f} {y:.2f}" for x, y in points)
        color = colors.get(path.get("category", "general"), colors["general"])
        lines.append(f'<path d="{data}" fill="none" stroke="{color}" stroke-width="0.8" vector-effect="non-scaling-stroke"/>')
    for label in preview.get("labels", []):
        if bounds["minX"] <= float(label.get("x", 0)) <= bounds["maxX"] and bounds["minY"] <= float(label.get("y", 0)) <= bounds["maxY"]:
            x, y = transform([float(label["x"]), float(label["y"])])
            text = html.escape(str(label.get("text", ""))[:50])
            lines.append(f'<text x="{x:.2f}" y="{y:.2f}" font-size="5" fill="#33444d">{text}</text>')
    lines.append('</svg>')
    output.write_text("\n".join(lines), encoding="utf-8")


def clip_segment_to_bounds(a: list[float], b: list[float], bounds: dict[str, float]) -> tuple[list[float], list[float]] | None:
    """Liang-Barsky clip in editor coordinates."""
    x1, y1, x2, y2 = float(a[0]), float(a[1]), float(b[0]), float(b[1])
    dx, dy = x2 - x1, y2 - y1
    low, high = 0.0, 1.0
    for p, q in ((-dx, x1 - bounds["minX"]), (dx, bounds["maxX"] - x1),
                 (-dy, y1 - bounds["minY"]), (dy, bounds["maxY"] - y1)):
        if abs(p) < 1e-9:
            if q < 0:
                return None
            continue
        ratio = q / p
        if p < 0:
            low = max(low, ratio)
        else:
            high = min(high, ratio)
        if low > high:
            return None
    return ([x1 + low * dx, y1 + low * dy], [x1 + high * dx, y1 + high * dy])


def propose_architecture(preview: dict[str, Any], payload: dict[str, Any], limit: int = 1200) -> dict[str, Any]:
    raw_bounds = payload.get("bounds") or {}
    try:
        bounds = {key: float(raw_bounds[key]) for key in ("minX", "minY", "maxX", "maxY")}
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Выделите рабочую область на CAD-подложке") from error
    if not all(math.isfinite(value) for value in bounds.values()):
        raise ValueError("Границы рабочей области заданы неверно")
    if bounds["minX"] >= bounds["maxX"] or bounds["minY"] >= bounds["maxY"]:
        raise ValueError("Рабочая область слишком мала")
    requested_layers = {str(value) for value in payload.get("layers", []) if str(value).strip()}
    available: dict[str, dict[str, Any]] = {}
    for path in preview.get("paths", []):
        entry = available.setdefault(path["layer"], {"layer": path["layer"],
                                                     "category": path.get("category", "general"), "paths": 0})
        entry["paths"] += 1
    if not requested_layers:
        requested_layers = {name for name, item in available.items()
                            if item["category"] in {"architecture", "partition"}}
    minimum = max(2.0, min(100.0, float(payload.get("minimumLength", 8))))
    walls: list[dict[str, Any]] = []
    seen: set[tuple[int, int, int, int, str]] = set()
    rejected = 0
    for path in preview.get("paths", []):
        if path["layer"] not in requested_layers:
            continue
        wall_type = "partition" if path.get("category") == "partition" else "wall"
        points = path.get("points", [])
        pairs = list(zip(points, points[1:]))
        if path.get("closed") and len(points) > 2:
            pairs.append((points[-1], points[0]))
        for start, end in pairs:
            clipped = clip_segment_to_bounds(start, end, bounds)
            if clipped is None:
                continue
            start, end = clipped
            if math.hypot(end[0] - start[0], end[1] - start[1]) < minimum:
                rejected += 1
                continue
            forward = (round(start[0] * 2), round(start[1] * 2), round(end[0] * 2), round(end[1] * 2), wall_type)
            reverse = (forward[2], forward[3], forward[0], forward[1], wall_type)
            key = min(forward, reverse)
            if key in seen:
                continue
            seen.add(key)
            walls.append({"type": wall_type, "x1": round(start[0], 2), "y1": round(start[1], 2),
                          "x2": round(end[0], 2), "y2": round(end[1], 2),
                          "sourceLayer": path["layer"]})
            if len(walls) >= limit:
                break
        if len(walls) >= limit:
            break
    return {"walls": walls, "doors": [], "windows": [], "layers": sorted(requested_layers),
            "availableLayers": sorted(available.values(), key=lambda item: (-item["paths"], item["layer"])),
            "rejectedShortSegments": rejected, "truncated": len(walls) >= limit,
            "note": "Проёмы пока не распознаются автоматически: их нужно подтвердить вручную на предложенных стенах."}


def pdf_renderer_path() -> str | None:
    """Find Poppler without assuming a particular Homebrew installation."""
    candidates = (
        shutil.which("pdftoppm"), "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm",
        "/usr/bin/pdftoppm",
        "/Users/olegklimov/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm",
    )
    return next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)


def pdf_text_extractor_path() -> str | None:
    candidates = (
        shutil.which("pdftotext"), "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext",
        "/usr/bin/pdftotext",
        "/Users/olegklimov/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdftotext",
    )
    return next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)


def pdf_objects(payload: bytes) -> dict[int, bytes]:
    return {int(match.group(1)): match.group(2) for match in re.finditer(
        rb"(?m)(\d+)\s+\d+\s+obj\b(.*?)\bendobj\b", payload, re.S)}


def pdf_stream_data(object_data: bytes) -> bytes:
    match = re.search(rb"\bstream\r?\n(.*?)\r?\nendstream\b", object_data, re.S)
    if not match:
        return b""
    data = match.group(1)
    if b"/FlateDecode" in object_data:
        try:
            return zlib.decompress(data)
        except zlib.error:
            return b""
    return data


def decode_pdf_fragment(raw: bytes) -> str:
    variants: list[str] = []
    for encoding in ("utf-16-be", "utf-8", "cp1251", "latin-1"):
        try:
            variants.append(raw.decode(encoding, errors="ignore"))
        except UnicodeDecodeError:
            continue
    return max(variants, key=lambda value: sum(char.isalpha() for char in value), default="")


def extract_pdf_page_text(page_data: bytes, objects: dict[int, bytes]) -> str:
    refs = re.findall(rb"/Contents\s+(\d+)\s+\d+\s+R", page_data)
    for array in re.findall(rb"/Contents\s*\[(.*?)\]", page_data, re.S):
        refs.extend(re.findall(rb"(\d+)\s+\d+\s+R", array))
    parts: list[str] = []
    for ref in refs:
        stream = pdf_stream_data(objects.get(int(ref), b""))
        for literal in re.findall(rb"\((?:\\.|[^\\)])*\)", stream):
            parts.append(decode_pdf_fragment(literal[1:-1]))
        for hex_text in re.findall(rb"<([0-9A-Fa-f]{4,})>", stream):
            try:
                parts.append(decode_pdf_fragment(bytes.fromhex(hex_text.decode("ascii"))))
            except ValueError:
                continue
    return " ".join(part.replace("\\(", "(").replace("\\)", ")") for part in parts)


def classify_pdf_page(text: str, page_number: int) -> dict[str, Any]:
    normalized = re.sub(r"\s+", " ", text).strip()
    lowered = normalized.casefold()
    kind = next((candidate for candidate, keywords in PDF_KIND_RULES
                 if any(keyword in lowered for keyword in keywords)), "other")
    title = PDF_KIND_NAMES[kind] if kind != "other" else f"Лист {page_number}"
    for phrase in ("план прокладки кабеля и расстановки оборудования", "эскиз монтажа точки доступа",
                   "схема внешних соединений", "структурная схема", "спецификация"):
        if phrase in lowered:
            title = phrase[:1].upper() + phrase[1:]
            break
    return {"page": page_number, "title": title, "kind": kind,
            "confidence": "high" if kind != "other" else "low", "textPreview": normalized[:360]}


def scan_pdf_source(source: Path) -> list[dict[str, Any]]:
    extractor = pdf_text_extractor_path()
    if extractor:
        page_count_result = subprocess.run([extractor, "-f", "1", "-l", "9999", str(source), "-"],
                                           check=False, capture_output=True, text=True, timeout=60)
        if page_count_result.returncode == 0:
            pages = page_count_result.stdout.split("\f")
            if pages and not pages[-1].strip():
                pages.pop()
            if pages:
                return [classify_pdf_page(text, number) for number, text in enumerate(pages, start=1)]
    objects = pdf_objects(source.read_bytes())
    pages = [data for data in objects.values() if re.search(rb"/Type\s*/Page\b", data)]
    return [classify_pdf_page(extract_pdf_page_text(data, objects), number)
            for number, data in enumerate(pages, start=1)] or [classify_pdf_page("", 1)]


def render_pdf_page(source: Path, output: Path, page_number: int, scale_to: int = 1800) -> None:
    renderer = pdf_renderer_path()
    if renderer is None:
        raise RuntimeError("Для подготовки PDF-подложки нужен Poppler (pdftoppm). Установите poppler и повторите преобразование.")
    output.parent.mkdir(parents=True, exist_ok=True)
    prefix = output.with_suffix("")
    command = [renderer, "-f", str(page_number), "-l", str(page_number), "-scale-to", str(scale_to),
               "-png", "-singlefile", str(source), str(prefix)]
    result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=60)
    if result.returncode or not output.is_file():
        raise RuntimeError("Не удалось отрисовать выбранную страницу PDF")


def analyze_project_sources(record: dict[str, Any]) -> dict[str, Any]:
    folder = project_path(record["id"]).parent
    sources: list[dict[str, Any]] = []
    for entry in record.get("files", []):
        suffix = Path(entry["name"]).suffix.lower()
        source = folder / entry["id"]
        if suffix == ".pdf":
            pages = scan_pdf_source(source)
            for page in pages[:MAX_ANALYSIS_PAGES]:
                thumbnail = f"preview-{entry['id']}-p{page['page']}.png"
                render_pdf_page(source, folder / thumbnail, page["page"], 440)
                page["thumbnailUrl"] = f"/api/projects/{record['id']}/derived/{thumbnail}"
            sources.append({"fileId": entry["id"], "name": entry["name"], "format": "pdf", "pages": pages,
                            "note": "Выберите лист плана: он станет заблокированной подложкой."})
        elif suffix in {".dwg", ".dxf"}:
            payload = source.read_bytes()
            try:
                document = read_dwg(payload) if suffix == ".dwg" else read_text_dxf(payload)
                preview = extract_cad_preview(document)
                regions = detect_cad_regions(preview)
                for region in regions:
                    thumbnail = f"preview-{Path(entry['id']).stem}-{region['id']}.svg"
                    render_cad_region_svg(preview, region, folder / thumbnail)
                    region["thumbnailUrl"] = f"/api/projects/{record['id']}/derived/{thumbnail}"
                layouts = [name for name in document.layout_names() if name != "Model"]
                sources.append({"fileId": entry["id"], "name": entry["name"], "format": suffix[1:],
                                "layouts": layouts, "preview": {"paths": len(preview["paths"]),
                                "labels": len(preview["labels"]), "layers": preview["layers"]},
                                "regions": regions,
                                "note": "Выберите нужную схему по миниатюре. Рекомендация не включается автоматически."})
            except (RuntimeError, ValueError) as error:
                sources.append({"fileId": entry["id"], "name": entry["name"], "format": suffix[1:],
                                "error": str(error), "candidates": []})
        elif suffix in {".png", ".jpg", ".jpeg"}:
            sources.append({"fileId": entry["id"], "name": entry["name"], "format": suffix[1:],
                            "candidates": [{"id": "image", "title": "Изображение-подложка", "kind": "plan",
                                            "confidence": "high"}]})
    return {"status": "ready", "analyzedAt": datetime.now(timezone.utc).isoformat(), "sources": sources}


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

    payload = await file.read(MAX_SOURCE_SIZE + 1)
    if len(payload) > MAX_SOURCE_SIZE:
        raise HTTPException(status_code=413, detail="Файл больше 100 МБ")

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
    cad_preview = None
    layout_names = [name for name in document.layout_names() if name != "Model"]
    if project_id is not None:
        with PROJECTS_LOCK:
            record = read_record(project_id)
            cad_preview = normalize_cad_preview(extract_cad_preview(document), record["project"]["floorPlan"])
            bounds = calculate_bounds(equipment)
            placed = []
            if bounds:
                floor = record["project"]["floorPlan"]
                factor = min((floor["width"]-200)/max(bounds["maxX"]-bounds["minX"], 1),
                             (floor["height"]-200)/max(bounds["maxY"]-bounds["minY"], 1))
                placed = [{**e, "originalX": e["x"], "originalY": e["y"],
                           "x": 100+(e["x"]-bounds["minX"])*factor,
                           "y": floor["height"]-100-(e["y"]-bounds["minY"])*factor} for e in equipment]
            record["project"]["equipment"] = placed
            record["cadSource"] = filename
            record["cadLayouts"] = layout_names
            if layout_names:
                record["project"]["floorPlan"]["name"] = layout_names[0]
            record["cadPreview"] = cad_preview
            write_record(record)
    return {
        "source": filename,
        "format": suffix.removeprefix("."),
        "equipment": equipment,
        "bounds": calculate_bounds(equipment),
        "preview": {"paths": len(cad_preview["paths"]), "labels": len(cad_preview["labels"]),
                    "layers": cad_preview["layers"], "truncated": cad_preview["truncated"]} if cad_preview else None,
        "layouts": layout_names,
        "summary": {
            "controllers": sum(item["type"] == "controller" for item in equipment),
            "doors": sum(item["type"] == "door" for item in equipment),
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


def read_record(project_id: str) -> dict:
    target = project_path(project_id)
    if not target.is_file():
        raise HTTPException(404, "Проект не найден")
    record = json.loads(target.read_text(encoding="utf-8"))
    record.setdefault("project", {}).setdefault("equipment", [])
    record["project"].setdefault("accessPoints", access_points_from_geometry(record.get("geometry", {})))
    return record


def ensure_initial_project() -> None:
    with PROJECTS_LOCK:
        if not project_path("initial").exists():
            project_data = load_project()
            write_record({"id": "initial", "name": project_data["project"]["object"],
                          "project": {**project_data, "accessPoints": project_data.get("accessPoints", [])},
                          "geometry": load_geometry(), "files": []})


@app.get("/api/projects")
def list_projects(archived: bool = False) -> list[dict]:
    ensure_initial_project()
    with PROJECTS_LOCK:
        records = [json.loads(p.read_text(encoding="utf-8")) for p in PROJECTS_DIR.glob("*/project.json")]
    records = [r for r in records if bool(r.get("archivedAt")) is archived]
    return sorted([{"id": r["id"], "name": r["name"], "updatedAt": r["updatedAt"],
                    "archivedAt": r.get("archivedAt")} for r in records],
                  key=lambda r: r["updatedAt"], reverse=True)


@app.post("/api/projects", status_code=201)
def create_project(payload: dict[str, Any]) -> dict:
    name = payload.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
        raise HTTPException(422, "Укажите название проекта (1–120 символов)")
    ensure_initial_project()
    record = {"id": uuid.uuid4().hex, "name": name.strip(), "files": [],
              "project": {"project": {"object": name.strip(), "address": "", "revision": "Новый проект"},
                          "floorPlan": {"width": 2650, "height": 1850, "rooms": []},
                          "equipment": [], "accessPoints": []},
              "geometry": {"version": 3, "canvas": {"width": 2650, "height": 1850},
                           "walls": [], "doors": [], "windows": [], "columns": [], "ceilingZones": []}}
    with PROJECTS_LOCK:
        write_record(record)
    return record


@app.get("/api/projects/{project_id}")
def get_project_record(project_id: str) -> dict:
    return read_record(project_id)


@app.patch("/api/projects/{project_id}/archive")
def archive_project(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    if project_id == "initial":
        raise HTTPException(422, "Демонстрационный проект нельзя переместить в архив")
    archived = payload.get("archived")
    if not isinstance(archived, bool):
        raise HTTPException(422, "Укажите состояние архива")
    with PROJECTS_LOCK:
        record = read_record(project_id)
        if archived:
            record["archivedAt"] = datetime.now(timezone.utc).isoformat()
        else:
            record.pop("archivedAt", None)
        write_record(record)
    return {"id": project_id, "name": record["name"], "archived": archived}


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str) -> dict[str, Any]:
    if project_id == "initial":
        raise HTTPException(422, "Демонстрационный проект нельзя удалить")
    with PROJECTS_LOCK:
        record = read_record(project_id)
        if not record.get("archivedAt"):
            raise HTTPException(422, "Сначала переместите проект в архив")
        shutil.rmtree(project_path(project_id).parent)
    return {"status": "deleted", "id": project_id, "name": record["name"]}


@app.put("/api/projects/{project_id}/geometry")
def save_project_geometry(project_id: str, payload: dict[str, Any]) -> dict:
    try:
        normalized = validate_geometry(payload)
    except (TypeError, ValueError, KeyError, OverflowError) as error:
        raise HTTPException(422, str(error)) from error
    with PROJECTS_LOCK:
        record = read_record(project_id)
        record["geometry"] = normalized
        write_record(record)
    return {"geometry": normalized, "walls": len(normalized["walls"]),
            "doors": len(normalized["doors"]), "windows": len(normalized["windows"]),
            "columns": len(normalized["columns"]), "ceilingZones": len(normalized["ceilingZones"])}


@app.put("/api/projects/{project_id}/equipment")
def save_project_equipment(project_id: str, payload: dict[str, Any]) -> dict:
    with PROJECTS_LOCK:
        record = read_record(project_id)
        try:
            if "accessPoints" in payload:
                record["project"]["accessPoints"] = validate_access_points(payload.get("accessPoints"), record["geometry"])
            normalized = validate_equipment(payload.get("equipment"), record["geometry"], record["project"].get("accessPoints", []))
        except (TypeError, ValueError, KeyError, OverflowError) as error:
            raise HTTPException(422, str(error)) from error
        record["project"]["equipment"] = normalized
        write_record(record)
    return {"status": "saved", "count": len(normalized), "equipment": normalized,
            "accessPoints": record["project"]["accessPoints"]}


@app.post("/api/projects/{project_id}/files", status_code=201)
async def add_project_file(project_id: str, file: UploadFile = File(...)) -> dict:
    read_record(project_id)
    name = Path((file.filename or "file").replace("\\", "/")).name
    suffix = Path(name).suffix.lower()
    if suffix not in {".pdf", ".dwg", ".dxf", ".png", ".jpg", ".jpeg"}:
        raise HTTPException(400, "Поддерживаются PDF, DWG, DXF, PNG и JPG")
    payload = await file.read(MAX_SOURCE_SIZE + 1)
    if not payload or len(payload) > MAX_SOURCE_SIZE:
        raise HTTPException(413, "Нужен непустой файл до 100 МБ")
    file_id = uuid.uuid4().hex + suffix
    with PROJECTS_LOCK:
        record = read_record(project_id)
        target = project_path(project_id).parent / file_id
        target.write_bytes(payload)
        entry = {"id": file_id, "name": name, "size": len(payload),
                 "url": f"/api/projects/{project_id}/files/{file_id}"}
        record["files"].append(entry)
        record["sourceAnalysis"] = {"status": "stale", "sources": []}
        write_record(record)
    return entry


@app.get("/api/projects/{project_id}/files/{file_id}")
def get_project_file(project_id: str, file_id: str) -> FileResponse:
    record = read_record(project_id)
    entry = next((f for f in record["files"] if f["id"] == file_id), None)
    if entry is None:
        raise HTTPException(404, "Файл не найден")
    return FileResponse(project_path(project_id).parent / entry["id"], filename=entry["name"])


@app.post("/api/projects/{project_id}/analyze-sources")
def analyze_sources(project_id: str) -> dict[str, Any]:
    with PROJECTS_LOCK:
        record = read_record(project_id)
        if not record.get("files"):
            raise HTTPException(422, "Сначала добавьте PDF, DWG, DXF или изображение")
        try:
            record["sourceAnalysis"] = analyze_project_sources(record)
        except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            raise HTTPException(422, str(error)) from error
        write_record(record)
    return record["sourceAnalysis"]


def derived_asset_path(record: dict[str, Any], asset_name: str) -> Path:
    analysis = record.get("sourceAnalysis", {})
    allowed = {
        Path(page.get("thumbnailUrl", "")).name
        for source in analysis.get("sources", [])
        for page in source.get("pages", [])
    }
    allowed.update(
        Path(region.get("thumbnailUrl", "")).name
        for source in analysis.get("sources", [])
        for region in source.get("regions", [])
    )
    working = record.get("workingSource", {})
    if working.get("derivedAsset"):
        allowed.add(working["derivedAsset"])
    if asset_name not in allowed:
        raise HTTPException(404, "Подложка не найдена")
    return project_path(record["id"]).parent / asset_name


@app.get("/api/projects/{project_id}/derived/{asset_name}")
def get_derived_asset(project_id: str, asset_name: str) -> FileResponse:
    record = read_record(project_id)
    target = derived_asset_path(record, asset_name)
    if not target.is_file():
        raise HTTPException(404, "Подложка не найдена")
    media_type = "image/svg+xml" if target.suffix.lower() == ".svg" else "image/png"
    return FileResponse(target, media_type=media_type)


@app.post("/api/projects/{project_id}/activate-source")
def activate_project_source(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    file_id = str(payload.get("fileId", ""))
    with PROJECTS_LOCK:
        record = read_record(project_id)
        analysis = record.get("sourceAnalysis", {})
        if analysis.get("status") != "ready":
            raise HTTPException(422, "Сначала нажмите «Преобразовать в рабочий проект»")
        entry = next((item for item in record.get("files", []) if item["id"] == file_id), None)
        if entry is None:
            raise HTTPException(404, "Исходный файл не найден")
        source = project_path(project_id).parent / entry["id"]
        suffix = Path(entry["name"]).suffix.lower()
        working: dict[str, Any] = {"fileId": file_id, "name": entry["name"],
                                   "activatedAt": datetime.now(timezone.utc).isoformat()}
        if suffix == ".pdf":
            try:
                page_number = int(payload.get("page", 0))
            except (TypeError, ValueError) as error:
                raise HTTPException(422, "Выберите страницу из результата анализа") from error
            candidate_source = next((item for item in analysis["sources"] if item["fileId"] == file_id), None)
            page = next((item for item in (candidate_source or {}).get("pages", []) if item["page"] == page_number), None)
            if page is None:
                raise HTTPException(422, "Выберите страницу из результата анализа")
            asset = f"working-{Path(file_id).stem}-p{page_number}.png"
            try:
                render_pdf_page(source, project_path(project_id).parent / asset, page_number)
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                raise HTTPException(422, str(error)) from error
            working.update({"type": "pdf", "page": page_number, "title": page["title"], "derivedAsset": asset,
                            "backgroundImage": f"/api/projects/{project_id}/derived/{asset}"})
            record["project"]["floorPlan"]["backgroundImage"] = working["backgroundImage"]
            record["project"]["floorPlan"]["name"] = page["title"]
            record.pop("cadPreview", None)
        elif suffix in {".dwg", ".dxf"}:
            try:
                document = read_dwg(source.read_bytes()) if suffix == ".dwg" else read_text_dxf(source.read_bytes())
            except (RuntimeError, ValueError) as error:
                raise HTTPException(422, str(error)) from error
            raw_preview = extract_cad_preview(document)
            regions = detect_cad_regions(raw_preview)
            region_id = str(payload.get("regionId", "")).strip() or None
            if len(regions) > 1 and region_id is None:
                raise HTTPException(422, "В DWG найдено несколько схем. Выберите нужную миниатюру.")
            try:
                preview = normalize_cad_preview(raw_preview, record["project"]["floorPlan"], region_id)
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            layouts = [name for name in document.layout_names() if name != "Model"]
            selected = next((region for region in regions if region["id"] == preview.get("selectedRegionId")), None)
            title = selected["title"] if selected else (layouts[0] if layouts else "Модель / CAD-подложка")
            working.update({"type": suffix[1:], "title": title,
                            **({"regionId": selected["id"]} if selected else {})})
            record["cadPreview"] = preview
            record["cadSource"] = entry["name"]
            record["cadLayouts"] = layouts
            record["project"]["floorPlan"].pop("backgroundImage", None)
            record["project"]["floorPlan"]["name"] = working["title"]
        else:
            working.update({"type": "image", "title": "Изображение-подложка",
                            "backgroundImage": entry["url"]})
            record["project"]["floorPlan"]["backgroundImage"] = entry["url"]
            record["project"]["floorPlan"]["name"] = working["title"]
            record.pop("cadPreview", None)
        record["workingSource"] = working
        write_record(record)
    return {"workingSource": working, "record": record}


@app.post("/api/projects/{project_id}/architecture-proposal")
def create_architecture_proposal(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    record = read_record(project_id)
    preview = record.get("cadPreview")
    if not preview:
        raise HTTPException(422, "Сначала выберите DWG или DXF как рабочий план")
    try:
        return propose_architecture(preview, payload)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


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
