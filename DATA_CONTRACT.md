# Контракт данных 0.1

Статус: frozen for implementation.

Документ определяет логическую модель данных. Он не является готовой JSON Schema
и не фиксирует URL endpoint'ов или способ физического хранения. Реализация может
разделять сущности по файлам или таблицам, если сохраняет этот контракт и
инварианты `PRODUCT_ARCHITECTURE.md`.

## 1. Общие правила

### 1.1. Версия

Каждый проект содержит:

```json
{
  "schema_version": "0.1"
}
```

Изменение, несовместимое с существующими данными, требует новой версии схемы и
миграции. Транспортные версии отдельных форматов, например `geometry.v2`, не
заменяют `schema_version` проекта.

### 1.2. Идентификаторы

- Идентификатор уникален в пределах проекта.
- Идентификатор не меняется при редактировании объекта.
- Копирование объекта создаёт новый идентификатор.
- Повторный импорт не переиспользует ID ручного объекта без явного сопоставления.
- Удалённый ID не назначается новому объекту.

Рекомендуемый формат — строковый UUID или ULID с читаемым префиксом сущности.

### 1.3. Время

Время хранится в ISO 8601 UTC, например `2026-09-17T12:50:00Z`.

### 1.4. Хэши

Хэш имеет вид `sha256:<hex>`. Хэш объекта вычисляется по каноническому JSON без
полей интерфейса, кэшей и самого хэша. Порядок ключей фиксирован, числа
нормализованы, массивы с семантически значимым порядком не сортируются.

Алгоритм канонизации должен быть один для редактора, аудитора, мигратора и
экспортёра.

### 1.5. Ссылочная целостность

- Ссылка указывает на существующий объект той же модели или снимка.
- Удаление объекта с активными зависимостями блокируется либо оформляется
  отдельными предложениями изменения связей.
- Между `WorkingModel`, `Revision` и `Release` нельзя создавать изменяемые
  перекрёстные ссылки на содержимое другого жизненного цикла.
- Снимок хранит собственные значения ссылок и не меняется вместе с рабочей
  моделью.

## 2. Корневая структура Project

```json
{
  "schema_version": "0.1",
  "project_id": "project-001",
  "metadata": {},
  "source_files": [],
  "sheet_sources": [],
  "coordinate_transforms": [],
  "working_model": {},
  "draft": null,
  "recognition_runs": [],
  "recognition_artifacts": [],
  "observations": [],
  "inference_runs": [],
  "evidence": [],
  "fusion_rulesets": [],
  "proposals": [],
  "proposal_decisions": [],
  "project_dictionary": [],
  "revisions": [],
  "validation_results": [],
  "releases": [],
  "ai_processing_policy": {},
  "storage_state": {},
  "created_at": "...",
  "updated_at": "..."
}
```

Обязательны: `schema_version`, `project_id`, `metadata`, `source_files`,
`working_model`, коллекции производственного цикла, `storage_state`, даты.
Крупные recognition artifacts могут храниться отдельно; корневая запись содержит
их метаданные, индексы и ссылки.

## 3. ProjectMetadata

Минимальные поля:

```json
{
  "name": "Бизнес-центр",
  "address": "",
  "description": "",
  "responsible_engineer": "engineer-01",
  "customer": "",
  "tags": []
}
```

Пустые реквизиты допустимы для рабочего проекта, но правила выпуска могут
требовать их заполнения.

## 4. SourceFile

```json
{
  "source_file_id": "source-01",
  "name": "План этажа.dwg",
  "media_type": "application/acad",
  "size_bytes": 12345,
  "checksum": "sha256:...",
  "storage_ref": "sources/source-01.dwg",
  "kind": "dwg",
  "created_at": "...",
  "created_by": "engineer-01",
  "supersedes_source_file_id": null,
  "metadata": {}
}
```

`kind`: `dwg`, `dxf`, `pdf`, `image` или `other`.

SourceFile неизменяем. Новая редакция документа создаётся как новый SourceFile и
может ссылаться на предыдущий через `supersedes_source_file_id`.

## 5. WorkingModel

```json
{
  "model_version": 18,
  "sheets": [],
  "project_systems": [],
  "relations": [],
  "issues": [],
  "updated_at": "...",
  "updated_by": "engineer-01"
}
```

`model_version` увеличивается при каждом успешном явном сохранении. Обновление
принимается только при совпадении ожидаемой версии, чтобы не затереть более новое
состояние.

Сохранение WorkingModel атомарно на уровне проекта: либо сохраняется согласованный
набор целиком, либо предыдущая версия остаётся действующей.

## 6. Sheet

