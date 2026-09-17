# Архитектура распознавания 0.1

Статус: утверждённая стратегия версии 0.1.

Документ развивает `PRODUCT_ARCHITECTURE.md` и `DATA_CONTRACT.md`. Он определяет,
как CAD, PDF, OCR, компьютерное зрение и VLM формируют проверяемые предложения,
не изменяя рабочую модель напрямую.

## 1. Цель

Распознавание помогает инженеру извлекать архитектуру, оборудование, подписи и
связи из неоднородных проектных материалов. Оно не является самостоятельным
источником истины.

Основная гарантия:

> Ни импорт, ни алгоритм распознавания, ни OCR, ни VLM не изменяют WorkingModel
> напрямую. WorkingModel изменяется только после явного ProposalDecision
> инженера.

## 2. Полная цепочка

```text
SourceFile
    ↓
SheetSource
    ↓
CoordinateTransform
    ↓
RecognitionRun
    ↓
RecognitionArtifacts
    ↓
Observations
    ↓
InferenceRun при необходимости
    ↓
Evidence groups
    ↓
FusionRuleSet
    ↓
Proposal
    ↓
ProposalDecision инженера
    ↓
WorkingModel version N
    ↓
Revision
    ↓
ValidationResult
    ↓
Release
```

Роли:

- `SourceFile` — неизменяемый исходный файл;
- `SheetSource` — использование части источника в контексте логического листа;
- `CoordinateTransform` — проверяемое совмещение координат источника и листа;
- `RecognitionRun` — один воспроизводимо описанный запуск обработки;
- `RecognitionArtifact` — крупный неизменяемый результат обработки;
- `Observation` — обнаруженный факт без доменного решения;
- `InferenceRun` — интерпретация VLM или другой модели;
- `Evidence` — проверяемое основание вывода;
- `FusionRuleSet` — версионированные правила формирования кандидата;
- `Proposal` — предлагаемое изменение;
- `ProposalDecision` — явное решение инженера;
- `Verification` — состояние принятого объекта WorkingModel;
- `ProjectDictionary` — ранее подтверждённое знание проекта.

## 3. Стратегия источников

### 3.1. Иерархия механизмов

```text
DWG/DXF
    точная векторная геометрия, CAD-текст, блоки и слои

PDF или изображение
    визуальная проверка, OCR, легенды и недостающие обозначения

Геометрические и CV-правила
    измерения, разрывы, дуги, контуры и сопоставление

VLM
    контекстная интерпретация неоднозначных фрагментов

Инженер
    окончательное решение
```

DWG/DXF обычно предпочтительнее для координат, но не является автоматически
наиболее авторитетным источником содержания. Авторитетность определяется для
конкретного scope с учётом дисциплины, даты, ревизии, официального статуса и
качества данных.

### 3.2. Source authority

Для источника или его привязки фиксируются:

```json
{
  "discipline": "architecture",
  "revision_label": "РД-3",
  "issued_at": "2026-08-14",
  "authority": "contractual",
  "quality": {
    "vector_geometry": true,
    "text_layer": true,
    "structured_layers": false
  }
}
```

`authority` может иметь значения `contractual`, `reference`, `working`,
`survey` или `unknown`. Приоритет одного источника не распространяется
автоматически на другие дисциплины и листы.

## 4. SheetSource

Один логический Sheet может использовать несколько источников:

```text
Sheet
├── архитектурный DWG
├── DWG инженерной системы
├── выпущенный PDF
└── исполнительный скан
```

Минимальная структура:

```json
{
  "sheet_source_id": "sheet-source-01",
  "sheet_id": "sheet-01",
  "source_file_id": "source-03",
  "source_locator": {
    "kind": "pdf_page",
    "value": 4
  },
  "role": "verification_overlay",
  "authority": {},
  "coordinate_transform_id": "transform-03",
  "created_at": "..."
}
```

Роли:

```text
primary_geometry
reference_geometry
equipment_source
text_source
legend_source
verification_overlay
```

