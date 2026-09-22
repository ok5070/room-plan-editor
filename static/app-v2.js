const state = {
  app: null, world: null, project: null, cadAreas: [],
  geometry: { version: 2, canvas: {}, walls: [], doors: [], windows: [] },
  equipment: [], markers: [], equipmentLayer: null, cadPreview: null, cadPreviewMaster: null, cadLayer: null, gridLayer: null, geometryLayer: null, stagingLayer: null, recognitionLayer: null, draftLayer: null, backgroundSprite: null,
  scale: 1, minScale: 0.12, maxScale: 6,
  dragging: false, dragStart: null, worldStart: null,
  editorEnabled: false, tool: "select", draftStart: null, selected: null, moving: null,
  history: [], future: [], dirty: false, equipmentDirty: false, savedGeometry: null, savedEquipment: null,
  viewMode: '2d', volume: null, stagingGeometry: null, audit: null, cadAppliedLayout: null, cadLayoutsCollapsed: false,
  modelVersion: 0, doorSampleMode: false, doorSampleStart: null, doorSampleCurrent: null,
  doorDetectionRun: null, doorCandidates: [], manualDoorLeafCount: 1,
  projectId: new URLSearchParams(location.search).get('project') || 'initial',
};

const $ = (selector) => document.querySelector(selector);
const clone = (value) => JSON.parse(JSON.stringify(value));
const equipmentCatalog = {
  access_point:{name:'Точка доступа',prefix:'ТД',symbol:'ТД',color:0x168d8a,mount:'door',height:1200},
  controller:{name:'Контроллер доступа',prefix:'AR',symbol:'AR',color:0x176f9f,mount:'wall',height:2200},
  reader:{name:'Считыватель',prefix:'YK',symbol:'СЧ',color:0x168d8a,mount:'wall',height:1200},
  exit_button:{name:'Кнопка «Выход»',prefix:'BGV',symbol:'В',color:0x3e9b62,mount:'wall',height:1200},
  emergency_release:{name:'Аварийная разблокировка',prefix:'BGM',symbol:'АВ',color:0xc54b46,mount:'wall',height:1200},
  lock:{name:'Электромагнитный замок',prefix:'UG',symbol:'З',color:0x687a80,mount:'door',height:2050},
  door_contact:{name:'Магнитоконтактный извещатель',prefix:'BGB',symbol:'Д',color:0x687a80,mount:'door',height:2050},
  door_closer:{name:'Дверной доводчик',prefix:'Доводчик',symbol:'ДВ',color:0x687a80,mount:'door',height:1980},
  power_supply:{name:'Источник питания',prefix:'R',symbol:'ИП',color:0xd78b24,mount:'wall',height:2200},
  battery:{name:'Аккумулятор',prefix:'АКБ',symbol:'АК',color:0xd78b24,mount:'cabinet',height:2200},
  junction_box:{name:'Соединительная коробка',prefix:'КС',symbol:'КС',color:0x687a80,mount:'wall',height:2200},
  intercom_panel:{name:'Вызывная панель домофона',prefix:'ДП',symbol:'ДП',color:0x7557b7,mount:'wall',height:1500},
  intercom_monitor:{name:'Монитор домофона',prefix:'ВМ',symbol:'ВМ',color:0x7557b7,mount:'wall',height:1500},
  camera:{name:'Камера видеонаблюдения',prefix:'КМ',symbol:'КМ',color:0xb14d68,mount:'wall',height:3000,system:'СОТ'},
  data_outlet:{name:'Информационная розетка',prefix:'ИР',symbol:'RJ',color:0x3976a8,mount:'wall',height:300,system:'СКС'},
  wifi_access_point:{name:'Точка Wi‑Fi',prefix:'AP',symbol:'Wi',color:0x3976a8,mount:'ceiling',height:2800,system:'СКС'},
  network_switch:{name:'Сетевой коммутатор',prefix:'SW',symbol:'SW',color:0x3976a8,mount:'cabinet',height:1200,system:'СКС'},
  patch_panel:{name:'Патч-панель',prefix:'PP',symbol:'PP',color:0x3976a8,mount:'cabinet',height:1200,system:'СКС'},
  rack:{name:'Телекоммуникационный шкаф',prefix:'ШТ',symbol:'ШТ',color:0x52636d,mount:'free',height:0,system:'СКС'},
};
const systemLabels={skud_intercom:'СКУД / домофония',cctv:'СОТ',sks:'СКС',architecture:'Архитектура'};
const layerNames = {cad:'CAD-подложка', wall:'Стены', partition:'Перегородки', door:'Двери / проёмы', window:'Окна', background:'PDF/изображение', controller:'Оборудование'};
const layers = Object.fromEntries(Object.keys(layerNames).map(k => [k,{visible:true,locked:k==='background'||k==='cad'}]));
function editable(layer) { return layers[layer].visible && !layers[layer].locked; }
function selectedEditable() {
  if (!state.selected) return false;
  if (state.selected.kind === 'equipment') return editable('controller');
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

function doorReviewSummary(doors = []) {
  const pending = doors.filter((door) => door.swing === 'unknown').length;
  return { total: doors.length, pending, confirmed: doors.length - pending };
}

async function loadJson(url, errorMessage) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(errorMessage);
  return response.json();
}

async function loadProject() {
  const projects = await loadJson('/api/projects', 'Не удалось прочитать список проектов');
  $('#project-list').innerHTML = projects.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  const record = await loadJson(`/api/projects/${encodeURIComponent(state.projectId)}`, 'Не удалось загрузить проект');
  state.project = record.project; state.geometry = record.geometry;
  state.modelVersion = Number(record.model_version) || 0;
  state.cadPreview = record.cadPreview || null; state.cadPreviewMaster = record.cadPreviewMaster || record.cadPreview || null; state.cadAreas = record.cadAreas || [];
  $('#project-list').value=state.projectId;
  renderProjectFiles(record.files);
  state.cadAppliedLayout=record.cadAppliedLayout||null;
  renderCadLayouts(record.cadLayouts, record.cadSelectedLayout, state.cadAppliedLayout);
  state.geometry.windows ||= [];
  state.geometry.doors.forEach((door) => { door.leafCount = door.leafCount === 2 ? 2 : 1; door.readerCount = door.readerCount === 2 ? 2 : 1; door.accessPointCode ||= null; });
  state.equipment = state.project.equipment || [];
  state.equipment=state.equipment.map(item=>({...item,code:item.code||item.id,mount:item.mount||'free',mountingHeight:item.mountingHeight??1200,status:item.status==='confirmed'?'confirmed':'proposed',...(item.type==='controller'?{formFactor:item.formFactor||'wall_enclosure',controllerDoorCapacity:item.controllerDoorCapacity||4,controllerReaderCapacity:item.controllerReaderCapacity||8,servedDoorIds:item.servedDoorIds||[]}:{})}));
  state.savedGeometry=clone(state.geometry); state.savedEquipment=clone(state.equipment);
  setEquipmentDirty(false);
  const { project } = state.project;
  $("#cover-object").textContent = project.object;
  $("#cover-address").textContent = project.address;
  $("#project-object").textContent = project.object;
  $("#project-address").textContent = project.address;
  $("#revision").textContent = project.revision;
  $('#floor-plan-title').textContent=state.project.floorPlan.name || 'План этажа';
  $("#source-label").textContent = state.cadPreview ? 'CAD-подложка · '+state.cadPreview.layers.length+' слоёв' : state.project.floorPlan.backgroundImage ? 'Проектная подложка' : 'Без подложки';
  updateSourceViewAvailability();
  await loadLatestDoorDetection();
}

async function loadLatestDoorDetection() {
  try {
    const result = await loadJson(`/api/projects/${encodeURIComponent(state.projectId)}/door-detection-runs/latest`, 'Не удалось загрузить результаты поиска дверей');
    state.modelVersion = Number(result.model_version) || state.modelVersion;
    setDoorDetectionRun(result.run?.status === 'pending' ? result.run : null);
  } catch (error) {
    setDoorDetectionRun(null);
  }
}

function setDoorDetectionRun(run) {
  state.doorDetectionRun = run;
  state.doorCandidates = run?.candidates || [];
  const count = state.doorCandidates.length;
  $('#door-accept-candidates').hidden = !count;
  $('#door-reject-candidates').hidden = !count;
  $('#door-candidate-count').textContent = count ? `Найдено: ${count}` : '';
  drawDoorRecognition();
}

function hasSourceUnderlay() {
  return Boolean(state.cadPreview || state.project?.floorPlan?.backgroundImage);
}

function updateSourceViewAvailability() {
  const button = $('#view-source-only');
  if (!button) return;
  button.disabled = !hasSourceUnderlay();
  button.title = button.disabled ? 'В проекте пока нет CAD, PDF или изображения' : 'Показать только исходную подложку';
}

function syncPlanLayerVisibility() {
  const sourceOnly = state.viewMode === 'source';
  if (state.backgroundSprite) state.backgroundSprite.visible = sourceOnly || layers.background.visible;
  if (state.cadLayer) state.cadLayer.visible = sourceOnly || layers.cad.visible;
  if (state.gridLayer) state.gridLayer.visible = !sourceOnly;
  if (state.geometryLayer) state.geometryLayer.visible = !sourceOnly;
  if (state.equipmentLayer) state.equipmentLayer.visible = !sourceOnly;
  if (state.draftLayer) state.draftLayer.visible = !sourceOnly;
  if (state.stagingLayer) state.stagingLayer.visible = !sourceOnly;
  if (state.recognitionLayer) state.recognitionLayer.visible = state.viewMode !== '25d';
}

