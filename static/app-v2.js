const state = {
  app: null, world: null, project: null,
  geometry: { version: 3, canvas: {}, walls: [], doors: [], windows: [], columns: [], ceilingZones: [] },
  accessPoints: [], equipment: [], markers: [], equipmentLayer: null, cadPreview: null, cadLayer: null, geometryLayer: null, analysisLayer: null, draftLayer: null, backgroundSprite: null,
  scale: 1, minScale: 0.12, maxScale: 6,
  dragging: false, dragStart: null, worldStart: null,
  editorEnabled: false, tool: "select", draftStart: null, selected: null, moving: null,
  history: [], future: [], dirty: false, equipmentDirty: false,
  viewMode: '2d', volume: null,
  cadArea: null, cadAreaStart: null, cadProposal: null,
  projectId: new URLSearchParams(location.search).get('project') || 'initial',
};

const $ = (selector) => document.querySelector(selector);
const clone = (value) => JSON.parse(JSON.stringify(value));
const equipmentCatalog = {
  access_point:{name:'Точка доступа',prefix:'ТД',symbol:'ТД',color:0x168d8a,mount:'door',height:1200},
  controller:{name:'Контроллер доступа',prefix:'КНТ.',symbol:'КНТ',color:0x176f9f,mount:'wall',height:2200},
  reader:{name:'Считыватель',prefix:'СЧТ.',symbol:'СЧТ',color:0x168d8a,mount:'wall',height:1200},
  exit_button:{name:'Кнопка «Выход»',prefix:'КВ.',symbol:'КВ',color:0x3e9b62,mount:'wall',height:1200},
  emergency_release:{name:'Аварийная разблокировка',prefix:'АВР.',symbol:'АВР',color:0xc54b46,mount:'wall',height:1200},
  lock:{name:'Электромагнитный замок',prefix:'ЗМК.',symbol:'ЗМК',color:0x687a80,mount:'door',height:2050},
  lock_strike:{name:'Ответная часть замка',prefix:'ОП.',symbol:'ОП',color:0x687a80,mount:'door',height:2050},
  door_contact:{name:'Магнитоконтактный извещатель',prefix:'МКД.',symbol:'МКД',color:0x687a80,mount:'door',height:2050},
  door_closer:{name:'Дверной доводчик',prefix:'ДОВ.',symbol:'ДОВ',color:0x687a80,mount:'door',height:1980},
  power_supply:{name:'Источник питания',prefix:'БП.',symbol:'БП',color:0xd78b24,mount:'wall',height:2200},
  battery:{name:'Аккумулятор',prefix:'АКБ',symbol:'АК',color:0xd78b24,mount:'cabinet',height:2200},
  junction_box:{name:'Соединительная коробка',prefix:'КС.',symbol:'КС',color:0x687a80,mount:'wall',height:2200},
  intercom_panel:{name:'Вызывная панель домофона',prefix:'ВП.',symbol:'ВП',color:0x7557b7,mount:'wall',height:1500},
  intercom_monitor:{name:'Абонентское устройство домофона',prefix:'АУ.',symbol:'АУ',color:0x7557b7,mount:'wall',height:1500},
  camera_ceiling:{name:'Потолочная камера без кронштейна',prefix:'КМ',symbol:'КМ',color:0x3f6fb5,mount:'ceiling',height:2700},
  camera_ceiling_bracket:{name:'Потолочная камера на кронштейне',prefix:'КК',symbol:'КК',color:0x315890,mount:'ceiling',height:2500},
};
const cameraTypes = new Set(['camera_ceiling','camera_ceiling_bracket']);
const layerNames = {cad:'CAD-подложка', wall:'Стены', partition:'Перегородки', column:'Колонны', ceiling:'Потолочные зоны', door:'Двери', window:'Окна', background:'PDF/изображение', controller:'Оборудование'};
const layers = Object.fromEntries(Object.keys(layerNames).map(k => [k,{visible:true,locked:k==='background'||k==='cad'}]));
function editable(layer) { return layers[layer].visible && !layers[layer].locked; }
function selectedEditable() {
  if (!state.selected) return false;
  if (state.selected.kind === 'equipment') return editable('controller');
  if (state.selected.kind === 'column') return editable('column');
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
  const [projects,archivedProjects] = await Promise.all([
    loadJson('/api/projects', 'Не удалось прочитать список проектов'),
    loadJson('/api/projects?archived=true', 'Не удалось прочитать архив проектов'),
  ]);
  $('#project-list').innerHTML = projects.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  $('#archived-project-list').innerHTML=archivedProjects.length?archivedProjects.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join(''):'<option value="">Архив пуст</option>';
  $('#archived-project-count').textContent=archivedProjects.length;
  $('#restore-project').disabled=!archivedProjects.length;
  $('#delete-project').disabled=!archivedProjects.length;
  $('#archive-project').disabled=state.projectId==='initial';
  const record = await loadJson(`/api/projects/${encodeURIComponent(state.projectId)}`, 'Не удалось загрузить проект');
  state.project = record.project; state.geometry = record.geometry;
  state.cadPreview = record.cadPreview || null;
  state.cadArea=record.cadPreview?.focus?clone(record.cadPreview.bounds):null;state.cadAreaStart=null;state.cadProposal=null;
  $('#project-list').value=state.projectId;
  renderProjectFiles(record.files);
  renderSourceAnalysis(record.sourceAnalysis, record.workingSource);
  renderCadWorkflow();
  state.geometry.windows ||= [];
  state.geometry.columns ||= [];
  state.geometry.ceilingZones ||= [];
  state.geometry.walls.forEach((wall) => { wall.topMode = wall.topMode === 'ceiling' ? 'ceiling' : 'fixed'; wall.heightMm = Math.max(100, Math.min(10000, Number(wall.heightMm) || 3000)); wall.ceilingZoneId ||= null; wall.materialBands = Array.isArray(wall.materialBands) ? wall.materialBands : []; });
  state.geometry.doors.forEach((door) => { door.leafCount = door.leafCount === 2 ? 2 : 1; door.readerCount = door.readerCount === 2 ? 2 : 1; door.accessPointCode ||= null; });
  state.accessPoints = normalizeAccessPoints(state.project.accessPoints || [], state.geometry);
  let equipmentCodesMigrated=false;
  state.equipment = state.project.equipment || [];
  state.equipment=state.equipment.map(item=>{
    const code=migrateEquipmentCode(item);
    equipmentCodesMigrated ||= Boolean(item.code) && item.code!==code;
    return {...item,code,mount:item.mount||'free',mountingHeight:item.mountingHeight??1200,status:item.status==='confirmed'?'confirmed':'proposed',...(item.type==='controller'?{formFactor:item.formFactor||'wall_enclosure',controllerDoorCapacity:item.controllerDoorCapacity||4,controllerReaderCapacity:item.controllerReaderCapacity||8,servedDoorIds:item.servedDoorIds||[]}:item.type==='power_supply'?{servedControllerId:item.servedControllerId||null}:cameraTypes.has(item.type)?{viewAngleDeg:item.viewAngleDeg||90,viewRange:item.viewRange||420,downTiltDeg:Number.isFinite(Number(item.downTiltDeg))?Number(item.downTiltDeg):45,blindZoneMode:item.blindZoneMode==='manual'?'manual':'auto',blindZone:Math.max(0,Number.isFinite(Number(item.blindZone))?Number(item.blindZone):70),bracketLengthMm:item.type==='camera_ceiling_bracket'?(item.bracketLengthMm||200):0}:{} )};
  });
  setEquipmentDirty(equipmentCodesMigrated);
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

const sourceKindNames={plan:'План',installation:'Монтажный эскиз',wiring:'Схема соединений',structure:'Структурная схема',specification:'Спецификация',other:'Не определён'};
function renderSourceAnalysis(analysis, workingSource) {
  const host=$('#source-analysis');
  if(!analysis || analysis.status==='stale') {host.innerHTML='<p class="editor-help">Исходники изменились. Нажмите «Преобразовать», чтобы найти рабочие листы.</p>';return;}
  if(analysis.status!=='ready') {host.innerHTML='<p class="editor-help">Добавьте PDF, DWG, DXF или изображение, затем преобразуйте проект.</p>';return;}
  const active=workingSource ? `<p class="source-analysis__active">Рабочий источник: ${escapeHtml(workingSource.title||workingSource.name)}</p>` : '';
  const cards=(analysis.sources||[]).map(source=>{
    if(source.error)return `<article class="source-card"><b>${escapeHtml(source.name)}</b><p>${escapeHtml(source.error)}</p></article>`;
    const pages=(source.pages||[]).map(page=>`<article class="source-sheet"><img src="${escapeHtml(page.thumbnailUrl||'')}" alt="${escapeHtml(page.title)}"><div><b>${escapeHtml(page.title)}</b><small>Стр. ${page.page} · ${sourceKindNames[page.kind]||'Лист'}${page.confidence==='low'?' · проверьте вручную':''}</small><button data-activate-source="${escapeHtml(source.fileId)}" data-page="${page.page}">Использовать как план</button></div></article>`).join('');
    const regions=(source.regions||[]).map(region=>`<article class="source-sheet source-sheet--region"><button type="button" class="source-sheet__preview" data-region-preview="${escapeHtml(region.thumbnailUrl||'')}" data-region-title="${escapeHtml(region.title)}" aria-label="Увеличить: ${escapeHtml(region.title)}"><img src="${escapeHtml(region.thumbnailUrl||'')}" alt=""></button><div><b>${escapeHtml(region.title)}${region.recommended?' · возможный план':''}</b><small>${region.architecturePaths} линий основы · ${region.labels} подписей${region.labelPreview?.length?` · ${escapeHtml(region.labelPreview.join(', '))}`:''}</small><button data-activate-source="${escapeHtml(source.fileId)}" data-region-id="${escapeHtml(region.id)}">Открыть эту схему</button></div></article>`).join('');
    const candidates=(source.candidates||[]).map(candidate=>`<article class="source-sheet source-sheet--compact"><div><b>${escapeHtml(candidate.title)}</b><small>${escapeHtml(source.format.toUpperCase())}${source.layouts?.length?` · листы: ${escapeHtml(source.layouts.join(', '))}`:''}</small><button data-activate-source="${escapeHtml(source.fileId)}">Использовать как план</button></div></article>`).join('');
    const preview=source.preview?`<small>${source.preview.paths} контуров · ${source.preview.labels} подписей · ${source.preview.layers.length} слоёв</small>`:'';
    const note=source.note?`<p>${escapeHtml(source.note)}</p>`:'';
    const opened=workingSource?.fileId===source.fileId?' open':'';
    return `<details class="source-card"${opened}><summary>${escapeHtml(source.name)} <small>· ${source.pages?.length||source.regions?.length||source.candidates?.length||0} вариантов</small></summary>${preview}${note}${pages||regions||candidates||'<p>Подходящий лист не определён.</p>'}</details>`;
  }).join('');
  host.innerHTML=active+cards;
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
  renderSourceAnalysis(record.sourceAnalysis, record.workingSource);
  return result;
}

async function analyzeSources() {
  showToast('Ищем листы и рабочие подложки…');
  const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/analyze-sources`,{method:'POST'});
  const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось преобразовать исходники');
  renderSourceAnalysis(result,state.project.workingSource);
  const pages=(result.sources||[]).reduce((sum,source)=>sum+(source.pages?.length||source.regions?.length||source.candidates?.length||0),0);
  const regions=(result.sources||[]).flatMap(source=>(source.regions||[]).map(region=>({source,region})));
  if((result.sources||[]).length===1&&regions.length===1){
    showToast('Найдена одна CAD-схема. Открываем её…');
    await activateSource(regions[0].source.fileId,null,regions[0].region.id);
    return;
  }
  showToast(`Анализ завершён: ${pages} кандидатов. Выберите рабочий лист.`);
}

async function activateSource(fileId,page,regionId) {
  hideSourcePreview();
  const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/activate-source`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId,...(page?{page:Number(page)}:{}),...(regionId?{regionId}:{})})});
  const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось активировать лист');
  await loadProject();await drawPlan();if(state.cadPreview?.focus)await findCadArchitecture();fitPlan();
  showToast(`Рабочий лист выбран: ${result.workingSource.title}`);
}

