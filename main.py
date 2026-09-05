from __future__ import annotations

import io
import json
import math
from pathlib import Path
import tempfile
from typing import Any

import ezdxf
from ezdxf.addons import odafc
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
PROJECT_FILE = BASE_DIR / "data" / "project.json"
GEOMETRY_FILE = BASE_DIR / "data" / "geometry.json"
MAX_DXF_SIZE = 25 * 1024 * 1024
ODA_MACOS_PATHS = (
    Path("/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter"),
    Path("/Applications/ODA File Converter.app/Contents/MacOS/ODAFileConverter"),
)

app = FastAPI(
    title="Редактор плана помещения",
    version="0.2.0",
)


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
        normalized_doors.append({
            "id": door_id,
            "wallId": wall_id,
            "x": round(x, 3), "y": round(y, 3),
            "width": round(max(12.0, min(width, 300.0)), 3),
            "rotation": round(rotation, 6),
            "swing": "right" if door.get("swing") == "right" else "left",
            "openingSide": 1 if door.get("openingSide") == 1 else -1,
            "leafCount": 2 if door.get("leafCount") == 2 else 1,
            "accessPointId": str(access_point_id).strip() if access_point_id not in (None, "") else None,
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

        point = entity.dxf.get("insert") if entity_type == "INSERT" else entity.dxf.get("location")
        if point is None and entity_type == "CIRCLE":
            point = entity.dxf.get("center")
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
async def parse_cad(file: UploadFile = File(...)) -> dict[str, Any]:
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
    return {
        "source": filename,
        "format": suffix.removeprefix("."),
        "equipment": equipment,
        "bounds": calculate_bounds(equipment),
        "summary": {
            "controllers": sum(item["type"] == "controller" for item in equipment),
            "doors": sum(item["type"] == "door" for item in equipment),
        },
    }


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