function renderProjectFiles(files) {
  $('#project-files').innerHTML=files.length ? files.map(f=>`<li><a href="${escapeHtml(f.url)}" download>${escapeHtml(f.name)}</a></li>`).join('') : '<li>Файлы пока не загружены</li>';
}

function cadLayoutStorageKey() { return `room-plan:cad-layouts-collapsed:${state.projectId}`; }
function setCadLayoutsCollapsed(collapsed, persist = true) {
  state.cadLayoutsCollapsed=Boolean(collapsed);
  const gallery=$('#cad-layout-gallery'),button=$('#cad-layout-toggle');
  if(gallery)gallery.hidden=state.cadLayoutsCollapsed;
  if(button){button.setAttribute('aria-expanded',String(!state.cadLayoutsCollapsed));button.textContent=state.cadLayoutsCollapsed?'Развернуть':'Свернуть';}
  if(persist&&typeof localStorage!=='undefined')localStorage.setItem(cadLayoutStorageKey(),state.cadLayoutsCollapsed?'1':'0');
}

function renderCadLayouts(layouts, selected, applied = state.cadAppliedLayout) {
  const picker=$('#cad-layout-picker'), select=$('#cad-layout-select');
  if(!picker||!select) return;
  const names=Array.isArray(layouts)?layouts:[];
  state.cadSelectedLayout=selected||null; state.cadPendingLayout=selected||null;
  picker.hidden=names.length===0;
  const gallery=$('#cad-layout-gallery');
  gallery.innerHTML=names.map(name=>`<button type="button" class="cad-layout-card" data-cad-layout="${escapeHtml(name)}"><canvas width="220" height="130"></canvas><span>${escapeHtml(name)}</span></button>`).join('');
  select.innerHTML=(selected&&names.includes(selected)?'': '<option value="">Выберите лист со схемой</option>')+names.map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if(selected&&names.includes(selected)) select.value=selected; else select.value='';
  gallery.querySelectorAll('[data-cad-layout]').forEach(card=>card.classList.toggle('is-selected',card.dataset.cadLayout===selected));
  gallery.querySelectorAll('canvas').forEach(canvas=>drawCadThumbnail(canvas, canvas.closest('[data-cad-layout]')?.dataset.cadLayout));
  $('#cad-layout-apply').disabled=!selected || state.cadPendingLayout===applied;
  const saved=typeof localStorage!=='undefined'?localStorage.getItem(cadLayoutStorageKey()):null;
  setCadLayoutsCollapsed(saved===null?state.cadLayoutsCollapsed:saved==='1',false);
}

function drawCadThumbnail(canvas, areaName) {
  const preview=state.cadPreviewMaster||state.cadPreview, ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height); ctx.fillStyle='#e9eeeb'; ctx.fillRect(0,0,canvas.width,canvas.height);
  if(!preview?.paths?.length) return;
  const area=state.cadAreas?.find(item=>item.name===areaName);
  const bounds=area?.bounds||preview.bounds||{minX:0,minY:0,maxX:state.project.floorPlan.width,maxY:state.project.floorPlan.height};
  const scale=Math.min((canvas.width-12)/Math.max(1,bounds.maxX-bounds.minX),(canvas.height-12)/Math.max(1,bounds.maxY-bounds.minY));
  const point=p=>[6+(p[0]-bounds.minX)*scale,canvas.height-6-(p[1]-bounds.minY)*scale];
  ctx.strokeStyle='#42636a';ctx.lineWidth=1;
  let paths=preview.paths;
  if(area) paths=area.pathIndexes.map(index=>preview.paths[index]).filter(Boolean);
  paths.slice(0,400).forEach(path=>{if(path.points.length<2)return;ctx.beginPath();path.points.forEach((p,i)=>{const q=point(p);i?ctx.lineTo(q[0],q[1]):ctx.moveTo(q[0],q[1]);});ctx.stroke();});
}

function openProject(id) {
  if(state.projectBusy) return showToast('Дождитесь завершения загрузки файла');
  if(state.dirty||state.equipmentDirty) return showToast('Сначала сохраните изменения текущего проекта');
  const url=new URL(location.href);url.searchParams.set('project',id);url.searchParams.set('editor','1');
  location.href=url.href;
}

