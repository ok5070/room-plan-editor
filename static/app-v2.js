const state = {
  app: null, world: null, project: null,
  geometry: { version: 2, canvas: {}, walls: [], doors: [], windows: [] },
  equipment: [], markers: [], geometryLayer: null, draftLayer: null, backgroundSprite: null,
  scale: 1, minScale: 0.12, maxScale: 6,
  dragging: false, dragStart: null, worldStart: null,
  editorEnabled: false, tool: "select", draftStart: null, selected: null, moving: null,
  history: [], future: [], dirty: false,
  viewMode: '2d', volume: null,
};

const $ = (selector) => document.querySelector(selector);
const clone = (value) => JSON.parse(JSON.stringify(value));
const layerNames = {wall:'Стены', partition:'Перегородки', door:'Двери', window:'Окна', background:'Подложка', controller:'Оборудование'};
const layers = Object.fromEntries(Object.keys(layerNames).map(k => [k,{visible:true,locked:k==='background'}]));
function editable(layer) { return layers[layer].visible && !layers[layer].locked; }
function selectedEditable() {
  if (!state.selected) return false;
  if (state.selected.kind !== 'wall') return editable(state.selected.kind);
  const w = state.geometry.walls.find(w=>w.id===state.selected.id);
  return w && editable(w.type) && !state.geometry.doors.some(d=>d.wallId===w.id&&!editable('door')) && !state.geometry.windows.some(d=>d.wallId===w.id&&!editable('window'));
}
function renderLayers() {
  $('#architectural-layers').innerHTML=Object.entries(layerNames).map(([key,name])=>'<div class="layer-controls"><span>'+name+'</span><button data-visible="'+key+'" aria-label="Видимость: '+name+'">'+(layers[key].visible?'Виден':'Скрыт')+'</button><button data-lock="'+key+'" aria-label="Блокировка: '+name+'">'+(layers[key].locked?'🔒':'🔓')+'</button></div>').join('');
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

async function loadJson(url, errorMessage) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(errorMessage);
  return response.json();
}

async function loadProject() {
  [state.project, state.geometry] = await Promise.all([
    loadJson("/api/project", "Не удалось загрузить проект"),
    loadJson("/api/geometry", "Не удалось загрузить геометрию"),
  ]);
  state.geometry.windows ||= [];
  state.geometry.doors.forEach((door) => { door.leafCount = door.leafCount === 2 ? 2 : 1; });
  state.equipment = state.project.equipment || [];
  const { project } = state.project;
  $("#cover-object").textContent = project.object;
  $("#cover-address").textContent = project.address;
  $("#project-object").textContent = project.object;
  $("#project-address").textContent = project.address;
  $("#revision").textContent = project.revision;
  $("#source-label").textContent = "Лист 4 · проектная подложка";
}

async function initializePixi() {
  const container = $("#floor-plan-container");
  state.app = new PIXI.Application();
  await state.app.init({ resizeTo: container, antialias: true, backgroundColor: 0xd8dcda, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true });
  container.prepend(state.app.canvas);
  state.world = new PIXI.Container();
  state.app.stage.addChild(state.world);
  await drawPlan();
  bindCanvasNavigation();
  fitPlan();
  $("#loading").classList.add("is-hidden");
}

async function drawPlan() {
  state.world.removeChildren();
  state.markers = [];
  const { floorPlan } = state.project;
  const paper = new PIXI.Graphics().rect(0, 0, floorPlan.width, floorPlan.height).fill({ color: 0xf4f5f3 });
  state.world.addChild(paper);
  if (floorPlan.backgroundImage) {
    const texture = await PIXI.Assets.load(floorPlan.backgroundImage);
    state.backgroundSprite = new PIXI.Sprite(texture);
    state.backgroundSprite.width = floorPlan.width;
    state.backgroundSprite.height = floorPlan.height;
    state.backgroundSprite.alpha = Number($("#background-opacity").value) / 100;
    state.world.addChild(state.backgroundSprite);
  }
  const grid = new PIXI.Graphics();
  for (let x = 0; x <= floorPlan.width; x += 50) grid.moveTo(x, 0).lineTo(x, floorPlan.height);
  for (let y = 0; y <= floorPlan.height; y += 50) grid.moveTo(0, y).lineTo(floorPlan.width, y);
  grid.stroke({ width: 1, color: 0x527176, alpha: 0.08 });
  state.world.addChild(grid);
  state.geometryLayer = new PIXI.Container();
  state.draftLayer = new PIXI.Container();
  state.world.addChild(state.geometryLayer, state.draftLayer);
  drawGeometry();
  state.equipment.forEach((item) => state.world.addChild(createMarker(item)));
  updateVisibleCount();
}