```json
{
  "sheet_id": "sheet-01",
  "source_file_id": "source-01",
  "source_locator": {
    "kind": "cad_layout",
    "value": "Model · область 1"
  },
  "name": "Первый этаж",
  "level": "Этаж 1",
  "coordinate_system": {},
  "architecture": {},
  "systems": [],
  "created_at": "...",
  "updated_at": "..."
}
```

`source_locator.kind` может быть `cad_layout`, `cad_area`, `pdf_page`,
`image_region` или `manual`.

Лист не владеет `relations` и `issues`; они находятся в WorkingModel и ссылаются
на листы или сущности.

## 7. Architecture

```json
{
  "geometry_schema_version": "2",
  "walls": [],
  "partitions": [],
  "doors": [],
  "openings": [],
  "windows": [],
  "rooms": []
}
```

Каждая архитектурная сущность содержит:

```text
id
entity_type
geometry
properties
placement
origin
verification
created_at
updated_at
```

Дверь отличается от проёма наличием подтверждённого дверного заполнения и его
параметров. Автоматически найденный разрыв без подтверждённых петель создаётся
как `Opening` либо как предложение преобразования в `Door`, а не как полностью
подтверждённая дверь.

## 8. SystemLayer и Entity

Листовые системы:

```json
{
  "system_id": "skud",
  "schema_version": "0.1",
  "entities": [],
  "routes": [],
  "cables": []
}
```

Общепроектные системы имеют ту же структуру в `project_systems`, но содержат
объекты, не принадлежащие одному пространственному листу.

Минимальная инженерная сущность:

```json
{
  "entity_id": "controller-01",
  "entity_type": "controller",
  "system_id": "skud",
  "code": "AR.1",
  "properties": {},
  "placement": {},
  "origin": {},
  "verification": {},
  "created_at": "...",
  "updated_at": "..."
}
```

Состав `properties` определяется версионированной схемой системы.

## 9. Placement

```json
{
  "kind": "sheet",
  "sheet_ids": ["sheet-01"],
  "geometry": {
    "type": "point",
    "coordinates": [120.0, 340.0],
    "rotation": 0.0,
    "elevation": 1.2
  }
}
```

`kind`:

```text
sheet
multi_sheet
project
unplaced
```

Правила:

- `sheet` требует ровно один `sheet_id`;
- `multi_sheet` требует не менее двух;
- `project` не требует геометрии листа;
- `unplaced` означает, что объект известен, но место ещё не определено.

## 10. Origin

```json
{
  "kind": "recognized",
  "source_file_id": "source-01",
  "sheet_id": "sheet-01",
  "recognition_run_id": "run-07",
  "proposal_id": "proposal-104",
  "algorithm_version": "recognizer-0.4",
  "confidence": 0.83,
  "created_at": "..."
}
```

`kind`:

```text
recognized
imported
manual
derived
legacy
```

Поля, неприменимые к выбранному виду происхождения, могут отсутствовать. История
происхождения принятого объекта не заменяется повторным распознаванием.

## 11. Verification

```json
{
  "status": "confirmed",
  "confirmed_revision_id": "revision-018",
  "confirmed_content_hash": "sha256:...",
  "confirmed_at": "...",
  "confirmed_by": "engineer-01",
  "note": ""
}
```

`status`:

```text
unverified
review_required
confirmed
rejected
needs_field_check
```

При изменении содержимого объекта подтверждение переводится в
`review_required`. Исторические сведения о подтверждении могут сохраняться в
журнале, но текущий статус не должен оставаться `confirmed` для другого хэша.

## 12. Relation

```json
{
  "relation_id": "relation-01",
  "relation_type": "controller_serves_door",
  "from_ref": {
    "entity_id": "controller-01"
  },
  "to_ref": {
    "entity_id": "door-18"
  },
  "system_id": "skud",
  "properties": {},
  "origin": {},
  "verification": {},
  "created_at": "...",
  "updated_at": "..."
}
```

Relation является самостоятельной сущностью. Удаление исходного или целевого
объекта невозможно без явного решения по зависимой связи.

## 13. Issue

```json
{
  "issue_id": "issue-01",
  "scope": "entity",
  "sheet_ids": ["sheet-01"],
  "system_id": "skud",
  "entity_refs": ["door-18"],
  "relation_refs": [],
  "category": "door_without_hinges",
  "severity": "review",
  "status": "open",
  "source": "validation",
  "message": "Не подтверждены петли дверного проёма",
  "ruleset_version": "skud-0.1",
  "created_at": "...",
  "resolved_at": null,
  "resolved_by": null,
  "resolution_note": null
}
```

`scope`: `project`, `sheet`, `system`, `entity`, `relation` или `release`.

`severity`: `blocking`, `review` или `recommendation`.

`status`: `open`, `acknowledged`, `resolved`, `deferred` или `dismissed`.