async function attachProjectFile(file) {
  const data=new FormData();data.append('file',file);
  const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/files`,{method:'POST',body:data});
  const result=await response.json();if(!response.ok) throw new Error(result.detail || 'Не удалось сохранить файл');
  const record=await loadJson(`/api/projects/${encodeURIComponent(state.projectId)}`,'Не удалось обновить список файлов');
  renderProjectFiles(record.files);
  return result;
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
  drawCadPreview();
  const grid = new PIXI.Graphics();
  for (let x = 0; x <= floorPlan.width; x += 50) grid.moveTo(x, 0).lineTo(x, floorPlan.height);
  for (let y = 0; y <= floorPlan.height; y += 50) grid.moveTo(0, y).lineTo(floorPlan.width, y);
  grid.stroke({ width: 1, color: 0x527176, alpha: 0.08 });
  state.gridLayer = grid;
  state.world.addChild(grid);
  state.geometryLayer = new PIXI.Container();
  state.equipmentLayer = new PIXI.Container();
  state.draftLayer = new PIXI.Container();
  state.world.addChild(state.geometryLayer, state.equipmentLayer, state.draftLayer);
  state.stagingLayer = new PIXI.Container();
  state.world.addChild(state.stagingLayer);
  state.recognitionLayer = new PIXI.Container();
  state.world.addChild(state.recognitionLayer);
  drawGeometry();
  drawEquipment();
  drawStagingGeometry();
  drawDoorRecognition();
  syncPlanLayerVisibility();
  updateVisibleCount();
}

function cadColor(layer) {
  const name=String(layer).toLowerCase();
  if(name.includes('fire') || name.includes('пож')) return 0xc54b46;
  if(name.includes('сот') || name.includes('cctv')) return 0x287cad;
  if(name.includes('оборуд')) return 0x167f7b;
  return 0x52646a;
}

function drawCadPreview() {
  state.cadLayer=new PIXI.Container();
  state.cadLayer.label='CAD preview (locked)';
  if(state.cadPreview) {
    const groups=new Map();
    state.cadPreview.paths.forEach(path=>{
      const color=cadColor(path.layer);
      if(!groups.has(color)) groups.set(color,new PIXI.Graphics());
      const g=groups.get(color), points=path.points;
      g.moveTo(points[0][0],points[0][1]);
      for(let i=1;i<points.length;i++) g.lineTo(points[i][0],points[i][1]);
      if(path.closed) g.closePath();
    });
    groups.forEach((g,color)=>{g.stroke({width:1.35,color,alpha:.82});state.cadLayer.addChild(g);});
    state.cadPreview.labels.forEach(label=>{
      const text=new PIXI.Text({text:label.text,style:{fontFamily:'Manrope, sans-serif',fontSize:label.height,fill:cadColor(label.layer)}});
      text.position.set(label.x,label.y);text.rotation=(label.rotation||0)*Math.PI/180;text.alpha=.72;
      state.cadLayer.addChild(text);
    });
  }
  state.cadLayer.visible=layers.cad.visible;
  state.cadLayer.alpha=Number($('#background-opacity').value)/100;
  state.world.addChild(state.cadLayer);
}

function visualWallStrokeWidth(wall) { return Math.max(1.5, Math.min(4, (Number(wall.thickness) || 13) / 4)); }

function drawGeometry() {
  if (!state.geometryLayer) return;
  state.geometryLayer.removeChildren();
  state.geometry.walls.forEach((wall) => {
    if (!layers[wall.type].visible) return;
    const selected = state.selected?.kind === "wall" && state.selected.id === wall.id;
    const g = new PIXI.Graphics();
    g.moveTo(wall.x1, wall.y1).lineTo(wall.x2, wall.y2).stroke({ width: visualWallStrokeWidth(wall), color: selected ? 0xf4bd5c : wall.type === "partition" ? 0x169b91 : 0x243c63, alpha: 0.96 });
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
    if (door.swing === 'unknown') {
      g.moveTo(-half, -7).lineTo(-half, 7).moveTo(half, -7).lineTo(half, 7).stroke({ width: 3, color: doorColor });
    } else if (door.leafCount === 2) {
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
  if (state.backgroundSprite) state.backgroundSprite.visible=state.viewMode === 'source' || layers.background.visible;
  if (state.cadLayer) state.cadLayer.visible=state.viewMode === 'source' || layers.cad.visible;
  state.markers.forEach(marker=>{marker.visible=layers.controller.visible;});
}

function drawStagingGeometry() {
  if (!state.stagingLayer) return;
  state.stagingLayer.removeChildren();
  if (!state.stagingGeometry) return;
  state.stagingGeometry.walls.forEach((wall) => {
    const g = new PIXI.Graphics();
    const color = wall.type === 'partition' ? 0x38dbd0 : wall.reviewHint === 'thin_parallel_pair' ? 0xf4d06f : 0xff9f43;
    g.moveTo(wall.x1, wall.y1).lineTo(wall.x2, wall.y2).stroke({ width: visualWallStrokeWidth(wall), color, alpha: 0.78, cap: 'round' });
    state.stagingLayer.addChild(g);
  });
  state.stagingGeometry.doors.forEach((door) => {
    const holder = new PIXI.Container(); holder.position.set(door.x, door.y); holder.rotation = door.rotation || 0;
    const g = new PIXI.Graphics(); const half = door.width / 2;
    g.moveTo(-half, 0).lineTo(half, 0).stroke({ width: 22, color: 0xffe0a3, alpha: 0.9 });
    g.moveTo(-half, -2).lineTo(half, -2).stroke({ width: 5, color: 0xff9f43, alpha: 0.95 });
    holder.addChild(g); state.stagingLayer.addChild(holder);
  });
  state.stagingGeometry.windows.forEach((windowItem) => {
    const holder = new PIXI.Container(); holder.position.set(windowItem.x, windowItem.y); holder.rotation = windowItem.rotation || 0;
    const g = new PIXI.Graphics(); const half = windowItem.width / 2;
    g.moveTo(-half, -7).lineTo(half, -7).moveTo(-half, 7).lineTo(half, 7).stroke({ width: 5, color: 0x8ce8ff, alpha: 0.95 });
    holder.addChild(g); state.stagingLayer.addChild(holder);
  });
}

function drawDoorRecognition() {
  if (!state.recognitionLayer) return;
  state.recognitionLayer.removeChildren();
  state.doorCandidates.forEach(candidate => {
    const holder = new PIXI.Container();
    holder.position.set(candidate.x, candidate.y); holder.rotation = candidate.rotation || 0;
    const g = new PIXI.Graphics(), half = candidate.width / 2;
    g.moveTo(-half, -10).lineTo(-half, 10).moveTo(half, -10).lineTo(half, 10).stroke({width:4,color:0xd84ed8,alpha:.95});
    g.moveTo(-half, 0).lineTo(half, 0).stroke({width:2,color:0xd84ed8,alpha:.72});
    g.circle(0,0,4).fill({color:0xd84ed8}).stroke({width:1,color:0xffffff});
    holder.addChild(g); state.recognitionLayer.addChild(holder);
  });
  if (state.doorSampleStart && state.doorSampleCurrent) {
    const minX=Math.min(state.doorSampleStart.x,state.doorSampleCurrent.x),minY=Math.min(state.doorSampleStart.y,state.doorSampleCurrent.y);
    const width=Math.abs(state.doorSampleCurrent.x-state.doorSampleStart.x),height=Math.abs(state.doorSampleCurrent.y-state.doorSampleStart.y);
    const frame=new PIXI.Graphics().rect(minX,minY,width,height).fill({color:0x42d1c5,alpha:.08}).stroke({width:3,color:0x42d1c5,alpha:.95});
    state.recognitionLayer.addChild(frame);
  }
}

function createMarker(item) {
  const marker = new PIXI.Container();
  marker.position.set(item.x, item.y);
  marker.label = item.type;
  const definition=equipmentCatalog[item.type]||{name:item.type,symbol:'•',color:0x6b7d82};
  const selected=state.selected?.kind==='equipment'&&state.selected.id===item.id;
  const shape = new PIXI.Graphics();
  const size=['controller','power_supply','battery','intercom_monitor'].includes(item.type)?14:10;
  shape.roundRect(-size,-size,size*2,size*2,3).fill({color:selected?0xf4bd5c:definition.color}).stroke({width:selected?4:2,color:0xffffff});
  const icon=new PIXI.Text({text:definition.symbol,style:{fontFamily:'Manrope, sans-serif',fontSize:size*.78,fontWeight:'700',fill:0xffffff}});
  icon.anchor.set(.5);icon.position.set(0,0);
  const label = new PIXI.Text({ text: item.code||item.id, style: { fontFamily: "Manrope, sans-serif", fontSize: 11, fontWeight: "700", fill: 0x1b3034 } });
  label.anchor.set(0.5, 0); label.position.set(0, size+6);
  marker.addChild(shape,icon,label); state.markers.push(marker); return marker;
}

function drawEquipment() {
  if(typeof DoorMount!=='undefined')state.equipment.forEach(item=>{if(item.doorMount)Object.assign(item,DoorMount.resolve(item,state.geometry));});
  if(!state.equipmentLayer)return;
  state.equipmentLayer.removeChildren();state.markers=[];
  state.equipment.forEach(item=>state.equipmentLayer.addChild(createMarker(item)));
  state.equipmentLayer.visible=layers.controller.visible;
  updateVisibleCount();
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
  if(editable('controller')) state.equipment.forEach(item=>{
    const distance=Math.hypot(point.x-item.x,point.y-item.y);
    if(distance<=Math.max(tolerance,18/state.scale)&&(!best||distance<best.distance)) best={kind:'equipment',id:item.id,distance};
  });
  if(best)return best;
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

function updateAuditCard(payload, status = 'staging') {
  const metadata = payload?.metadata || {};
  const counts = state.audit?.counts && status !== 'staging' ? state.audit.counts : { walls: payload.walls?.length || 0, rooms: payload.rooms?.length || 0, doors: payload.doors?.length || 0, windows: payload.windows?.length || 0, devices: payload.devices?.length || 0 };
  state.audit = { source: metadata.source || state.audit?.source || 'geometry.v2', k: metadata.k ?? state.audit?.k ?? '—', mergedPairs: metadata.wall_detection?.centerline_merged_pairs ?? state.audit?.mergedPairs ?? 0, compoundGroups: metadata.wall_detection?.centerline_compound_groups ?? state.audit?.compoundGroups ?? 0, gapOpenings: metadata.wall_detection?.recognized_opening_gaps ?? state.audit?.gapOpenings ?? 0, pairCandidates: metadata.wall_detection?.thin_parallel_pair_candidates ?? metadata.pairCandidates ?? state.audit?.pairCandidates ?? 0, counts, status };
  $('#audit-card').hidden = false;
  const labels = { staging: 'STAGING · НЕ СОХРАНЕНО', confirmed: 'ПОДТВЕРЖДЕНО · НЕ СОХРАНЕНО', saved: 'СОХРАНЕНО В ПРОЕКТ', rejected: 'ОТКЛОНЕНО · ПРОЕКТ БЕЗ ИЗМЕНЕНИЙ' };
  $('#audit-status').textContent = labels[status] || status;
  $('#audit-status').classList.toggle('status-badge--attention', status !== 'saved');
  $('#audit-source').textContent = state.audit.source;
  $('#audit-k').textContent = state.audit.k;
  $('#audit-walls').textContent = String(counts.walls);
  $('#audit-merged-pairs').textContent = String(state.audit.mergedPairs);
  $('#audit-compound-groups').textContent = String(state.audit.compoundGroups);
  $('#audit-gap-openings').textContent = String(state.audit.gapOpenings);
  $('#audit-pair-candidates').textContent = String(state.audit.pairCandidates);
  $('#audit-rooms').textContent = String(counts.rooms);
  $('#audit-openings').textContent = `${counts.doors} / ${counts.windows}`;
  $('#audit-devices').textContent = String(counts.devices);
}

function normalizeImportedGeometry(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Файл аудита должен содержать JSON-объект');
  if (!Array.isArray(payload.walls)) throw new Error('В geometry.v2 отсутствует массив walls');
  const transform = importedGeometryTransform(payload);
  const walls = payload.walls.map((wall, index) => {
    const values = [wall.x1, wall.y1, wall.x2, wall.y2].map(Number);
    if (values.some((value) => !Number.isFinite(value))) throw new Error(`Некорректные координаты стены ${index + 1}`);
    const start = transform.point(values[0], values[1]), end = transform.point(values[2], values[3]);
    const k = Number(payload.metadata?.k);
    const gapMm = Number(wall.pairedGapMm);
    const physicalThickness = wall.source === 'cad_face_pair_centerline' && Number.isFinite(k) && k > 0 && gapMm > 0
      ? gapMm / (k * 1000) * transform.scale : Number(wall.thickness) || 13;
    return { id: String(wall.id || `W-IMP-${String(index + 1).padStart(4, '0')}`), type: wall.type === 'partition' ? 'partition' : 'wall', x1: start.x, y1: start.y, x2: end.x, y2: end.y, thickness: Math.max(2, Math.min(physicalThickness, 80)), ...(wall.reviewHint === 'thin_parallel_pair' ? { reviewHint: 'thin_parallel_pair', pairedGapMm: Number(wall.pairedGapMm) || 0 } : {}) };
  });
  const normalizeAttached = (items, kind) => (Array.isArray(items) ? items : []).map((item, index) => {
    const point = transform.point(Number(item.x), Number(item.y));
    const width = Number(item.width);
    return { ...item, id: String(item.id || `${kind.toUpperCase()}-IMP-${String(index + 1).padStart(4, '0')}`), x: point.x, y: point.y, ...(Number.isFinite(width) ? {width: width * transform.scale} : {}), rotation: transform.flipY ? -(Number(item.rotation) || 0) : Number(item.rotation) || 0, wallId: String(item.wallId || '') };
  });
  return { version: 2, canvas: { width: state.project.floorPlan.width, height: state.project.floorPlan.height }, walls, doors: normalizeAttached(payload.doors, 'door'), windows: normalizeAttached(payload.windows, 'window') };
}

function importedGeometryTransform(payload) {
  const metadata = payload.metadata || {};
  const sourceCoordinates = metadata.coordinate_system === 'source_cad';
  if (!sourceCoordinates) {
    const origin = metadata.origin || {};
    const ox = Number(origin.x) || 0, oy = Number(origin.y) || 0;
    return { point: (x, y) => ({ x: x - ox, y: y - oy }), flipY: false, mode: 'identity', scale: 1 };
  }

  const floor = state.project.floorPlan;
  const source = state.cadPreview?.sourceBounds;
  const previewTransform = state.cadPreview?.transform;
  if (source && previewTransform) {
    const scale = Number(previewTransform.scale), padding = Number(previewTransform.padding);
    if (Number.isFinite(scale) && scale > 0 && Number.isFinite(padding)) {
      return {
        point: (x, y) => ({
          x: padding + (x - Number(source.minX)) * scale,
          y: Number(floor.height) - padding - (y - Number(source.minY)) * scale,
        }),
        flipY: true,
        mode: 'cad-preview', scale,
      };
    }
  }

  const origin = metadata.origin || {};
  const ox = Number(origin.x) || 0, oy = Number(origin.y) || 0;
  const sourceWidth = Math.max(1, Number(payload.canvas?.width) || 1);
  const sourceHeight = Math.max(1, Number(payload.canvas?.height) || 1);
  const padding = 70;
  const scale = Math.min((Number(floor.width) - padding * 2) / sourceWidth, (Number(floor.height) - padding * 2) / sourceHeight);
  const left = (Number(floor.width) - sourceWidth * scale) / 2;
  const top = (Number(floor.height) - sourceHeight * scale) / 2;
  return {
    point: (x, y) => ({ x: left + (x - ox) * scale, y: top + sourceHeight * scale - (y - oy) * scale }),
    flipY: true,
    mode: 'fit-canvas', scale,
  };
}

function applyStagingGeometry(payload, sourceName = 'geometry.v2') {
  const prepared = CenterlinePairs.prepare(payload);
  const imported = normalizeImportedGeometry(prepared.payload);
  state.stagingGeometry = imported;
  updateAuditCard({ ...prepared.payload, metadata: { ...(prepared.payload.metadata || {}), source: sourceName } }, 'staging');
  state.selected = null; drawStagingGeometry(); $('#audit-actions').hidden = false;
  showToast(`Импортирован ${sourceName}: стен — ${imported.walls.length}, проёмов — ${prepared.recognizedOpenings}, проверить — ${prepared.remainingHints}`);
}

function clearStagingGeometry() { state.stagingGeometry = null; if (state.stagingLayer) state.stagingLayer.removeChildren(); $('#audit-actions').hidden = true; }
function dismissStagingGeometry() {
  clearStagingGeometry();
  if (state.audit) updateAuditCard({ walls: state.geometry.walls, doors: state.geometry.doors, windows: state.geometry.windows, metadata: state.audit }, 'rejected');
  showToast('Staging-геометрия отклонена; рабочий план не изменён');
}
function commitStagingGeometry() {
  if (!state.stagingGeometry) return;
  beginMutation(); state.geometry = clone(state.stagingGeometry); clearStagingGeometry();
  updateAuditCard({ walls: state.geometry.walls, doors: state.geometry.doors, windows: state.geometry.windows, metadata: state.audit || {} }, 'confirmed');
  state.selected = null; drawGeometry(); drawEquipment(); showGeometryCard(); setDirty(true);
  showToast('Геометрия аудита принята в рабочую модель. Нажмите «Сохранить геометрию»');
}

function nextId(prefix, items) { const ids = new Set(items.map((item) => item.id)); let n = 1; while (ids.has(`${prefix}-${String(n).padStart(3, "0")}`)) n++; return `${prefix}-${String(n).padStart(3, "0")}`; }
function snapshot() { return {geometry:clone(state.geometry),equipment:clone(state.equipment)}; }
function beginMutation(domain='geometry') { state.history.push(snapshot()); if (state.history.length > 100) state.history.shift(); state.future = []; domain==='equipment'?setEquipmentDirty(true):setDirty(true); }
function setDirty(value) { state.dirty = value; $("#save-geometry").disabled = !value; $("#edit-status").textContent = value ? "есть изменения" : state.editorEnabled ? "редактирование" : "просмотр"; updateEditorButtons(); }
function setEquipmentDirty(value) { state.equipmentDirty=value; $('#save-equipment').disabled=!value; $('#equipment-status').textContent=value?'есть изменения':`${state.equipment.length} размещено`; updateEditorButtons(); }
function refreshDirtyFromSaved() {
  setDirty(JSON.stringify(state.geometry)!==JSON.stringify(state.savedGeometry));
  setEquipmentDirty(JSON.stringify(state.equipment)!==JSON.stringify(state.savedEquipment));
}

function nextEquipmentCode(prefix) {
  const used=new Set(state.equipment.map(item=>item.code));let number=1;
  while(used.has(`${prefix}.${number}`))number++;
  return `${prefix}.${number}`;
}

function normalizeAccessPointCode(value) {
  const match=String(value||'').trim().toUpperCase().replace(/\s+/g,'').match(/^(?:ТД|TD)\.?([0-9]+)\.([0-9]+)$/);
  return match?`ТД.${Number(match[1])}.${Number(match[2])}`:null;
}

function projectEquipmentCode(type,door) {
  const accessPoint=normalizeAccessPointCode(door?.accessPointCode);
  if(!accessPoint)return null;
  if(type==='access_point')return accessPoint;
  const suffix=accessPoint.slice(3),controller=suffix.split('.')[0];
  if(type==='controller')return `AR.${controller}`;
  if(type==='power_supply')return `R${controller}`;
  if(type==='battery')return `АКБ.${controller}`;
  if(type==='door_closer')return `Поз.4 · ${accessPoint}`;
  return `${equipmentCatalog[type]?.prefix||type}${suffix}`;
}

function updateDoorEquipmentCodes(door) {
  const pointTypes=new Set(['access_point','reader','exit_button','emergency_release','lock','door_contact','door_closer','junction_box','intercom_panel']);let changed=0;
  state.equipment.filter(item=>item.hostDoorId===door.id&&pointTypes.has(item.type)).forEach(item=>{const code=projectEquipmentCode(item.type,door);if(code&&item.code!==code){item.code=code;changed++;}});
  return changed;
}

function nearestDoor(point,tolerance=Infinity) {
  let best=null;
  state.geometry.doors.forEach(door=>{
    const distance=Math.hypot(point.x-door.x,point.y-door.y);
    if(distance<=tolerance&&(!best||distance<best.distance))best={door,distance};
  });
  return best;
}

function addEquipment(point,type) {
  const definition=equipmentCatalog[type];if(!definition)return;
  const doorTypes=new Set(['access_point','reader','exit_button','emergency_release','lock','door_contact','door_closer','intercom_panel']);
  const doorTarget=doorTypes.has(type)?nearestDoor(point,70/state.scale):null;
  if(doorTypes.has(type)&&!doorTarget)return showToast('Разместите этот прибор рядом с существующей дверью',true);
  if(doorTarget&&!doorTarget.door.accessPointCode)return showToast('Сначала назначьте двери код точки доступа, например ТД.1.1',true);
  const wallTarget=nearestWall(point,70/state.scale);
  beginMutation('equipment');
  const item={id:nextId('EQ',state.equipment),system:'skud_intercom',type,code:projectEquipmentCode(type,doorTarget?.door)||nextEquipmentCode(definition.prefix),
    x:point.x,y:point.y,rotation:doorTarget?.door.rotation||wallTarget?.rotation||0,mount:definition.mount,
    mountingHeight:definition.height,hostDoorId:doorTarget?.door.id||null,hostWallId:doorTarget?.door.wallId||wallTarget?.wall.id||null,status:'proposed'};
  if(type==='controller')Object.assign(item,{formFactor:'wall_enclosure',controllerDoorCapacity:4,controllerReaderCapacity:8,servedDoorIds:[]});
  state.equipment.push(item);state.selected={kind:'equipment',id:item.id};drawEquipment();showGeometryCard();
}

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
  state.geometry.doors.push({ id: nextId("D", state.geometry.doors), wallId: target.wall.id, x: target.x, y: target.y, width: leafCount === 2 ? 88 : 48, rotation: target.rotation, swing, leafCount, readerCount:1, accessPointId: null, accessPointCode: null });
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
  if(state.selected.kind==='door'&&state.equipment.some(item=>item.hostDoorId===state.selected.id))return showToast('Сначала отвяжите оборудование от этой двери',true);
  if(state.selected.kind==='wall') {
    const doorIds=new Set(state.geometry.doors.filter(door=>door.wallId===state.selected.id).map(door=>door.id));
    if(state.equipment.some(item=>item.hostWallId===state.selected.id||doorIds.has(item.hostDoorId)))return showToast('Сначала отвяжите оборудование от стены и её дверей',true);
  }
  beginMutation(state.selected.kind==='equipment'?'equipment':'geometry');
  if (state.selected.kind === "wall") {
    state.geometry.walls = state.geometry.walls.filter((item) => item.id !== state.selected.id);
    state.geometry.doors = state.geometry.doors.filter((item) => item.wallId !== state.selected.id);
    state.geometry.windows = state.geometry.windows.filter((item) => item.wallId !== state.selected.id);
  } else if (state.selected.kind === "door") state.geometry.doors = state.geometry.doors.filter((item) => item.id !== state.selected.id);
  else if(state.selected.kind==='window') state.geometry.windows = state.geometry.windows.filter((item) => item.id !== state.selected.id);
  else {state.equipment=state.equipment.filter(item=>item.id!==state.selected.id);setEquipmentDirty(true);}
  state.selected = null; drawGeometry();drawEquipment(); showGeometryCard();
}

function restoreSnapshot(saved){state.geometry=clone(saved.geometry);state.equipment=clone(saved.equipment);state.selected=null;refreshDirtyFromSaved();drawGeometry();drawEquipment();showGeometryCard();}
function undo() { if (!state.history.length) return; state.future.push(snapshot()); restoreSnapshot(state.history.pop()); }
function redo() { if (!state.future.length) return; state.history.push(snapshot()); restoreSnapshot(state.future.pop()); }
function clearDraft() { if (state.draftLayer) state.draftLayer.removeChildren(); }
function drawDraft(point) { clearDraft(); if (!state.draftStart) return; const g = new PIXI.Graphics(); g.moveTo(state.draftStart.x, state.draftStart.y).lineTo(point.x, point.y).stroke({ width: 5, color: 0xf4bd5c, alpha: 0.9 }); g.circle(state.draftStart.x, state.draftStart.y, 8).fill({ color: 0xf4bd5c }); state.draftLayer.addChild(g); }

function handleEditorDown(event) {
  const point = worldPoint(event);
  const layer = state.tool.startsWith('door') ? 'door' : state.tool.startsWith('equipment:')?'controller':state.tool;
  if (layer !== 'select' && layers[layer] && !editable(layer)) return showToast('Сначала включите и разблокируйте слой');
  if (["wall", "partition"].includes(state.tool)) {
    if (!state.draftStart) { state.draftStart = point; drawDraft(point); setEditorHint("Укажите вторую точку"); }
    else { addWall(state.tool, state.draftStart, point); setTool(state.tool); }
    return;
  }
  if (state.tool === "door-left") return addDoor(point, "left", 1);
  if (state.tool === "door-right") return addDoor(point, "right", 1);
  if (state.tool === "door-double") return addDoor(point, "right", 2);
  if (state.tool === "door-manual") return addDoor(point, "unknown", state.manualDoorLeafCount);
  if (state.tool === "window") return addWindow(point);
  if(state.tool.startsWith('equipment:'))return addEquipment(point,state.tool.split(':')[1]);
  state.selected = nearestElement(point);
  if (selectedEditable()) state.moving = { start: point, geometry: clone(state.geometry), equipment:clone(state.equipment), started: false };
  drawGeometry();drawEquipment(); showGeometryCard();
}

function handleEditorMove(event) {
  const point = worldPoint(event); if (state.draftStart) drawDraft(point); if (!state.moving || !state.selected) return;
  if(state.selected.kind==='equipment'&&state.equipment.find(e=>e.id===state.selected.id)?.doorMount)return;
  const dx = point.x - state.moving.start.x, dy = point.y - state.moving.start.y;
  if (!state.moving.started && Math.hypot(dx, dy) < 2) return;
  if (!state.moving.started) { beginMutation(state.selected.kind==='equipment'?'equipment':'geometry'); state.moving.started = true; }
  if(state.selected.kind==='equipment') {
    const original=state.moving.equipment.find(item=>item.id===state.selected.id),item=state.equipment.find(item=>item.id===state.selected.id);
    Object.assign(item,{x:original.x+dx,y:original.y+dy});
    const door=nearestDoor(item,70/state.scale),wall=nearestWall(item,70/state.scale);
    item.hostDoorId=door?.door.id||null;item.hostWallId=door?.door.wallId||wall?.wall.id||null;item.rotation=door?.door.rotation||wall?.rotation||item.rotation;
    setEquipmentDirty(true);
  } else if (state.selected.kind === "wall") {
    const original = state.moving.geometry.walls.find((item) => item.id === state.selected.id), wall = state.geometry.walls.find((item) => item.id === state.selected.id);
    Object.assign(wall, { x1: original.x1 + dx, y1: original.y1 + dy, x2: original.x2 + dx, y2: original.y2 + dy });
    state.geometry.doors.filter((door) => door.wallId === wall.id).forEach((door) => { const originalDoor = state.moving.geometry.doors.find((item) => item.id === door.id); door.x = originalDoor.x + dx; door.y = originalDoor.y + dy; });
    state.geometry.windows.filter((windowItem) => windowItem.wallId === wall.id).forEach((windowItem) => { const originalWindow = state.moving.geometry.windows.find((item) => item.id === windowItem.id); windowItem.x = originalWindow.x + dx; windowItem.y = originalWindow.y + dy; });
    const doorIds=new Set(state.geometry.doors.filter(door=>door.wallId===wall.id).map(door=>door.id));
    state.equipment.filter(item=>item.hostWallId===wall.id||doorIds.has(item.hostDoorId)).forEach(item=>{const originalItem=state.moving.equipment.find(entry=>entry.id===item.id);item.x=originalItem.x+dx;item.y=originalItem.y+dy;});
    if(state.equipment.some(item=>item.hostWallId===wall.id||doorIds.has(item.hostDoorId)))setEquipmentDirty(true);
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
    if (target) {
      const oldX=item.x,oldY=item.y;Object.assign(item, { wallId: target.wall.id, x: target.x, y: target.y, rotation: target.rotation });
      if(state.selected.kind==='door') {
        state.equipment.filter(entry=>entry.hostDoorId===item.id).forEach(entry=>{entry.x+=item.x-oldX;entry.y+=item.y-oldY;entry.hostWallId=item.wallId;entry.rotation=item.rotation;});
        if(state.equipment.some(entry=>entry.hostDoorId===item.id))setEquipmentDirty(true);
      }
    }
  }
  drawGeometry();drawEquipment();
}

function bindCanvasNavigation() {
  const canvas = state.app.canvas;
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); zoomAt(event.deltaY < 0 ? 1.12 : 0.89, event.clientX, event.clientY); }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    if (state.viewMode === 'source' && state.doorSampleMode && event.button === 0) {
      state.doorSampleStart = worldPoint(event); state.doorSampleCurrent = state.doorSampleStart;
      drawDoorRecognition(); return;
    }
    if (state.viewMode === '2d' && state.editorEnabled && state.tool!=='pan' && !state.spaceHeld && event.button!==1) return handleEditorDown(event);
    state.dragging = true; state.dragStart = { x: event.clientX, y: event.clientY }; state.worldStart = { x: state.world.x, y: state.world.y };
  });
  canvas.addEventListener("pointermove", (event) => {
    const point = worldPoint(event); $("#cursor-coordinates").textContent = `${point.x.toFixed(0)} / ${point.y.toFixed(0)}`;
    if (state.doorSampleStart) { state.doorSampleCurrent = point; drawDoorRecognition(); return; }
    if (state.editorEnabled && !state.dragging) return handleEditorMove(event);
    if (state.dragging) state.world.position.set(state.worldStart.x + event.clientX - state.dragStart.x, state.worldStart.y + event.clientY - state.dragStart.y);
  });
  const stop = () => { state.dragging = false; state.moving = null; };
  canvas.addEventListener("pointerup", () => {
    if (state.doorSampleStart) { const end=state.doorSampleCurrent; finishDoorSample(state.doorSampleStart,end); return; }
    stop();
  });
  canvas.addEventListener("pointercancel", () => { cancelDoorSampleSelection(); stop(); });
  canvas.addEventListener("pointerleave", () => { $("#cursor-coordinates").textContent = "— / —"; });
}

function setTool(tool) {
  state.tool = tool; state.draftStart = null; state.moving = null; clearDraft();
  document.querySelectorAll(".tool-button").forEach((button) => button.classList.toggle("is-active", button.dataset.tool === tool));
  document.querySelectorAll('.equipment-tool').forEach(button=>button.classList.toggle('is-active',tool===`equipment:${button.dataset.equipmentType}`));
  $("#floor-plan-container").dataset.tool = tool;
  if (tool==='pan') return setEditorHint('Зажмите левую кнопку и перемещайте весь план');
  if(tool.startsWith('equipment:'))return setEditorHint(`Размещение: ${equipmentCatalog[tool.split(':')[1]].name}`);
  setEditorHint({ select: "Выберите или перетащите элемент", wall: "Стена: укажите первую точку", partition: "Перегородка: укажите первую точку", "door-left": "Левая дверь: нажмите рядом со стеной", "door-right": "Правая дверь: нажмите рядом со стеной", "door-double": "Двойная дверь: нажмите рядом со стеной", "door-manual": `${state.manualDoorLeafCount===2?'Двустворчатая':'Одностворчатая'} дверь: нажмите на стену`, window: "Окно: нажмите рядом со стеной" }[tool]);
}

function cancelDoorSampleSelection() {
  state.doorSampleStart=null;state.doorSampleCurrent=null;drawDoorRecognition();
}

function setDoorSampleMode(active) {
  state.doorSampleMode=Boolean(active);cancelDoorSampleSelection();
  $('#door-train-sample').classList.toggle('is-active',state.doorSampleMode);
  $('#door-train-sample').textContent=state.doorSampleMode?'Отменить выделение':'Обучить по образцу';
  if(state.doorSampleMode) $('#editor-hint').textContent='Обведите рамкой один дверной символ целиком';
}

async function finishDoorSample(start,end) {
  state.doorSampleStart=null;state.doorSampleCurrent=null;setDoorSampleMode(false);
  if(!end||Math.abs(end.x-start.x)<8||Math.abs(end.y-start.y)<8)return showToast('Выделите весь символ двери рамкой',true);
  const bounds={minX:Math.min(start.x,end.x),minY:Math.min(start.y,end.y),maxX:Math.max(start.x,end.x),maxY:Math.max(start.y,end.y)};
  const leafCount=Number($('#door-sample-type').value)===2?2:1;
  state.projectBusy=true;$('#door-train-sample').disabled=true;
  try{
    const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/door-patterns/detect`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bounds,leaf_count:leafCount})});
    const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось распознать образец двери');
    state.modelVersion=Number(result.model_version)||state.modelVersion;setDoorDetectionRun(result.run);
    if(result.run.candidate_count)showToast(`Шаблон сохранён. Найдено похожих дверей: ${result.run.candidate_count}`);
    else showToast('Шаблон сохранён, но похожих дверей на листе не найдено',true);
  }catch(error){showToast(error.message,true);}finally{state.projectBusy=false;$('#door-train-sample').disabled=false;drawDoorRecognition();}
}