function drawGeometry() {
  if (!state.geometryLayer) return;
  state.geometryLayer.removeChildren();
  state.geometry.walls.forEach((wall) => {
    if (!layers[wall.type].visible) return;
    const selected = state.selected?.kind === "wall" && state.selected.id === wall.id;
    const g = new PIXI.Graphics();
    g.moveTo(wall.x1, wall.y1).lineTo(wall.x2, wall.y2).stroke({ width: wall.thickness, color: selected ? 0xf4bd5c : wall.type === "partition" ? 0x169b91 : 0x243c63, alpha: 0.96 });
    if (selected) {
      g.circle(wall.x1, wall.y1, 9).fill({ color: 0xf4bd5c }).stroke({ width: 2, color: 0xffffff });
      g.circle(wall.x2, wall.y2, 9).fill({ color: 0xf4bd5c }).stroke({ width: 2, color: 0xffffff });
    }
    state.geometryLayer.addChild(g);
  });
  state.geometry.doors.forEach((door) => {
    if (!layers.door.visible) return;
    const selected = state.selected?.kind === "door" && state.selected.id === door.id;
    const holder = new PIXI.Container();
    holder.position.set(door.x, door.y);
    holder.rotation = door.rotation || 0;
    holder.scale.y = door.openingSide === 1 ? -1 : 1;
    const g = new PIXI.Graphics();
    const half = door.width / 2;
    g.moveTo(-half, 0).lineTo(half, 0).stroke({ width: 18, color: 0xf4f5f3, alpha: 0.96 });
    const doorColor = selected ? 0xf4bd5c : 0x176f9f;
    if (door.leafCount === 2) {
      const leaf = door.width * 0.46;
      g.moveTo(-half, 0).lineTo(-half, -leaf).stroke({ width: 4, color: doorColor });
      g.moveTo(half, 0).lineTo(half, -leaf).stroke({ width: 4, color: doorColor });
      g.moveTo(-half, -leaf).quadraticCurveTo(-door.width * 0.04, -leaf, -door.width * 0.04, 0).stroke({ width: 2, color: doorColor, alpha: 0.72 });
      g.moveTo(half, -leaf).quadraticCurveTo(door.width * 0.04, -leaf, door.width * 0.04, 0).stroke({ width: 2, color: doorColor, alpha: 0.72 });
    } else {
      const hinge = door.swing === "right" ? half : -half;
      const leafEnd = door.swing === "right" ? hinge - door.width * 0.82 : hinge + door.width * 0.82;
      g.moveTo(hinge, 0).lineTo(hinge, -door.width * 0.82).stroke({ width: 4, color: doorColor });
      g.moveTo(hinge, -door.width * 0.82).quadraticCurveTo(leafEnd, -door.width * 0.82, leafEnd, 0).stroke({ width: 2, color: doorColor, alpha: 0.72 });
    }
    g.circle(0, 0, selected ? 8 : 5).fill({ color: selected ? 0xf4bd5c : 0x168d8a }).stroke({ width: 2, color: 0xffffff });
    holder.addChild(g);
    state.geometryLayer.addChild(holder);
  });
  state.geometry.windows.forEach((windowItem) => {
    if (!layers.window.visible) return;
    const selected = state.selected?.kind === "window" && state.selected.id === windowItem.id;
    const holder = new PIXI.Container();
    holder.position.set(windowItem.x, windowItem.y);
    holder.rotation = windowItem.rotation || 0;
    const g = new PIXI.Graphics();
    const half = windowItem.width / 2;
    const color = selected ? 0xf4bd5c : 0x42aee8;
    g.moveTo(-half, 0).lineTo(half, 0).stroke({ width: 18, color: 0xf4f5f3, alpha: 0.96 });
    g.moveTo(-half, -5).lineTo(half, -5).stroke({ width: 3, color });
    g.moveTo(-half, 5).lineTo(half, 5).stroke({ width: 3, color });
    g.moveTo(-half, -8).lineTo(-half, 8).moveTo(half, -8).lineTo(half, 8).stroke({ width: 3, color });
    if (selected) g.circle(0, 0, 7).fill({ color: 0xf4bd5c }).stroke({ width: 2, color: 0xffffff });
    holder.addChild(g);
    state.geometryLayer.addChild(holder);
  });
  updateVisibleCount();
  updateEditorButtons();
  if (state.backgroundSprite) state.backgroundSprite.visible=layers.background.visible;
  state.markers.forEach(marker=>{marker.visible=layers.controller.visible;});
}

