/* Front elevations of one access point, edited as a draft until explicitly applied. */
function doorHingeView(door, side) {
  if (door.leafCount === 2) return {positions:[-door.width/2,door.width/2],label:'Петли с двух сторон'};
  const localX=door.swing==='right'?door.width/2:-door.width/2;
  const screenX=localX*side;
  return {positions:[screenX],label:`Петли ${screenX<0?'слева':'справа'}`};
}

function doorOpeningView(door, side) {
  const targetSide=door.openingSide===1?1:-1;
  const toward=targetSide===side;
  return {toward,targetSide,label:`${toward?'НА СЕБЯ':'ОТ СЕБЯ'} · в сторону ${targetSide===1?'А':'Б'}`};
}

function openDoorEditor(doorId) {
  const door=state.geometry.doors.find(d=>d.id===doorId);
  if(!door)return;
  if(!editable('controller'))return showToast('Разблокируйте слой оборудования',true);
  const accessPoint=accessPointForDoor(door);
  if(!accessPoint)return showToast('Сначала назначьте двери точку прохода, например ТД.1.1',true);
  const draft=clone(state.equipment);let side=1,selected=null,drag=null;
  const dialog=document.createElement('dialog');dialog.className='door-editor';
  const referenceUrl=`/api/projects/${encodeURIComponent(state.projectId)}/reference-sheets/door-installation`;
  const typeOptions=Object.entries(equipmentCatalog).filter(([type])=>type!=='access_point').map(([type,value])=>`<option value="${type}">${value.name}</option>`).join('');
  dialog.innerHTML=`<form method="dialog"><button class="door-close" aria-label="Закрыть">×</button></form>
    <h2>${escapeHtml(accessPoint.code)} <small>· дверь ${escapeHtml(door.id)}</small></h2>
    <p>Вид на закрытую дверь. Размещайте приборы на двух сторонах стены.</p>
    <div class="door-layout"><div class="door-workspace">
      <div class="door-workspace__toolbar"><button id="de-reference-toggle" aria-pressed="true">Скрыть лист 6</button><span>Сверка с проектным эскизом</span></div>
      <div class="door-canvas-pair">
        <div class="door-drawing">
          <div class="door-sides"><button data-side="1">Сторона А</button><button data-side="-1">Сторона Б</button></div>
          <svg class="door-elevation" viewBox="-110 -155 220 165" role="img" aria-label="Размещение оборудования на двери"></svg>
          <p>Масштаб пока условный: 1 единица плана ≈ 20 мм. Высота — до центра прибора.</p>
        </div>
        <aside class="door-reference" id="de-reference">
          <div class="door-reference__header"><strong>Проектный лист 6</strong><span>Эскиз монтажа точки доступа</span></div>
          <div class="door-reference__viewport"><img src="${referenceUrl}" alt="Лист 6 — Эскиз монтажа точки доступа"></div>
          <div class="door-reference__zoom"><button data-reference-zoom="-25" aria-label="Уменьшить справочный лист">−</button><output id="de-reference-zoom">100%</output><button data-reference-zoom="25" aria-label="Увеличить справочный лист">+</button></div>
          <p class="door-reference__error" hidden>Для этого проекта справочный лист ещё не подготовлен.</p>
        </aside>
      </div>
    </div><div class="door-controls">
      <button id="de-template">Заполнить по листу 6<br><small>текущая сторона — коридор</small></button>
      <label>Прибор<select id="de-item"></select></label>
      <label>Добавить<select id="de-type">${typeOptions}</select><button id="de-add">Добавить прибор</button></label>
      <label>Поверхность<select id="de-surface"><option value="wall">Стена рядом / над дверью</option><option value="frame">Коробка</option><option value="leaf">Дверное полотно</option></select></label>
      <label>Сторона прибора<select id="de-side"><option value="1">А</option><option value="-1">Б</option></select></label>
      <label>Смещение от центра проёма, мм<input id="de-offset" type="number" step="10"></label>
      <label>Высота центра, мм<input id="de-height" type="number" min="0" max="3000" step="10"></label>
      <button id="de-position">Применить положение</button><p id="de-warning" role="status"></p>
      <button id="de-apply">Применить к плану</button><p>Затем нажмите «Сохранить оборудование».</p>
    </div></div>`;
  document.body.append(dialog);const q=s=>dialog.querySelector(s),svg=q('svg');
  const reference=q('#de-reference'),referenceImage=reference.querySelector('img'),referenceViewport=reference.querySelector('.door-reference__viewport');let referenceZoom=100;
  const owned=()=>draft.filter(e=>e.hostDoorId===doorId),current=()=>draft.find(e=>e.id===selected);
  const defaults=()=>({side,surface:'wall',offset:door.width/2+10});
  function fields(){const item=current();if(!item)return;const mount=item.doorMount||defaults();q('#de-surface').value=mount.surface;q('#de-side').value=mount.side;q('#de-offset').value=Math.round(mount.offset*20);q('#de-height').value=item.mountingHeight;}
  function render(){
    q('#de-item').innerHTML='<option value="">Выберите прибор</option>'+owned().map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)}${item.doorMount?'':' · вне шаблона'}</option>`).join('');q('#de-item').value=selected||'';
    dialog.querySelectorAll('[data-side]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.side)===side)));
    const half=door.width/2,hinges=doorHingeView(door,side),opening=doorOpeningView(door,side);
    const hingeMarks=hinges.positions.map(x=>[-84,-52,-20].map(y=>`<g transform="translate(${x} ${y})"><rect x="-2.4" y="-5" width="4.8" height="10" rx="1.5" fill="#d99a35" stroke="#7d5519" stroke-width=".7"/><path d="M0 -4V4" stroke="#fff1c7" stroke-width=".7"/></g>`).join('')).join('');
    const openingColor=opening.toward?'#147d88':'#176f9f',openingArrow=opening.toward?'↙':'↗';
    svg.innerHTML=`<rect x="-110" y="-150" width="220" height="150" fill="#e2e6e4"/><text x="0" y="-134" text-anchor="middle" font-size="7" font-weight="700" fill="#17343f">${hinges.label}</text><rect x="-45" y="-128" width="90" height="15" rx="7.5" fill="${openingColor}"/><text x="0" y="-118" text-anchor="middle" font-size="6" font-weight="700" fill="white">${openingArrow} ${opening.label}</text><rect x="${-half-3}" y="-107" width="${door.width+6}" height="107" fill="#657a81"/><rect x="${-half}" y="-104" width="${door.width}" height="104" fill="#a4b3b9" stroke="#435d67"/>${door.leafCount===2?'<path d="M0 -104V0" stroke="#435d67"/>':''}${hingeMarks}<path d="M-110 0H110" stroke="#435d67"/>`;
    owned().filter(item=>item.doorMount?.side===side).forEach(item=>{const mount=item.doorMount,x=mount.offset*side,y=-item.mountingHeight*.05;svg.insertAdjacentHTML('beforeend',`<g data-device="${escapeHtml(item.id)}" transform="translate(${x} ${y})"><rect x="-3" y="-4" width="6" height="8" rx="1" fill="${item.id===selected?'#e7a32c':'#147d88'}" stroke="white" stroke-width=".5"/><text x="5" y="0" font-size="4" fill="#17343f">${escapeHtml(item.code)}</text></g>`);});
  }
  function position(offset,height){const item=current();if(!item)return '';const surface=q('#de-surface').value,itemSide=Number(q('#de-side').value),half=door.width/2;
    if(!Number.isFinite(offset)||!Number.isFinite(height)||Math.abs(offset)>105||height<80||height>2900)return 'Положение за пределами вида.';
    if(surface==='wall'&&Math.abs(offset)<half+4&&height<2200)return 'На этом месте проём.';
    if(surface==='leaf'&&(Math.abs(offset)>half-4||height>1980))return 'Прибор должен находиться внутри полотна.';
    if(surface==='frame'&&!(Math.abs(Math.abs(offset)-half)<5&&height<2140||Math.abs(offset)<=half+3&&height>=2000&&height<=2160))return 'Выберите боковую или верхнюю часть коробки.';
    if(owned().some(other=>other.id!==item.id&&other.doorMount?.side===itemSide&&Math.abs(other.doorMount.offset-offset)<7&&Math.abs(other.mountingHeight-height)<150))return 'Слишком близко к другому прибору.';
    item.doorMount={side:itemSide,surface,offset};item.mount=surface==='wall'?'wall':'door';item.mountingHeight=height;item.hostWallId=door.wallId;Object.assign(item,DoorMount.resolve(item,state.geometry));return '';
  }
  const createItem=type=>{const definition=equipmentCatalog[type],id=nextId('EQ',draft);return {id,type,system:'skud_intercom',code:projectEquipmentCode(type,door)||nextEquipmentCode(definition.prefix),x:door.x,y:door.y,rotation:door.rotation||0,accessPointId:accessPoint.id,hostDoorId:doorId,hostWallId:door.wallId,mount:definition.mount,mountingHeight:definition.height,status:'proposed'};};
  q('#de-item').onchange=event=>{selected=event.target.value;fields();render();};
  dialog.querySelectorAll('[data-side]').forEach(button=>button.onclick=()=>{side=Number(button.dataset.side);render();});
  q('#de-add').onclick=()=>{const type=q('#de-type').value;if(owned().some(item=>item.type===type))return q('#de-warning').textContent='Такой прибор уже есть у этой двери.';const item=createItem(type);draft.push(item);selected=item.id;fields();render();};
  q('#de-template').onclick=()=>{const touched=Sheet6DoorTemplate.apply(draft,door,side,createItem);touched.forEach(item=>{item.accessPointId=accessPoint.id;item.code=projectEquipmentCode(item.type,door);Object.assign(item,DoorMount.resolve(item,state.geometry));});selected=touched[0]?.id||selected;q('#de-warning').textContent=`Шаблон листа 6: ${touched.length} позиций. Проверьте обе стороны.`;fields();render();};
  q('#de-reference-toggle').onclick=event=>{const hidden=reference.toggleAttribute('hidden');event.currentTarget.setAttribute('aria-pressed',String(!hidden));event.currentTarget.textContent=hidden?'Показать лист 6':'Скрыть лист 6';};
  dialog.querySelectorAll('[data-reference-zoom]').forEach(button=>button.onclick=()=>{referenceZoom=Math.max(50,Math.min(250,referenceZoom+Number(button.dataset.referenceZoom)));referenceImage.style.width=`${referenceZoom}%`;q('#de-reference-zoom').value=`${referenceZoom}%`;});
  referenceViewport.onwheel=event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();referenceZoom=Math.max(50,Math.min(250,referenceZoom+(event.deltaY<0?25:-25)));referenceImage.style.width=`${referenceZoom}%`;q('#de-reference-zoom').value=`${referenceZoom}%`;};
  referenceImage.onerror=()=>{referenceViewport.hidden=true;reference.querySelector('.door-reference__zoom').hidden=true;reference.querySelector('.door-reference__error').hidden=false;};
  q('#de-position').onclick=()=>{q('#de-warning').textContent=position(Number(q('#de-offset').value)/20,Number(q('#de-height').value));render();};
  svg.onpointerdown=event=>{const hit=event.target.closest('[data-device]');if(hit){selected=hit.dataset.device;fields();drag=selected;svg.setPointerCapture(event.pointerId);render();}else if(selected)place(event);};
  function place(event){const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());q('#de-side').value=side;q('#de-warning').textContent=position(Math.round(point.x*side),Math.round(-point.y*2)*10);fields();render();}
  svg.onpointermove=event=>{if(drag)place(event);};svg.onpointerup=svg.onpointercancel=()=>{drag=null;};
  q('#de-apply').onclick=()=>{beginMutation('equipment');accessPoint.corridorSide=side;state.equipment=draft;drawEquipment();showGeometryCard();dialog.close();};
  dialog.addEventListener('cancel',event=>event.stopPropagation());dialog.addEventListener('keydown',event=>event.stopPropagation());dialog.onclose=()=>dialog.remove();render();dialog.showModal();
}
if(typeof module!=='undefined')module.exports={doorHingeView,doorOpeningView};