## 5. CoordinateTransform

Совмещение источников является отдельной проверяемой операцией.

```json
{
  "coordinate_transform_id": "transform-03",
  "sheet_source_id": "sheet-source-01",
  "type": "affine_2d",
  "matrix": [1, 0, 0, 1, 125.4, -84.2],
  "source_unit": "mm",
  "target_unit": "plan_unit",
  "control_points": [],
  "rms_error": 2.8,
  "status": "confirmed",
  "content_hash": "sha256:...",
  "confirmed_by": "engineer-01",
  "confirmed_at": "..."
}
```

Без подтверждённого масштаба PDF-измерения остаются в пикселях. Высокая ошибка
совмещения блокирует точные межисточниковые предложения.

RecognitionRun ссылается на ID и хэш использованной трансформации. Последующее
исправление CoordinateTransform не меняет смысл старого запуска.

## 6. RecognitionRun

```json
{
  "recognition_run_id": "run-07",
  "source_file_id": "source-01",
  "sheet_source_id": "sheet-source-01",
  "coordinate_transform_id": "transform-03",
  "coordinate_transform_hash": "sha256:...",
  "algorithm": "cad-architecture-recognizer",
  "algorithm_version": "0.4",
  "base_model_version": 18,
  "status": "completed",
  "effective_ai_processing_policy": {},
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

RecognitionRun владеет результатами запуска, но ссылается на SheetSource и
CoordinateTransform вместо их дублирования.

## 7. RecognitionArtifact

Полные CAD-примитивы, OCR-результаты, crops и CV-данные не хранятся внутри
основного `project.json`.

```json
{
  "artifact_id": "artifact-01",
  "recognition_run_id": "run-07",
  "kind": "cad_primitives",
  "path": "recognition/run-07/cad-primitives.jsonl",
  "media_type": "application/x-ndjson",
  "size_bytes": 123456,
  "sha256": "sha256:...",
  "retention_policy": "full",
  "created_at": "..."
}
```

Возможные виды:

```text
cad_primitives
cad_text
ocr_results
crops
cv_results
legend_fragments
normalized_candidates
```

Артефакт неизменяем. Новая обработка создаёт новый Artifact и новый Run.

## 8. Observation

Observation фиксирует обнаруженный факт без утверждения его доменного смысла.

```json
{
  "observation_id": "text-22",
  "recognition_run_id": "run-07",
  "artifact_id": "artifact-ocr-01",
  "kind": "ocr_text",
  "sheet_source_id": "sheet-source-pdf-01",
  "source_bbox": [1200, 850, 1260, 890],
  "value": "Д-12",
  "confidence": 0.94,
  "extractor": {
    "name": "ocr-engine",
    "version": "0.1"
  }
}
```

Типы могут включать:

```text
cad_line
cad_polyline
cad_arc
cad_block
cad_text
ocr_text
cv_symbol
wall_gap
contour
legend_fragment
crop
```

Observation «найден текст Д-12» допустим. Observation «это дверь Д-12» смешивает
наблюдение с интерпретацией и запрещён.

Для больших результатов Project хранит компактный observation index и ссылки на
потоковые artifacts, а не все CAD-линии как вложенный JSON.

## 9. Воспроизводимый crop

```json
{
  "crop_id": "crop-44",
  "recognition_run_id": "run-07",
  "sheet_source_id": "sheet-source-pdf-01",
  "source_bbox": [1100, 760, 1380, 1020],
  "context_margin": 80,
  "render_dpi": 300,
  "rotation": 0,
  "image_hash": "sha256:...",
  "artifact_id": "artifact-crops-01"
}
```

Для кандидата допускаются объектный crop и расширенный контекстный crop. Хэш без
координат и параметров построения не обеспечивает воспроизводимость.

## 10. InferenceRun

VLM используется только для контекстной интерпретации подготовленных данных.

```json
{
  "inference_run_id": "inference-04",
  "recognition_run_id": "run-07",
  "purpose": "door_classification",
  "model_provider": "local",
  "model_name": "qwen-vl",
  "model_version": "x.y",
  "runtime": "runtime-0.z",
  "prompt_version": "door-symbol-0.1",
  "prompt_hash": "sha256:...",
  "decoding": {
    "temperature": 0.0,
    "top_p": 1.0,
    "seed": 42
  },
  "input_refs": [],
  "input_hashes": [],
  "raw_output": {},
  "normalized_output": {},
  "validation_errors": [],
  "reproducibility": {},
  "created_at": "..."
}
```

InferenceRun обеспечивает воспроизводимое происхождение результата, но не
гарантирует побайтно одинаковый повторный ответ модели.

VLM не используется для:

- точных координат стен;
- метрического масштаба;
- геометрических пересечений;
- автоматического удаления;
- непосредственного изменения WorkingModel;
- окончательного инженерного подтверждения.

## 11. Evidence и измерения

Evidence ссылается на машинно проверяемые данные.

```json
{
  "evidence_id": "evidence-geometry-01",
  "recognition_run_id": "run-07",
  "kind": "wall_gap",
  "group": "geometry",
  "observation_refs": ["cad-line-101", "cad-line-102"],
  "measurement": {
    "value": 910,
    "unit": "mm",
    "coordinate_transform_id": "transform-03",
    "measurement_uncertainty": 12
  }
}
```

Для некалиброванного изображения:

```json
{
  "value": 146,
  "unit": "px",
  "metric_value": null,
  "coordinate_transform_id": null
}
```

Группы Evidence:

```text
geometry
text
legend
visual_interpretation
confirmed_project_knowledge
```

Текстовое объяснение VLM не является измерением. Интерпретация может ссылаться
на InferenceRun и имеет меньший статус, чем подтверждённая геометрия.

Признаки, происходящие из одного crop, алгоритма или легенды, не считаются
независимыми доказательствами только из-за разного представления.

## 12. FusionRuleSet

Proposal формируется контролируемыми и версионированными правилами.

```json
{
  "fusion_ruleset_id": "door-fusion-0.1",
  "entity_family": "door",
  "version": "0.1",
  "groups": {
    "geometry": "strong",
    "legend": "supporting",
    "text": "supporting",
    "visual_interpretation": "weak",
    "confirmed_project_knowledge": "authoritative"
  },
  "conflict_policy": "review_required",
  "created_at": "..."
}
```

Балльные веса не считаются вероятностями. Реальные веса и пороги вводятся только
после оценки на размеченном наборе. Ruleset сохраняет объяснимость и версию.

## 13. Candidate и Proposal

Кандидат не является объектом WorkingModel.

```json
{
  "proposal_id": "proposal-104",
  "recognition_run_id": "run-07",
  "operation": "create",
  "candidate_type": "door",
  "target_entity_type": "door",
  "target_id": null,
  "target_content_hash": null,
  "candidate": {
    "geometry": {},
    "properties": {
      "hinge_side": "unknown",
      "swing_direction": "unknown"
    }
  },
  "evidence_ids": [],
  "fusion_ruleset_id": "door-fusion-0.1",
  "evidence_strength": "medium",
  "review_priority": "high",
  "status": "pending",
  "created_at": "..."
}
```

`candidate_type` для проёмов:

```text
opening
door
unknown_opening
```

`target_entity_type` описывает будущую доменную сущность, например `opening`,
`door`, `window`, `wall`, `partition`, `route`, `equipment` или `relation`.

Операции Proposal:

```text
create
update
delete
link
unlink
```

Для update/delete/link/unlink проверяется target content hash. Исчезновение
объекта в новом источнике само по себе не является достаточным основанием для
delete. Ручной объект никогда не удаляется только из-за отсутствия в новом
импорте.

Статусы Proposal:

```text
pending
accepted
rejected
deferred
conflict
superseded
```

## 14. Двери и проёмы

| Наблюдения | candidate_type |
|---|---|
| Только разрыв стены | `opening` |
| Разрыв, полотно и дуга | `door` |
| Дверной CAD-блок | `door` |
| Противоречивые признаки | `unknown_opening` |

После принятия door Proposal создаётся Door. Сам факт существования двери и
подтверждение отдельных свойств разделены:

```json
{
  "entity_type": "door",
  "properties": {
    "hinge_side": "unknown",
    "swing_direction": "unknown"
  },
  "verification": {
    "status": "unverified"
  }
}
```

Неподтверждённые петли или направление создают Issue, но не превращают
существующую дверь обратно в Opening.

## 15. ProposalDecision

Решение инженера не участвует в fusion того же Proposal.

```json
{
  "decision_id": "decision-01",
  "proposal_id": "proposal-104",
  "decision": "accepted_with_changes",
  "decided_by": "engineer-01",
  "decided_at": "...",
  "changes": {
    "hinge_side": "left",
    "swing_direction": "inward"
  }
}
```

Решения:

```text
accepted
accepted_with_changes
rejected
deferred
conflict_resolved
```

Принятие выполняется атомарной доменной операцией, проверяет model_version и
target hash, применяет только заявленное изменение и возвращает новую версию
WorkingModel.

## 16. Verification после принятия

Verification принадлежит объекту WorkingModel, а не кандидату.

```json
{
  "status": "confirmed",
  "confirmed_model_version": 18,
  "confirmed_content_hash": "sha256:...",
  "confirmed_at": "...",
  "confirmed_by": "engineer-01"
}
```

Revision создаётся позднее и фиксирует это состояние. WorkingModel не
редактируется задним числом ради добавления `revision_id` в Verification.

Если содержимое объекта изменилось, старое подтверждение не соответствует новому
content hash и текущий статус становится `review_required`.

## 17. ProjectDictionary

Ранее подтверждённое знание может участвовать в новых fusion rules.

```json
{
  "knowledge_id": "knowledge-03",
  "kind": "symbol_mapping",
  "scope": {
    "source_file_ids": ["source-01"],
    "sheet_ids": ["sheet-01", "sheet-02"],
    "system_ids": ["skud"]
  },
  "signature": {
    "algorithm": "symbol-signature-0.1",
    "value": "..."
  },
  "meaning": "reader",
  "status": "confirmed",
  "confirmed_by": "engineer-01",
  "confirmed_at": "...",
  "source_decision_id": "decision-08",
  "supersedes_knowledge_id": null
}
```

Статусы:

```text
proposed
confirmed
superseded
revoked
```

Знание действует только внутри scope. Вывод VLM сам по себе не становится
confirmed knowledge.

## 18. Конфиденциальность

```json
{
  "ai_processing_policy": {
    "external_ai_allowed": false,
    "local_ai_allowed": true,
    "artifact_retention_allowed": true,
    "training_use_allowed": false
  }
}
```

Политика наследуется:

```text
Project
    ↓ только равное или более строгое ограничение