function createMarker(item) {
  const marker = new PIXI.Container();
  marker.position.set(item.x, item.y);
  marker.label = item.type;
  const shape = new PIXI.Graphics();
  if (item.type === "controller") shape.circle(0, 0, 11).fill({ color: 0x1b8f88 }).stroke({ width: 3, color: 0xffffff });
  else shape.rect(-8, -8, 16, 16).fill({ color: 0xf4bd5c }).stroke({ width: 3, color: 0xffffff });
  const label = new PIXI.Text({ text: item.id, style: { fontFamily: "Manrope, sans-serif", fontSize: 12, fontWeight: "700", fill: 0x1b3034 } });
  label.anchor.set(0.5, 0); label.position.set(0, 18);
  marker.addChild(shape, label); state.markers.push(marker); return marker;
}

function fitPlan() {
  if (state.viewMode === '25d') return state.volume?.fit();
  if (!state.app || !state.project) return;
  const { width, height } = state.project.floorPlan;
  const viewWidth = state.app.screen.width, viewHeight = state.app.screen.height;
  state.scale = Math.max(state.minScale, Math.min((viewWidth - 70) / width, (viewHeight - 70) / height));
  state.world.scale.set(state.scale);
  state.world.position.set((viewWidth - width * state.scale) / 2, (viewHeight - height * state.scale) / 2);
  updateZoomLabel();
}

function resizePlan() {
  if (state.viewMode === '25d') return state.volume?.render();
  if (!state.app) return;
  const container = $("#floor-plan-container");
  state.app.renderer.resize(container.clientWidth, container.clientHeight);
  fitPlan();
}

function zoomAt(factor, clientX, clientY) {
  if (state.viewMode === '25d') return state.volume?.zoomBy(factor);
  const rect = state.app.canvas.getBoundingClientRect();
  const sx = (clientX ?? rect.left + rect.width / 2) - rect.left, sy = (clientY ?? rect.top + rect.height / 2) - rect.top;
  const old = state.scale, next = Math.max(state.minScale, Math.min(state.maxScale, old * factor));
  const lx = (sx - state.world.x) / old, ly = (sy - state.world.y) / old;
  state.scale = next; state.world.scale.set(next); state.world.position.set(sx - lx * next, sy - ly * next); updateZoomLabel();
}

function updateZoomLabel() { $("#zoom-label").textContent = `${Math.round(state.scale * 100)}%`; }
function snapPoint(point) { return $("#snap-toggle").checked ? { x: Math.round(point.x / 10) * 10, y: Math.round(point.y / 10) * 10 } : point; }
function worldPoint(event) {
  const rect = state.app.canvas.getBoundingClientRect();
  return snapPoint({ x: (event.clientX - rect.left - state.world.x) / state.scale, y: (event.clientY - rect.top - state.world.y) / state.scale });
}

function projectToWall(point, wall) {
  const vx = wall.x2 - wall.x1, vy = wall.y2 - wall.y1, length2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((point.x - wall.x1) * vx + (point.y - wall.y1) * vy) / length2));
  const x = wall.x1 + t * vx, y = wall.y1 + t * vy;
  return { x, y, t, distance: Math.hypot(point.x - x, point.y - y), rotation: Math.atan2(vy, vx) };
}

function nearestWall(point, tolerance = Infinity) {
  let best = null;
  state.geometry.walls.forEach((wall) => { const p = projectToWall(point, wall); if (p.distance <= tolerance && (!best || p.distance < best.distance)) best = { wall, ...p }; });
  return best;
}

function nearestElement(point) {
  const tolerance = 22 / state.scale; let best = null;
  for (const [kind,items] of [['door',state.geometry.doors],['window',state.geometry.windows]]) {
    if (!editable(kind)) continue;
    items.forEach(item=>{const c=Math.cos(item.rotation||0),s=Math.sin(item.rotation||0),dx=point.x-item.x,dy=point.y-item.y;
      const distance=Math.hypot(Math.max(0,Math.abs(dx*c+dy*s)-item.width/2),-dx*s+dy*c);
      if(distance<=tolerance&&(!best||distance<best.distance)) best={kind,id:item.id,distance};
    });
  }
  if (best) return best;
  state.geometry.walls.forEach((wall) => { if(!editable(wall.type)) return; const distance = projectToWall(point, wall).distance; if (distance <= tolerance && (!best || distance < best.distance)) best = { kind: "wall", id: wall.id, distance }; });
  return best;
}