function showSourcePreview(button) {
  const viewer=$('#cad-source-preview');
  const url=button.dataset.regionPreview;
  const active=viewer.dataset.url===url&&!viewer.hidden;
  document.querySelectorAll('.source-sheet--region').forEach(card=>card.classList.remove('is-previewing'));
  if(active){hideSourcePreview();return;}
  viewer.dataset.url=url;
  $('#cad-source-preview-image').src=url;
  $('#cad-source-preview-title').textContent=(button.dataset.regionTitle||'Схема')+' · предварительный просмотр';
  viewer.hidden=false;
  button.closest('.source-sheet--region')?.classList.add('is-previewing');
}

function hideSourcePreview() {
  const viewer=$('#cad-source-preview');
  if(!viewer)return;
  viewer.hidden=true;
  viewer.dataset.url='';
  document.querySelectorAll('.source-sheet--region').forEach(card=>card.classList.remove('is-previewing'));
}

async function setProjectArchived(projectId,archived) {
  const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/archive`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived})});
  const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось изменить архив проекта');
  return result;
}

async function archiveCurrentProject() {
  if(state.projectId==='initial')return showToast('Демонстрационный проект нельзя архивировать');
  if(state.dirty||state.equipmentDirty)return showToast('Сначала сохраните изменения текущего проекта');
  await setProjectArchived(state.projectId,true);
  const projects=await loadJson('/api/projects','Не удалось обновить список проектов');
  showToast('Проект перемещён в архив');
  if(projects.length)openProject(projects[0].id);
}

async function restoreArchivedProject() {
  const projectId=$('#archived-project-list').value;if(!projectId)return;
  const result=await setProjectArchived(projectId,false);
  showToast(`Проект восстановлен: ${result.name}`);
  openProject(projectId);
}

async function deleteArchivedProject() {
  const select=$('#archived-project-list');const projectId=select.value;if(!projectId)return;
  const name=select.options[select.selectedIndex]?.textContent||'проект';
  if(!window.confirm(`Окончательно удалить проект «${name}» и все загруженные файлы? Восстановить его будет нельзя.`))return;
  const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}`,{method:'DELETE'});
  const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось удалить проект');
  const archived=await loadJson('/api/projects?archived=true','Не удалось обновить архив');
  select.innerHTML=archived.length?archived.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join(''):'<option value="">Архив пуст</option>';
  $('#archived-project-count').textContent=archived.length;$('#restore-project').disabled=!archived.length;$('#delete-project').disabled=!archived.length;
  showToast(`Проект удалён: ${result.name}`);
}