Issue имеет стабильный ключ дедупликации без версии ruleset:

```text
{rule_id}:{scope_type}:{scope_id}
```

`ruleset_version` хранится отдельным полем. Изменение версии набора правил не
создаёт новый Issue, пока смысл правила и `rule_id` остаются прежними.

Автоматически вычисленный Issue не закрывается удалением визуального сообщения.
Повторная проверка либо подтверждает его актуальность, либо создаёт доменное
решение о закрытии.

## 14. Draft

```json
{
  "draft_id": "draft-01",
  "base_model_version": 18,
  "working_model_snapshot": {},
  "created_at": "...",
  "updated_at": "...",
  "client_id": "local-editor",
  "content_hash": "sha256:..."
}
```

В версии 0.1 у проекта не более одного активного Draft. При восстановлении
сравнивается `base_model_version`. Если WorkingModel изменился после создания
черновика, требуется явное разрешение конфликта.

После успешного сохранения Draft может быть удалён или помечен восстановленным.

## 15. RecognitionRun

```json
{
  "recognition_run_id": "run-07",
  "source_file_id": "source-01",
  "sheet_id": "sheet-01",
  "algorithm": "cad-architecture-recognizer",
  "algorithm_version": "0.4",
  "base_model_version": 18,
  "status": "completed",
  "started_at": "...",
  "finished_at": "...",
  "summary": {},
  "error": null
}
```

Статусы:

```text
pending
processing
completed
partially_accepted
accepted
rejected
failed
```

Статус запуска выводится из состояния его предложений и выполнения обработки.

## 16. Proposal

```json
{
  "proposal_id": "proposal-104",
  "recognition_run_id": "run-07",
  "sheet_id": "sheet-01",
  "operation": "update",
  "entity_type": "door",
  "target_id": "door-18",
  "target_content_hash": "sha256:...",
  "candidate": {
    "geometry": {},
    "properties": {}
  },
  "confidence": 0.83,
  "status": "pending",
  "decision": null,
  "created_at": "..."
}
```

`operation`: `create`, `update`, `delete`, `link` или `unlink`.

`status`: `pending`, `accepted`, `rejected`, `conflict` или `superseded`.

Перед `update`, `delete`, `link` и `unlink` проверяется целевой хэш. Для `create`
выполняется проверка вероятного дубля. Принятие записывает решение и обновляет
WorkingModel одной атомарной доменной операцией.

## 17. Revision

```json
{
  "revision_id": "revision-018",
  "project_id": "project-001",
  "revision_number": 18,
  "source_model_version": 18,
  "created_at": "...",
  "created_by": "engineer-01",
  "model_hash": "sha256:...",
  "working_model_snapshot": {}
}
```

Revision неизменяема и содержит полный снимок проекта. Номер ревизии уникален и
монотонно увеличивается внутри проекта.

## 18. ValidationResult

```json
{
  "validation_id": "validation-018-skud",
  "revision_id": "revision-018",
  "scope": {
    "sheet_ids": ["sheet-01", "sheet-02"],
    "system_ids": ["architecture", "skud"]
  },
  "ruleset_versions": {
    "architecture": "architecture-0.1",
    "skud": "skud-0.1"
  },
  "checked_at": "...",
  "checked_by": "engineer-01",
  "result": {
    "status": "ready_for_release",
    "required_total": 91,
    "required_completed": 78,
    "blocking_issues": 0,
    "review_issues": 13,
    "recommendations": 4
  },
  "issues_snapshot": []
}
```

ValidationResult неизменяем. Scope задаётся множествами листов и систем.
Проверка покрывает выпуск, если множество листов и систем Release является
подмножеством scope ValidationResult и `revision_id` совпадает.

## 19. Release

```json
{
  "release_id": "release-003",
  "release_number": 3,
  "project_id": "project-001",
  "revision_id": "revision-018",
  "validation_result_id": "validation-018-skud",
  "schema_version": "0.1",
  "scope": {
    "sheet_ids": ["sheet-01"],
    "system_ids": ["architecture", "skud"]
  },
  "status": "released",
  "created_at": "...",
  "created_by": "engineer-01",
  "manifest": {},
  "model_hash": "sha256:...",
  "file_hashes": {},
  "passport": {},
  "limitations": [],
  "issues_snapshot": {},
  "sources_policy": "referenced"
}
```

Статус Release: `released`, `superseded` или `withdrawn`. Изменение статуса не
изменяет содержимое комплекта.

Release неизменяем. Новый результат создаёт новый `release_id` и номер.

`sources_policy`: `included`, `referenced` или `excluded`.

## 20. Manifest

Манифест обеспечивает воспроизводимость комплекта:

