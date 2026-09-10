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

    def test_projects_can_be_archived_restored_and_deleted_from_archive(self):
        project = main.create_project({"name": "Архивируемый"})
        self.assertIn(project["id"], {item["id"] for item in main.list_projects()})
        main.archive_project(project["id"], {"archived": True})
        self.assertNotIn(project["id"], {item["id"] for item in main.list_projects()})
        self.assertIn(project["id"], {item["id"] for item in main.list_projects(archived=True)})
        main.archive_project(project["id"], {"archived": False})
        with self.assertRaises(HTTPException):
            main.delete_project(project["id"])
        main.archive_project(project["id"], {"archived": True})
        deleted = main.delete_project(project["id"])
        self.assertEqual(deleted["status"], "deleted")
        self.assertFalse(main.project_path(project["id"]).exists())

    def test_image_source_can_be_converted_to_working_background(self):
        project = main.create_project({"name": "Подложка"})
        entry = asyncio.run(main.add_project_file(project["id"], UploadFile(filename="plan.png", file=io.BytesIO(b"png"))))
        analysis = main.analyze_sources(project["id"])
        self.assertEqual(analysis["sources"][0]["candidates"][0]["title"], "Изображение-подложка")
        activated = main.activate_project_source(project["id"], {"fileId": entry["id"]})
        self.assertEqual(activated["workingSource"]["type"], "image")
        self.assertEqual(activated["record"]["project"]["floorPlan"]["backgroundImage"], entry["url"])
        self.assertEqual(activated["record"]["geometry"]["walls"], [])

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

    def test_partition_height_and_material_bands_are_normalized(self):
        geometry = {"version": 2, "canvas": {"width": 400, "height": 300},
                    "walls": [{"id": "P1", "type": "partition", "x1": 0, "y1": 0,
                               "x2": 300, "y2": 0, "thickness": 7, "topMode": "ceiling",
                               "heightMm": 2400, "materialBands": [
                                   {"fromMm": 1200, "toMm": 2400, "material": "Стеклоблок"},
                                   {"fromMm": 0, "toMm": 1200, "material": "Газоблок"},
                               ]}], "doors": [], "windows": []}
        saved = main.validate_geometry(geometry)
        self.assertEqual(saved["version"], 3)
        self.assertEqual(saved["walls"][0]["topMode"], "ceiling")
        self.assertEqual(saved["walls"][0]["heightMm"], 2400)
        self.assertEqual([band["material"] for band in saved["walls"][0]["materialBands"]],
                         ["Газоблок", "Стеклоблок"])
        invalid = copy.deepcopy(geometry)
        invalid["walls"][0]["materialBands"][0]["fromMm"] = 1100
        with self.assertRaises(ValueError):
            main.validate_geometry(invalid)
        invalid = copy.deepcopy(geometry)
        invalid["walls"][0]["topMode"] = "roof"
        with self.assertRaises(ValueError):
            main.validate_geometry(invalid)

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

    def test_architectural_door_can_be_saved_without_access_point(self):
        project = main.create_project({"name": "Архитектурный план"})
        geometry = copy.deepcopy(project["geometry"])
        geometry["walls"] = [{"id": "W1", "type": "wall", "x1": 0, "y1": 0,
                              "x2": 300, "y2": 0, "thickness": 13}]
        geometry["doors"] = [{"id": "D1", "wallId": "W1", "x": 100, "y": 0,
                              "width": 48, "rotation": 0, "swing": "left",
                              "leafCount": 1, "accessPointCode": None}]
        main.save_project_geometry(project["id"], geometry)
        saved_geometry = main.read_record(project["id"])["geometry"]
        self.assertIsNone(saved_geometry["doors"][0]["accessPointCode"])
        self.assertEqual(main.read_record(project["id"])["project"]["equipment"], [])

    def test_access_points_are_separate_from_architectural_doors(self):
        project = main.create_project({"name": "Точки прохода"})
        geometry = copy.deepcopy(project["geometry"])
        geometry["walls"] = [{"id": "W1", "type": "wall", "x1": 0, "y1": 0,
                              "x2": 300, "y2": 0, "thickness": 13}]
        geometry["doors"] = [{"id": "D1", "wallId": "W1", "x": 100, "y": 0,
                              "width": 48, "rotation": 0, "swing": "left",
                              "leafCount": 1, "readerCount": 1, "accessPointCode": None}]
        main.save_project_geometry(project["id"], geometry)
        access_points = [{"id": "AP-D1", "code": "ТД.1.1", "doorId": "D1",
                          "readerCount": 2, "corridorSide": -1}]
        equipment = [{"id": "EQ-001", "type": "reader", "code": "YK1.1", "x": 100,
                      "y": 8, "mount": "wall", "mountingHeight": 1200,
                      "accessPointId": "AP-D1", "hostDoorId": "D1", "hostWallId": "W1",
                      "doorMount": {"side": -1, "surface": "wall", "offset": 35}}]
        saved = main.save_project_equipment(project["id"], {"accessPoints": access_points,
                                                            "equipment": equipment})
        self.assertEqual(saved["accessPoints"][0]["code"], "ТД.1.1")
        self.assertEqual(saved["accessPoints"][0]["doorId"], "D1")
        self.assertEqual(saved["accessPoints"][0]["readerCount"], 2)
        reopened = main.read_record(project["id"])
        self.assertEqual(reopened["project"]["accessPoints"], saved["accessPoints"])
        self.assertEqual(reopened["project"]["equipment"], saved["equipment"])
        self.assertEqual(reopened["project"]["equipment"][0]["accessPointId"], "AP-D1")
        self.assertEqual(reopened["project"]["equipment"][0]["doorMount"], equipment[0]["doorMount"])
        self.assertIsNone(reopened["geometry"]["doors"][0]["accessPointCode"])
        with self.assertRaises(ValueError):
            main.validate_access_points([{**access_points[0], "id": "AP-D2", "code": "bad"}], geometry)
        with self.assertRaises(ValueError):
            main.validate_equipment([{**equipment[0], "accessPointId": "AP-MISSING"}], geometry, saved["accessPoints"])
        with self.assertRaises(ValueError):
            main.validate_equipment([{**equipment[0], "hostDoorId": None}], geometry, saved["accessPoints"])
        overloaded = {"id": "EQ-C1", "type": "controller", "code": "AR.1", "x": 20,
                      "y": 10, "mount": "wall", "mountingHeight": 2200,
                      "controllerDoorCapacity": 1, "controllerReaderCapacity": 1,
                      "servedDoorIds": ["D1"]}
        with self.assertRaises(ValueError):
            main.validate_equipment([overloaded], geometry, saved["accessPoints"])

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
        initial_project = main.read_record("initial")["project"]
        self.assertEqual(initial_project["floorPlan"], main.load_project()["floorPlan"])
        self.assertEqual(initial_project["equipment"], main.load_project()["equipment"])
        self.assertEqual(initial_project["accessPoints"], [])

    def test_cad_preview_prioritizes_architecture_and_proposes_only_selected_area(self):
        document = main.ezdxf.new()
        document.layers.add("Wall")
        document.layers.add("Размеры")
        model = document.modelspace()
        model.add_line((0, 0), (100, 0), dxfattribs={"layer": "Wall"})
        model.add_line((0, 40), (100, 40), dxfattribs={"layer": "Wall"})
        model.add_linear_dim(base=(0, 20), p1=(0, 0), p2=(100, 0), dxfattribs={"layer": "Размеры"}).render()
        preview = main.extract_cad_preview(document, limit=2)
        self.assertEqual(len(preview["paths"]), 2)
        self.assertTrue(all(path["layer"] == "Wall" for path in preview["paths"]))
        self.assertTrue(all(path["category"] == "architecture" for path in preview["paths"]))
        self.assertEqual(main.classify_cad_layer("03. Размеры"), "annotation")
        proposal = main.propose_architecture(preview, {
            "bounds": {"minX": 20, "minY": -5, "maxX": 80, "maxY": 10},
            "layers": ["Wall"], "minimumLength": 5,
        })
        self.assertEqual(len(proposal["walls"]), 1)
        self.assertEqual(proposal["walls"][0]["x1"], 20)
        self.assertEqual(proposal["walls"][0]["x2"], 80)
        self.assertEqual(proposal["doors"], [])
        self.assertIn("Проёмы пока", proposal["note"])

    def test_cad_preview_lists_regions_and_focuses_only_selected_one(self):
        main_paths = []
        for index in range(12):
            x = index * 10
            main_paths.extend([
                {"layer": "Wall", "category": "architecture", "entityType": "LINE",
                 "points": [[x, 0], [x + 10, 0]], "closed": False},
                {"layer": "Wall", "category": "architecture", "entityType": "LINE",
                 "points": [[x, 60], [x + 10, 60]], "closed": False},
            ])
        main_paths.extend([
            {"layer": "Wall", "category": "architecture", "entityType": "LINE",
             "points": [[0, 0], [0, 60]], "closed": False},
            {"layer": "Wall", "category": "architecture", "entityType": "LINE",
             "points": [[120, 0], [120, 60]], "closed": False},
        ])
        clutter = []
        for index in range(40):
            clutter.extend([
                {"layer": "Wall", "category": "architecture", "entityType": "LINE",
                 "points": [[1000 + index, 1000], [1001 + index, 1000]], "closed": False},
                {"layer": "Wall", "category": "architecture", "entityType": "LINE",
                 "points": [[1000 + index, 1010], [1001 + index, 1010]], "closed": False},
            ])
        clutter.extend([
            {"layer": "Wall", "category": "architecture", "entityType": "LINE",
             "points": [[1000, 1000], [1000, 1010]], "closed": False},
            {"layer": "Wall", "category": "architecture", "entityType": "LINE",
             "points": [[1040, 1000], [1040, 1010]], "closed": False},
        ])
        preview = {"paths": main_paths + clutter,
                   "labels": [{"layer": "0", "text": "Кухня", "x": 20, "y": 20, "height": 3, "rotation": 0},
                              {"layer": "0", "text": "Коридор", "x": 70, "y": 20, "height": 3, "rotation": 0}],
                   "layers": ["0", "Wall"], "layerStats": [], "truncated": False,
                   "bounds": {"minX": 0, "minY": 0, "maxX": 1040, "maxY": 1010}}
        regions = main.detect_cad_regions(preview)
        self.assertEqual(len(regions), 2)
        self.assertEqual(sum(region["recommended"] for region in regions), 1)
        overview = main.focus_cad_preview(preview)
        self.assertNotIn("selectedRegionId", overview)
        self.assertEqual(len(overview["regions"]), 2)
        selected = next(region for region in regions if region["recommended"])
        focused = main.focus_cad_preview(preview, selected["id"])
        self.assertEqual(focused["selectedRegionId"], selected["id"])
        self.assertEqual(focused["focus"]["roomHints"], 2)
        self.assertTrue(all(path["points"][0][0] < 500 for path in focused["paths"]))

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
        power_supply = {"id": "EQ-BP1", "type": "power_supply", "code": "БП.1", "x": 30,
                        "y": 10, "mount": "wall", "mountingHeight": 2200,
                        "servedControllerId": "EQ-C1"}
        linked = main.validate_equipment([controller, power_supply], geometry)
        self.assertEqual(linked[1]["servedControllerId"], "EQ-C1")
        with self.assertRaises(ValueError):
            main.validate_equipment([{**power_supply, "servedControllerId": "MISSING"}], geometry)
        with self.assertRaises(ValueError):
            main.validate_equipment([{**controller, "controllerReaderCapacity": 2}], geometry)
        with self.assertRaises(ValueError):
            main.validate_equipment([controller, {**controller, "id": "EQ-C2", "code": "AR.2"}], geometry)

    def test_ceiling_zone_is_validated_and_persisted(self):
        project = main.create_project({"name": "Потолки"})
        geometry = copy.deepcopy(project["geometry"])
        geometry["ceilingZones"] = [{"id": "CZ-001", "x": 20, "y": 30,
                                     "width": 240, "height": 180,
                                     "heightMm": 2750, "type": "suspended"}]
        saved = main.save_project_geometry(project["id"], geometry)["geometry"]
        self.assertEqual(saved["ceilingZones"][0]["heightMm"], 2750)
        self.assertEqual(saved["ceilingZones"][0]["type"], "suspended")
        self.assertEqual(len(saved["ceilingZones"][0]["points"]), 4)
        self.assertEqual(main.read_record(project["id"])["geometry"]["ceilingZones"], saved["ceilingZones"])
        polygon = copy.deepcopy(geometry)
        polygon["ceilingZones"][0]["points"] = [
            {"x": 20, "y": 30}, {"x": 260, "y": 30}, {"x": 220, "y": 120},
            {"x": 260, "y": 210}, {"x": 20, "y": 210},
        ]
        normalized = main.validate_geometry(polygon)["ceilingZones"][0]
        self.assertEqual(len(normalized["points"]), 5)
        self.assertEqual(normalized["width"], 240)
        invalid = copy.deepcopy(geometry)
        invalid["ceilingZones"][0]["type"] = "sloped"
        with self.assertRaises(ValueError):
            main.validate_geometry(invalid)

    def test_ceiling_cameras_preserve_mount_and_view_parameters(self):
        geometry = {"walls": [], "doors": [], "windows": [], "columns": [], "ceilingZones": []}
        cameras = [
            {"id": "CAM-1", "type": "camera_ceiling", "code": "КМ.1", "x": 100, "y": 120,
             "rotation": 0.785398, "mount": "ceiling", "mountingHeight": 2700,
             "viewAngleDeg": 100, "viewRange": 480, "blindZone": 65, "status": "proposed"},
            {"id": "CAM-2", "type": "camera_ceiling_bracket", "code": "КК.1", "x": 300, "y": 320,
             "rotation": 1.570796, "mount": "ceiling", "mountingHeight": 2500,
             "viewAngleDeg": 70, "viewRange": 600, "bracketLengthMm": 350, "status": "confirmed"},
        ]
        saved = main.validate_equipment(cameras, geometry)
        self.assertEqual(saved[0]["system"], "cctv")
        self.assertEqual(saved[0]["bracketLengthMm"], 0)
        self.assertEqual(saved[0]["blindZone"], 65)
        self.assertEqual(saved[1]["bracketLengthMm"], 350)
        self.assertEqual(saved[1]["viewAngleDeg"], 70)


if __name__ == "__main__":
    unittest.main()