function nextId(prefix, items) { const ids = new Set(items.map((item) => item.id)); let n = 1; while (ids.has(`${prefix}-${String(n).padStart(3, "0")}`)) n++; return `${prefix}-${String(n).padStart(3, "0")}`; }
function snapshot() { return JSON.stringify(state.geometry); }
function beginMutation() { state.history.push(snapshot()); if (state.history.length > 100) state.history.shift(); state.future = []; setDirty(true); }
function setDirty(value) { state.dirty = value; $("#save-geometry").disabled = !value; $("#edit-status").textContent = value ? "есть изменения" : state.editorEnabled ? "редактирование" : "просмотр"; updateEditorButtons(); }

function addWall(type, start, end) {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 12) return showToast("Элемент слишком короткий", true);
  beginMutation();
  state.geometry.walls.push({ id: nextId(type === "wall" ? "W" : "P", state.geometry.walls), type, x1: start.x, y1: start.y, x2: end.x, y2: end.y, thickness: type === "wall" ? 13 : 7 });
  state.draftStart = null; clearDraft(); drawGeometry();
}

function addDoor(point, swing = "right", leafCount = 1) {
  const target = nearestWall(point, 45 / state.scale);
  if (!target) return showToast("Нажмите ближе к существующей стене", true);
  beginMutation();
  state.geometry.doors.push({ id: nextId("D", state.geometry.doors), wallId: target.wall.id, x: target.x, y: target.y, width: leafCount === 2 ? 88 : 48, rotation: target.rotation, swing, leafCount, accessPointId: null });
  drawGeometry();
}

function addWindow(point) {
  const target = nearestWall(point, 45 / state.scale);
  if (!target) return showToast("Нажмите ближе к существующей стене", true);
  beginMutation();
  state.geometry.windows.push({ id: nextId("WIN", state.geometry.windows), wallId: target.wall.id, x: target.x, y: target.y, width: 72, rotation: target.rotation });
  drawGeometry();
}

function deleteSelected() {
  if (!selectedEditable()) return showToast('Слой или связанные проёмы заблокированы');
  beginMutation();
  if (state.selected.kind === "wall") {
    state.geometry.walls = state.geometry.walls.filter((item) => item.id !== state.selected.id);
    state.geometry.doors = state.geometry.doors.filter((item) => item.wallId !== state.selected.id);
    state.geometry.windows = state.geometry.windows.filter((item) => item.wallId !== state.selected.id);
  } else if (state.selected.kind === "door") state.geometry.doors = state.geometry.doors.filter((item) => item.id !== state.selected.id);
  else state.geometry.windows = state.geometry.windows.filter((item) => item.id !== state.selected.id);
  state.selected = null; drawGeometry(); showGeometryCard();
}

function undo() { if (!state.history.length) return; state.future.push(snapshot()); state.geometry = JSON.parse(state.history.pop()); state.selected = null; setDirty(true); drawGeometry(); showGeometryCard(); }
function redo() { if (!state.future.length) return; state.history.push(snapshot()); state.geometry = JSON.parse(state.future.pop()); state.selected = null; setDirty(true); drawGeometry(); showGeometryCard(); }
function clearDraft() { if (state.draftLayer) state.draftLayer.removeChildren(); }
function drawDraft(point) { clearDraft(); if (!state.draftStart) return; const g = new PIXI.Graphics(); g.moveTo(state.draftStart.x, state.draftStart.y).lineTo(point.x, point.y).stroke({ width: 5, color: 0xf4bd5c, alpha: 0.9 }); g.circle(state.draftStart.x, state.draftStart.y, 8).fill({ color: 0xf4bd5c }); state.draftLayer.addChild(g); }

