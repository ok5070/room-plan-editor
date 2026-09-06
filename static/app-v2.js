const state = {
  app: null, world: null, project: null,
  geometry: { version: 2, canvas: {}, walls: [], doors: [], windows: [] },
  equipment: [], markers: [], equipmentLayer: null, cadPreview: null, cadLayer: null, geometryLayer: null, draftLayer: null, backgroundSprite: null,
  scale: 1, minScale: 0.12, maxScale: 6,
  dragging: false, dragStart: null, worldStart: null,
  editorEnabled: false, tool: "select", draftStart: null, selected: null, moving: null,
  history: [], future: [], dirty: false, equipmentDirty: false,
  viewMode: '2d', volume: null,
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
};
const layerNames = {cad:'CAD-подложка', wall:'Стены', partition:'Перегородки', door:'Двери', window:'Окна', background:'PDF/изображение', controller:'Оборудование'};
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
  state.cadPreview = record.cadPreview || null;
  $('#project-list').value=state.projectId;
  renderProjectFiles(record.files);
  state.geometry.windows ||= [];
  state.geometry.doors.forEach((door) => { door.leafCount = door.leafCount === 2 ? 2 : 1; door.readerCount = door.readerCount === 2 ? 2 : 1; door.accessPointCode ||= null; });
  state.equipment = state.project.equipment || [];
  state.equipment=state.equipment.map(item=>({...item,code:item.code||item.id,mount:item.mount||'free',mountingHeight:item.mountingHeight??1200,status:item.status==='confirmed'?'confirmed':'proposed',...(item.type==='controller'?{formFactor:item.formFactor||'wall_enclosure',controllerDoorCapacity:item.controllerDoorCapacity||4,controllerReaderCapacity:item.controllerReaderCapacity||8,servedDoorIds:item.servedDoorIds||[]}:{})}));
  setEquipmentDirty(false);
  const { project } = state.project;
  $("#cover-object").textContent = project.object;
  $("#cover-address").textContent = project.address;
  $("#project-object").textContent = project.object;
  $("#project-address").textContent = project.address;
  $("#revision").textContent = project.revision;
  $('#floor-plan-title').textContent=state.project.floorPlan.name || 'План этажа';
  $("#source-label").textContent = state.cadPreview ? 'CAD-подложка · '+state.cadPreview.layers.length+' слоёв' : state.project.floorPlan.backgroundImage ? 'Проектная подложка' : 'Без подложки';
}

function renderProjectFiles(files) {
  $('#project-files').innerHTML=files.length ? files.map(f=>`<li><a href="${escapeHtml(f.url)}" download>${escapeHtml(f.name)}</a></li>`).join('') : '<li>Файлы пока не загружены</li>';
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
  state.world.addChild(grid);
  state.geometryLayer = new PIXI.Container();
  state.equipmentLayer = new PIXI.Container();
  state.draftLayer = new PIXI.Container();
  state.world.addChild(state.geometryLayer, state.equipmentLayer, state.draftLayer);
  drawGeometry();
  drawEquipment();
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
  if (state.cadLayer) state.cadLayer.visible=layers.cad.visible;
  state.markers.forEach(marker=>{marker.visible=layers.controller.visible;});
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

function nextId(prefix, items) { const ids = new Set(items.map((item) => item.id)); let n = 1; while (ids.has(`${prefix}-${String(n).padStart(3, "0")}`)) n++; return `${prefix}-${String(n).padStart(3, "0")}`; }
function snapshot() { return {geometry:clone(state.geometry),equipment:clone(state.equipment)}; }
function beginMutation(domain='geometry') { state.history.push(snapshot()); if (state.history.length > 100) state.history.shift(); state.future = []; domain==='equipment'?setEquipmentDirty(true):setDirty(true); }
function setDirty(value) { state.dirty = value; $("#save-geometry").disabled = !value; $("#edit-status").textContent = value ? "есть изменения" : state.editorEnabled ? "редактирование" : "просмотр"; updateEditorButtons(); }
function setEquipmentDirty(value) { state.equipmentDirty=value; $('#save-equipment').disabled=!value; $('#equipment-status').textContent=value?'есть изменения':`${state.equipment.length} размещено`; updateEditorButtons(); }

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

function restoreSnapshot(saved){state.geometry=clone(saved.geometry);state.equipment=clone(saved.equipment);state.selected=null;setDirty(true);setEquipmentDirty(true);drawGeometry();drawEquipment();showGeometryCard();}
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
  document.querySelectorAll('.equipment-tool').forEach(button=>button.classList.toggle('is-active',tool===`equipment:${button.dataset.equipmentType}`));
  $("#floor-plan-container").dataset.tool = tool;
  if (tool==='pan') return setEditorHint('Зажмите левую кнопку и перемещайте весь план');
  if(tool.startsWith('equipment:'))return setEditorHint(`Размещение: ${equipmentCatalog[tool.split(':')[1]].name}`);
  setEditorHint({ select: "Выберите или перетащите элемент", wall: "Стена: укажите первую точку", partition: "Перегородка: укажите первую точку", "door-left": "Левая дверь: нажмите рядом со стеной", "door-right": "Правая дверь: нажмите рядом со стеной", "door-double": "Двойная дверь: нажмите рядом со стеной", window: "Окно: нажмите рядом со стеной" }[tool]);
}

