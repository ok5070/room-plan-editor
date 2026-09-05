const state = {
  app: null,
  world: null,
  project: null,
  equipment: [],
  markers: [],
  scale: 1,
  minScale: 0.25,
  maxScale: 4,
  dragging: false,
  dragStart: null,
  worldStart: null,
};

const $ = (selector) => document.querySelector(selector);

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function statusText(status) {
  return ({
    online: "в сети",
    attention: "требует внимания",
    closed: "закрыта",
    open: "открыта",
    not_configured: "не настроен",
  })[status] || status || "—";
}

async function loadProject() {
  const response = await fetch("/api/project");
  if (!response.ok) throw new Error("Не удалось загрузить данные проекта");
  state.project = await response.json();
  state.equipment = state.project.equipment;
  fillProjectText();
}

function fillProjectText() {
  const { project } = state.project;
  $("#cover-object").textContent = project.object;
  $("#cover-address").textContent = project.address;
  $("#project-object").textContent = project.object;
  $("#project-address").textContent = project.address;
  $("#revision").textContent = project.revision;
}

async function initializePixi() {
  const container = $("#floor-plan-container");
  state.app = new PIXI.Application();
  await state.app.init({
    resizeTo: container,
    antialias: true,
    backgroundColor: 0xd8dcda,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  container.prepend(state.app.canvas);
  state.world = new PIXI.Container();
  state.app.stage.addChild(state.world);
  drawPlan();
  bindCanvasNavigation();
  fitPlan();
  $("#loading").classList.add("is-hidden");
}

function drawPlan() {
  state.world.removeChildren();
  state.markers = [];
  const { floorPlan } = state.project;

  const paper = new PIXI.Graphics();
  paper.rect(0, 0, floorPlan.width, floorPlan.height).fill({ color: 0xe4e7e4 });
  state.world.addChild(paper);

  const grid = new PIXI.Graphics();
  for (let x = 0; x <= floorPlan.width; x += 50) grid.moveTo(x, 0).lineTo(x, floorPlan.height);
  for (let y = 0; y <= floorPlan.height; y += 50) grid.moveTo(0, y).lineTo(floorPlan.width, y);
  grid.stroke({ width: 1, color: 0x9aa9a7, alpha: 0.16 });
  state.world.addChild(grid);

  const rooms = new PIXI.Graphics();
  floorPlan.rooms.forEach((room) => {
    rooms.rect(room.x, room.y, room.width, room.height).fill({ color: 0xf2f3f0, alpha: 0.75 }).stroke({ width: 5, color: 0x34494d });
    const label = new PIXI.Text({
      text: room.label.toUpperCase(),
      style: { fontFamily: "Manrope, sans-serif", fontSize: 13, fontWeight: "600", fill: 0x6e7d7e, letterSpacing: 1.2 },
    });
    label.position.set(room.x + 18, room.y + 18);
    state.world.addChild(label);
  });
  state.world.addChildAt(rooms, 2);

  const title = new PIXI.Text({
    text: "ПЛАН ЭТАЖА 01  /  ДЕМОНСТРАЦИОННАЯ СХЕМА",
    style: { fontFamily: "Manrope, sans-serif", fontSize: 12, fontWeight: "700", fill: 0x526669, letterSpacing: 1.5 },
  });
  title.position.set(80, 46);
  state.world.addChild(title);

  state.equipment.forEach((item) => state.world.addChild(createMarker(item)));
  updateVisibleCount();
}

function createMarker(item) {
  const marker = new PIXI.Container();
  marker.position.set(item.x, item.y);
  marker.eventMode = "static";
  marker.cursor = "pointer";
  marker.label = item.type;

  const halo = new PIXI.Graphics();
  const shape = new PIXI.Graphics();
  if (item.type === "controller") {
    halo.circle(0, 0, 22).fill({ color: 0x42d1c5, alpha: 0.15 });
    shape.circle(0, 0, 11).fill({ color: item.status === "attention" ? 0xf4bd5c : 0x1b8f88 }).stroke({ width: 3, color: 0xffffff });
  } else {
    halo.rect(-17, -17, 34, 34).fill({ color: 0xf4bd5c, alpha: 0.12 });
    shape.rect(-9, -9, 18, 18).fill({ color: 0xf4bd5c }).stroke({ width: 3, color: 0xffffff });
    shape.rotation = Math.PI / 4;
  }

  const label = new PIXI.Text({
    text: item.id,
    style: { fontFamily: "Manrope, sans-serif", fontSize: 12, fontWeight: "700", fill: 0x1b3034 },
  });
  label.anchor.set(0.5, 0);
  label.position.set(0, 22);
  marker.addChild(halo, shape, label);
  marker.on("pointertap", (event) => {
    event.stopPropagation();
    selectEquipment(item, marker);
  });
  marker.on("pointerover", () => { marker.scale.set(1.15); });
  marker.on("pointerout", () => { marker.scale.set(1); });
  state.markers.push(marker);
  return marker;
}

function selectEquipment(item, marker) {
  state.markers.forEach((candidate) => { candidate.alpha = candidate === marker ? 1 : 0.56; });
  const type = item.type === "controller" ? "Контроллер" : "Дверь";
  const relationLabel = item.type === "controller" ? "Двери" : "Контроллер";
  const relationValue = item.connections?.join(", ") || item.controller || "—";
  $("#object-card").innerHTML = `
    <div class="object-card__content">
      <div class="object-card__head">
        <h3>${escapeHtml(item.id)}</h3>
        <span class="status-badge status-badge--${escapeHtml(item.status)}">${escapeHtml(statusText(item.status))}</span>
      </div>
      <dl>
        <dt>Тип</dt><dd>${type}</dd>
        <dt>Зона</dt><dd>${escapeHtml(item.zone || item.layer || "—")}</dd>
        <dt>Модель</dt><dd>${escapeHtml(item.model || item.block || "—")}</dd>
        <dt>${relationLabel}</dt><dd>${escapeHtml(relationValue)}</dd>
        <dt>X / Y</dt><dd>${Number(item.x).toFixed(1)} / ${Number(item.y).toFixed(1)}</dd>
      </dl>
    </div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function fitPlan() {
  if (!state.app || !state.project) return;
  const { width, height } = state.project.floorPlan;
  const viewWidth = state.app.screen.width;
  const viewHeight = state.app.screen.height;
  state.scale = Math.min((viewWidth - 80) / width, (viewHeight - 80) / height);
  state.scale = Math.max(state.minScale, state.scale);
  state.world.scale.set(state.scale);
  state.world.position.set((viewWidth - width * state.scale) / 2, (viewHeight - height * state.scale) / 2);
  updateZoomLabel();
}

function zoomAt(factor, clientX, clientY) {
  const rect = state.app.canvas.getBoundingClientRect();
  const pointerX = clientX ?? rect.left + rect.width / 2;
  const pointerY = clientY ?? rect.top + rect.height / 2;
  const screenX = pointerX - rect.left;
  const screenY = pointerY - rect.top;
  const oldScale = state.scale;
  const newScale = Math.max(state.minScale, Math.min(state.maxScale, oldScale * factor));
  const localX = (screenX - state.world.x) / oldScale;
  const localY = (screenY - state.world.y) / oldScale;
  state.scale = newScale;
  state.world.scale.set(newScale);
  state.world.position.set(screenX - localX * newScale, screenY - localY * newScale);
  updateZoomLabel();
}

function updateZoomLabel() {
  $("#zoom-label").textContent = `${Math.round(state.scale * 100)}%`;
}

function bindCanvasNavigation() {
  const canvas = state.app.canvas;
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.12 : 0.89, event.clientX, event.clientY);
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    state.dragging = true;
    state.dragStart = { x: event.clientX, y: event.clientY };
    state.worldStart = { x: state.world.x, y: state.world.y };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const localX = (event.clientX - rect.left - state.world.x) / state.scale;
    const localY = (event.clientY - rect.top - state.world.y) / state.scale;
    $("#cursor-coordinates").textContent = `${localX.toFixed(0)} / ${localY.toFixed(0)}`;
    if (!state.dragging) return;
    state.world.position.set(
      state.worldStart.x + event.clientX - state.dragStart.x,
      state.worldStart.y + event.clientY - state.dragStart.y,
    );
  });
  const stopDragging = () => { state.dragging = false; };
  canvas.addEventListener("pointerup", stopDragging);
  canvas.addEventListener("pointercancel", stopDragging);
  canvas.addEventListener("pointerleave", () => { $("#cursor-coordinates").textContent = "— / —"; });
}

function updateVisibleCount() {
  const enabled = new Set([...document.querySelectorAll(".layer-toggle:checked")].map((input) => input.dataset.layer));
  let visible = 0;
  state.markers.forEach((marker) => {
    marker.visible = enabled.has(marker.label);
    if (marker.visible) visible += 1;
  });
  $("#visible-count").textContent = `${visible} ${visible === 1 ? "объект" : visible < 5 ? "объекта" : "объектов"}`;
}

async function uploadCad(file) {
  const formData = new FormData();
  formData.append("file", file);
  showToast(`Читаем ${file.name.toLowerCase().endsWith(".dwg") ? "DWG" : "DXF"}…`);
  const response = await fetch("/api/parse-cad", { method: "POST", body: formData });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || "Ошибка чтения DXF");
  if (!result.equipment.length) {
    showToast("Файл прочитан, но блоки СКУД не найдены. Проверьте названия слоёв.", true);
    return;
  }
  state.equipment = normalizeDxfCoordinates(result.equipment, result.bounds);
  $("#source-label").textContent = file.name;
  drawPlan();
  fitPlan();
  showToast(`Найдено: ${result.summary.controllers} контроллера, ${result.summary.doors} дверей`);
}

function normalizeDxfCoordinates(items, bounds) {
  if (!bounds) return items;
  const target = state.project.floorPlan;
  const sourceWidth = Math.max(bounds.maxX - bounds.minX, 1);
  const sourceHeight = Math.max(bounds.maxY - bounds.minY, 1);
  const padding = 100;
  const factor = Math.min((target.width - padding * 2) / sourceWidth, (target.height - padding * 2) / sourceHeight);
  return items.map((item) => ({
    ...item,
    originalX: item.x,
    originalY: item.y,
    x: padding + (item.x - bounds.minX) * factor,
    y: target.height - padding - (item.y - bounds.minY) * factor,
  }));
}

function bindInterface() {
  $("#enter-plan").addEventListener("click", () => {
    $("#cover").classList.add("is-hidden");
    $("#dashboard").classList.add("is-visible");
    $("#dashboard").setAttribute("aria-hidden", "false");
    window.setTimeout(fitPlan, 250);
  });
  $("#back-to-cover").addEventListener("click", () => {
    $("#cover").classList.remove("is-hidden");
    $("#dashboard").classList.remove("is-visible");
    $("#dashboard").setAttribute("aria-hidden", "true");
  });
  $("#zoom-in").addEventListener("click", () => zoomAt(1.2));
  $("#zoom-out").addEventListener("click", () => zoomAt(0.82));
  $("#fit-plan").addEventListener("click", fitPlan);
  document.querySelectorAll(".layer-toggle").forEach((toggle) => toggle.addEventListener("change", updateVisibleCount));
  $("#cad-file").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try { await uploadCad(file); } catch (error) { showToast(error.message, true); }
    event.target.value = "";
  });
  window.addEventListener("resize", () => window.setTimeout(fitPlan, 100));
}

async function start() {
  bindInterface();
  try {
    await loadProject();
    await initializePixi();
  } catch (error) {
    $("#loading").innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    showToast(error.message, true);
  }
}

start();