SourceFile
    ↓
RecognitionRun
    ↓
InferenceRun
```

Запрет имеет приоритет. Нельзя отправлять внешний crop или текст, если это
запрещено на любом вышестоящем уровне. Разрешение на inference и разрешение на
использование данных для обучения являются разными настройками.

## 19. Воспроизводимость и retention

Уровни:

### full

Хранятся входные artifacts, crops, хэши, prompt, decoding, raw output,
normalized output, модель и runtime. Результат разрешено использовать в
производственном Proposal.

### metadata_only

Хранятся модель, версии, prompt hash, параметры, входные хэши, normalized output,
Evidence, ProposalDecision и применённая политика. Результат разрешено
использовать, но Release фиксирует ограничение воспроизводимости.

### none

Хранятся только минимальные сведения о факте запуска. Такой InferenceRun:

- используется только для экспериментального просмотра;
- не участвует в Evidence fusion;
- не создаёт производственный Proposal;
- не изменяет WorkingModel;
- не используется в ValidationResult и Release.

Правило:

> Если невозможно сохранить минимальный аудиторский след интерпретации, её нельзя
> использовать как основание инженерной модели.

## 20. Локальные и внешние модели

Модели подключаются через заменяемые роли:

```text
TextExtractor
VisualInterpreter
EvidenceFusion
```

Конкретное имя модели не является частью основного контракта. Оно фиксируется в
InferenceRun.

Приоритет обработки:

1. CAD `TEXT`/`MTEXT` и блоки;
2. локальный OCR для PDF и изображений;
3. VLM только для неоднозначных подготовленных фрагментов;
4. внешний сервис только при явном разрешении политики;
5. инженерное решение.

Для текущего локального прототипа кандидатами являются PaddleOCR-VL для OCR и
компактная Qwen-VL для интерпретации. Выбор не фиксируется до сравнительного
теста на реальных проектных фрагментах.

## 21. Метрики пилота дверей

### Обнаружение

- precision и recall;
- ложные кандидаты;
- пропущенные двери.

### Классификация

- дверь, проём или unknown;
- одинарная или двойная;
- сопоставление подписи;
- сопоставление с легендой.

### Геометрия

- наличие полотна;
- сторона петель;
- направление открывания;
- ширина;
- привязка к стене;
- метрическая точность.

### Производственная полезность

- время проверки одной двери;
- доля Proposal, принятых без изменений;
- доля конфликтов;
- доля unknown;
- количество ручных исправлений;
- количество ложных предложений на лист.

Для первой версии приоритетна точность Proposal, а не максимальная полнота.

## 22. Порядок реализации

### Фаза A — безопасный фундамент

1. SourceFile.
2. SheetSource.
3. CoordinateTransform.
4. Сохраняемый RecognitionRun.
5. RecognitionArtifact и observation index.
6. Сохраняемый Proposal.
7. ProposalDecision.
8. Защита WorkingModel.

### Фаза B — детерминированное распознавание

1. CAD geometry и CAD text Observations.
2. Измерения с единицами и uncertainty.
3. Evidence groups.
4. FusionRuleSet для дверей.
5. Частичное принятие и конфликт target hash.

### Фаза C — OCR

1. Воспроизводимые crops.
2. OCR Observations с bbox и rotation.
3. Валидация технических кодов.
4. ProjectDictionary и легенды.

### Фаза D — экспериментальная VLM

1. Политика AI-обработки.
2. InferenceRun.
3. Локальный пилот на дверях.
4. Набор из 50–100 проверенных кандидатов.
5. Оценка метрик и решение о расширении.

## 23. Критерий готовности первой вертикали

1. Сохранить ручную стену и дверь в WorkingModel.
2. Запустить новый CAD-импорт.
3. Убедиться, что WorkingModel не изменилась.
4. Перезапустить приложение и восстановить RecognitionRun и Proposal.
5. Принять одно Proposal.
6. Убедиться, что изменился только заявленный объект.
7. Изменить вручную другой целевой объект.
8. Убедиться, что старое Proposal получило conflict и не применилось.
9. Зафиксировать ProposalDecision и новую model_version.

VLM не является обязательной для прохождения этой вертикали.

## 24. Инварианты стратегии 0.1

1. Ни один этап распознавания не изменяет WorkingModel напрямую.
2. SourceFile и RecognitionArtifact неизменяемы.
3. Observation не содержит неподтверждённого доменного решения.
4. VLM создаёт интерпретацию, а не Proposal.
5. Evidence ссылается на проверяемые источники.
6. FusionRuleSet версионирован и объясним.
7. Коррелированные признаки не считаются независимыми автоматически.
8. Candidate не является сущностью WorkingModel.
9. ProposalDecision отделён от Evidence fusion.
10. Принятие Proposal проверяет model_version и target hash.
11. Ручные изменения имеют приоритет.
12. Verification относится к принятому состоянию объекта.
13. ProjectDictionary действует только внутри scope.
14. Запрет конфиденциальности имеет приоритет.
15. InferenceRun с reproducibility `none` не используется в производственной
    модели.
16. Release честно отражает ограничения воспроизводимости.
