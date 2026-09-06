from __future__ import annotations

import io
import json
import math
import os
from pathlib import Path
import tempfile
import uuid
import re
import secrets
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
MAX_DXF_SIZE = 25 * 1024 * 1024
EQUIPMENT_TYPES = {
    "access_point", "controller", "reader", "exit_button", "emergency_release",
    "lock", "door_contact", "door_closer", "power_supply", "battery", "junction_box",
    "intercom_panel", "intercom_monitor", "network_switch", "door",
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
        access_point_code = str(door.get("accessPointCode", "")).strip() or None
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
            "id": item_id, "system": "skud_intercom", "type": item_type, "code": code,
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
        raise HTTPException(status_code=413, detail="Файл больше 25 МБ")

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
    return json.loads(target.read_text(encoding="utf-8"))


def ensure_initial_project() -> None:
    with PROJECTS_LOCK:
        if not project_path("initial").exists():
            project_data = load_project()
            write_record({"id": "initial", "name": project_data["project"]["object"],
                          "project": project_data, "geometry": load_geometry(), "files": []})


@app.get("/api/projects")
def list_projects() -> list[dict]:
    ensure_initial_project()
    with PROJECTS_LOCK:
        records = [json.loads(p.read_text(encoding="utf-8")) for p in PROJECTS_DIR.glob("*/project.json")]
    return sorted([{"id": r["id"], "name": r["name"], "updatedAt": r["updatedAt"]} for r in records],
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
    with PROJECTS_LOCK:
        write_record(record)
    return record


@app.get("/api/projects/{project_id}")
def get_project_record(project_id: str) -> dict:
    return read_record(project_id)


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
            "doors": len(normalized["doors"]), "windows": len(normalized["windows"])}


@app.put("/api/projects/{project_id}/equipment")
def save_project_equipment(project_id: str, payload: dict[str, Any]) -> dict:
    with PROJECTS_LOCK:
        record = read_record(project_id)
        try:
            normalized = validate_equipment(payload.get("equipment"), record["geometry"])
        except (TypeError, ValueError, KeyError, OverflowError) as error:
            raise HTTPException(422, str(error)) from error
        record["project"]["equipment"] = normalized
        write_record(record)
    return {"status": "saved", "count": len(normalized), "equipment": normalized}


@app.post("/api/projects/{project_id}/files", status_code=201)
async def add_project_file(project_id: str, file: UploadFile = File(...)) -> dict:
    read_record(project_id)
    name = Path((file.filename or "file").replace("\\", "/")).name
    suffix = Path(name).suffix.lower()
    if suffix not in {".pdf", ".dwg", ".dxf", ".png", ".jpg", ".jpeg"}:
        raise HTTPException(400, "Поддерживаются PDF, DWG, DXF, PNG и JPG")
    payload = await file.read(MAX_DXF_SIZE + 1)
    if not payload or len(payload) > MAX_DXF_SIZE:
        raise HTTPException(413, "Нужен непустой файл до 25 МБ")
    file_id = uuid.uuid4().hex + suffix
    with PROJECTS_LOCK:
        record = read_record(project_id)
        target = project_path(project_id).parent / file_id
        target.write_bytes(payload)
        entry = {"id": file_id, "name": name, "size": len(payload),
                 "url": f"/api/projects/{project_id}/files/{file_id}"}
        record["files"].append(entry)
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