function handleEditorDown(event) {
  const point = worldPoint(event);
  const layer = state.tool.startsWith('door') ? 'door' : state.tool;
  if (layer !== 'select' && layers[layer] && !editable(layer)) return showToast('Сначала включите и разблокируйте слой');
  if (["wall", "partition"].includes(state.tool)) {
    if (!state.draftStart) { state.draftStart = point; drawDraft(point); setEditorHint("Укажите вторую точку"); }
    else { addWall(state.tool, state.draftStart, point); setTool(state.tool); }
    return;
  }
  if (state.tool === "door-left") return addDoor(point, "left", 1);
  if (state.tool === "door-right") return addDoor(point, "right", 1);
  if (state.tool === "door-double") return addDoor(point, "right", 2);
  if (state.tool === "window") return addWindow(point);
  state.selected = nearestElement(point);
  if (selectedEditable()) state.moving = { start: point, geometry: clone(state.geometry), started: false };
  drawGeometry(); showGeometryCard();
}

function handleEditorMove(event) {
  const point = worldPoint(event); if (state.draftStart) drawDraft(point); if (!state.moving || !state.selected) return;
  const dx = point.x - state.moving.start.x, dy = point.y - state.moving.start.y;
  if (!state.moving.started && Math.hypot(dx, dy) < 2) return;
  if (!state.moving.started) { beginMutation(); state.moving.started = true; }
  if (state.selected.kind === "wall") {
    const original = state.moving.geometry.walls.find((item) => item.id === state.selected.id), wall = state.geometry.walls.find((item) => item.id === state.selected.id);
    Object.assign(wall, { x1: original.x1 + dx, y1: original.y1 + dy, x2: original.x2 + dx, y2: original.y2 + dy });
    state.geometry.doors.filter((door) => door.wallId === wall.id).forEach((door) => { const originalDoor = state.moving.geometry.doors.find((item) => item.id === door.id); door.x = originalDoor.x + dx; door.y = originalDoor.y + dy; });
    state.geometry.windows.filter((windowItem) => windowItem.wallId === wall.id).forEach((windowItem) => { const originalWindow = state.moving.geometry.windows.find((item) => item.id === windowItem.id); windowItem.x = originalWindow.x + dx; windowItem.y = originalWindow.y + dy; });
  } else {
    const item = state.selected.kind === "door" ? state.geometry.doors.find((entry) => entry.id === state.selected.id) : state.geometry.windows.find((entry) => entry.id === state.selected.id);
    const host = state.geometry.walls.find(w=>w.id===item.wallId);
    const target = event.altKey ? nearestWall(point,45/state.scale) : host ? {wall:host,...projectToWall(point,host)} : null;
    if (target) {
      const length=Math.hypot(target.wall.x2-target.wall.x1,target.wall.y2-target.wall.y1);
      const margin=Math.min(.5,item.width/2/(length||1));
      const t=Math.max(margin,Math.min(1-margin,target.t));
      target.x=target.wall.x1+t*(target.wall.x2-target.wall.x1); target.y=target.wall.y1+t*(target.wall.y2-target.wall.y1);
    }
    if (target) Object.assign(item, { wallId: target.wall.id, x: target.x, y: target.y, rotation: target.rotation });
  }
  drawGeometry();
}

function bindCanvasNavigation() {
  const canvas = state.app.canvas;
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); zoomAt(event.deltaY < 0 ? 1.12 : 0.89, event.clientX, event.clientY); }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    if (state.editorEnabled && state.tool!=='pan' && !state.spaceHeld && event.button!==1) return handleEditorDown(event);
    state.dragging = true; state.dragStart = { x: event.clientX, y: event.clientY }; state.worldStart = { x: state.world.x, y: state.world.y };
  });
  canvas.addEventListener("pointermove", (event) => {
    const point = worldPoint(event); $("#cursor-coordinates").textContent = `${point.x.toFixed(0)} / ${point.y.toFixed(0)}`;
    if (state.editorEnabled && !state.dragging) return handleEditorMove(event);
    if (state.dragging) state.world.position.set(state.worldStart.x + event.clientX - state.dragStart.x, state.worldStart.y + event.clientY - state.dragStart.y);
  });
  const stop = () => { state.dragging = false; state.moving = null; };
  canvas.addEventListener("pointerup", stop); canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", () => { $("#cursor-coordinates").textContent = "— / —"; });
}

function setTool(tool) {
  state.tool = tool; state.draftStart = null; state.moving = null; clearDraft();
  document.querySelectorAll(".tool-button").forEach((button) => button.classList.toggle("is-active", button.dataset.tool === tool));
  $("#floor-plan-container").dataset.tool = tool;
  if (tool==='pan') return setEditorHint('Зажмите левую кнопку и перемещайте весь план');
  setEditorHint({ select: "Выберите или перетащите элемент", wall: "Стена: укажите первую точку", partition: "Перегородка: укажите первую точку", "door-left": "Левая дверь: нажмите рядом со стеной", "door-right": "Правая дверь: нажмите рядом со стеной", "door-double": "Двойная дверь: нажмите рядом со стеной", window: "Окно: нажмите рядом со стеной" }[tool]);
}

