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

    def test_upload_isolation_and_identical_source_deduplication(self):
        a = main.create_project({"name": "А"})
        b = main.create_project({"name": "Б"})
        entries = [asyncio.run(main.add_project_file(a["id"], UploadFile(filename="../../plan.dwg", file=io.BytesIO(b"test-original")))) for _ in range(2)]
        self.assertEqual(entries[0]["id"], entries[1]["id"])
        self.assertEqual(len(main.read_record(a["id"])["files"]), 1)
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

    def test_archive_restore_and_permanent_delete(self):
        project = main.create_project({"name": "Временный объект"})
        archived = main.set_project_archived(project["id"], {"archived": True})
        self.assertTrue(archived["archived"])
        self.assertTrue(next(item for item in main.list_projects() if item["id"] == project["id"])["archived"])
        with self.assertRaises(HTTPException):
            main.delete_project(project["id"], {"confirmName": "Неверное название"})
        restored = main.set_project_archived(project["id"], {"archived": False})
        self.assertFalse(restored["archived"])
        with self.assertRaises(HTTPException):
            main.delete_project(project["id"], {"confirmName": "Временный объект"})
        main.set_project_archived(project["id"], {"archived": True})
        result = main.delete_project(project["id"], {"confirmName": "Временный объект"})
        self.assertEqual(result["status"], "deleted")
        self.assertFalse(main.project_path(project["id"]).parent.exists())

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
        inferred = copy.deepcopy(geometry)
        inferred["doors"] = [{**geometry["doors"][0], "swing": "unknown",
                              "accessPointCode": None, "confidence": "cad_wall_gap",
                              "reviewHint": "confirm_hinge_and_opening_side"}]
        normalized = main.validate_geometry(inferred)["doors"][0]
        self.assertEqual(normalized["swing"], "unknown")
        self.assertIsNone(normalized["accessPointCode"])
        self.assertEqual(normalized["confidence"], "cad_wall_gap")
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
        saved = main.read_record(a["id"])
        self.assertEqual(saved["project"]["equipment"], [])
        self.assertEqual(len(saved["cadPreview"]["paths"]), 2)
        self.assertEqual(len(saved["recognition_runs"]), 1)
        self.assertTrue(any(item["entity_type"] == "equipment" for item in saved["proposals"]))
        self.assertEqual(main.read_record("initial")["project"], main.load_project())

    def test_cad_wall_faces_become_one_centerline(self):
        walls = [
            {"id": "W-A", "type": "wall", "x1": 0, "y1": 0, "x2": 4000, "y2": 0,
             "thickness": 180, "layer": "A-WALL"},
            {"id": "W-B", "type": "wall", "x1": 0, "y1": 200, "x2": 4000, "y2": 200,
             "thickness": 180, "layer": "A-WALL"},
            {"id": "CAP-1", "type": "wall", "x1": 0, "y1": 0, "x2": 0, "y2": 200,
             "thickness": 180, "layer": "A-WALL"},
            {"id": "CAP-2", "type": "wall", "x1": 4000, "y1": 0, "x2": 4000, "y2": 200,
             "thickness": 180, "layer": "A-WALL"},
            {"id": "P-A", "type": "partition", "x1": 5000, "y1": 0, "x2": 7000, "y2": 0,
             "thickness": 120, "layer": "I-WALL"},
            {"id": "P-B", "type": "partition", "x1": 5000, "y1": 120, "x2": 7000, "y2": 120,
             "thickness": 120, "layer": "I-WALL"},
        ]
        collapsed, pairs, caps = main.collapse_wall_face_pairs(walls)
        self.assertEqual((pairs, caps), (2, 2))
        self.assertEqual(len(collapsed), 2)
        self.assertEqual([wall["type"] for wall in collapsed], ["wall", "partition"])
        self.assertEqual([collapsed[0]["y1"], collapsed[0]["y2"]], [100, 100])
        self.assertEqual([collapsed[1]["y1"], collapsed[1]["y2"]], [60, 60])
        self.assertTrue(all(wall["id"].endswith("-CL") for wall in collapsed))

        # A third competing face is ambiguous: mutual-best matching may merge
        # only the unambiguous closest pair, never all three into two walls.
        ambiguous = walls[:2] + [{**walls[1], "id": "W-C", "y1": -200, "y2": -200}]
        collapsed, pairs, _ = main.collapse_wall_face_pairs(ambiguous)
        self.assertEqual(pairs, 1)
        self.assertEqual(len(collapsed), 2)

    def test_reparse_keeps_selected_model_area_on_canvas(self):
        project = main.create_project({"name": "Повторный импорт"})
        record = main.read_record(project["id"])
        record["cadSelectedLayout"] = "Model · область 1"
        record["cadAppliedLayout"] = "Model · область 1"
        main.write_record(record)
        document = main.ezdxf.new()
        document.modelspace().add_line((0, 0), (1000, 0), dxfattribs={"layer": "A-WALL"})
        document.modelspace().add_line((5000, 0), (6000, 0), dxfattribs={"layer": "A-WALL"})
        output = io.StringIO()
        document.write(output)
        area = {"name": "Model · область 1",
                "bounds": {"minX": 70, "minY": 1770, "maxX": 570, "maxY": 1790},
                "pathIndexes": [0]}
        with patch.object(main, "detect_cad_areas", return_value=[area]):
            asyncio.run(main.parse_cad(UploadFile(filename="repeat.dxf",
                                                  file=io.BytesIO(output.getvalue().encode())), project["id"]))
        saved = main.read_record(project["id"])
        self.assertEqual(saved["cadAppliedLayout"], "Model · область 1")
        self.assertEqual(saved["project"]["floorPlan"]["name"], "Model · область 1")
        self.assertEqual(len(saved["cadPreview"]["paths"]), 1)
        self.assertEqual(len(saved["cadPreviewMaster"]["paths"]), 2)

    def test_door_block_on_layer_zero_becomes_neutral_opening(self):
        document = main.ezdxf.new()
        document.modelspace().add_line((0, 0), (1000, 0), dxfattribs={"layer": "A-WALL"})
        document.blocks.new("Door 1000")
        document.modelspace().add_blockref("Door 1000", (500, 0), dxfattribs={"layer": "0"})
        geometry = main.extract_cad_geometry(document)
        self.assertEqual(len(geometry["doors"]), 1)
        self.assertEqual(geometry["doors"][0]["swing"], "unknown")
        self.assertEqual(geometry["doors"][0]["wallId"], geometry["walls"][0]["id"])

    def test_architecture_and_system_rules_are_project_agnostic(self):
        self.assertEqual(main.classify_architecture_layer("АР_Стены несущие"), "wall")
        self.assertEqual(main.classify_architecture_layer("Interior-Wall"), "partition")
        self.assertEqual(main.classify_architecture_layer("I-WALL"), "partition")
        self.assertIsNone(main.classify_architecture_layer("CCTV-CABLE"))
        self.assertEqual(main.classify_entity("СОТ-Камеры", "CAM-01"), "camera")
        self.assertEqual(main.classify_entity("СКС", "RJ45 outlet"), "data_outlet")
        self.assertEqual(main.classify_entity("0", "Wi-Fi AP"), "wifi_access_point")
        blank = main.ezdxf.new()
        blank.modelspace().add_line((0, 0), (100, 0), dxfattribs={"layer": "Unknown-Lines"})
        geometry = main.extract_cad_geometry(blank)
        self.assertEqual(geometry["walls"], [])
        self.assertEqual(geometry["metadata"]["architectureMode"], "manual_blank")
        item = {"id": "CAM-01", "type": "camera", "x": 10, "y": 20,
                "mount": "wall", "mountingHeight": 3000}
        saved = main.validate_equipment([item], {"walls": [], "doors": []})[0]
        self.assertEqual(saved["system"], "cctv")

    def test_selecting_model_area_creates_staging_without_replacing_working_model(self):
        project = main.create_project({"name": "Выбор листа"})
        record = main.read_record(project["id"])
        record["cadPreview"] = {
            "paths": [
                {"layer": "A-WALL", "points": [[70, 1780], [570, 1780]], "closed": False},
                {"layer": "A-WALL", "points": [[1570, 780], [2070, 780]], "closed": False},
            ],
            "labels": [], "layers": ["A-WALL"],
            "bounds": {"minX": 70, "minY": 70, "maxX": 2070, "maxY": 1780},
            "sourceBounds": {"minX": 0, "minY": 0, "maxX": 200, "maxY": 171},
            "transform": {"scale": 10, "padding": 70}, "truncated": False,
        }
        record["geometry"] = {
            "version": 2, "canvas": {"width": 2650, "height": 1850},
            "walls": [
                {"id": "W1", "type": "wall", "x1": 70, "y1": 1780, "x2": 570, "y2": 1780, "thickness": 10},
                {"id": "W2", "type": "wall", "x1": 1570, "y1": 780, "x2": 2070, "y2": 780, "thickness": 10},
            ],
            "doors": [], "windows": [],
        }
        record["cadEquipmentMaster"] = [
            {"id": "D-01", "type": "door", "x": 25, "y": 0, "status": "not_configured"},
            {"id": "D-02", "type": "door", "x": 175, "y": 100, "status": "not_configured"},
        ]
        record["cadAreas"] = [
            {"name": "Model · область 1", "bounds": {"minX": 70, "minY": 1770, "maxX": 570, "maxY": 1790}, "pathIndexes": [0]},
            {"name": "Model · область 2", "bounds": {"minX": 1570, "minY": 770, "maxX": 2070, "maxY": 790}, "pathIndexes": [1]},
        ]
        record["cadLayouts"] = [area["name"] for area in record["cadAreas"]]
        record["cadSource"] = "source.dwg"
        record["files"] = [{"id": "source.dwg", "source_file_id": "source.dwg",
                            "name": "source.dwg", "size": 1,
                            "url": f"/api/projects/{project['id']}/files/source.dwg"}]
        main.write_record(record)

        result = main.select_cad_layout(project["id"], {"layout": "Model · область 1"})
        saved = main.read_record(project["id"])
        self.assertEqual(result["layout"], "Model · область 1")
        self.assertEqual(result["summary"]["walls"], 1)
        self.assertEqual([wall["id"] for wall in saved["geometry"]["walls"]], ["W1", "W2"])
        self.assertEqual(saved["project"]["equipment"], [])
        self.assertEqual([wall["id"] for wall in result["staging"]["geometry"]["walls"]], ["W1"])
        self.assertEqual([item["id"] for item in result["staging"]["equipment"]], ["D-01"])
        self.assertEqual(len(saved["cadPreview"]["paths"]), 1)
        self.assertEqual(len(saved["cadPreviewMaster"]["paths"]), 2)

    def test_door_sample_creates_persisted_candidates_and_requires_explicit_acceptance(self):
        project = main.create_project({"name": "Обучение дверям"})
        record = main.read_record(project["id"])
        record["geometry"]["walls"] = [
            {"id": "W1", "type": "wall", "x1": 0, "y1": 100,
             "x2": 260, "y2": 100, "thickness": 13},
        ]
        record["cadPreview"] = {
            "paths": [
                {"layer": "DOOR", "points": [[40, 100], [72, 68]], "closed": False},
                {"layer": "DOOR", "points": [[150, 100], [182, 68]], "closed": False},
            ],
            "labels": [], "layers": ["DOOR"], "truncated": False,
        }
        record["cadSelectedLayout"] = "Этаж 1"
        main.write_record(record)

        before = copy.deepcopy(main.read_record(project["id"])["geometry"])
        result = main.create_door_pattern(project["id"], {
            "leaf_count": 1,
            "bounds": {"minX": 30, "minY": 55, "maxX": 82, "maxY": 110},
        })
        self.assertEqual(result["run"]["candidate_count"], 2)
        self.assertEqual(main.read_record(project["id"])["geometry"], before)
        latest = main.latest_door_detection_run(project["id"])
        self.assertEqual(latest["run"]["run_id"], result["run"]["run_id"])

        accepted = main.decide_door_detection_run(
            project["id"], result["run"]["run_id"],
            {"decision": "accepted", "expected_model_version": 0})
        self.assertEqual(accepted["accepted_count"], 2)
        self.assertEqual(len(accepted["geometry"]["doors"]), 2)
        self.assertTrue(all(door["leafCount"] == 1 for door in accepted["geometry"]["doors"]))
        self.assertTrue(all(door["swing"] == "unknown" for door in accepted["geometry"]["doors"]))
        self.assertEqual(main.latest_door_detection_run(project["id"])["undo_run"]["run_id"],
                         result["run"]["run_id"])

        reverted = main.undo_door_detection_run(
            project["id"], result["run"]["run_id"],
            {"expected_model_version": accepted["model_version"]})
        self.assertEqual(reverted["removed_count"], 2)
        self.assertEqual(reverted["restored_count"], 0)
        self.assertEqual(reverted["geometry"], before)
        self.assertIsNone(main.latest_door_detection_run(project["id"])["undo_run"])

    def test_door_detection_undo_refuses_to_remove_a_manually_changed_door(self):
        project = main.create_project({"name": "Защищённая отмена дверей"})
        record = main.read_record(project["id"])
        record["geometry"]["walls"] = [
            {"id": "W1", "type": "wall", "x1": 0, "y1": 100,
             "x2": 260, "y2": 100, "thickness": 13},
        ]
        record["cadPreview"] = {
            "paths": [
                {"layer": "DOOR", "points": [[40, 100], [72, 68]], "closed": False},
                {"layer": "DOOR", "points": [[150, 100], [182, 68]], "closed": False},
            ],
            "labels": [], "layers": ["DOOR"], "truncated": False,
        }
        record["cadSelectedLayout"] = "Этаж 1"
        main.write_record(record)
        run = main.create_door_pattern(project["id"], {
            "leaf_count": 1,
            "bounds": {"minX": 30, "minY": 55, "maxX": 82, "maxY": 110},
        })["run"]
        accepted = main.decide_door_detection_run(
            project["id"], run["run_id"],
            {"decision": "accepted", "expected_model_version": 0})
        changed = main.read_record(project["id"])
        changed["geometry"]["doors"][0]["swing"] = "left"
        main.write_record(changed)

        with self.assertRaises(HTTPException) as raised:
            main.undo_door_detection_run(
                project["id"], run["run_id"],
                {"expected_model_version": accepted["model_version"]})
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(len(main.read_record(project["id"])["geometry"]["doors"]), 2)

    def test_legacy_create_only_door_run_can_be_undone_safely(self):
        project = main.create_project({"name": "Старая партия дверей"})
        record = main.read_record(project["id"])
        record["geometry"]["walls"] = [
            {"id": "W1", "type": "wall", "x1": 0, "y1": 100,
             "x2": 260, "y2": 100, "thickness": 13},
        ]
        record["cadPreview"] = {
            "paths": [{"layer": "DOOR", "points": [[40, 100], [72, 68]], "closed": False}],
            "labels": [], "layers": ["DOOR"], "truncated": False,
        }
        record["cadSelectedLayout"] = "Этаж 1"
        main.write_record(record)
        run = main.create_door_pattern(project["id"], {
            "leaf_count": 1,
            "bounds": {"minX": 30, "minY": 55, "maxX": 82, "maxY": 110},
        })["run"]
        accepted = main.decide_door_detection_run(
            project["id"], run["run_id"],
            {"decision": "accepted", "expected_model_version": 0})
        legacy = main.read_record(project["id"])
        legacy["door_detection_runs"][-1].pop("rollback")
        main.write_record(legacy)

        self.assertEqual(main.latest_door_detection_run(project["id"])["undo_run"]["run_id"],
                         run["run_id"])
        reverted = main.undo_door_detection_run(
            project["id"], run["run_id"],
            {"expected_model_version": accepted["model_version"]})
        self.assertEqual(reverted["removed_count"], 1)
        self.assertEqual(reverted["geometry"]["doors"], [])

    def test_door_sample_matches_shape_not_only_layer_and_length(self):
        project = main.create_project({"name": "Дверной шаблон"})
        record = main.read_record(project["id"])
        record["geometry"]["walls"] = [
            {"id": "W1", "type": "wall", "x1": 0, "y1": 100,
             "x2": 320, "y2": 100, "thickness": 13},
        ]
        record["cadPreview"] = {
            "paths": [
                # Selected shallow door leaf and a repeated leaf.
                {"layer": "PLAN", "points": [[40, 100], [70, 94]], "closed": False},
                {"layer": "PLAN", "points": [[150, 100], [180, 93]], "closed": False},
                # Same length and layer, but a dimension-like steep diagonal.
                {"layer": "PLAN", "points": [[230, 100], [251, 78]], "closed": False},
                # Wall and jamb fragments must never become door leaves.
                {"layer": "PLAN", "points": [[0, 100], [31, 100]], "closed": False},
                {"layer": "PLAN", "points": [[280, 100], [280, 70]], "closed": False},
            ],
            "labels": [], "layers": ["PLAN"], "truncated": False,
        }
        record["cadSelectedLayout"] = "Этаж 1"
        main.write_record(record)

        result = main.create_door_pattern(project["id"], {
            "leaf_count": 1,
            "bounds": {"minX": 35, "minY": 88, "maxX": 75, "maxY": 105},
        })
        self.assertEqual(result["run"]["candidate_count"], 2)
        self.assertEqual(len(result["pattern"]["leaf_signatures"]), 1)
        self.assertTrue(all(candidate["x"] < 200
                            for candidate in result["run"]["candidates"]))

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