async function decideDoorCandidates(decision) {
  if(!state.doorDetectionRun)return;
  state.projectBusy=true;
  try{
    const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/door-detection-runs/${encodeURIComponent(state.doorDetectionRun.run_id)}/decision`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision,expected_model_version:state.modelVersion})});
    const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось сохранить решение');
    state.modelVersion=Number(result.model_version)||state.modelVersion;
    if(decision==='accepted'){
      state.geometry=result.geometry;state.savedGeometry=clone(state.geometry);setDirty(false);setDoorDetectionRun(null);await setViewMode('2d');drawGeometry();showGeometryCard();
      showToast(`Двери добавлены: ${result.accepted_count}${result.conflicts?.length?`, конфликтов: ${result.conflicts.length}`:''}`);
    }else{setDoorDetectionRun(null);showToast('Найденные двери отклонены; рабочий план не изменён');}
  }catch(error){showToast(error.message,true);}finally{state.projectBusy=false;}
}

async function activateManualDoor() {
  state.manualDoorLeafCount=Number($('#door-sample-type').value)===2?2:1;setDoorSampleMode(false);
  await setViewMode('2d');if(!state.editorEnabled)toggleEditor();setTool('door-manual');
  showToast(`Ручная постановка: ${state.manualDoorLeafCount===2?'двустворчатая':'одностворчатая'} дверь. Нажмите на нужную стену.`);
}

function setEditorHint(text) { $("#editor-hint").textContent = state.editorEnabled ? text : "Режим просмотра"; $("#editor-hint").classList.toggle("is-editing", state.editorEnabled); }
function toggleEditor() {
  if (state.viewMode === '25d') return showToast('Вернитесь в «План 2D» для редактирования');
  if (state.viewMode === 'source') return showToast('Подложка предназначена для сравнения. Вернитесь в «План 2D» для редактирования');
  state.editorEnabled = !state.editorEnabled;
  $("#editor-toggle").setAttribute("aria-pressed", String(state.editorEnabled));
  $("#editor-section").classList.toggle("is-visible", state.editorEnabled);
  $("#floor-plan-container").classList.toggle("is-editing", state.editorEnabled);
  if (!state.editorEnabled) { state.selected = null; state.draftStart = null; clearDraft(); drawGeometry();drawEquipment(); }
  setTool("select"); setDirty(state.dirty);
}

function showGeometryCard() {
  if (!state.selected) { $("#object-card").innerHTML = '<div class="object-card__empty"><span class="crosshair" aria-hidden="true"></span><p>Выберите объект на плане</p></div>'; return; }
  const item = state.selected.kind === "wall" ? state.geometry.walls.find((x) => x.id === state.selected.id) : state.selected.kind === "door" ? state.geometry.doors.find((x) => x.id === state.selected.id) : state.selected.kind==='window' ? state.geometry.windows.find((x) => x.id === state.selected.id) : state.equipment.find(x=>x.id===state.selected.id);
  if (!item) return;
  if(state.selected.kind==='equipment') {
    const definition=equipmentCatalog[item.type]||{name:item.type};
    const doorOptions=['<option value="">Не привязано</option>',...state.geometry.doors.map(door=>`<option value="${escapeHtml(door.id)}" ${item.hostDoorId===door.id?'selected':''}>${escapeHtml(door.id)}</option>`)].join('');
    const served=new Set(item.servedDoorIds||[]),readerLoad=state.geometry.doors.filter(door=>served.has(door.id)).reduce((sum,door)=>sum+(door.readerCount||1),0);
    const controllerFields=item.type==='controller'?`<label class="card-field">Форм-фактор<select data-equipment-field="formFactor"><option value="wall_enclosure">Корпус настенного исполнения</option><option value="din_rail">Модуль на DIN-рейку</option></select></label><label class="card-field">Ёмкость, дверей<select data-equipment-field="controllerDoorCapacity">${[1,2,4,8].map(value=>`<option value="${value}">${value}</option>`).join('')}</select></label><label class="card-field">Ёмкость, считывателей<input data-equipment-field="controllerReaderCapacity" type="number" min="1" max="32" value="${item.controllerReaderCapacity||8}"></label><fieldset class="controller-doors"><legend>Обслуживаемые точки доступа</legend>${state.geometry.doors.map(door=>`<label><input type="checkbox" data-controller-door="${escapeHtml(door.id)}" ${served.has(door.id)?'checked':''}>${escapeHtml(door.accessPointCode||door.id)} · ${door.readerCount||1} сч.</label>`).join('')||'<p>Дверей пока нет</p>'}</fieldset><p class="editor-help">Загрузка: ${served.size}/${item.controllerDoorCapacity||4} дверей, ${readerLoad}/${item.controllerReaderCapacity||8} считывателей. Форм-фактор и место независимы: DIN-модуль может находиться в шкафу, в локальном настенном боксе или в боксе за потолком.</p>`:`<label class="card-field">Связанная дверь<select data-equipment-field="hostDoorId">${doorOptions}</select></label>`;
    $("#object-card").innerHTML=`<div class="object-card__content"><div class="object-card__head"><h3>${escapeHtml(item.code)}</h3><span class="status-badge">${escapeHtml(definition.system||systemLabels[item.system]||'Инженерная система')}</span></div><dl><dt>Тип</dt><dd>${escapeHtml(definition.name)}</dd><dt>Координаты</dt><dd>${item.x.toFixed(0)} / ${item.y.toFixed(0)}</dd></dl><label class="card-field">Обозначение<input data-equipment-field="code" maxlength="80" value="${escapeHtml(item.code)}"></label><label class="card-field">Место монтажа<select data-equipment-field="mount"><option value="wall">На стене (в боксе / на DIN-рейке)</option><option value="door">На двери/проёме</option><option value="ceiling">За потолком (в боксе / на DIN-рейке)</option><option value="cabinet">В шкафу</option><option value="free">Без привязки</option></select></label><label class="card-field">Высота, мм<input data-equipment-field="mountingHeight" type="number" min="0" max="10000" value="${item.mountingHeight}"></label>${controllerFields}<label class="card-field">Статус<select data-equipment-field="status"><option value="proposed">Предложено</option><option value="confirmed">Подтверждено</option></select></label></div>`;
    $("#object-card [data-equipment-field=mount]").value=item.mount;
    $("#object-card [data-equipment-field=status]").value=item.status;
    if(item.type==='controller'){$("#object-card [data-equipment-field=formFactor]").value=item.formFactor||'wall_enclosure';$("#object-card [data-equipment-field=controllerDoorCapacity]").value=String(item.controllerDoorCapacity||4);}
    if(item.type!=='controller'&&item.hostDoorId){const button=document.createElement('button');button.className='save-geometry';button.textContent='Оборудование двери · А / Б';button.onclick=()=>openDoorEditor(item.hostDoorId);$('#object-card .object-card__content').append(button);}
    return;
  }
  const type = state.selected.kind === "wall" ? item.type === "partition" ? "Перегородка" : "Стена" : state.selected.kind === "door" ? item.swing === 'unknown' ? "Дверной проём · петли не подтверждены" : item.leafCount === 2 ? "Двойная дверь" : "Одинарная дверь" : "Окно";
  const details = state.selected.kind === "wall" ? `<dt>Начало</dt><dd>${item.x1.toFixed(0)} / ${item.y1.toFixed(0)}</dd><dt>Конец</dt><dd>${item.x2.toFixed(0)} / ${item.y2.toFixed(0)}</dd>` : `<dt>Стена</dt><dd>${escapeHtml(item.wallId)}</dd><dt>Центр</dt><dd>${item.x.toFixed(0)} / ${item.y.toFixed(0)}</dd>`;
  const doorActions = state.selected.kind === "door" ? `<label class="card-field">Точка доступа<input data-door-field="accessPointCode" placeholder="ТД.1.1" value="${escapeHtml(item.accessPointCode||'')}"></label><label class="card-field">Считыватели<select data-door-field="readerCount"><option value="1">1 — вход по карте, выход по кнопке</option><option value="2" ${item.readerCount===2?'selected':''}>2 — считыватель с обеих сторон</option></select></label><div class="object-card__actions"><button type="button" data-door-action="flip">Петли: ${item.swing === "unknown" ? "не заданы" : item.swing === "left" ? "слева" : "справа"}</button><button type="button" data-door-action="side">Сменить сторону открытия (${item.openingSide === 1 ? 'Б' : 'А'})</button><button type="button" data-door-action="toggle-leaves">${item.leafCount === 2 ? "Сделать одинарной" : "Сделать двойной"}</button></div><p class="editor-help">${item.swing==='unknown'?'Проём найден автоматически. Нажмите «Петли», чтобы подтвердить направление открывания. ':''}Код вида ТД.1.1 определяет проектные обозначения приборов. Число считывателей учитывается в загрузке контроллера.</p>` : state.selected.kind === 'window' ? `<p class="editor-help">Ширина: ${item.width} ед. плана. Перетащите вдоль стены; Alt — перенос на другую стену.</p>` : "";
  const status = state.selected.kind === 'door' && item.swing === 'unknown' ? 'требует проверки' : 'выбран';
  $("#object-card").innerHTML = `<div class="object-card__content"><div class="object-card__head"><h3>${escapeHtml(item.id)}</h3><span class="status-badge">${status}</span></div><dl><dt>Тип</dt><dd>${type}</dd>${details}</dl>${doorActions}</div>`;
  if(state.selected.kind==='door')$('#object-card .object-card__actions').insertAdjacentHTML('afterbegin','<button type="button" data-door-action="equipment">Оборудование двери · А / Б</button>');
}

function updateEditorButtons() { $("#delete-element").disabled = !selectedEditable(); $("#undo-edit").disabled = !state.history.length; $("#redo-edit").disabled = !state.future.length; }
function updateVisibleCount() { if (state.geometry) { const walls=state.geometry.walls.length,doorReview=doorReviewSummary(state.geometry.doors),windows=state.geometry.windows.length,equipment=state.markers.length,cad=state.cadPreview?.paths?.length||0; const doorLabel=doorReview.total?`${doorReview.total} проёмов${doorReview.pending?` (${doorReview.pending} без петель)`:''}`:null; const parts=[`${walls} стен`,doorLabel,windows?`${windows} окон`:null,equipment?`${equipment} приборов`:null,cad?`${cad} CAD`:null].filter(Boolean); $("#visible-count").textContent=parts.join(' · '); } }

async function saveGeometry() {
  const response = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/geometry`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.geometry) });
  const result = await response.json(); if (!response.ok) throw new Error(result.detail || "Не удалось сохранить геометрию");
  state.geometry = result.geometry; state.savedGeometry=clone(state.geometry); if(!state.equipmentDirty){state.history=[];state.future=[];} setDirty(false); if (state.audit) updateAuditCard({ ...state.geometry, metadata: state.audit }, 'saved'); drawGeometry(); showToast(`Сохранено: ${result.walls} стен, ${result.doors} дверей, ${result.windows} окон`);
}