function setEditorHint(text) { $("#editor-hint").textContent = state.editorEnabled ? text : "Режим просмотра"; $("#editor-hint").classList.toggle("is-editing", state.editorEnabled); }
function toggleEditor() {
  if (state.viewMode === '25d') return showToast('Вернитесь в «План 2D» для редактирования');
  state.editorEnabled = !state.editorEnabled;
  $("#editor-toggle").setAttribute("aria-pressed", String(state.editorEnabled));
  $("#editor-section").classList.toggle("is-visible", state.editorEnabled);
  $("#floor-plan-container").classList.toggle("is-editing", state.editorEnabled);
  if (!state.editorEnabled) { state.selected = null; state.draftStart = null; clearDraft(); drawGeometry(); }
  setTool("select"); setDirty(state.dirty);
}

function showGeometryCard() {
  if (!state.selected) { $("#object-card").innerHTML = '<div class="object-card__empty"><span class="crosshair" aria-hidden="true"></span><p>Выберите объект на плане</p></div>'; return; }
  const item = state.selected.kind === "wall" ? state.geometry.walls.find((x) => x.id === state.selected.id) : state.selected.kind === "door" ? state.geometry.doors.find((x) => x.id === state.selected.id) : state.geometry.windows.find((x) => x.id === state.selected.id);
  if (!item) return;
  const type = state.selected.kind === "wall" ? item.type === "partition" ? "Перегородка" : "Стена" : state.selected.kind === "door" ? item.leafCount === 2 ? "Двойная дверь" : "Одинарная дверь" : "Окно";
  const details = state.selected.kind === "wall" ? `<dt>Начало</dt><dd>${item.x1.toFixed(0)} / ${item.y1.toFixed(0)}</dd><dt>Конец</dt><dd>${item.x2.toFixed(0)} / ${item.y2.toFixed(0)}</dd>` : `<dt>Стена</dt><dd>${escapeHtml(item.wallId)}</dd><dt>Центр</dt><dd>${item.x.toFixed(0)} / ${item.y.toFixed(0)}</dd>`;
  const doorActions = state.selected.kind === "door" ? `<div class="object-card__actions"><button type="button" data-door-action="flip">Петли: ${item.swing === "left" ? "слева" : "справа"}</button><button type="button" data-door-action="side">Сменить сторону открытия (${item.openingSide === 1 ? 'Б' : 'А'})</button><button type="button" data-door-action="toggle-leaves">${item.leafCount === 2 ? "Сделать одинарной" : "Сделать двойной"}</button></div><p class="editor-help">А/Б — стороны стены. «Внутрь» определяется относительно выбранного помещения.</p>` : state.selected.kind === 'window' ? `<p class="editor-help">Ширина: ${item.width} ед. плана. Перетащите вдоль стены; Alt — перенос на другую стену.</p>` : "";
  $("#object-card").innerHTML = `<div class="object-card__content"><div class="object-card__head"><h3>${escapeHtml(item.id)}</h3><span class="status-badge">выбран</span></div><dl><dt>Тип</dt><dd>${type}</dd>${details}</dl>${doorActions}</div>`;
}

function updateEditorButtons() { $("#delete-element").disabled = !selectedEditable(); $("#undo-edit").disabled = !state.history.length; $("#redo-edit").disabled = !state.future.length; }
function updateVisibleCount() { if (state.geometry) $("#visible-count").textContent = `${state.geometry.walls.length + state.geometry.doors.length + state.geometry.windows.length + state.markers.length} элементов`; }

async function saveGeometry() {
  const response = await fetch("/api/geometry", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.geometry) });
  const result = await response.json(); if (!response.ok) throw new Error(result.detail || "Не удалось сохранить геометрию");
  state.geometry = result.geometry; state.history = []; state.future = []; setDirty(false); drawGeometry(); showToast(`Сохранено: ${result.walls} стен, ${result.doors} дверей, ${result.windows} окон`);
}