```json
{
  "format": "elv-digital-model",
  "format_version": "0.1",
  "project_id": "project-001",
  "release_id": "release-003",
  "revision_id": "revision-018",
  "scope": {},
  "systems": [],
  "sheets": [],
  "sources": [],
  "files": [],
  "ruleset_versions": {},
  "generator_versions": {},
  "created_at": "..."
}
```

Каждый включённый файл имеет относительный путь, размер и SHA-256. Манифест не
содержит абсолютных локальных путей.

## 21. Routes и cables

Минимальные будущие сущности первой инженерной вертикали:

```text
Route
RouteSegment
Cable
Tray
ConnectionPoint
Passage
```

Каждая содержит ID, систему, placement, геометрию, начало, конец, высоту или
отметку, origin и verification. Cable связывается с конечными объектами через
Relation и использует Route или RouteSegment, а не встраивает неструктурированную
линию в оборудование.

Подробные поля определяются отдельной схемой кабельной инфраструктуры, но эти
сущности не должны нарушать общий жизненный цикл WorkingModel → Revision →
ValidationResult → Release.

## 22. Состояния проекта

```json
{
  "working_status": "in_progress",
  "storage_state": {
    "status": "active",
    "changed_at": "...",
    "changed_by": "engineer-01"
  },
  "latest_revision_id": "revision-018",
  "latest_release_id": "release-003"
}
```

`working_status`: `in_progress`, `review_required` или `ready_for_release`.

`storage_state.status`: `active`, `archived` или `trash`.

Наличие Release не прекращает работу над следующей версией.

## 23. Совместимость geometry.v2

Существующий `geometry.v2` сохраняется как транспортный формат архитектурного
блока на период миграции. При импорте он преобразуется в RecognitionRun и
Proposal, а не записывается в WorkingModel напрямую.

При экспорте из WorkingModel он формируется адаптером и не становится вторым
источником истины.

## 24. Обязательные доменные операции

Реализация должна предоставлять операции с эквивалентной семантикой:

```text
add_source_file
start_recognition_run
record_proposals
accept_proposals
reject_proposals
save_draft
restore_draft
save_working_model
create_revision
validate_revision
create_release
archive_project
move_project_to_trash
restore_project
delete_project_permanently
```

Интерфейс и API не должны обходить эти операции прямой заменой вложенных массивов.

## 25. Инварианты контракта

1. `WorkingModel` изменяется только доменной операцией с проверкой версии.
2. RecognitionRun и Proposal сохраняются независимо от WorkingModel.
3. Принятие Proposal проверяет конфликт и обновляет только заявленный scope.
4. Draft не считается сохранённой рабочей моделью.
5. Revision, ValidationResult и Release неизменяемы.
6. Release покрывается ValidationResult той же Revision.
7. Ссылки внутри каждого снимка разрешаются без обращения к изменяемой модели.
8. Origin и Verification не теряются при сохранении и экспорте.
9. Issues и Relations имеют стабильные ID и единое место хранения.
10. Старые данные читаются только через версионированный адаптер или миграцию.

## 26. Расширение контракта распознавания

Подробные поля, статусы и правила следующих сущностей определены в
`RECOGNITION_ARCHITECTURE.md`:

```text
SheetSource
CoordinateTransform
RecognitionArtifact
Observation
InferenceRun
Evidence
FusionRuleSet
ProposalDecision
ProjectDictionary
```

Дополнительные правила контракта:

1. Один Sheet может использовать несколько SourceFile через SheetSource.
2. RecognitionRun ссылается на конкретную версию CoordinateTransform по ID и
   content hash.
3. Полные CAD-примитивы, crops и OCR-результаты не обязаны находиться в основном
   project.json; их RecognitionArtifact неизменяем и имеет checksum.
4. Observation фиксирует обнаруженный факт и не выдаёт интерпретацию за доменную
   сущность.
5. InferenceRun фиксирует модель, runtime, prompt, входные хэши, normalized output
   и применённую политику воспроизводимости.
6. VLM-интерпретация не создаёт Proposal напрямую.
7. Proposal формируется версионированным FusionRuleSet из групп Evidence.
8. ProposalDecision хранится отдельно от Proposal и Evidence.
9. Принятие Proposal проверяет target content hash и ожидаемую model_version.
10. Verification принятого объекта ссылается на confirmed_model_version и
    confirmed_content_hash; Revision позднее фиксирует это состояние.
11. ProjectDictionary содержит только scoped knowledge с собственным статусом и
    происхождением.
12. AI processing policy наследуется от Project к SourceFile и запуску; более
    низкий уровень может только ужесточить ограничение.
13. InferenceRun с уровнем воспроизводимости `none` не может быть основанием
    производственного Proposal, WorkingModel, ValidationResult или Release.