function setEditorHint(text) { $("#editor-hint").textContent = state.editorEnabled ? text : "Режим просмотра"; $("#editor-hint").classList.toggle("is-editing", state.editorEnabled); }
function toggleEditor() {
  if (state.viewMode === '25d') return showToast('Вернитесь в «План 2D» для редактирования');
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
    $("#object-card").innerHTML=`<div class="object-card__content"><div class="object-card__head"><h3>${escapeHtml(item.code)}</h3><span class="status-badge">СКУД</span></div><dl><dt>Тип</dt><dd>${escapeHtml(definition.name)}</dd><dt>Координаты</dt><dd>${item.x.toFixed(0)} / ${item.y.toFixed(0)}</dd></dl><label class="card-field">Обозначение<input data-equipment-field="code" maxlength="80" value="${escapeHtml(item.code)}"></label><label class="card-field">Место монтажа<select data-equipment-field="mount"><option value="wall">На стене (в боксе / на DIN-рейке)</option><option value="door">На двери/проёме</option><option value="ceiling">За потолком (в боксе / на DIN-рейке)</option><option value="cabinet">В шкафу</option><option value="free">Без привязки</option></select></label><label class="card-field">Высота, мм<input data-equipment-field="mountingHeight" type="number" min="0" max="10000" value="${item.mountingHeight}"></label>${controllerFields}<label class="card-field">Статус<select data-equipment-field="status"><option value="proposed">Предложено</option><option value="confirmed">Подтверждено</option></select></label></div>`;
    $("#object-card [data-equipment-field=mount]").value=item.mount;
    $("#object-card [data-equipment-field=status]").value=item.status;
    if(item.type==='controller'){$("#object-card [data-equipment-field=formFactor]").value=item.formFactor||'wall_enclosure';$("#object-card [data-equipment-field=controllerDoorCapacity]").value=String(item.controllerDoorCapacity||4);}
    if(item.type!=='controller'&&item.hostDoorId){const button=document.createElement('button');button.className='save-geometry';button.textContent='Оборудование двери · А / Б';button.onclick=()=>openDoorEditor(item.hostDoorId);$('#object-card .object-card__content').append(button);}
    return;
  }
  const type = state.selected.kind === "wall" ? item.type === "partition" ? "Перегородка" : "Стена" : state.selected.kind === "door" ? item.leafCount === 2 ? "Двойная дверь" : "Одинарная дверь" : "Окно";
  const details = state.selected.kind === "wall" ? `<dt>Начало</dt><dd>${item.x1.toFixed(0)} / ${item.y1.toFixed(0)}</dd><dt>Конец</dt><dd>${item.x2.toFixed(0)} / ${item.y2.toFixed(0)}</dd>` : `<dt>Стена</dt><dd>${escapeHtml(item.wallId)}</dd><dt>Центр</dt><dd>${item.x.toFixed(0)} / ${item.y.toFixed(0)}</dd>`;
  const doorActions = state.selected.kind === "door" ? `<label class="card-field">Точка доступа<input data-door-field="accessPointCode" placeholder="ТД.1.1" value="${escapeHtml(item.accessPointCode||'')}"></label><label class="card-field">Считыватели<select data-door-field="readerCount"><option value="1">1 — вход по карте, выход по кнопке</option><option value="2" ${item.readerCount===2?'selected':''}>2 — считыватель с обеих сторон</option></select></label><div class="object-card__actions"><button type="button" data-door-action="flip">Петли: ${item.swing === "left" ? "слева" : "справа"}</button><button type="button" data-door-action="side">Сменить сторону открытия (${item.openingSide === 1 ? 'Б' : 'А'})</button><button type="button" data-door-action="toggle-leaves">${item.leafCount === 2 ? "Сделать одинарной" : "Сделать двойной"}</button></div><p class="editor-help">Код вида ТД.1.1 определяет проектные обозначения приборов. Число считывателей учитывается в загрузке контроллера.</p>` : state.selected.kind === 'window' ? `<p class="editor-help">Ширина: ${item.width} ед. плана. Перетащите вдоль стены; Alt — перенос на другую стену.</p>` : "";
  $("#object-card").innerHTML = `<div class="object-card__content"><div class="object-card__head"><h3>${escapeHtml(item.id)}</h3><span class="status-badge">выбран</span></div><dl><dt>Тип</dt><dd>${type}</dd>${details}</dl>${doorActions}</div>`;
  if(state.selected.kind==='door')$('#object-card .object-card__actions').insertAdjacentHTML('afterbegin','<button type="button" data-door-action="equipment">Оборудование двери · А / Б</button>');
}