async function uploadCad(file) {
  const data = new FormData(); data.append("file", file); showToast(`Читаем ${file.name}…`);
  const response = await fetch("/api/parse-cad", { method: "POST", body: data }), result = await response.json();
  if (!response.ok) throw new Error(result.detail || "Ошибка чтения CAD");
  state.equipment = normalizeCoordinates(result.equipment, result.bounds); $("#source-label").textContent = file.name; await drawPlan(); fitPlan(); showToast(`Найдено: ${result.summary.controllers} контроллеров, ${result.summary.doors} дверей`);
}

function normalizeCoordinates(items, bounds) {
  if (!bounds) return items; const target = state.project.floorPlan, sw = Math.max(bounds.maxX - bounds.minX, 1), sh = Math.max(bounds.maxY - bounds.minY, 1), pad = 100, factor = Math.min((target.width - 2 * pad) / sw, (target.height - 2 * pad) / sh);
  return items.map((item) => ({ ...item, originalX: item.x, originalY: item.y, x: pad + (item.x - bounds.minX) * factor, y: target.height - pad - (item.y - bounds.minY) * factor }));
}

function bindInterface() {
  renderLayers();
  $('#architectural-layers').addEventListener('click',event=>{
    const b=event.target.closest('button'); if(!b) return;
    if(b.dataset.visible) layers[b.dataset.visible].visible=!layers[b.dataset.visible].visible;
    if(b.dataset.lock) layers[b.dataset.lock].locked=!layers[b.dataset.lock].locked;
    state.selected=null;state.moving=null;state.draftStart=null;clearDraft();renderLayers();drawGeometry();showGeometryCard();
  });
  for(const [id,locked] of [['lock-all',true],['unlock-all',false]]) $('#'+id).addEventListener('click',()=>{
    Object.values(layers).forEach(l=>l.locked=locked);state.selected=null;state.moving=null;state.draftStart=null;clearDraft();renderLayers();drawGeometry();showGeometryCard();
  });
  $('#volume-navigation').addEventListener('change',e=>{if(state.volume) state.volume.panMode=e.target.value==='pan';});
  window.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName)){e.preventDefault();state.spaceHeld=true;if(state.volume)state.volume.spaceHeld=true;}});
  const releaseSpace=()=>{state.spaceHeld=false;if(state.volume)state.volume.spaceHeld=false;};
  window.addEventListener('keyup',e=>{if(e.code==='Space')releaseSpace();});
  window.addEventListener('blur',()=>{releaseSpace();state.dragging=false;state.moving=null;});
  $('#view-2d').addEventListener('click', () => setViewMode('2d'));
  $('#view-25d').addEventListener('click', () => setViewMode('25d'));
  const changeCamera = () => state.volume?.setCamera(Number($('#view-tilt').value), Number($('#view-rotation').value));
  $('#view-tilt').addEventListener('input', changeCamera);
  $('#view-rotation').addEventListener('input', changeCamera);
  document.querySelectorAll('[data-tilt]').forEach(button => button.addEventListener('click', () => { $('#view-tilt').value = button.dataset.tilt; changeCamera(); }));
  $('#tilt-minus').addEventListener('click', () => { $('#view-tilt').value = Math.max(0, Number($('#view-tilt').value)-5); changeCamera(); });
  $('#tilt-plus').addEventListener('click', () => { $('#view-tilt').value = Math.min(70, Number($('#view-tilt').value)+5); changeCamera(); });
  $('#view-source').addEventListener('change', event => { if (state.volume) { state.volume.showSource = event.target.checked; state.volume.render(); } });
  $("#enter-plan").addEventListener("click", () => { $("#cover").classList.add("is-hidden"); $("#dashboard").classList.add("is-visible"); $("#dashboard").setAttribute("aria-hidden", "false"); setTimeout(resizePlan, 250); });
  $("#back-to-cover").addEventListener("click", () => { $("#cover").classList.remove("is-hidden"); $("#dashboard").classList.remove("is-visible"); $("#dashboard").setAttribute("aria-hidden", "true"); });
  $("#zoom-in").addEventListener("click", () => zoomAt(1.2)); $("#zoom-out").addEventListener("click", () => zoomAt(0.82)); $("#fit-plan").addEventListener("click", fitPlan);
  $("#editor-toggle").addEventListener("click", toggleEditor);
  document.querySelectorAll(".tool-button").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  $("#delete-element").addEventListener("click", deleteSelected); $("#undo-edit").addEventListener("click", undo); $("#redo-edit").addEventListener("click", redo);
  $("#object-card").addEventListener("click", (event) => {
    const action = event.target.closest("[data-door-action]")?.dataset.doorAction;
    if (!action || state.selected?.kind !== "door" || !selectedEditable()) return;
    const door = state.geometry.doors.find((item) => item.id === state.selected.id);
    if (!door) return;
    beginMutation();
    if (action === "flip") door.swing = door.swing === "left" ? "right" : "left";
    if (action === "side") door.openingSide = door.openingSide === 1 ? -1 : 1;
    if (action === "toggle-leaves") { door.leafCount = door.leafCount === 2 ? 1 : 2; door.width = door.leafCount === 2 ? Math.max(88, door.width) : Math.min(48, door.width); }
    drawGeometry(); showGeometryCard();
  });
  $("#save-geometry").addEventListener("click", async () => { try { await saveGeometry(); } catch (error) { showToast(error.message, true); } });
  $("#background-opacity").addEventListener("input", (event) => { if (state.backgroundSprite) state.backgroundSprite.alpha = Number(event.target.value) / 100; });
  $("#cad-file").addEventListener("change", async (event) => { const [file] = event.target.files; if (!file) return; try { await uploadCad(file); } catch (error) { showToast(error.message, true); } event.target.value = ""; });
  window.addEventListener("keydown", (event) => {
    if (state.viewMode === '25d' || !state.editorEnabled || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if (["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); deleteSelected(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    const shortcuts = { v: "select", w: "wall", p: "partition", l: "door-left", r: "door-right", d: "door-double", o: "window" }; if (shortcuts[event.key.toLowerCase()]) setTool(shortcuts[event.key.toLowerCase()]);
    if (event.key === "Escape") setTool("select");
  });
  window.addEventListener("resize", () => setTimeout(resizePlan, 100));
}

async function setViewMode(mode) {
  if (!state.app || mode === state.viewMode || state.viewLoading) return;
  if (mode === '25d') {
    if (state.dirty) return showToast('Сначала нажмите «Сохранить геометрию», затем включите объёмный вид');
    state.viewLoading = true;
    try {
      const saved = await loadJson('/api/geometry', 'Не удалось прочитать сохранённый план');
      if (!saved.walls.length) return showToast('Добавьте и сохраните стены для объёмного просмотра');
      if (!state.volume) state.volume = new Plan25D($('#plan-25d'), (tilt, rotation, zoom) => {
        $('#view-tilt').value = Math.round(tilt); $('#tilt-value').textContent = `${Math.round(tilt)}°`;
        $('#view-rotation').value = Math.round(rotation); $('#rotation-value').textContent = `${Math.round(rotation)}°`;
        $('#zoom-label').textContent = `${Math.round(zoom*100)}%`;
      });
      state.volume.setModel(saved, state.project.floorPlan);
      state.volume.panMode=$('#volume-navigation').value==='pan';
      $('#view-25d-info').textContent = `Сохранённый план: ${saved.walls.length} стен и перегородок, ${saved.doors.length} дверей, ${(saved.windows || []).length} окон. Основание — прямоугольная подставка; контур пола ещё не выделен.`;
    } catch(error) { showToast(error.message, true); return; }
    finally { state.viewLoading = false; }
  }
  state.viewMode = mode;
  const volume = mode === '25d';
  state.draftStart = null; state.moving = null; clearDraft();
  document.body.classList.toggle('view-25d', volume);
  $('#view-25d-settings').hidden = !volume;
  $('#plan-25d').hidden = !volume;
  state.app.canvas.style.display = volume ? 'none' : 'block';
  $('#view-2d').setAttribute('aria-pressed', String(!volume));
  $('#view-25d').setAttribute('aria-pressed', String(volume));
  $('#editor-toggle').disabled = volume;
  if (state.volume) { state.volume.active = volume; state.volume.render(); }
  if (volume) setEditorHint('2.5D · сохранённая геометрия');
  else { setTool('select'); resizePlan(); }
}

async function start() {
  bindInterface();
  try {
    await loadProject(); await initializePixi();
    if (new URLSearchParams(location.search).get("editor") === "1") {
      $("#cover").classList.add("is-hidden");
      $("#cover").style.display = "none";
      $("#dashboard").classList.add("is-visible");
      $("#dashboard").style.opacity = "1";
      $("#dashboard").setAttribute("aria-hidden", "false");
      toggleEditor();
      setTimeout(resizePlan, 100);
    }
  }
  catch (error) { $("#loading").innerHTML = `<p>${escapeHtml(error.message)}</p>`; showToast(error.message, true); }
}

start();