async function initializePixi() {
  const container = $("#floor-plan-container");
  state.app = new PIXI.Application();
  await state.app.init({ resizeTo: container, antialias: true, backgroundColor: 0xd8dcda, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true });
  container.prepend(state.app.canvas);
  state.world = new PIXI.Container();
  state.app.stage.addChild(state.world);
  await drawPlan();
  if(state.cadPreview?.focus)await findCadArchitecture();
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
  state.analysisLayer = new PIXI.Container();
  state.draftLayer = new PIXI.Container();
  state.world.addChild(state.geometryLayer, state.equipmentLayer, state.analysisLayer, state.draftLayer);
  drawCadAnalysis();
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

function cadAvailableLayers() {
  const counts=new Map();
  (state.cadPreview?.paths||[]).forEach(path=>{
    const item=counts.get(path.layer)||{layer:path.layer,category:path.category||'general',paths:0};item.paths++;counts.set(path.layer,item);
  });
  return [...counts.values()].sort((a,b)=>b.paths-a.paths||a.layer.localeCompare(b.layer));
}

function renderCadWorkflow() {
  const host=$('#cad-workflow');if(!host)return;
  host.hidden=!state.cadPreview;
  if(!state.cadPreview)return;
  const choices=cadAvailableLayers(),suggested=choices.filter(item=>['architecture','partition'].includes(item.category));
  $('#cad-layer-choices').innerHTML=(suggested.length?suggested:choices.slice(0,8)).map(item=>`<label><input type="checkbox" value="${escapeHtml(item.layer)}" ${suggested.includes(item)?'checked':''}>${escapeHtml(item.layer)} · ${item.paths}</label>`).join('');
  $('#cad-area-status').textContent=state.cadArea?(state.cadPreview?.focus?'Выбранная схема открыта. Рабочую область можно уточнить.':'Рабочая область выбрана. При необходимости выделите её заново.'):'Нажмите «Область CAD» и укажите два противоположных угла.';
  $('#find-cad-architecture').disabled=!state.cadArea;
  $('#cad-proposal-actions').hidden=!state.cadProposal;
  if(state.cadProposal)$('#cad-proposal-status').textContent=`Предложено: ${state.cadProposal.walls.length} отрезков стен. ${state.cadProposal.note||''}`;
}

function drawCadAnalysis(pointer=null) {
  if(!state.analysisLayer)return;
  state.analysisLayer.removeChildren();
  const end=pointer&&state.cadAreaStart?pointer:null,area=end?{minX:Math.min(state.cadAreaStart.x,end.x),minY:Math.min(state.cadAreaStart.y,end.y),maxX:Math.max(state.cadAreaStart.x,end.x),maxY:Math.max(state.cadAreaStart.y,end.y)}:state.cadArea;
  if(area){const g=new PIXI.Graphics().rect(area.minX,area.minY,area.maxX-area.minX,area.maxY-area.minY).fill({color:0xf4bd5c,alpha:.08}).stroke({width:3,color:0xf4bd5c,alpha:.9});state.analysisLayer.addChild(g);}
  if(state.cadProposal){const g=new PIXI.Graphics();state.cadProposal.walls.forEach(w=>g.moveTo(w.x1,w.y1).lineTo(w.x2,w.y2));g.stroke({width:4,color:0xe48632,alpha:.86});state.analysisLayer.addChild(g);}
}

async function findCadArchitecture() {
  if(!state.cadArea)return showToast('Сначала выделите рабочую область',true);
  const selected=[...document.querySelectorAll('#cad-layer-choices input:checked')].map(input=>input.value);
  if(!selected.length)return showToast('Выберите хотя бы один слой CAD',true);
  const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/architecture-proposal`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bounds:state.cadArea,layers:selected})});
  const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось найти стены');
  state.cadProposal=result;drawCadAnalysis();renderCadWorkflow();
  showToast(result.walls.length?`Найдено ${result.walls.length} отрезков. Проверьте оранжевый черновик.`:'В выбранной области на отмеченных слоях стены не найдены',!result.walls.length);
}

function applyCadProposal() {
  if(!state.cadProposal?.walls?.length)return;
  beginMutation();
  state.cadProposal.walls.forEach(candidate=>state.geometry.walls.push({id:nextId(candidate.type==='partition'?'P':'W',state.geometry.walls),type:candidate.type,x1:candidate.x1,y1:candidate.y1,x2:candidate.x2,y2:candidate.y2,thickness:candidate.type==='partition'?7:13,topMode:'fixed',heightMm:3000,ceilingZoneId:null,materialBands:[],sourceLayer:candidate.sourceLayer,status:'proposed'}));
  const count=state.cadProposal.walls.length;state.cadProposal=null;drawCadAnalysis();drawGeometry();renderCadWorkflow();setTool('select');showToast(`Добавлено ${count} отрезков. Теперь их можно исправить или удалить.`);
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
      const heightLabel = new PIXI.Text({text:wall.topMode==='ceiling'?`до потолка · ${Math.round(wall.heightMm)} мм`:`h=${Math.round(wall.heightMm)} мм`,style:{fontFamily:'Manrope, sans-serif',fontSize:18,fill:0x17383f,stroke:{color:0xffffff,width:4}}});
      heightLabel.anchor.set(.5,1);heightLabel.position.set((wall.x1+wall.x2)/2,(wall.y1+wall.y2)/2-10);state.geometryLayer.addChild(heightLabel);
    }
    state.geometryLayer.addChild(g);
  });
  (state.geometry.columns||[]).forEach(column=>{
    if(!layers.column.visible)return;
    const selected=state.selected?.kind==='column'&&state.selected.id===column.id;
    const g=new PIXI.Graphics();const half=column.size/2;
    if(column.shape==='round')g.circle(column.x,column.y,half);
    else g.rect(column.x-half,column.y-half,column.size,column.size);
    g.fill({color:selected?0xf4bd5c:0xb4aaa0,alpha:.96}).stroke({width:selected?4:2,color:selected?0xffffff:0x776f67});
    state.geometryLayer.addChild(g);
  });
  (state.geometry.ceilingZones||[]).forEach(zone=>{
    if(!layers.ceiling.visible)return;
    const selected=state.selected?.kind==='ceiling'&&state.selected.id===zone.id;
    const points=ceilingZonePoints(zone),g=new PIXI.Graphics();
    g.moveTo(points[0].x,points[0].y);points.slice(1).forEach(point=>g.lineTo(point.x,point.y));g.closePath();
    g.fill({color:selected?0xf4bd5c:0x8fa6a8,alpha:selected?.24:.12}).stroke({width:selected?3:2,color:selected?0xf4bd5c:0x688083,alpha:.9});
    if(selected)points.forEach((point,index)=>{
      const next=points[(index+1)%points.length],mx=(point.x+next.x)/2,my=(point.y+next.y)/2;
      g.circle(mx,my,5/state.scale).fill({color:0x17383f,alpha:.82}).stroke({width:1.5/state.scale,color:0xffffff});
      g.circle(point.x,point.y,8/state.scale).fill({color:0xffffff}).stroke({width:2/state.scale,color:0xf4bd5c});
    });
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
    const accessPointCode=doorAccessPointCode(door);
    const doorColor = selected ? 0xf4bd5c : accessPointCode ? 0x176f9f : 0x7c8b91;
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
  if(cameraTypes.has(item.type)){
    const rotation=Number(item.rotation)||0,coverage=cameraCoverageShape(item,state.geometry);
    shape.moveTo(coverage.polygon[0].x-item.x,coverage.polygon[0].y-item.y);coverage.polygon.slice(1).forEach(point=>shape.lineTo(point.x-item.x,point.y-item.y));shape.closePath().fill({color:0x4b91d1,alpha:.13}).stroke({width:1.5,color:0x4b91d1,alpha:.58});
    const c=Math.cos(rotation),s=Math.sin(rotation),n={x:-s,y:c};
    if(item.type==='camera_ceiling_bracket'){
      shape.moveTo(-c*18,-s*18).lineTo(0,0).stroke({width:5,color:0x315890});
      shape.rect(c*2+n.x*-8,s*2+n.y*-8,16,16).fill({color:selected?0xf4bd5c:0x315890}).stroke({width:2,color:0xffffff});
    } else shape.circle(0,0,13).fill({color:selected?0xf4bd5c:0x3f6fb5}).stroke({width:3,color:0xffffff});
    shape.moveTo(c*5+n.x*-7,s*5+n.y*-7).lineTo(c*19,s*19).lineTo(c*5+n.x*7,s*5+n.y*7).closePath().fill({color:0xffffff,alpha:.96});
    if(selected){const distance=55/state.scale,hx=c*distance,hy=s*distance;shape.moveTo(c*20,s*20).lineTo(hx,hy).stroke({width:2/state.scale,color:0xf4bd5c});shape.circle(hx,hy,8/state.scale).fill({color:0xffffff}).stroke({width:2/state.scale,color:0xf4bd5c});}
    const label = new PIXI.Text({ text: item.code||item.id, style: { fontFamily: "Manrope, sans-serif", fontSize: 11, fontWeight: "700", fill: 0x1b3034 } });
    label.anchor.set(0.5,0);label.position.set(0,22);marker.addChild(shape,label);state.markers.push(marker);return marker;
  }
  const size=['controller','power_supply','battery','intercom_monitor'].includes(item.type)?14:10;
  shape.roundRect(-size,-size,size*2,size*2,3).fill({color:selected?0xf4bd5c:definition.color}).stroke({width:selected?4:2,color:0xffffff});
  const icon=new PIXI.Text({text:definition.symbol,style:{fontFamily:'Manrope, sans-serif',fontSize:size*.78,fontWeight:'700',fill:0xffffff}});
  icon.anchor.set(.5);icon.position.set(0,0);
  const label = new PIXI.Text({ text: item.code||item.id, style: { fontFamily: "Manrope, sans-serif", fontSize: 11, fontWeight: "700", fill: 0x1b3034 } });
  label.anchor.set(0.5, 0); label.position.set(0, size+6);
  marker.addChild(shape,icon,label); state.markers.push(marker); return marker;
}

function accessPointMarkerPosition(point) {
  const door=state.geometry.doors.find(item=>item.id===point.doorId);
  if(!door)return null;
  const side=point.corridorSide===-1?-1:1, rotation=door.rotation||0;
  const offset=Math.max(30,door.width*.62);
  return {door,x:door.x-Math.sin(rotation)*side*offset,y:door.y+Math.cos(rotation)*side*offset};
}

function createAccessPointMarker(point) {
  const position=accessPointMarkerPosition(point);
  if(!position)return null;
  const selected=state.selected?.kind==='door'&&state.selected.id===position.door.id;
  const marker=new PIXI.Container();marker.position.set(position.x,position.y);marker.label='access_point';
  const labelText=point.code.replace(/^(ТД)\./,'$1.\n');
  const label=new PIXI.Text({text:labelText,style:{fontFamily:'Manrope, sans-serif',fontSize:9,fontWeight:'800',lineHeight:9,align:'center',fill:0xffffff}});
  label.anchor.set(.5);
  const shape=new PIXI.Graphics();
  shape.roundRect(-17,-17,34,34,3).fill({color:selected?0xf4bd5c:0x176f9f}).stroke({width:selected?3:2,color:0xffffff});
  marker.addChild(shape,label);state.markers.push(marker);return marker;
}

function equipmentShownOnPlan(item) {
  if(item.accessPointId&&state.accessPoints.some(point=>point.id===item.accessPointId))return false;
  return !item.hostDoorId||!state.accessPoints.some(point=>point.doorId===item.hostDoorId);
}

function cameraBlockerSegments(geometry) {
  const segments=[];
  (geometry.walls||[]).forEach(wall=>{
    const dx=wall.x2-wall.x1,dy=wall.y2-wall.y1,length=Math.hypot(dx,dy);if(length<.01)return;
    const ux=dx/length,uy=dy/length;
    const openings=[...(geometry.doors||[]),...(geometry.windows||[])].filter(item=>item.wallId===wall.id).map(item=>{
      const center=(item.x-wall.x1)*ux+(item.y-wall.y1)*uy,half=(Number(item.width)||0)/2;
      return {start:Math.max(0,center-half),end:Math.min(length,center+half)};
    }).filter(span=>span.end>span.start).sort((a,b)=>a.start-b.start);
    const merged=[];openings.forEach(span=>{const last=merged.at(-1);if(last&&span.start<=last.end)last.end=Math.max(last.end,span.end);else merged.push({...span});});
    let cursor=0;[...merged,{start:length,end:length}].forEach(span=>{
      if(span.start-cursor>.01)segments.push({a:{x:wall.x1+ux*cursor,y:wall.y1+uy*cursor},b:{x:wall.x1+ux*span.start,y:wall.y1+uy*span.start}});
      cursor=Math.max(cursor,span.end);
    });
  });
  return segments;
}

function cameraRaySegmentDistance(origin,dx,dy,segment) {
  const sx=segment.b.x-segment.a.x,sy=segment.b.y-segment.a.y,den=dx*sy-dy*sx;if(Math.abs(den)<1e-8)return Infinity;
  const qx=segment.a.x-origin.x,qy=segment.a.y-origin.y,t=(qx*sy-qy*sx)/den,u=(qx*dy-qy*dx)/den;
  return t>=.01&&u>=0&&u<=1?t:Infinity;
}

function cameraRayColumnDistance(origin,dx,dy,column) {
  const half=(Number(column.size)||36)/2;
  if(column.shape==='round'){
    const ox=origin.x-column.x,oy=origin.y-column.y,b=ox*dx+oy*dy,c=ox*ox+oy*oy-half*half,disc=b*b-c;
    if(disc<0)return Infinity;const near=-b-Math.sqrt(disc),far=-b+Math.sqrt(disc);return near>=.01?near:far>=.01?far:Infinity;
  }
  let near=-Infinity,far=Infinity;
  for(const [o,d,min,max] of [[origin.x,dx,column.x-half,column.x+half],[origin.y,dy,column.y-half,column.y+half]]){
    if(Math.abs(d)<1e-8){if(o<min||o>max)return Infinity;continue;}
    let a=(min-o)/d,b=(max-o)/d;if(a>b)[a,b]=[b,a];near=Math.max(near,a);far=Math.min(far,b);if(near>far)return Infinity;
  }
  return near>=.01?near:far>=.01?far:Infinity;
}

function cameraPlanAngle(camera) {
  const tilt=Math.max(0,Math.min(90,Number.isFinite(Number(camera.downTiltDeg))?Number(camera.downTiltDeg):45));
  return tilt>=89 ? Math.PI*2 : Math.max(20,Math.min(180,Number(camera.viewAngleDeg)||90))*Math.PI/180;
}

function cameraAutoBlindZone(camera) {
  const tilt=Math.max(0,Math.min(90,Number.isFinite(Number(camera.downTiltDeg))?Number(camera.downTiltDeg):45));
  const fov=Math.max(20,Math.min(180,Number(camera.viewAngleDeg)||90));
  const heightPlan=Math.max(20,Math.min(3000,(Number(camera.mountingHeight)||2700)/10));
  const nearAngle=(tilt+fov/2)*Math.PI/180;
  if(tilt>=89 || nearAngle>=Math.PI/2)return 0;
  return Math.max(0,Math.min((Number(camera.viewRange)||420)-1,heightPlan/Math.tan(nearAngle)));
}

function cameraBlindZone(camera) {
  const mode=camera.blindZoneMode || (Number.isFinite(Number(camera.downTiltDeg))?'auto':'manual');
  if(mode==='manual')return Math.max(0,Math.min((Number(camera.viewRange)||420)-1,Number.isFinite(Number(camera.blindZone))?Number(camera.blindZone):70));
  return cameraAutoBlindZone(camera);
}

function cameraVisibilityPolygon(camera,geometry,steps=120) {
  const origin={x:camera.x,y:camera.y},range=Math.max(40,Number(camera.viewRange)||420),rotation=Number(camera.rotation)||0,angle=cameraPlanAngle(camera);
  const segments=cameraBlockerSegments(geometry),columns=geometry.columns||[],points=[origin];
  for(let index=0;index<=steps;index++){
    const rayAngle=rotation-angle/2+angle*index/steps,dx=Math.cos(rayAngle),dy=Math.sin(rayAngle);
    let distance=range;segments.forEach(segment=>{distance=Math.min(distance,cameraRaySegmentDistance(origin,dx,dy,segment));});columns.forEach(column=>{distance=Math.min(distance,cameraRayColumnDistance(origin,dx,dy,column));});
    points.push({x:origin.x+dx*distance,y:origin.y+dy*distance});
  }
  return points;
}

function cameraCoverageShape(camera,geometry,steps=120) {
  const rawOuter=cameraVisibilityPolygon(camera,geometry,steps).slice(1),rotation=Number(camera.rotation)||0,angle=cameraPlanAngle(camera);
  const blindZone=cameraBlindZone(camera);
  const inner=rawOuter.map((_,index)=>{const rayAngle=rotation-angle/2+angle*index/steps;return {x:camera.x+Math.cos(rayAngle)*blindZone,y:camera.y+Math.sin(rayAngle)*blindZone};});
  const outer=rawOuter.map((point,index)=>Math.hypot(point.x-camera.x,point.y-camera.y)<=blindZone?inner[index]:point);
  return {polygon:[inner[0],...outer,...inner.slice().reverse()],outer,inner,center:outer[Math.floor(outer.length/2)],blindZone};
}

function drawLogicalConnections() {
  const g=new PIXI.Graphics();
  const controllers=new Map(state.equipment.filter(item=>item.type==='controller').map(item=>[item.id,item]));
  state.equipment.filter(item=>item.type==='controller').forEach(controller=>{
    (controller.servedDoorIds||[]).forEach(doorId=>{
      const point=state.accessPoints.find(entry=>entry.doorId===doorId),target=point&&accessPointMarkerPosition(point);
      if(!target)return;
      g.moveTo(controller.x,controller.y).lineTo(target.x,target.y).stroke({width:2,color:0x168d8a,alpha:.62});
    });
  });
  state.equipment.filter(item=>item.type==='power_supply'&&item.servedControllerId).forEach(powerSupply=>{
    const controller=controllers.get(powerSupply.servedControllerId);
    if(controller)g.moveTo(powerSupply.x,powerSupply.y).lineTo(controller.x,controller.y).stroke({width:2.5,color:0xd78b24,alpha:.74});
  });
  state.equipmentLayer.addChild(g);
}

function drawEquipment() {
  if(typeof DoorMount!=='undefined')state.equipment.forEach(item=>{if(item.doorMount)Object.assign(item,DoorMount.resolve(item,state.geometry));});
  if(!state.equipmentLayer)return;
  state.equipmentLayer.removeChildren();state.markers=[];
  drawLogicalConnections();
  state.accessPoints.forEach(point=>{const marker=createAccessPointMarker(point);if(marker)state.equipmentLayer.addChild(marker);});
  state.equipment.filter(equipmentShownOnPlan).forEach(item=>state.equipmentLayer.addChild(createMarker(item)));
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

function ceilingZonePoints(zone) {
  if (Array.isArray(zone.points) && zone.points.length >= 3) return zone.points;
  return [
    {x:zone.x,y:zone.y}, {x:zone.x+zone.width,y:zone.y},
    {x:zone.x+zone.width,y:zone.y+zone.height}, {x:zone.x,y:zone.y+zone.height},
  ];
}

function syncCeilingBounds(zone) {
  zone.points = ceilingZonePoints(zone).map(point=>({x:point.x,y:point.y}));
  const xs=zone.points.map(point=>point.x),ys=zone.points.map(point=>point.y);
  zone.x=Math.min(...xs);zone.y=Math.min(...ys);
  zone.width=Math.max(20,Math.max(...xs)-zone.x);zone.height=Math.max(20,Math.max(...ys)-zone.y);
  return zone;
}

function ceilingEdgeProjection(point,a,b) {
  const vx=b.x-a.x,vy=b.y-a.y,length2=vx*vx+vy*vy||1;
  const t=Math.max(0,Math.min(1,((point.x-a.x)*vx+(point.y-a.y)*vy)/length2));
  const x=a.x+t*vx,y=a.y+t*vy;
  return {x,y,t,distance:Math.hypot(point.x-x,point.y-y)};
}

function pointInPolygon(point,points) {
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[i],b=points[j];
    if(((a.y>point.y)!==(b.y>point.y))&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}

function nearestElement(point) {
  const tolerance = 22 / state.scale; let best = null;
  if(editable('controller')&&editable('door'))state.accessPoints.forEach(accessPoint=>{
    const marker=accessPointMarkerPosition(accessPoint);if(!marker)return;
    const distance=Math.hypot(point.x-marker.x,point.y-marker.y);
    if(distance<=Math.max(tolerance,28/state.scale)&&(!best||distance<best.distance))best={kind:'door',id:marker.door.id,distance};
  });
  if(best)return best;
  if(editable('ceiling')&&state.selected?.kind==='ceiling'){
    const zone=(state.geometry.ceilingZones||[]).find(item=>item.id===state.selected.id);
    if(zone){
      const points=ceilingZonePoints(zone);
      for(let index=0;index<points.length;index++)if(Math.hypot(point.x-points[index].x,point.y-points[index].y)<=12/state.scale)return {kind:'ceiling',id:zone.id,handle:`vertex:${index}`,distance:0};
      for(let index=0;index<points.length;index++){
        const a=points[index],b=points[(index+1)%points.length],middle={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
        if(Math.hypot(point.x-middle.x,point.y-middle.y)<=10/state.scale)return {kind:'ceiling',id:zone.id,handle:`edge:${index}`,distance:0};
      }
    }
  }
  if(editable('column'))(state.geometry.columns||[]).forEach(column=>{
    const dx=Math.abs(point.x-column.x),dy=Math.abs(point.y-column.y),half=column.size/2;
    const distance=column.shape==='round'?Math.max(0,Math.hypot(dx,dy)-half):Math.hypot(Math.max(0,dx-half),Math.max(0,dy-half));
    if(distance<=tolerance&&(!best||distance<best.distance))best={kind:'column',id:column.id,distance};
  });
  if(best)return best;
  if(editable('controller')&&state.selected?.kind==='equipment'){
    const item=state.equipment.find(entry=>entry.id===state.selected.id);
    if(item&&cameraTypes.has(item.type)){
      const distance=55/state.scale,hx=item.x+Math.cos(item.rotation||0)*distance,hy=item.y+Math.sin(item.rotation||0)*distance;
      if(Math.hypot(point.x-hx,point.y-hy)<=12/state.scale)return {kind:'equipment',id:item.id,handle:'rotation',distance:0};
    }
  }
  if(editable('controller')) state.equipment.filter(equipmentShownOnPlan).forEach(item=>{
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
  if(best)return best;
  if(editable('ceiling'))(state.geometry.ceilingZones||[]).forEach(zone=>{
    const points=ceilingZonePoints(zone);
    let edgeDistance=Infinity;
    for(let index=0;index<points.length;index++)edgeDistance=Math.min(edgeDistance,ceilingEdgeProjection(point,points[index],points[(index+1)%points.length]).distance);
    const inside=pointInPolygon(point,points);
    if(edgeDistance<=tolerance&&(!best||edgeDistance<best.distance))best={kind:'ceiling',id:zone.id,handle:null,distance:edgeDistance};
    if(inside&&!best)best={kind:'ceiling',id:zone.id,handle:null,distance:0};
  });
  return best;
}

function nextId(prefix, items) { const ids = new Set(items.map((item) => item.id)); let n = 1; while (ids.has(`${prefix}-${String(n).padStart(3, "0")}`)) n++; return `${prefix}-${String(n).padStart(3, "0")}`; }
function snapshot() { return {geometry:clone(state.geometry),accessPoints:clone(state.accessPoints),equipment:clone(state.equipment)}; }
function beginMutation(domain='geometry') { state.history.push(snapshot()); if (state.history.length > 100) state.history.shift(); state.future = []; domain==='equipment'?setEquipmentDirty(true):setDirty(true); }
function setDirty(value) { state.dirty = value; $("#save-geometry").disabled = !value; $("#edit-status").textContent = value ? "есть изменения" : state.editorEnabled ? "редактирование" : "просмотр"; updateEditorButtons(); }
function setEquipmentDirty(value) {
  state.equipmentDirty=value;$('#save-equipment').disabled=!value;
  const cctvButton=$('#save-cctv-equipment');if(cctvButton)cctvButton.disabled=!value;
  $('#equipment-status').textContent=value?'есть изменения':`${state.equipment.length} размещено`;
  const cctvStatus=$('#cctv-equipment-status');if(cctvStatus){const count=state.equipment.filter(item=>cameraTypes.has(item.type)).length;cctvStatus.textContent=value?'есть изменения':`${count} камер`;}
  updateEditorButtons();
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

function normalizeAccessPoints(points, geometry) {
  const result=[], seenDoors=new Set(), seenCodes=new Set();
  (points||[]).forEach((point)=>{
    const door=geometry.doors.find(item=>item.id===point.doorId), code=normalizeAccessPointCode(point.code);
    if(!door||!code||seenDoors.has(door.id)||seenCodes.has(code))return;
    result.push({id:point.id||nextId('AP',result),code,doorId:door.id,readerCount:point.readerCount===2?2:1,corridorSide:point.corridorSide===-1?-1:1,status:point.status==='confirmed'?'confirmed':'proposed'});
    seenDoors.add(door.id);seenCodes.add(code);
  });
  geometry.doors.forEach(door=>{
    const code=normalizeAccessPointCode(door.accessPointCode);
    if(!code||seenDoors.has(door.id)||seenCodes.has(code))return;
    const id=door.accessPointId||`AP-${door.id}`;
    result.push({id,code,doorId:door.id,readerCount:door.readerCount===2?2:1,corridorSide:1,status:'proposed'});
    door.accessPointId=id;seenDoors.add(door.id);seenCodes.add(code);
  });
  return result;
}

function accessPointForDoor(door) {
  if(!door)return null;
  return state.accessPoints.find(point=>point.doorId===door.id)||null;
}

function doorAccessPointCode(door) {
  return accessPointForDoor(door)?.code || normalizeAccessPointCode(door?.accessPointCode);
}

function assignAccessPointToDoor(door, value) {
  const code=normalizeAccessPointCode(value);
  if(!code)return {error:'Используйте формат ТД.1.1'};
  const duplicate=state.accessPoints.find(point=>point.doorId!==door.id&&point.code===code);
  if(duplicate)return {error:`${code} уже назначена другой двери`};
  let point=accessPointForDoor(door);
  if(!point){
    point={id:door.accessPointId||nextId('AP',state.accessPoints),code,doorId:door.id,readerCount:door.readerCount===2?2:1,corridorSide:1,status:'proposed'};
    state.accessPoints.push(point);
  }
  point.code=code;point.readerCount=door.readerCount===2?2:1;door.accessPointId=point.id;door.accessPointCode=code;
  return {point};
}

function removeAccessPointFromDoor(door) {
  const point=accessPointForDoor(door);
  state.accessPoints=state.accessPoints.filter(item=>item.doorId!==door.id);
  door.accessPointId=null;door.accessPointCode=null;
  if(point)state.equipment=state.equipment.filter(item=>item.accessPointId!==point.id&&item.hostDoorId!==door.id);
  return point;
}

function projectEquipmentCode(type,door) {
  const accessPoint=doorAccessPointCode(door);
  if(!accessPoint)return null;
  if(type==='access_point')return accessPoint;
  const suffix=accessPoint.slice(3),controller=suffix.split('.')[0];
  if(type==='controller')return `КНТ.${controller}`;
  if(type==='power_supply')return `БП.${controller}`;
  if(type==='battery')return `АКБ.${controller}`;
  if(type==='door_closer')return `ДОВ.${suffix}`;
  return `${equipmentCatalog[type]?.prefix||type}${suffix}`;
}

function migrateEquipmentCode(item) {
  const source=String(item.code||item.id||'').trim();
  if(item.type==='camera_ceiling')return source.replace(/^КМ\.\./,'КМ.');
  if(item.type==='camera_ceiling_bracket')return source.replace(/^КК\.\./,'КК.');
  const door=state.geometry.doors.find(entry=>entry.id===item.hostDoorId);
  const pointCode=door&&doorAccessPointCode(door);
  const generated=pointCode?projectEquipmentCode(item.type,door):null;
  if(generated && /^(?:AR|YK|BGV|BGM|BGB|UG|R|Поз\.4|Ответная часть|КС)/i.test(source))return generated;
  const legacyPrefixes={
    controller:[/^AR\.?/i,'КНТ.'], reader:[/^YK\.?/i,'СЧТ.'], exit_button:[/^BGV\.?/i,'КВ.'],
    emergency_release:[/^BGM\.?/i,'АВР.'], lock:[/^UG\.?/i,'ЗМК.'], lock_strike:[/^UG-ОП\.?/i,'ОП.'],
    door_contact:[/^BGB\.?/i,'МКД.'], door_closer:[/^(?:Доводчик|Поз\.4)\.?\s*/i,'ДОВ.'],
    power_supply:[/^R\.?/i,'БП.'], intercom_panel:[/^ДП\.?/i,'ВП.'], intercom_monitor:[/^ВМ\.?/i,'АУ.'],
  };
  const rule=legacyPrefixes[item.type];
  if(!rule)return source;
  return source.replace(rule[0],rule[1]);
}

function updateDoorEquipmentCodes(door) {
  const pointTypes=new Set(['access_point','reader','exit_button','emergency_release','lock','lock_strike','door_contact','door_closer','junction_box','intercom_panel']);let changed=0;
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
  const doorTypes=new Set(['access_point','reader','exit_button','emergency_release','lock','lock_strike','door_contact','door_closer','intercom_panel']);
  const doorTarget=doorTypes.has(type)?nearestDoor(point,70/state.scale):null;
  if(doorTypes.has(type)&&!doorTarget)return showToast('Разместите этот прибор рядом с существующей дверью',true);
  const accessPoint=accessPointForDoor(doorTarget?.door);
  if(doorTarget&&!accessPoint)return showToast('Сначала назначьте двери точку прохода, например ТД.1.1',true);
  const wallTarget=cameraTypes.has(type)?null:nearestWall(point,type==='controller'?Infinity:70/state.scale);
  const wallMountedController=type==='controller'&&wallTarget;
  beginMutation('equipment');
  const item={id:nextId('EQ',state.equipment),system:'skud_intercom',type,code:projectEquipmentCode(type,doorTarget?.door)||nextEquipmentCode(definition.prefix),
    x:wallMountedController?wallTarget.x:point.x,y:wallMountedController?wallTarget.y:point.y,rotation:doorTarget?.door.rotation||wallTarget?.rotation||0,mount:definition.mount,
    mountingHeight:definition.height,accessPointId:accessPoint?.id||null,hostDoorId:doorTarget?.door.id||null,hostWallId:doorTarget?.door.wallId||wallTarget?.wall.id||null,status:'proposed'};
  if(type==='controller')Object.assign(item,{formFactor:'wall_enclosure',controllerDoorCapacity:4,controllerReaderCapacity:8,servedDoorIds:[]});
  if(cameraTypes.has(type))Object.assign(item,{system:'cctv',rotation:0,viewAngleDeg:90,viewRange:420,downTiltDeg:45,blindZoneMode:'auto',blindZone:70,bracketLengthMm:type==='camera_ceiling_bracket'?200:0});
  state.equipment.push(item);state.selected={kind:'equipment',id:item.id};drawEquipment();showGeometryCard();
}

function addWall(type, start, end) {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 12) return showToast("Элемент слишком короткий", true);
  beginMutation();
  state.geometry.walls.push({ id: nextId(type === "wall" ? "W" : "P", state.geometry.walls), type, x1: start.x, y1: start.y, x2: end.x, y2: end.y, thickness: type === "wall" ? 13 : 7, topMode:'fixed', heightMm:3000, ceilingZoneId:null, materialBands:[] });
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

function addColumn(point,shape) {
  beginMutation();
  const column={id:nextId('COL',state.geometry.columns||[]),shape,x:point.x,y:point.y,size:36,heightMm:3000};
  state.geometry.columns.push(column);state.selected={kind:'column',id:column.id};drawGeometry();showGeometryCard();
}
function addCeilingZone(point) {
  beginMutation();
  const x=point.x-110,y=point.y-80,width=220,height=160;
  const zone={id:nextId('CZ',state.geometry.ceilingZones||[]),x,y,width,height,heightMm:2700,type:'flat',points:[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}]};
  state.geometry.ceilingZones.push(zone);state.selected={kind:'ceiling',id:zone.id};drawGeometry();updateVisibleCount();showGeometryCard();
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
    const doorIds=new Set(state.geometry.doors.filter((item)=>item.wallId===state.selected.id).map((item)=>item.id));
    state.accessPoints=state.accessPoints.filter(item=>!doorIds.has(item.doorId));
    state.geometry.walls = state.geometry.walls.filter((item) => item.id !== state.selected.id);
    state.geometry.doors = state.geometry.doors.filter((item) => item.wallId !== state.selected.id);
    state.geometry.windows = state.geometry.windows.filter((item) => item.wallId !== state.selected.id);
  } else if (state.selected.kind === "door") { state.accessPoints=state.accessPoints.filter(item=>item.doorId!==state.selected.id); state.geometry.doors = state.geometry.doors.filter((item) => item.id !== state.selected.id); }
  else if(state.selected.kind==='window') state.geometry.windows = state.geometry.windows.filter((item) => item.id !== state.selected.id);
  else if(state.selected.kind==='column') state.geometry.columns = (state.geometry.columns||[]).filter((item) => item.id !== state.selected.id);
  else if(state.selected.kind==='ceiling') state.geometry.ceilingZones = (state.geometry.ceilingZones||[]).filter((item) => item.id !== state.selected.id);
  else {state.equipment=state.equipment.filter(item=>item.id!==state.selected.id);setEquipmentDirty(true);}
  state.selected = null; drawGeometry();drawEquipment();updateVisibleCount(); showGeometryCard();
}

function restoreSnapshot(saved){state.geometry=clone(saved.geometry);state.accessPoints=clone(saved.accessPoints||[]);state.equipment=clone(saved.equipment);state.selected=null;setDirty(true);setEquipmentDirty(true);drawGeometry();drawEquipment();showGeometryCard();}
function undo() { if (!state.history.length) return; state.future.push(snapshot()); restoreSnapshot(state.history.pop()); }
function redo() { if (!state.future.length) return; state.history.push(snapshot()); restoreSnapshot(state.future.pop()); }
function clearDraft() { if (state.draftLayer) state.draftLayer.removeChildren(); }
function drawDraft(point) { clearDraft(); if (!state.draftStart) return; const g = new PIXI.Graphics(); g.moveTo(state.draftStart.x, state.draftStart.y).lineTo(point.x, point.y).stroke({ width: 5, color: 0xf4bd5c, alpha: 0.9 }); g.circle(state.draftStart.x, state.draftStart.y, 8).fill({ color: 0xf4bd5c }); state.draftLayer.addChild(g); }

function handleEditorDown(event) {
  const point = worldPoint(event);
  const layer = state.tool.startsWith('door') ? 'door' : state.tool.startsWith('column-')?'column':state.tool==='ceiling-zone'?'ceiling':state.tool.startsWith('equipment:')?'controller':state.tool;
  if (layer !== 'select' && layers[layer] && !editable(layer)) return showToast('Сначала включите и разблокируйте слой');
  if(state.tool==='cad-area'){
    if(!state.cadPreview)return showToast('Сначала выберите DWG или DXF как рабочий план',true);
    if(!state.cadAreaStart){state.cadAreaStart=point;state.cadArea=null;state.cadProposal=null;drawCadAnalysis(point);renderCadWorkflow();setEditorHint('Область CAD: укажите второй угол');}
    else {const start=state.cadAreaStart;state.cadAreaStart=null;state.cadArea={minX:Math.min(start.x,point.x),minY:Math.min(start.y,point.y),maxX:Math.max(start.x,point.x),maxY:Math.max(start.y,point.y)};if(state.cadArea.maxX-state.cadArea.minX<10||state.cadArea.maxY-state.cadArea.minY<10){state.cadArea=null;showToast('Область слишком мала',true);}drawCadAnalysis();renderCadWorkflow();setEditorHint('Область выбрана. Нажмите «Найти стены в области»');}
    return;
  }
  if (["wall", "partition"].includes(state.tool)) {
    if (!state.draftStart) { state.draftStart = point; drawDraft(point); setEditorHint("Укажите вторую точку"); }
    else { addWall(state.tool, state.draftStart, point); setTool(state.tool); }
    return;
  }
  if (state.tool === "door-left") return addDoor(point, "left", 1);
  if (state.tool === "door-right") return addDoor(point, "right", 1);
  if (state.tool === "door-double") return addDoor(point, "right", 2);
  if (state.tool === "window") return addWindow(point);
  if(state.tool==='column-round')return addColumn(point,'round');
  if(state.tool==='column-square')return addColumn(point,'square');
  if(state.tool==='ceiling-zone')return addCeilingZone(point);
  if(state.tool.startsWith('equipment:'))return addEquipment(point,state.tool.split(':')[1]);
  state.selected = nearestElement(point);
  if(state.selected?.kind==='ceiling'&&state.selected.handle?.startsWith('edge:')){
    const zone=state.geometry.ceilingZones.find(item=>item.id===state.selected.id),points=ceilingZonePoints(zone);
    const edgeIndex=Number(state.selected.handle.split(':')[1]),projection=ceilingEdgeProjection(point,points[edgeIndex],points[(edgeIndex+1)%points.length]);
    beginMutation();points.splice(edgeIndex+1,0,{x:projection.x,y:projection.y});zone.points=points;syncCeilingBounds(zone);
    state.selected.handle=`vertex:${edgeIndex+1}`;
    state.moving={start:point,geometry:clone(state.geometry),equipment:clone(state.equipment),handle:state.selected.handle,started:true};
    drawGeometry();showGeometryCard();return;
  }
  if (selectedEditable()) state.moving = { start: point, geometry: clone(state.geometry), equipment:clone(state.equipment), handle:state.selected.handle||null, started: false };
  drawGeometry();drawEquipment(); showGeometryCard();
}

function handleEditorMove(event) {
  const point = worldPoint(event); if(state.cadAreaStart)drawCadAnalysis(point);if (state.draftStart) drawDraft(point); if (!state.moving || !state.selected) return;
  if(state.selected.kind==='equipment'&&state.equipment.find(e=>e.id===state.selected.id)?.doorMount)return;
  const dx = point.x - state.moving.start.x, dy = point.y - state.moving.start.y;
  if (!state.moving.started && Math.hypot(dx, dy) < 2) return;
  if (!state.moving.started) { beginMutation(state.selected.kind==='equipment'?'equipment':'geometry'); state.moving.started = true; }
  if(state.selected.kind==='equipment') {
    const original=state.moving.equipment.find(item=>item.id===state.selected.id),item=state.equipment.find(item=>item.id===state.selected.id);
    if(cameraTypes.has(item.type)&&state.moving.handle==='rotation'){
      let angle=Math.atan2(point.y-item.y,point.x-item.x);if(event.shiftKey)angle=Math.round(angle/(Math.PI/4))*(Math.PI/4);item.rotation=angle;
    } else {
      Object.assign(item,{x:original.x+dx,y:original.y+dy});
      if(!cameraTypes.has(item.type)){const door=nearestDoor(item,70/state.scale),wall=nearestWall(item,70/state.scale);item.hostDoorId=door?.door.id||null;item.hostWallId=door?.door.wallId||wall?.wall.id||null;item.rotation=door?.door.rotation||wall?.rotation||item.rotation;}
    }
    setEquipmentDirty(true);
  } else if (state.selected.kind === "wall") {
    const original = state.moving.geometry.walls.find((item) => item.id === state.selected.id), wall = state.geometry.walls.find((item) => item.id === state.selected.id);
    Object.assign(wall, { x1: original.x1 + dx, y1: original.y1 + dy, x2: original.x2 + dx, y2: original.y2 + dy });
    state.geometry.doors.filter((door) => door.wallId === wall.id).forEach((door) => { const originalDoor = state.moving.geometry.doors.find((item) => item.id === door.id); door.x = originalDoor.x + dx; door.y = originalDoor.y + dy; });
    state.geometry.windows.filter((windowItem) => windowItem.wallId === wall.id).forEach((windowItem) => { const originalWindow = state.moving.geometry.windows.find((item) => item.id === windowItem.id); windowItem.x = originalWindow.x + dx; windowItem.y = originalWindow.y + dy; });
    const doorIds=new Set(state.geometry.doors.filter(door=>door.wallId===wall.id).map(door=>door.id));
    state.equipment.filter(item=>item.hostWallId===wall.id||doorIds.has(item.hostDoorId)).forEach(item=>{const originalItem=state.moving.equipment.find(entry=>entry.id===item.id);item.x=originalItem.x+dx;item.y=originalItem.y+dy;});
    if(state.equipment.some(item=>item.hostWallId===wall.id||doorIds.has(item.hostDoorId)))setEquipmentDirty(true);
  } else if(state.selected.kind==='column') {
    const original=(state.moving.geometry.columns||[]).find(item=>item.id===state.selected.id),column=(state.geometry.columns||[]).find(item=>item.id===state.selected.id);
    Object.assign(column,{x:original.x+dx,y:original.y+dy});
  } else if(state.selected.kind==='ceiling') {
    const original=(state.moving.geometry.ceilingZones||[]).find(item=>item.id===state.selected.id),zone=(state.geometry.ceilingZones||[]).find(item=>item.id===state.selected.id);
    const originalPoints=ceilingZonePoints(original);
    if(!state.moving.handle)zone.points=originalPoints.map(vertex=>({x:vertex.x+dx,y:vertex.y+dy}));
    else if(state.moving.handle.startsWith('vertex:')){
      const index=Number(state.moving.handle.split(':')[1]);zone.points=originalPoints.map(vertex=>({...vertex}));
      let target={x:originalPoints[index].x+dx,y:originalPoints[index].y+dy};
      if(event.shiftKey){
        const anchor=zone.points[(index-1+zone.points.length)%zone.points.length],length=Math.hypot(target.x-anchor.x,target.y-anchor.y),angle=Math.round(Math.atan2(target.y-anchor.y,target.x-anchor.x)/(Math.PI/4))*(Math.PI/4);
        target={x:anchor.x+Math.cos(angle)*length,y:anchor.y+Math.sin(angle)*length};
      }
      zone.points[index]=target;
    }
    syncCeilingBounds(zone);
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
  const stop = () => {
    const geometryChanged = Boolean(state.moving?.started);
    state.dragging = false;
    state.moving = null;
    if (geometryChanged) showGeometryCard();
  };
  canvas.addEventListener("pointerup", stop); canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", () => { $("#cursor-coordinates").textContent = "— / —"; });
}

function setTool(tool) {
  state.tool = tool; state.draftStart = null; state.cadAreaStart=null; state.moving = null; clearDraft();drawCadAnalysis();
  document.querySelectorAll(".tool-button").forEach((button) => button.classList.toggle("is-active", button.dataset.tool === tool));
  document.querySelectorAll('.equipment-tool').forEach(button=>button.classList.toggle('is-active',tool===`equipment:${button.dataset.equipmentType}`));
  $("#floor-plan-container").dataset.tool = tool;
  if (tool==='pan') return setEditorHint('Зажмите левую кнопку и перемещайте весь план');
  if(tool==='cad-area')return setEditorHint(state.cadPreview?'Область CAD: укажите первый угол':'Сначала выберите DWG или DXF как рабочий план');
  if(tool.startsWith('equipment:'))return setEditorHint(`Размещение: ${equipmentCatalog[tool.split(':')[1]].name}`);
  setEditorHint({ select: "Выберите или перетащите элемент", wall: "Стена: укажите первую точку", partition: "Перегородка: укажите первую точку", "column-round": "Круглая колонна: нажмите на плане", "column-square": "Квадратная колонна: нажмите на плане", "ceiling-zone": "Потолочная зона: нажмите внутри помещения", "door-left": "Левая дверь: нажмите рядом со стеной", "door-right": "Правая дверь: нажмите рядом со стеной", "door-double": "Двойная дверь: нажмите рядом со стеной", window: "Окно: нажмите рядом со стеной" }[tool]);
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
  const item = state.selected.kind === "wall" ? state.geometry.walls.find((x) => x.id === state.selected.id) : state.selected.kind === "door" ? state.geometry.doors.find((x) => x.id === state.selected.id) : state.selected.kind==='window' ? state.geometry.windows.find((x) => x.id === state.selected.id) : state.selected.kind==='column' ? state.geometry.columns.find((x)=>x.id===state.selected.id) : state.selected.kind==='ceiling' ? state.geometry.ceilingZones.find((x)=>x.id===state.selected.id) : state.equipment.find(x=>x.id===state.selected.id);
  if (!item) return;
  if(state.selected.kind==='ceiling') {
    syncCeilingBounds(item);const points=ceilingZonePoints(item),canRemoveVertex=state.selected.handle?.startsWith('vertex:')&&points.length>3;
    $('#object-card').innerHTML=`<div class="object-card__content"><div class="object-card__head"><h3>${escapeHtml(item.id)}</h3><span class="status-badge">ПОТОЛОК</span></div><dl><dt>Габарит</dt><dd>${Math.round(item.width)} × ${Math.round(item.height)} ед.</dd><dt>Углов</dt><dd>${points.length}</dd><dt>Отметка</dt><dd>${Math.round(item.heightMm)} мм</dd></dl><label class="card-field">Тип потолка<select data-ceiling-field="type"><option value="flat">Сплошной</option><option value="suspended">Подвесной</option><option value="open">Открытое перекрытие</option></select></label><label class="card-field">Общая ширина<input data-ceiling-field="width" type="number" min="20" max="10000" step="10" value="${Math.round(item.width)}"></label><label class="card-field">Общая глубина<input data-ceiling-field="height" type="number" min="20" max="10000" step="10" value="${Math.round(item.height)}"></label><label class="card-field">Высота потолка, мм<input data-ceiling-field="heightMm" type="number" min="100" max="10000" step="10" value="${Math.round(item.heightMm)}"></label>${canRemoveVertex?'<button type="button" data-ceiling-action="remove-vertex">Удалить выбранный угол</button>':''}<p class="editor-help">Белые точки — углы: перетаскивайте их. Тёмная точка посередине стороны — добавить новый угол. Shift при перетаскивании фиксирует направление по шагу 45°. За внутреннюю область двигается вся зона.</p></div>`;
    $('#object-card [data-ceiling-field=type]').value=item.type;return;
  }
  if(state.selected.kind==='equipment') {
    const definition=equipmentCatalog[item.type]||{name:item.type};
    if(cameraTypes.has(item.type)){
      const rotationDeg=((Number(item.rotation)||0)*180/Math.PI+360)%360;
      const bracket=item.type==='camera_ceiling_bracket'?`<label class="card-field">Длина кронштейна, мм<input data-equipment-field="bracketLengthMm" type="number" min="50" max="2000" step="10" value="${item.bracketLengthMm||200}"></label>`:'';
      const blindMode=item.blindZoneMode==='manual'?'manual':'auto',autoBlind=Math.round(cameraAutoBlindZone(item)),blindValue=blindMode==='manual'?Math.round(cameraBlindZone(item)):autoBlind;
      $('#object-card').innerHTML=`<div class="object-card__content"><div class="object-card__head"><h3>${escapeHtml(item.code)}</h3><span class="status-badge">ОХРАННОЕ ТВ</span></div><dl><dt>Тип</dt><dd>${escapeHtml(definition.name)}</dd><dt>Координаты</dt><dd>${item.x.toFixed(0)} / ${item.y.toFixed(0)}</dd></dl><label class="card-field">Сценарий<select data-equipment-field="cameraPreset"><option value="custom">Пользовательская настройка</option><option value="cash_zone">Кассовая зона</option></select></label><label class="card-field">Обозначение<input data-equipment-field="code" maxlength="80" value="${escapeHtml(item.code)}"></label><label class="card-field">Высота установки, мм<input data-equipment-field="mountingHeight" type="number" min="100" max="10000" step="10" value="${item.mountingHeight}"></label>${bracket}<label class="card-field">Направление по плану, °<input data-equipment-field="rotationDeg" type="number" min="0" max="359" step="5" value="${Math.round(rotationDeg)}"></label><label class="card-field">Наклон к полу, °<input data-equipment-field="downTiltDeg" type="number" min="0" max="90" step="5" value="${Number.isFinite(Number(item.downTiltDeg))?item.downTiltDeg:45}"></label><p class="editor-help">0° — камера смотрит горизонтально, 90° — строго перпендикулярно вниз.</p><label class="card-field">Угол обзора, °<input data-equipment-field="viewAngleDeg" type="number" min="20" max="180" step="5" value="${item.viewAngleDeg||90}"></label><label class="card-field">Дальность на плане<input data-equipment-field="viewRange" type="number" min="40" max="3000" step="10" value="${item.viewRange||420}"></label><label class="card-field">Мёртвая зона<select data-equipment-field="blindZoneMode"><option value="auto">Автоматически · ${autoBlind} ед.</option><option value="manual">Вручную</option></select></label><label class="card-field">Ручной радиус мёртвой зоны, ед.<input data-equipment-field="blindZone" type="number" min="0" max="2000" step="10" value="${blindValue}" ${blindMode==='auto'?'disabled':''}></label><label class="card-field">Статус<select data-equipment-field="status"><option value="proposed">Предложено</option><option value="confirmed">Подтверждено</option></select></label><p class="editor-help">Голубой сектор учитывает наклон камеры. При 90° обзор на плане становится круглым. Стены и колонны обрезают видимую область.</p></div>`;
      $('#object-card [data-equipment-field=cameraPreset]').value=item.cameraPreset||'custom';
      $('#object-card [data-equipment-field=blindZoneMode]').value=blindMode;
      $('#object-card [data-equipment-field=status]').value=item.status;return;
    }
    const doorOptions=['<option value="">Не привязано</option>',...state.geometry.doors.map(door=>`<option value="${escapeHtml(door.id)}" ${item.hostDoorId===door.id?'selected':''}>${escapeHtml(door.id)}${doorAccessPointCode(door)?` · ${escapeHtml(doorAccessPointCode(door))}`:''}</option>`)].join('');
    const served=new Set(item.servedDoorIds||[]);
    const servedPoints=state.accessPoints.filter(point=>served.has(point.doorId));
    const readerLoad=servedPoints.reduce((sum,point)=>sum+(point.readerCount||1),0);
    const pointChoices=state.accessPoints.map(point=>`<label><input type="checkbox" data-controller-door="${escapeHtml(point.doorId)}" ${served.has(point.doorId)?'checked':''}>${escapeHtml(point.code)} · дверь ${escapeHtml(point.doorId)} · ${point.readerCount||1} сч.</label>`).join('');
    const controllerChoices=['<option value="">Не назначен</option>',...state.equipment.filter(entry=>entry.type==='controller').map(controller=>`<option value="${escapeHtml(controller.id)}" ${item.servedControllerId===controller.id?'selected':''}>${escapeHtml(controller.code)} · ${escapeHtml(controller.id)}</option>`)].join('');
    const controllerFields=item.type==='controller'?`<label class="card-field">Форм-фактор<select data-equipment-field="formFactor"><option value="wall_enclosure">Корпус настенного исполнения</option><option value="din_rail">Модуль на DIN-рейку</option></select></label><label class="card-field">Ёмкость, дверей<select data-equipment-field="controllerDoorCapacity">${[1,2,4,8].map(value=>`<option value="${value}">${value}</option>`).join('')}</select></label><label class="card-field">Ёмкость, считывателей<input data-equipment-field="controllerReaderCapacity" type="number" min="1" max="32" value="${item.controllerReaderCapacity||8}"></label><fieldset class="controller-doors"><legend>Обслуживаемые точки прохода</legend>${pointChoices||'<p>Назначьте ТД на двери</p>'}</fieldset><p class="editor-help">Загрузка: ${servedPoints.length}/${item.controllerDoorCapacity||4} точек прохода, ${readerLoad}/${item.controllerReaderCapacity||8} считывателей. Форм-фактор и место независимы: DIN-модуль может находиться в шкафу, в локальном настенном боксе или в боксе за потолком.</p>`:`<label class="card-field">Связанная дверь<select data-equipment-field="hostDoorId">${doorOptions}</select></label>`;
    const powerSupplyFields=item.type==='power_supply'?`<label class="card-field">Питает контроллер<select data-equipment-field="servedControllerId">${controllerChoices}</select></label><p class="editor-help">Оранжевая линия на плане — условная связь питания БП → КНТ, не фактическая кабельная трасса.</p>`:'';
    $("#object-card").innerHTML=`<div class="object-card__content"><div class="object-card__head"><h3>${escapeHtml(item.code)}</h3><span class="status-badge">СКУД</span></div><dl><dt>Тип</dt><dd>${escapeHtml(definition.name)}</dd><dt>Координаты</dt><dd>${item.x.toFixed(0)} / ${item.y.toFixed(0)}</dd></dl><label class="card-field">Обозначение<input data-equipment-field="code" maxlength="80" value="${escapeHtml(item.code)}"></label><label class="card-field">Место монтажа<select data-equipment-field="mount"><option value="wall">На стене (в боксе / на DIN-рейке)</option><option value="door">На двери/проёме</option><option value="ceiling">За потолком (в боксе / на DIN-рейке)</option><option value="cabinet">В шкафу</option><option value="free">Без привязки</option></select></label><label class="card-field">Высота, мм<input data-equipment-field="mountingHeight" type="number" min="0" max="10000" value="${item.mountingHeight}"></label>${controllerFields}${powerSupplyFields}<label class="card-field">Статус<select data-equipment-field="status"><option value="proposed">Предложено</option><option value="confirmed">Подтверждено</option></select></label></div>`;
    $("#object-card [data-equipment-field=mount]").value=item.mount;
    $("#object-card [data-equipment-field=status]").value=item.status;
    if(item.type==='controller'){$("#object-card [data-equipment-field=formFactor]").value=item.formFactor||'wall_enclosure';$("#object-card [data-equipment-field=controllerDoorCapacity]").value=String(item.controllerDoorCapacity||4);}
    if(item.type!=='controller'&&item.hostDoorId){const button=document.createElement('button');button.className='save-geometry';button.textContent='Монтажный узел · стороны А / Б';button.onclick=()=>openDoorEditor(item.hostDoorId);$('#object-card .object-card__content').append(button);}
    return;
  }
  const type = state.selected.kind === "wall" ? item.type === "partition" ? "Перегородка" : "Стена" : state.selected.kind === "door" ? item.leafCount === 2 ? "Двойная дверь" : "Одинарная дверь" : state.selected.kind==='column' ? item.shape==='round'?'Круглая колонна':'Квадратная колонна' : "Окно";
  const details = state.selected.kind === "wall" ? `<dt>Начало</dt><dd>${item.x1.toFixed(0)} / ${item.y1.toFixed(0)}</dd><dt>Конец</dt><dd>${item.x2.toFixed(0)} / ${item.y2.toFixed(0)}</dd><dt>Верх</dt><dd>${item.topMode==='ceiling'?'До потолка':'Фиксированный'} · ${Math.round(item.heightMm||3000)} мм</dd>` : state.selected.kind==='column'?`<dt>Центр</dt><dd>${item.x.toFixed(0)} / ${item.y.toFixed(0)}</dd><dt>Размер</dt><dd>${Math.round(item.size)} ед.</dd><dt>Высота</dt><dd>${Math.round(item.heightMm)} мм</dd>`:`<dt>Стена</dt><dd>${escapeHtml(item.wallId)}</dd><dt>Центр</dt><dd>${item.x.toFixed(0)} / ${item.y.toFixed(0)}</dd>`;
  const wallFields = state.selected.kind === 'wall' ? `<label class="card-field">Режим верха<select data-wall-field="topMode"><option value="fixed">Фиксированная высота</option><option value="ceiling">До потолка зоны</option></select></label><label class="card-field">${item.topMode==='ceiling'?'Текущая отметка, мм':'Высота, мм'}<input data-wall-field="heightMm" type="number" min="100" max="10000" step="10" value="${item.heightMm||3000}"></label><p class="editor-help">${item.topMode==='ceiling'?'До добавления потолочных зон эта отметка используется в 2.5D.':'Высота отображается в 2.5D.'}</p><details class="wall-composition"><summary>Состав по высоте${item.materialBands.length?` · ${item.materialBands.length}`:''}</summary><div class="material-bands">${item.materialBands.map((band,index)=>`<div class="material-band"><input aria-label="От, мм" title="От, мм" type="number" min="0" max="10000" step="10" data-wall-band-index="${index}" data-wall-band-field="fromMm" value="${band.fromMm}"><input aria-label="До, мм" title="До, мм" type="number" min="1" max="10000" step="10" data-wall-band-index="${index}" data-wall-band-field="toMm" value="${band.toMm}"><input aria-label="Материал" title="Материал" maxlength="80" data-wall-band-index="${index}" data-wall-band-field="material" value="${escapeHtml(band.material)}" placeholder="Материал"><button type="button" title="Удалить полосу" data-wall-action="remove-band" data-wall-band-index="${index}">×</button></div>`).join('')}</div><button type="button" class="add-material-band" data-wall-action="add-band">+ Добавить полосу</button><p class="editor-help">Диапазоны не должны перекрываться. Например: 0–1200 газоблок, 1200–2400 стеклоблок.</p></details>` : '';
  const accessPoint=accessPointForDoor(item);
  const doorActions = state.selected.kind === "door" ? `<div class="access-point-card"><span>Точка прохода СКУД</span><strong>${escapeHtml(accessPoint?.code||'не назначена')}</strong><label class="card-field">Код точки прохода<input data-door-field="accessPointCode" placeholder="ТД.1.1" value="${escapeHtml(accessPoint?.code||item.accessPointCode||'')}"></label><button type="button" data-door-action="assign-access-point">Назначить точку прохода</button>${accessPoint?'<button type="button" data-door-action="remove-access-point">Снять точку прохода</button>':''}</div><label class="card-field">Считыватели точки прохода<select data-door-field="readerCount"><option value="1">1 — вход по карте, выход по кнопке</option><option value="2" ${(accessPoint?.readerCount||item.readerCount)===2?'selected':''}>2 — считыватель с обеих сторон</option></select></label><div class="object-card__actions"><button type="button" data-door-action="flip">Петли: ${item.swing === "left" ? "слева" : "справа"}</button><button type="button" data-door-action="side">Сменить сторону открытия (${item.openingSide === 1 ? 'Б' : 'А'})</button><button type="button" data-door-action="toggle-leaves">${item.leafCount === 2 ? "Сделать одинарной" : "Сделать двойной"}</button></div><p class="editor-help">Дверь остаётся архитектурным объектом. Точка прохода назначается отдельно и включает оборудование СКУД.</p>` : state.selected.kind === 'window' ? `<p class="editor-help">Ширина: ${item.width} ед. плана. Перетащите вдоль стены; Alt — перенос на другую стену.</p>` : "";
  $("#object-card").innerHTML = `<div class="object-card__content"><div class="object-card__head"><h3>${escapeHtml(item.id)}</h3><span class="status-badge">выбран</span></div><dl><dt>Тип</dt><dd>${type}</dd>${details}</dl>${wallFields}${doorActions}</div>`;
  if(state.selected.kind==='wall')$('#object-card [data-wall-field=topMode]').value=item.topMode||'fixed';
  if(state.selected.kind==='door')$('#object-card .object-card__actions').insertAdjacentHTML('afterbegin','<button type="button" data-door-action="equipment">Монтажный узел · стороны А / Б</button>');
}

function updateEditorButtons() { $("#delete-element").disabled = !selectedEditable(); $("#undo-edit").disabled = !state.history.length; $("#redo-edit").disabled = !state.future.length; }
function updateVisibleCount() { if (state.geometry) { const edited=state.geometry.walls.length+state.geometry.doors.length+state.geometry.windows.length+(state.geometry.columns||[]).length+(state.geometry.ceilingZones||[]).length+state.markers.length; const cad=state.cadPreview?.paths?.length||0; $("#visible-count").textContent = cad ? `${edited} ред. · ${cad} CAD` : `${edited} элементов`; } }

async function saveGeometry() {
  const response = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/geometry`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.geometry) });
  const result = await response.json(); if (!response.ok) throw new Error(result.detail || "Не удалось сохранить геометрию");
  state.geometry = result.geometry; if(!state.equipmentDirty){state.history=[];state.future=[];} setDirty(false); drawGeometry(); showToast(`Сохранено: ${result.walls} стен, ${result.doors} дверей, ${result.windows} окон, ${result.columns||0} колонн, ${result.ceilingZones||0} потолочных зон`);
}

