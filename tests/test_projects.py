"""Project storage tests use only a temporary directory, never the user's plan."""
import asyncio
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from fastapi import HTTPException, UploadFile


class ProjectsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(main, "PROJECTS_DIR", Path(self.temp.name))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_initial_copy_and_isolation(self):
        original = main.GEOMETRY_FILE.read_bytes()
        self.assertEqual(main.list_projects()[0]["id"], "initial")
        self.assertEqual(main.read_record("initial")["geometry"], json.loads(original))
        a = main.create_project({"name": "Проект А"})
        b = main.create_project({"name": "Проект Б"})
        geometry = copy.deepcopy(a["geometry"])
        geometry["walls"].append({"id": "W1", "type": "wall", "x1": 0, "y1": 0,
                                  "x2": 300, "y2": 0, "thickness": 13})
        main.save_project_geometry(a["id"], geometry)
        self.assertEqual(len(main.read_record(a["id"])["geometry"]["walls"]), 1)
        self.assertEqual(main.read_record(b["id"])["geometry"]["walls"], [])
        main.list_projects()  # Must not re-import/overwrite the first project.
        self.assertEqual(main.GEOMETRY_FILE.read_bytes(), original)
        self.assertEqual(len(main.list_projects()), 3)

    def test_upload_isolation_and_duplicate_names(self):
        a = main.create_project({"name": "А"})
        b = main.create_project({"name": "Б"})
        entries = [asyncio.run(main.add_project_file(a["id"], UploadFile(filename="../../plan.dwg", file=io.BytesIO(b"test-original")))) for _ in range(2)]
        self.assertNotEqual(entries[0]["id"], entries[1]["id"])
        self.assertEqual(entries[0]["name"], "plan.dwg")
        self.assertEqual(Path(main.get_project_file(a["id"], entries[0]["id"]).path).read_bytes(), b"test-original")
        self.assertEqual(main.read_record(b["id"])["files"], [])
        with self.assertRaises(HTTPException):
            main.get_project_file(b["id"], entries[0]["id"])

    def test_reference_sheet_is_project_scoped(self):
        project = main.create_project({"name": "Со справочным листом"})
        target = main.project_path(project["id"]).parent / "reference-door-installation.png"
        target.write_bytes(b"png")
        sheets = main.list_reference_sheets(project["id"])
        self.assertEqual(sheets[0]["id"], "door-installation")
        self.assertEqual(Path(main.get_reference_sheet(project["id"], "door-installation").path), target)
        other = main.create_project({"name": "Без справочного листа"})
        self.assertEqual(main.list_reference_sheets(other["id"]), [])
        with self.assertRaises(HTTPException):
            main.get_reference_sheet(other["id"], "door-installation")

    def test_invalid_requests(self):
        for name in ["", " "*4, "x"*121, None]:
            with self.assertRaises(HTTPException):
                main.create_project({"name": name})
        with self.assertRaises(HTTPException):
            main.read_record("../../geometry")
        a = main.create_project({"name": "А"})
        before = main.read_record(a["id"])
        with self.assertRaises(HTTPException):
            main.save_project_geometry(a["id"], {"walls": "invalid"})
        self.assertEqual(main.read_record(a["id"]), before)

    def test_equipment_is_saved_per_project_and_validated(self):
        a = main.create_project({"name": "СКУД А"})
        b = main.create_project({"name": "СКУД Б"})
        geometry = copy.deepcopy(a["geometry"])
        geometry["walls"] = [{"id": "W1", "type": "wall", "x1": 0, "y1": 0,
                              "x2": 300, "y2": 0, "thickness": 13}]
        geometry["doors"] = [{"id": "D1", "wallId": "W1", "x": 100, "y": 0,
                              "width": 48, "rotation": 0, "swing": "left", "leafCount": 1,
                              "accessPointCode": "ТД.1.1"}]
        main.save_project_geometry(a["id"], geometry)
        self.assertEqual(main.read_record(a["id"])["geometry"]["doors"][0]["accessPointCode"], "ТД.1.1")
        item = {"id": "EQ-001", "type": "reader", "code": "BGV.1", "x": 110, "y": 8,
                "mount": "wall", "mountingHeight": 1200, "hostDoorId": "D1", "hostWallId": "W1"}
        saved = main.save_project_equipment(a["id"], {"equipment": [item]})
        self.assertEqual(saved["equipment"][0]["status"], "proposed")
        mounted = {**item, "doorMount": {"side": -1, "surface": "wall", "offset": 35},
                   "templateSource": "СБСТ-2026-03-Р-СКУД, лист 6"}
        main.save_project_equipment(a["id"], {"equipment": [mounted]})
        self.assertEqual(main.read_record(a["id"])["project"]["equipment"][0]["doorMount"], mounted["doorMount"])
        self.assertEqual(main.read_record(a["id"])["project"]["equipment"][0]["templateSource"], mounted["templateSource"])
        with self.assertRaises(ValueError):
            main.validate_equipment([{**mounted, "doorMount": {"side": 0, "surface": "wall", "offset": 35}}], geometry)
        self.assertEqual(main.read_record(b["id"])["project"]["equipment"], [])
        with self.assertRaises(HTTPException):
            main.save_project_equipment(a["id"], {"equipment": [item, {**item, "id": "EQ-002"}]})
        with self.assertRaises(HTTPException):
            main.save_project_equipment(a["id"], {"equipment": [{**item, "hostDoorId": "missing"}]})
        duplicate = copy.deepcopy(geometry)
        duplicate["doors"].append({**duplicate["doors"][0], "id": "D2", "x": 180})
        with self.assertRaises(ValueError):
            main.validate_geometry(duplicate)

    def test_cad_result_survives_reopen(self):
        a = main.create_project({"name": "CAD"})
        document = main.ezdxf.new()
        document.modelspace().add_circle((10, 20), 2, dxfattribs={"layer": "controller"})
        document.modelspace().add_line((0, 0), (100, 0), dxfattribs={"layer": "План"})
        output = io.StringIO()
        document.write(output)
        result = asyncio.run(main.parse_cad(UploadFile(filename="test.dxf", file=io.BytesIO(output.getvalue().encode())), a["id"]))
        self.assertEqual(result["summary"]["controllers"], 1)
        self.assertEqual(result["preview"]["paths"], 2)
        self.assertEqual(result["layouts"], ["Layout1"])
        self.assertIn("План", result["preview"]["layers"])
        self.assertEqual(len(main.read_record(a["id"])["project"]["equipment"]), 1)
        self.assertEqual(len(main.read_record(a["id"])["cadPreview"]["paths"]), 2)
        self.assertEqual(main.read_record("initial")["project"], main.load_project())

    def test_controller_capacity_and_din_mounting(self):
        project = main.create_project({"name": "Контроллеры"})
        geometry = copy.deepcopy(project["geometry"])
        geometry["walls"] = [{"id": "W1", "type": "wall", "x1": 0, "y1": 0,
                              "x2": 400, "y2": 0, "thickness": 13}]
        geometry["doors"] = [
            {"id": "D1", "wallId": "W1", "x": 100, "y": 0, "width": 48,
             "rotation": 0, "swing": "left", "leafCount": 1, "readerCount": 2,
             "accessPointCode": "ТД.1.1"},
            {"id": "D2", "wallId": "W1", "x": 200, "y": 0, "width": 48,
             "rotation": 0, "swing": "right", "leafCount": 1, "readerCount": 1,
             "accessPointCode": "ТД.1.2"},
        ]
        geometry = main.validate_geometry(geometry)
        controller = {"id": "EQ-C1", "type": "controller", "code": "AR.1", "x": 20,
                      "y": 10, "mount": "ceiling", "mountingHeight": 2800,
                      "formFactor": "din_rail", "controllerDoorCapacity": 2,
                      "controllerReaderCapacity": 3, "servedDoorIds": ["D1", "D2"]}
        saved = main.validate_equipment([controller], geometry)[0]
        self.assertEqual(saved["formFactor"], "din_rail")
        self.assertEqual(saved["mount"], "ceiling")
        self.assertEqual(saved["servedDoorIds"], ["D1", "D2"])
        with self.assertRaises(ValueError):
            main.validate_equipment([{**controller, "controllerReaderCapacity": 2}], geometry)
        with self.assertRaises(ValueError):
            main.validate_equipment([controller, {**controller, "id": "EQ-C2", "code": "AR.2"}], geometry)


if __name__ == "__main__":
    unittest.main()