function updateEditorButtons() { $("#delete-element").disabled = !selectedEditable(); $("#undo-edit").disabled = !state.history.length; $("#redo-edit").disabled = !state.future.length; }
function updateVisibleCount() { if (state.geometry) { const edited=state.geometry.walls.length+state.geometry.doors.length+state.geometry.windows.length+state.markers.length; const cad=state.cadPreview?.paths?.length||0; $("#visible-count").textContent = cad ? `${edited} ред. · ${cad} CAD` : `${edited} элементов`; } }

async function saveGeometry() {
  const response = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/geometry`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.geometry) });
  const result = await response.json(); if (!response.ok) throw new Error(result.detail || "Не удалось сохранить геометрию");
  state.geometry = result.geometry; if(!state.equipmentDirty){state.history=[];state.future=[];} setDirty(false); drawGeometry(); showToast(`Сохранено: ${result.walls} стен, ${result.doors} дверей, ${result.windows} окон`);
}

async function saveEquipment() {
  const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/equipment`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({equipment:state.equipment})});
  const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось сохранить оборудование');
  state.equipment=result.equipment;state.project.equipment=state.equipment;if(!state.dirty){state.history=[];state.future=[];}setEquipmentDirty(false);drawEquipment();showToast(`Оборудование сохранено: ${result.count}`);
}

async function uploadCad(file) {
  await attachProjectFile(file);
  const data = new FormData(); data.append("file", file); showToast(`Читаем ${file.name}…`);
  const response = await fetch(`/api/parse-cad?project_id=${encodeURIComponent(state.projectId)}`, { method: "POST", body: data }), result = await response.json();
  if (!response.ok) throw new Error(result.detail || "Ошибка чтения CAD");
  const record=await loadJson(`/api/projects/${encodeURIComponent(state.projectId)}`,'DWG прочитан, но результат не удалось открыть');
  state.project=record.project;state.geometry=record.geometry;state.equipment=record.project.equipment||[];state.cadPreview=record.cadPreview||null;
  $("#source-label").textContent = file.name; await drawPlan(); fitPlan();
  const preview=result.preview;
  showToast(`CAD-подложка: ${preview?.paths||0} контуров, ${preview?.labels||0} подписей, ${preview?.layers?.length||0} слоёв. Найдено оборудования: ${result.equipment.length}.`);
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
    try {await attachProjectFile(file);showToast('Исходный файл сохранён в проекте. Это не автоматическая обводка плана.');}
    catch(error){showToast(error.message,true);}finally{event.target.value='';state.projectBusy=false;}
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
    if (action === "flip") door.swing = door.swing === "left" ? "right" : "left";
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
  $('#save-equipment').addEventListener('click',async()=>{try{await saveEquipment();}catch(error){showToast(error.message,true);}});
  $("#background-opacity").addEventListener("input", (event) => { const alpha=Number(event.target.value)/100; if (state.backgroundSprite) state.backgroundSprite.alpha=alpha; if(state.cadLayer) state.cadLayer.alpha=alpha; });
  $("#cad-file").addEventListener("change", async (event) => { const [file] = event.target.files; if (!file) return; if(state.projectBusy){event.target.value='';return showToast('Дождитесь завершения загрузки файла');} state.projectBusy=true; try { await uploadCad(file); } catch (error) { showToast(error.message, true); } finally {state.projectBusy=false;event.target.value = "";} });
  window.addEventListener("keydown", (event) => {
    if (document.querySelector('dialog[open]') || state.viewMode === '25d' || !state.editorEnabled || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
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
      const saved = (await loadJson(`/api/projects/${encodeURIComponent(state.projectId)}`, 'Не удалось прочитать сохранённый план')).geometry;
      if (!saved.walls.length) return showToast('Добавьте и сохраните стены для объёмного просмотра');
      if (!state.volume) state.volume = new Plan25D($('#plan-25d'), (tilt, rotation, zoom) => {
        $('#view-tilt').value = Math.round(tilt); $('#tilt-value').textContent = `${Math.round(tilt)}°`;
        $('#view-rotation').value = Math.round(rotation); $('#rotation-value').textContent = `${Math.round(rotation)}°`;
        $('#zoom-label').textContent = `${Math.round(zoom*100)}%`;
      });
      state.volume.setModel(saved, state.project.floorPlan, state.equipment);
      state.volume.panMode=$('#volume-navigation').value==='pan';
      $('#view-25d-info').textContent = `Сохранённый план: ${saved.walls.length} стен и перегородок, ${saved.doors.length} дверей, ${(saved.windows || []).length} окон, ${state.equipment.length} единиц оборудования. Основание — прямоугольная подставка; контур пола ещё не выделен.`;
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