async function saveEquipment() {
  const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/equipment`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessPoints:state.accessPoints,equipment:state.equipment})});
  const result=await response.json();if(!response.ok)throw new Error(result.detail||'Не удалось сохранить оборудование');
  state.accessPoints=result.accessPoints||state.accessPoints;state.project.accessPoints=state.accessPoints;
  state.equipment=result.equipment;state.project.equipment=state.equipment;if(!state.dirty){state.history=[];state.future=[];}setEquipmentDirty(false);drawEquipment();showToast(`Оборудование сохранено: ${result.count}, точек прохода: ${state.accessPoints.length}`);
}

async function uploadCad(file) {
  await attachProjectFile(file);
  const data = new FormData(); data.append("file", file); showToast(`Читаем ${file.name}…`);
  const response = await fetch(`/api/parse-cad?project_id=${encodeURIComponent(state.projectId)}`, { method: "POST", body: data }), result = await response.json();
  if (!response.ok) throw new Error(result.detail || "Ошибка чтения CAD");
  const record=await loadJson(`/api/projects/${encodeURIComponent(state.projectId)}`,'DWG прочитан, но результат не удалось открыть');
  state.project=record.project;state.geometry=record.geometry;state.accessPoints=normalizeAccessPoints(record.project.accessPoints||[],state.geometry);state.equipment=record.project.equipment||[];state.cadPreview=record.cadPreview||null;
  state.cadArea=record.cadPreview?.focus?clone(record.cadPreview.bounds):null;state.cadAreaStart=null;state.cadProposal=null;renderCadWorkflow();
  $("#source-label").textContent = file.name; await drawPlan();if(state.cadPreview?.focus)await findCadArchitecture();fitPlan();
  const preview=result.preview;
  showToast(`CAD-подложка: ${preview?.paths||0} контуров, ${preview?.labels||0} подписей, ${preview?.layers?.length||0} слоёв. Найдено оборудования: ${result.equipment.length}.`);
}

function normalizeCoordinates(items, bounds) {
  if (!bounds) return items; const target = state.project.floorPlan, sw = Math.max(bounds.maxX - bounds.minX, 1), sh = Math.max(bounds.maxY - bounds.minY, 1), pad = 100, factor = Math.min((target.width - 2 * pad) / sw, (target.height - 2 * pad) / sh);
  return items.map((item) => ({ ...item, originalX: item.x, originalY: item.y, x: pad + (item.x - bounds.minX) * factor, y: target.height - pad - (item.y - bounds.minY) * factor }));
}

function bindInterface() {
  $('#open-project').addEventListener('click',()=>openProject($('#project-list').value));
  $('#archive-project').addEventListener('click',async()=>{try{await archiveCurrentProject();}catch(error){showToast(error.message,true);}});
  $('#restore-project').addEventListener('click',async()=>{try{await restoreArchivedProject();}catch(error){showToast(error.message,true);}});
  $('#delete-project').addEventListener('click',async()=>{try{await deleteArchivedProject();}catch(error){showToast(error.message,true);}});
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
  $('#analyze-sources').addEventListener('click',async()=>{
    if(state.projectBusy)return showToast('Дождитесь завершения текущей операции');
    const button=$('#analyze-sources');state.projectBusy=true;button.disabled=true;
    try{await analyzeSources();}catch(error){showToast(error.message,true);}finally{state.projectBusy=false;button.disabled=false;}
  });
  $('#source-analysis').addEventListener('click',async event=>{
    const preview=event.target.closest('[data-region-preview]');
    if(preview){showSourcePreview(preview);return;}
    const button=event.target.closest('[data-activate-source]');if(!button)return;
    if(state.projectBusy)return showToast('Дождитесь завершения текущей операции');
    state.projectBusy=true;button.disabled=true;
    try{await activateSource(button.dataset.activateSource,button.dataset.page,button.dataset.regionId);}
    catch(error){showToast(error.message,true);}finally{state.projectBusy=false;button.disabled=false;}
  });
  $('#close-cad-source-preview').addEventListener('click',hideSourcePreview);
  window.addEventListener('keydown',event=>{if(event.key==='Escape')hideSourcePreview();});
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
  $('#view-camera-coverage').addEventListener('change',event=>{if(state.volume){state.volume.showCameraCoverage=event.target.checked;state.volume.render();}});
  $('#view-camera-opacity').addEventListener('input',event=>{const value=Number(event.target.value)||18;$('#view-camera-opacity-value').textContent=`${value}%`;if(state.volume){state.volume.cameraCoverageOpacity=value/100;state.volume.render();}});
  $("#enter-plan").addEventListener("click", () => { $("#cover").classList.add("is-hidden"); $("#dashboard").classList.add("is-visible"); $("#dashboard").setAttribute("aria-hidden", "false"); setTimeout(resizePlan, 250); });
  $("#back-to-cover").addEventListener("click", () => { $("#cover").classList.remove("is-hidden"); $("#dashboard").classList.remove("is-visible"); $("#dashboard").setAttribute("aria-hidden", "true"); });
  $("#zoom-in").addEventListener("click", () => zoomAt(1.2)); $("#zoom-out").addEventListener("click", () => zoomAt(0.82)); $("#fit-plan").addEventListener("click", fitPlan);
  $("#editor-toggle").addEventListener("click", toggleEditor);
  document.querySelectorAll(".tool-button").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  $('#find-cad-architecture').addEventListener('click',async()=>{const button=$('#find-cad-architecture');button.disabled=true;try{await findCadArchitecture();}catch(error){showToast(error.message,true);}finally{button.disabled=!state.cadArea;}});
  $('#apply-cad-proposal').addEventListener('click',applyCadProposal);
  $('#clear-cad-proposal').addEventListener('click',()=>{state.cadProposal=null;drawCadAnalysis();renderCadWorkflow();showToast('Черновик сброшен');});
  document.querySelectorAll('.equipment-tool').forEach(button=>button.addEventListener('click',()=>{
    if(!state.editorEnabled)return showToast('Сначала включите «Редактор плана»');
    setTool(`equipment:${button.dataset.equipmentType}`);
  }));
  $("#delete-element").addEventListener("click", deleteSelected); $("#undo-edit").addEventListener("click", undo); $("#redo-edit").addEventListener("click", redo);
  $("#object-card").addEventListener("click", (event) => {
    const ceilingAction=event.target.closest('[data-ceiling-action]')?.dataset.ceilingAction;
    if(ceilingAction==='remove-vertex'&&state.selected?.kind==='ceiling'&&selectedEditable()){
      const zone=state.geometry.ceilingZones.find(item=>item.id===state.selected.id),points=zone&&ceilingZonePoints(zone);
      const index=Number(state.selected.handle?.split(':')[1]);
      if(!zone||points.length<=3||!Number.isInteger(index))return;
      beginMutation();points.splice(index,1);zone.points=points;syncCeilingBounds(zone);state.selected.handle=null;
      drawGeometry();showGeometryCard();return;
    }
    const wallAction=event.target.closest('[data-wall-action]')?.dataset.wallAction;
    if(wallAction&&state.selected?.kind==='wall'&&selectedEditable()){
      const wall=state.geometry.walls.find(item=>item.id===state.selected.id);if(!wall)return;
      if(wallAction==='add-band'){
        const from=wall.materialBands.reduce((maximum,band)=>Math.max(maximum,Number(band.toMm)||0),0);
        if(from>=wall.heightMm)return showToast('Высота уже полностью распределена',true);
        beginMutation();
        wall.materialBands.push({fromMm:from,toMm:wall.heightMm,material:'Новый материал'});
      } else if(wallAction==='remove-band'){beginMutation();wall.materialBands.splice(Number(event.target.closest('[data-wall-band-index]').dataset.wallBandIndex),1);}
      drawGeometry();showGeometryCard();return;
    }
    const action = event.target.closest("[data-door-action]")?.dataset.doorAction;
    if (!action || state.selected?.kind !== "door" || !selectedEditable()) return;
    const door = state.geometry.doors.find((item) => item.id === state.selected.id);
    if (!door) return;
    if (action === 'equipment') return openDoorEditor(door.id);
    if (action === 'assign-access-point') {
      const input=$('#object-card [data-door-field=accessPointCode]');
      const code=normalizeAccessPointCode(input?.value);
      if(!code)return showToast('Используйте формат ТД.1.1',true);
      if(state.accessPoints.some(point=>point.doorId!==door.id&&point.code===code))return showToast(`${code} уже назначена другой двери`,true);
      beginMutation('equipment');const result=assignAccessPointToDoor(door,code);setDirty(true);
      const renamed=updateDoorEquipmentCodes(door);if(renamed)setEquipmentDirty(true);
      drawGeometry();drawEquipment();showGeometryCard();return showToast(`${result.point.code} назначена двери ${door.id}`);
    }
    if (action === 'remove-access-point') {
      if(state.equipment.some(item=>item.hostDoorId===door.id))return showToast('Сначала удалите или отвяжите оборудование этой точки прохода',true);
      beginMutation('equipment');const removed=removeAccessPointFromDoor(door);setDirty(true);
      drawGeometry();drawEquipment();showGeometryCard();return showToast(removed?'Точка прохода снята с двери':'У двери нет точки прохода');
    }
    beginMutation();
    if (action === "flip") door.swing = door.swing === "left" ? "right" : "left";
    if (action === "side") door.openingSide = door.openingSide === 1 ? -1 : 1;
    if (action === "toggle-leaves") { door.leafCount = door.leafCount === 2 ? 1 : 2; door.width = door.leafCount === 2 ? Math.max(88, door.width) : Math.min(48, door.width); }
    drawGeometry(); showGeometryCard();
  });
  $('#object-card').addEventListener('change',event=>{
    const ceilingField=event.target.dataset.ceilingField;
    if(ceilingField&&state.selected?.kind==='ceiling'&&selectedEditable()){
      const zone=state.geometry.ceilingZones.find(item=>item.id===state.selected.id);if(!zone)return;
      beginMutation();
      if(ceilingField==='type')zone.type=['flat','suspended','open'].includes(event.target.value)?event.target.value:'flat';
      if(ceilingField==='heightMm')zone.heightMm=Math.max(100,Math.min(10000,Number(event.target.value)||2700));
      if(ceilingField==='width'||ceilingField==='height'){
        syncCeilingBounds(zone);const next=Math.max(20,Math.min(10000,Number(event.target.value)||20));
        const scale=next/zone[ceilingField],axis=ceilingField==='width'?'x':'y',origin=zone[axis];
        zone.points=ceilingZonePoints(zone).map(point=>({...point,[axis]:origin+(point[axis]-origin)*scale}));syncCeilingBounds(zone);
      }
      drawGeometry();showGeometryCard();return;
    }
    const wallField=event.target.dataset.wallField,bandField=event.target.dataset.wallBandField;
    if((wallField||bandField)&&state.selected?.kind==='wall'&&selectedEditable()){
      const wall=state.geometry.walls.find(item=>item.id===state.selected.id);if(!wall)return;
      beginMutation();
      if(wallField==='topMode')wall.topMode=event.target.value==='ceiling'?'ceiling':'fixed';
      if(wallField==='heightMm'){
        wall.heightMm=Math.max(100,Math.min(10000,Number(event.target.value)||3000));
        wall.materialBands=wall.materialBands.map(band=>({...band,fromMm:Math.min(band.fromMm,wall.heightMm),toMm:Math.min(band.toMm,wall.heightMm)})).filter(band=>band.toMm>band.fromMm);
      }
      if(bandField){const band=wall.materialBands[Number(event.target.dataset.wallBandIndex)];if(!band)return;if(bandField==='material')band.material=event.target.value.trim()||'Материал';else band[bandField]=Math.max(bandField==='toMm'?1:0,Math.min(wall.heightMm,Number(event.target.value)||0));}
      drawGeometry();showGeometryCard();return;
    }
    const doorField=event.target.dataset.doorField;
    if(doorField&&state.selected?.kind==='door'&&selectedEditable()){
      const door=state.geometry.doors.find(entry=>entry.id===state.selected.id);if(!door)return;
      if(doorField==='readerCount'){
        const next=Number(event.target.value)===2?2:1,point=accessPointForDoor(door),controllers=state.equipment.filter(item=>item.type==='controller'&&(item.servedDoorIds||[]).includes(door.id));
        if(next===2&&controllers.some(item=>{const load=state.accessPoints.filter(entry=>(item.servedDoorIds||[]).includes(entry.doorId)).reduce((sum,entry)=>sum+(entry.doorId===door.id?next:entry.readerCount||1),0);return load>(item.controllerReaderCapacity||8);})){event.target.value=String(point?.readerCount||door.readerCount||1);return showToast('У связанного контроллера недостаточно каналов считывателей',true);}
        beginMutation(point?'equipment':'geometry');door.readerCount=next;if(point){point.readerCount=next;setEquipmentDirty(true);}
        drawGeometry();showGeometryCard();return;
      }
      const code=normalizeAccessPointCode(event.target.value);
      if(!door)return;
      if(event.target.value.trim()&&!code){event.target.value=door.accessPointCode||'';return showToast('Используйте формат ТД.1.1',true);}
      if(code&&state.accessPoints.some(entry=>entry.doorId!==door.id&&entry.code===code)){event.target.value=doorAccessPointCode(door)||'';return showToast(`${code} уже назначена другой двери`,true);}
      if(!code){
        if(state.equipment.some(item=>item.hostDoorId===door.id)){event.target.value=doorAccessPointCode(door)||'';return showToast('Сначала удалите или отвяжите оборудование этой точки прохода',true);}
        beginMutation('equipment');removeAccessPointFromDoor(door);setDirty(true);drawGeometry();drawEquipment();showGeometryCard();showToast('Связь с точкой прохода снята');return;
      }
      beginMutation('equipment');assignAccessPointToDoor(door,code);setDirty(true);const renamed=updateDoorEquipmentCodes(door);if(renamed)setEquipmentDirty(true);
      drawGeometry();drawEquipment();showGeometryCard();showToast(`${code}: обновлено обозначений — ${renamed}`);return;
    }
    const servedDoorId=event.target.dataset.controllerDoor;
    if(servedDoorId&&state.selected?.kind==='equipment'&&selectedEditable()){
      const item=state.equipment.find(entry=>entry.id===state.selected.id);if(!item||item.type!=='controller')return;
      const next=new Set(item.servedDoorIds||[]);event.target.checked?next.add(servedDoorId):next.delete(servedDoorId);
      const readerLoad=state.accessPoints.filter(point=>next.has(point.doorId)).reduce((sum,point)=>sum+(point.readerCount||1),0);
      if(next.size>(item.controllerDoorCapacity||4)||readerLoad>(item.controllerReaderCapacity||8)){event.target.checked=!event.target.checked;return showToast('Превышена ёмкость контроллера по дверям или считывателям',true);}
      if(event.target.checked&&state.equipment.some(other=>other.id!==item.id&&other.type==='controller'&&(other.servedDoorIds||[]).includes(servedDoorId))){event.target.checked=false;return showToast('Эта дверь уже назначена другому контроллеру',true);}
      beginMutation('equipment');item.servedDoorIds=[...next];showGeometryCard();return;
    }
    const field=event.target.dataset.equipmentField;if(!field||state.selected?.kind!=='equipment'||!selectedEditable())return;
    const item=state.equipment.find(entry=>entry.id===state.selected.id);if(!item)return;
    if(field==='controllerDoorCapacity'||field==='controllerReaderCapacity'){
      const next=Math.max(1,Number(event.target.value)||1),served=new Set(item.servedDoorIds||[]),readerLoad=state.accessPoints.filter(point=>served.has(point.doorId)).reduce((sum,point)=>sum+(point.readerCount||1),0);
      if((field==='controllerDoorCapacity'&&served.size>next)||(field==='controllerReaderCapacity'&&readerLoad>next)){showGeometryCard();return showToast('Сначала уменьшите число обслуживаемых дверей',true);}
    }
    beginMutation('equipment');
    if(field==='cameraPreset'){
      item.cameraPreset=event.target.value==='cash_zone'?'cash_zone':'custom';
      if(item.cameraPreset==='cash_zone'){item.downTiltDeg=90;item.blindZoneMode='auto';}
    }
    if(field==='mountingHeight')item[field]=Math.max(0,Math.min(10000,Number(event.target.value)||0));
    else if(field==='rotationDeg')item.rotation=((Number(event.target.value)||0)%360)*Math.PI/180;
    else if(field==='downTiltDeg')item[field]=Math.max(0,Math.min(90,Number(event.target.value)||0));
    else if(field==='viewAngleDeg')item[field]=Math.max(20,Math.min(180,Number(event.target.value)||90));
    else if(field==='viewRange')item[field]=Math.max(40,Math.min(3000,Number(event.target.value)||420));
    else if(field==='blindZoneMode')item[field]=event.target.value==='manual'?'manual':'auto';
    else if(field==='blindZone')item[field]=Math.max(0,Math.min(Math.max(0,(Number(item.viewRange)||420)-1),Number(event.target.value)||0));
    else if(field==='bracketLengthMm')item[field]=Math.max(50,Math.min(2000,Number(event.target.value)||200));
    else if(field==='controllerDoorCapacity')item[field]=[1,2,4,8].includes(Number(event.target.value))?Number(event.target.value):4;
    else if(field==='controllerReaderCapacity')item[field]=Math.max(1,Math.min(32,Number(event.target.value)||1));
    if(item.doorMount&&['mount','hostDoorId'].includes(field)){delete item.doorMount;showToast('Смена монтажа сняла точную привязку. Уточните монтаж в редакторе двери.');}
    if(field==='hostDoorId') {item[field]=event.target.value||null;const door=state.geometry.doors.find(entry=>entry.id===item[field]);if(door){item.hostWallId=door.wallId;item.rotation=door.rotation||0;}}
    else if(!['cameraPreset','mountingHeight','rotationDeg','downTiltDeg','viewAngleDeg','viewRange','blindZoneMode','blindZone','bracketLengthMm','controllerDoorCapacity','controllerReaderCapacity'].includes(field))item[field]=event.target.value.trim?event.target.value.trim():event.target.value;
    if(field==='code'&&!item.code)item.code=item.id;
    drawEquipment();showGeometryCard();
  });
  $("#save-geometry").addEventListener("click", async () => { try { await saveGeometry(); } catch (error) { showToast(error.message, true); } });
  $('#save-equipment').addEventListener('click',async()=>{try{await saveEquipment();}catch(error){showToast(error.message,true);}});
  $('#save-cctv-equipment').addEventListener('click',async()=>{try{await saveEquipment();}catch(error){showToast(error.message,true);}});
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
      state.volume.setModel(saved, state.project.floorPlan, state.equipment, state.accessPoints);
      state.volume.panMode=$('#volume-navigation').value==='pan';
      $('#view-25d-info').textContent = `Сохранённый план: ${saved.walls.length} стен и перегородок, ${saved.doors.length} дверей, ${(saved.windows || []).length} окон, ${state.volume.equipmentCount} схематичных обозначений. Дверной узел СКУД показан одним знаком ТД. Основание — прямоугольная подставка; контур пола ещё не выделен.`;
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