async function saveEquipment() {
  const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/equipment`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({equipment:state.equipment})});
  const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось сохранить оборудование');
  state.equipment=result.equipment;state.project.equipment=state.equipment;state.savedEquipment=clone(state.equipment);if(!state.dirty){state.history=[];state.future=[];}setEquipmentDirty(false);drawEquipment();showToast(`Оборудование сохранено: ${result.count}`);
}

async function uploadCad(file) {
  await attachProjectFile(file);
  const data = new FormData(); data.append("file", file); showToast(`Читаем ${file.name}…`);
  const response = await fetch(`/api/parse-cad?project_id=${encodeURIComponent(state.projectId)}`, { method: "POST", body: data }), result = await response.json();
  if (!response.ok) throw new Error(result.detail || "Ошибка чтения CAD");
  const record=await loadJson(`/api/projects/${encodeURIComponent(state.projectId)}`,'DWG прочитан, но результат не удалось открыть');
  state.project=record.project;state.geometry=record.geometry;state.equipment=record.project.equipment||[];state.cadPreview=record.cadPreview||null;state.cadPreviewMaster=record.cadPreviewMaster||record.cadPreview||null;state.cadAreas=record.cadAreas||[];
  state.cadAppliedLayout=record.cadAppliedLayout||null;
  updateSourceViewAvailability();
  renderCadLayouts(record.cadLayouts, record.cadSelectedLayout, state.cadAppliedLayout);
  state.history=[];state.future=[];setDirty(false);setEquipmentDirty(false);
  state.savedGeometry=clone(state.geometry);state.savedEquipment=clone(state.equipment);
  $("#source-label").textContent = file.name; await drawPlan(); fitPlan();
  const preview=result.preview;
  showToast(`CAD распознан: ${result.summary?.walls||0} стен, ${result.summary?.recognizedDoors||0} дверей. Найдено оборудования: ${result.equipment.length}.`);
}

function normalizeCoordinates(items, bounds) {
  if (!bounds) return items; const target = state.project.floorPlan, sw = Math.max(bounds.maxX - bounds.minX, 1), sh = Math.max(bounds.maxY - bounds.minY, 1), pad = 100, factor = Math.min((target.width - 2 * pad) / sw, (target.height - 2 * pad) / sh);
  return items.map((item) => ({ ...item, originalX: item.x, originalY: item.y, x: pad + (item.x - bounds.minX) * factor, y: target.height - pad - (item.y - bounds.minY) * factor }));
}

function bindInterface() {
  $('#open-project').addEventListener('click',()=>openProject($('#project-list').value));
  $('#create-project').addEventListener('click',async()=>{
    if(state.projectBusy) return showToast('Дождитесь завершения загрузки файла');
    if(state.dirty||state.equipmentDirty) return showToast('Сначала сохраните изменения текущего проекта');
    const name=$('#new-project-name').value.trim();
    if(!name) return showToast('Введите название нового проекта');
    const button=$('#create-project');button.disabled=true;
    try {
      const response=await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
      const result=await response.json();if(!response.ok) throw new Error(result.detail || 'Не удалось создать проект');
      openProject(result.id);
    } catch(error){showToast(error.message,true);} finally {button.disabled=false;}
  });
  $('#project-source-file').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    if(state.projectBusy){event.target.value='';return showToast('Дождитесь завершения загрузки файла');}
    state.projectBusy=true;
    try {
      const isCad=/\.(dwg|dxf)$/i.test(file.name);
      if(isCad) await uploadCad(file);
      else {await attachProjectFile(file);showToast('Исходный файл сохранён в проекте.');}
    }
    catch(error){showToast(error.message,true);}finally{event.target.value='';state.projectBusy=false;}
  });
  $('#cad-layout-select').addEventListener('change',event=>{
    state.cadPendingLayout=event.target.value||null;
    $('#cad-layout-apply').disabled=!state.cadPendingLayout||state.cadPendingLayout===state.cadAppliedLayout;
    $('#cad-layout-gallery').querySelectorAll('[data-cad-layout]').forEach(card=>card.classList.toggle('is-selected',card.dataset.cadLayout===state.cadPendingLayout));
    $('#floor-plan-title').textContent=state.cadPendingLayout===state.cadAppliedLayout
      ? state.project.floorPlan.name||'План этажа' : `Ожидает применения · ${state.cadPendingLayout||'лист не выбран'}`;
    if(state.cadPendingLayout!==state.cadAppliedLayout) showToast(`Лист выбран: ${state.cadPendingLayout}. Нажмите «Выбрать страницу»`);
  });
  $('#cad-layout-gallery').addEventListener('click',event=>{
    const card=event.target.closest('[data-cad-layout]'); if(!card)return;
    $('#cad-layout-select').value=card.dataset.cadLayout; $('#cad-layout-select').dispatchEvent(new Event('change',{bubbles:true}));
  });
  $('#cad-layout-toggle').addEventListener('click',()=>setCadLayoutsCollapsed(!state.cadLayoutsCollapsed));
  $('#cad-layout-apply').addEventListener('click',async()=>{
    if(!state.cadPendingLayout)return;
    if(state.dirty||state.equipmentDirty)return showToast('Сначала сохраните изменения текущего листа',true);
    const button=$('#cad-layout-apply');button.disabled=true;state.projectBusy=true;
    try {
      const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/cad-layout`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({layout:state.cadPendingLayout})});
      const result=await response.json(); if(!response.ok) throw new Error(result.detail||'Не удалось выбрать лист CAD');
      state.cadSelectedLayout=result.layout; state.cadPendingLayout=result.layout; state.cadAppliedLayout=result.appliedLayout||result.layout; state.project.floorPlan.name=result.layout;
      state.cadPreview=result.cadPreview||null;state.cadPreviewMaster=result.cadPreviewMaster||state.cadPreviewMaster||state.cadPreview;state.cadAreas=result.cadAreas||state.cadAreas;
      state.geometry=result.geometry;state.equipment=result.equipment||[];state.project.equipment=state.equipment;
      state.savedGeometry=clone(state.geometry);state.savedEquipment=clone(state.equipment);state.history=[];state.future=[];state.selected=null;
      setDirty(false);setEquipmentDirty(false);renderCadLayouts(result.cadLayouts,result.layout,state.cadAppliedLayout);
      $('#floor-plan-title').textContent=result.layout;$('#source-label').textContent=`CAD-подложка · ${state.cadPreview?.layers?.length||0} слоёв`;
      await drawPlan();fitPlan();showGeometryCard();
      showToast(`На холст перенесён ${result.layout}: ${result.summary.walls} стен, ${result.summary.doors} проёмов, ${result.summary.equipment} приборов`);
    } catch(error){button.disabled=false;showToast(error.message,true);}finally{state.projectBusy=false;}
  });
  window.addEventListener('beforeunload',event=>{if(state.dirty || state.equipmentDirty || state.projectBusy){event.preventDefault();event.returnValue='';}});
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
  $('#view-source-only').addEventListener('click', () => setViewMode('source'));
  $('#view-2d').addEventListener('click', () => setViewMode('2d'));
  $('#view-25d').addEventListener('click', () => setViewMode('25d'));
  $('#door-train-sample').addEventListener('click',()=>setDoorSampleMode(!state.doorSampleMode));
  $('#door-add-manual').addEventListener('click',activateManualDoor);
  $('#door-accept-candidates').addEventListener('click',()=>decideDoorCandidates('accepted'));
  $('#door-reject-candidates').addEventListener('click',()=>decideDoorCandidates('rejected'));
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
  document.querySelectorAll('.equipment-tool').forEach(button=>button.addEventListener('click',()=>{
    if(!state.editorEnabled)return showToast('Сначала включите «Редактор плана»');
    setTool(`equipment:${button.dataset.equipmentType}`);
  }));
  $("#delete-element").addEventListener("click", deleteSelected); $("#undo-edit").addEventListener("click", undo); $("#redo-edit").addEventListener("click", redo);
  $("#object-card").addEventListener("click", (event) => {
    const action = event.target.closest("[data-door-action]")?.dataset.doorAction;
    if (!action || state.selected?.kind !== "door" || !selectedEditable()) return;
  const door = state.geometry.doors.find((item) => item.id === state.selected.id);
    if (!door) return;
    if (action === 'equipment') return openDoorEditor(door.id);
    beginMutation();
    if (action === "flip") door.swing = door.swing === "unknown" ? "left" : door.swing === "left" ? "right" : "left";
    if (action === "side") door.openingSide = door.openingSide === 1 ? -1 : 1;
    if (action === "toggle-leaves") { door.leafCount = door.leafCount === 2 ? 1 : 2; door.width = door.leafCount === 2 ? Math.max(88, door.width) : Math.min(48, door.width); }
    drawGeometry(); showGeometryCard();
  });
  $('#object-card').addEventListener('change',event=>{
    const doorField=event.target.dataset.doorField;
    if(doorField&&state.selected?.kind==='door'&&selectedEditable()){
      const door=state.geometry.doors.find(entry=>entry.id===state.selected.id);if(!door)return;
      if(doorField==='readerCount'){
        const next=Number(event.target.value)===2?2:1,controllers=state.equipment.filter(item=>item.type==='controller'&&(item.servedDoorIds||[]).includes(door.id));
        if(next===2&&controllers.some(item=>{const load=state.geometry.doors.filter(entry=>(item.servedDoorIds||[]).includes(entry.id)).reduce((sum,entry)=>sum+(entry.id===door.id?next:entry.readerCount||1),0);return load>(item.controllerReaderCapacity||8);})){event.target.value=String(door.readerCount||1);return showToast('У связанного контроллера недостаточно каналов считывателей',true);}
        beginMutation();door.readerCount=next;drawGeometry();showGeometryCard();return;
      }
      const code=normalizeAccessPointCode(event.target.value);
      if(!door)return;
      if(event.target.value.trim()&&!code){event.target.value=door.accessPointCode||'';return showToast('Используйте формат ТД.1.1',true);}
      if(code&&state.geometry.doors.some(entry=>entry.id!==door.id&&entry.accessPointCode===code)){event.target.value=door.accessPointCode||'';return showToast(`${code} уже назначена другой двери`,true);}
      beginMutation();door.accessPointCode=code;const renamed=updateDoorEquipmentCodes(door);if(renamed)setEquipmentDirty(true);
      drawGeometry();drawEquipment();showGeometryCard();showToast(code?`${code}: обновлено обозначений — ${renamed}`:'Связь с точкой доступа снята');return;
    }
    const servedDoorId=event.target.dataset.controllerDoor;
    if(servedDoorId&&state.selected?.kind==='equipment'&&selectedEditable()){
      const item=state.equipment.find(entry=>entry.id===state.selected.id);if(!item||item.type!=='controller')return;
      const next=new Set(item.servedDoorIds||[]);event.target.checked?next.add(servedDoorId):next.delete(servedDoorId);
      const readerLoad=state.geometry.doors.filter(door=>next.has(door.id)).reduce((sum,door)=>sum+(door.readerCount||1),0);
      if(next.size>(item.controllerDoorCapacity||4)||readerLoad>(item.controllerReaderCapacity||8)){event.target.checked=!event.target.checked;return showToast('Превышена ёмкость контроллера по дверям или считывателям',true);}
      if(event.target.checked&&state.equipment.some(other=>other.id!==item.id&&other.type==='controller'&&(other.servedDoorIds||[]).includes(servedDoorId))){event.target.checked=false;return showToast('Эта дверь уже назначена другому контроллеру',true);}
      beginMutation('equipment');item.servedDoorIds=[...next];showGeometryCard();return;
    }
    const field=event.target.dataset.equipmentField;if(!field||state.selected?.kind!=='equipment'||!selectedEditable())return;
    const item=state.equipment.find(entry=>entry.id===state.selected.id);if(!item)return;
    if(field==='controllerDoorCapacity'||field==='controllerReaderCapacity'){
      const next=Math.max(1,Number(event.target.value)||1),served=new Set(item.servedDoorIds||[]),readerLoad=state.geometry.doors.filter(door=>served.has(door.id)).reduce((sum,door)=>sum+(door.readerCount||1),0);
      if((field==='controllerDoorCapacity'&&served.size>next)||(field==='controllerReaderCapacity'&&readerLoad>next)){showGeometryCard();return showToast('Сначала уменьшите число обслуживаемых дверей',true);}
    }
    beginMutation('equipment');
    if(field==='mountingHeight')item[field]=Math.max(0,Math.min(10000,Number(event.target.value)||0));
    else if(field==='controllerDoorCapacity')item[field]=[1,2,4,8].includes(Number(event.target.value))?Number(event.target.value):4;
    else if(field==='controllerReaderCapacity')item[field]=Math.max(1,Math.min(32,Number(event.target.value)||1));
    if(item.doorMount&&['mount','hostDoorId'].includes(field)){delete item.doorMount;showToast('Смена монтажа сняла точную привязку. Уточните монтаж в редакторе двери.');}
    if(field==='hostDoorId') {item[field]=event.target.value||null;const door=state.geometry.doors.find(entry=>entry.id===item[field]);if(door){item.hostWallId=door.wallId;item.rotation=door.rotation||0;}}
    else if(!['mountingHeight','controllerDoorCapacity','controllerReaderCapacity'].includes(field))item[field]=event.target.value.trim?event.target.value.trim():event.target.value;
    if(field==='code'&&!item.code)item.code=item.id;
    drawEquipment();showGeometryCard();
  });
  $("#save-geometry").addEventListener("click", async () => { try { await saveGeometry(); } catch (error) { showToast(error.message, true); } });
  $('#audit-commit-btn').addEventListener('click', commitStagingGeometry);
  $('#audit-dismiss-btn').addEventListener('click', dismissStagingGeometry);
  $('#save-equipment').addEventListener('click',async()=>{try{await saveEquipment();}catch(error){showToast(error.message,true);}});
  $("#background-opacity").addEventListener("input", (event) => { const alpha=Number(event.target.value)/100; if (state.backgroundSprite) state.backgroundSprite.alpha=alpha; if(state.cadLayer) state.cadLayer.alpha=alpha; });
  $('#import-v2-file').addEventListener('change', async (event) => {
    const [file] = event.target.files; if (!file) return;
    try { applyStagingGeometry(JSON.parse(await file.text()), file.name); }
    catch (error) { showToast(`Не удалось импортировать geometry.v2: ${error.message}`, true); }
    event.target.value = '';
  });
  $("#cad-file").addEventListener("change", async (event) => { const [file] = event.target.files; if (!file) return; if(state.projectBusy){event.target.value='';return showToast('Дождитесь завершения загрузки файла');} state.projectBusy=true; try { await uploadCad(file); } catch (error) { showToast(error.message, true); } finally {state.projectBusy=false;event.target.value = "";} });
  window.addEventListener("keydown", (event) => {
    if (document.querySelector('dialog[open]') || state.viewMode !== '2d' || !state.editorEnabled || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if (["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); deleteSelected(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    const shortcuts = { v: "select", w: "wall", p: "partition", l: "door-left", r: "door-right", d: "door-double", o: "window" }; if (shortcuts[event.key.toLowerCase()]) setTool(shortcuts[event.key.toLowerCase()]);
    if (event.key === "Escape") setTool("select");
  });
  window.addEventListener("resize", () => setTimeout(resizePlan, 100));
}

async function setViewMode(mode) {
  if (!state.app || mode === state.viewMode || state.viewLoading) return;
  if (mode === 'source' && !hasSourceUnderlay()) return showToast('В этом проекте пока нет исходной подложки');
  if (mode === '25d') {
    if (state.stagingGeometry) return showToast('Сначала примите или отклоните staging-геометрию');
    if (state.dirty) return showToast('Сначала нажмите «Сохранить геометрию», затем включите объёмный вид');
    state.viewLoading = true;
    try {
      const saved = (await loadJson(`/api/projects/${encodeURIComponent(state.projectId)}`, 'Не удалось прочитать сохранённый план')).geometry;
      if (!saved.walls.length) return showToast('Добавьте и сохраните стены для объёмного просмотра');
      if (!state.volume) state.volume = new Plan25D($('#plan-25d'), (tilt, rotation, zoom) => {
        $('#view-tilt').value = Math.round(tilt); $('#tilt-value').textContent = `${Math.round(tilt)}°`;
        $('#view-rotation').value = Math.round(rotation); $('#rotation-value').textContent = `${Math.round(rotation)}°`;
        $('#zoom-label').textContent = `${Math.round(zoom*100)}%`;
      });
      state.volume.setModel(saved, state.project.floorPlan, state.equipment);
      state.volume.panMode=$('#volume-navigation').value==='pan';
      $('#view-source').disabled = !state.project.floorPlan.backgroundImage;
      if ($('#view-source').disabled) { $('#view-source').checked = false; state.volume.showSource = false; }
      const doorReview=doorReviewSummary(saved.doors);
      $('#view-25d-info').textContent = `Сохранённый план: ${saved.walls.length} стен и перегородок, ${state.volume.columnCount || 0} квадратных колонн, ${doorReview.total} дверных проёмов${doorReview.pending ? `, ${doorReview.pending} без подтверждённых петель` : ''}, ${(saved.windows || []).length} окон, ${state.equipment.length} единиц оборудования. Проёмы без подтверждённых петель показаны без дверного полотна. Контур пола ещё не выделен; показываются только стены.`;
    } catch(error) { showToast(error.message, true); return; }
    finally { state.viewLoading = false; }
  }
  state.viewMode = mode;
  const volume = mode === '25d';
  const sourceOnly = mode === 'source';
  setDoorSampleMode(false);
  state.draftStart = null; state.moving = null; clearDraft();
  document.body.classList.toggle('view-25d', volume);
  document.body.classList.toggle('view-source', sourceOnly);
  $('#view-25d-settings').hidden = !volume;
  $('#door-recognition-toolbar').hidden = !sourceOnly;
  $('#plan-25d').hidden = !volume;
  state.app.canvas.style.display = volume ? 'none' : 'block';
  $('#view-source-only').setAttribute('aria-pressed', String(sourceOnly));
  $('#view-2d').setAttribute('aria-pressed', String(mode === '2d'));
  $('#view-25d').setAttribute('aria-pressed', String(volume));
  $('#editor-toggle').disabled = volume || sourceOnly;
  syncPlanLayerVisibility();
  if (state.volume) { state.volume.active = volume; state.volume.render(); }
  if (volume) setEditorHint('2.5D · сохранённая геометрия');
  else if (sourceOnly) { setEditorHint('Исходная подложка · режим сравнения'); resizePlan(); }
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
