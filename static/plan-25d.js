/* Deterministic orthographic 2.5D renderer. All lengths use the plan coordinate system. */
const ceilingPoints = zone => Array.isArray(zone.points) && zone.points.length >= 3 ? zone.points : [
  {x:zone.x,y:zone.y},{x:zone.x+zone.width,y:zone.y},
  {x:zone.x+zone.width,y:zone.y+zone.height},{x:zone.x,y:zone.y+zone.height},
];
const cameraBlockers25D = geometry => (geometry.walls||[]).flatMap(wall=>{
  const dx=wall.x2-wall.x1,dy=wall.y2-wall.y1,length=Math.hypot(dx,dy);if(length<.01)return [];
  const ux=dx/length,uy=dy/length;
  const spans=[...(geometry.doors||[]),...(geometry.windows||[])].filter(item=>item.wallId===wall.id).map(item=>{const center=(item.x-wall.x1)*ux+(item.y-wall.y1)*uy,half=(Number(item.width)||0)/2;return {start:Math.max(0,center-half),end:Math.min(length,center+half)};}).filter(span=>span.end>span.start).sort((a,b)=>a.start-b.start);
  const merged=[];spans.forEach(span=>{const last=merged.at(-1);if(last&&span.start<=last.end)last.end=Math.max(last.end,span.end);else merged.push({...span});});
  const result=[];let cursor=0;[...merged,{start:length,end:length}].forEach(span=>{if(span.start-cursor>.01)result.push({a:{x:wall.x1+ux*cursor,y:wall.y1+uy*cursor},b:{x:wall.x1+ux*span.start,y:wall.y1+uy*span.start}});cursor=Math.max(cursor,span.end);});return result;
});
const raySegment25D=(origin,dx,dy,segment)=>{const sx=segment.b.x-segment.a.x,sy=segment.b.y-segment.a.y,den=dx*sy-dy*sx;if(Math.abs(den)<1e-8)return Infinity;const qx=segment.a.x-origin.x,qy=segment.a.y-origin.y,t=(qx*sy-qy*sx)/den,u=(qx*dy-qy*dx)/den;return t>=.01&&u>=0&&u<=1?t:Infinity;};
const rayColumn25D=(origin,dx,dy,column)=>{
  const half=(Number(column.size)||36)/2;
  if(column.shape==='round'){const ox=origin.x-column.x,oy=origin.y-column.y,b=ox*dx+oy*dy,c=ox*ox+oy*oy-half*half,disc=b*b-c;if(disc<0)return Infinity;const near=-b-Math.sqrt(disc),far=-b+Math.sqrt(disc);return near>=.01?near:far>=.01?far:Infinity;}
  let near=-Infinity,far=Infinity;for(const [o,d,min,max] of [[origin.x,dx,column.x-half,column.x+half],[origin.y,dy,column.y-half,column.y+half]]){if(Math.abs(d)<1e-8){if(o<min||o>max)return Infinity;continue;}let a=(min-o)/d,b=(max-o)/d;if(a>b)[a,b]=[b,a];near=Math.max(near,a);far=Math.min(far,b);if(near>far)return Infinity;}return near>=.01?near:far>=.01?far:Infinity;
};
const cameraPlanAngle25D=camera=>{const tilt=Math.max(0,Math.min(90,Number.isFinite(Number(camera.downTiltDeg))?Number(camera.downTiltDeg):45));return tilt>=89?Math.PI*2:Math.max(20,Math.min(180,Number(camera.viewAngleDeg)||90))*Math.PI/180;};
const cameraAutoBlindZone25D=camera=>{const tilt=Math.max(0,Math.min(90,Number.isFinite(Number(camera.downTiltDeg))?Number(camera.downTiltDeg):45)),fov=Math.max(20,Math.min(180,Number(camera.viewAngleDeg)||90)),heightPlan=Math.max(20,Math.min(3000,(Number(camera.mountingHeight)||2700)/10)),nearAngle=(tilt+fov/2)*Math.PI/180;if(tilt>=89||nearAngle>=Math.PI/2)return 0;return Math.max(0,Math.min((Number(camera.viewRange)||420)-1,heightPlan/Math.tan(nearAngle)));};
const cameraBlindZone25D=camera=>{const mode=camera.blindZoneMode||(Number.isFinite(Number(camera.downTiltDeg))?'auto':'manual');return mode==='manual'?Math.max(0,Math.min((Number(camera.viewRange)||420)-1,Number.isFinite(Number(camera.blindZone))?Number(camera.blindZone):70)):cameraAutoBlindZone25D(camera);};
const cameraVisibility25D=(camera,geometry,steps=120)=>{
  const origin={x:camera.x,y:camera.y},range=Math.max(40,Number(camera.viewRange)||420),rotation=Number(camera.rotation)||0,angle=cameraPlanAngle25D(camera),segments=cameraBlockers25D(geometry),columns=geometry.columns||[],points=[origin];
  for(let index=0;index<=steps;index++){const rayAngle=rotation-angle/2+angle*index/steps,dx=Math.cos(rayAngle),dy=Math.sin(rayAngle);let distance=range;segments.forEach(segment=>distance=Math.min(distance,raySegment25D(origin,dx,dy,segment)));columns.forEach(column=>distance=Math.min(distance,rayColumn25D(origin,dx,dy,column)));points.push({x:origin.x+dx*distance,y:origin.y+dy*distance});}return points;
};
const cameraCoverage25D=(camera,geometry,steps=120)=>{
  const rawOuter=cameraVisibility25D(camera,geometry,steps).slice(1),rotation=Number(camera.rotation)||0,angle=cameraPlanAngle25D(camera),blindZone=cameraBlindZone25D(camera);
  const inner=rawOuter.map((_,index)=>{const rayAngle=rotation-angle/2+angle*index/steps;return {x:camera.x+Math.cos(rayAngle)*blindZone,y:camera.y+Math.sin(rayAngle)*blindZone};});
  const outer=rawOuter.map((point,index)=>Math.hypot(point.x-camera.x,point.y-camera.y)<=blindZone?inner[index]:point);
  return {polygon:[inner[0],...outer,...inner.slice().reverse()],center:outer[Math.floor(outer.length/2)],centerStart:inner[Math.floor(inner.length/2)],blindZone};
};
class Plan25D {
  constructor(canvas, onCamera) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onCamera = onCamera;
    this.tilt = 45; this.rotation = 0; this.zoom = 1; this.pan = {x: 0, y: 0};
    this.faces = []; this.showSource = false; this.showCameraCoverage = true; this.cameraCoverageOpacity = .18; this.cameraCoverage = []; this.active = false;
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }, {passive: false});
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      this.drag = {x: e.clientX, y: e.clientY, pan: this.panMode || this.spaceHeld || e.shiftKey || e.button === 2};
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (this.drag.pan) { this.pan.x += dx; this.pan.y += dy; }
      else { this.rotation = (this.rotation + dx * .4 + 360) % 360; this.tilt = Math.max(0, Math.min(70, this.tilt + dy * .3)); }
      this.drag.x = e.clientX; this.drag.y = e.clientY; this.render();
    });
    const stop = () => { this.drag = null; };
    canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('dblclick', () => this.fit());
    this.observer = new ResizeObserver(() => this.render()); this.observer.observe(canvas.parentElement);
  }
  setModel(geometry, floorPlan, equipment = [], accessPoints = []) {
    this.faces = []; this.equipmentLabels = []; this.connectionLines = []; this.cameraCoverage = []; this.equipmentCount = 0; this.geometry = geometry; this.floorPlan = floorPlan; this.ceilingZones = geometry.ceilingZones || [];
    const walls = geometry.walls;
    const columns = geometry.columns || [];
    const xs = walls.flatMap(w => [w.x1, w.x2]).concat(columns.flatMap(c => [c.x-c.size/2, c.x+c.size/2]));
    const ys = walls.flatMap(w => [w.y1, w.y2]).concat(columns.flatMap(c => [c.y-c.size/2, c.y+c.size/2])).concat(this.ceilingZones.flatMap(z=>ceilingPoints(z).map(point=>point.y)));
    xs.push(...this.ceilingZones.flatMap(z=>ceilingPoints(z).map(point=>point.x)));
    this.bounds = (walls.length || columns.length) ? {minX: Math.min(...xs) - 20, maxX: Math.max(...xs) + 20, minY: Math.min(...ys) - 20, maxY: Math.max(...ys) + 20} : {minX: 0, maxX: floorPlan.width, minY: 0, maxY: floorPlan.height};
    this.center = {x: (this.bounds.minX + this.bounds.maxX) / 2, y: (this.bounds.minY + this.bounds.maxY) / 2};
    // Until metric calibration exists: 3000 mm equals 150 plan-height units.
    const zScale = 150 / 3000, doorHeight = 104, sill = 45, windowTop = 118;
    const wallHeight = wall => Math.max(5, Math.min(500, (Number(wall.heightMm) || 3000) * zScale));
    this.height = Math.max(150, ...walls.map(wallHeight), ...this.ceilingZones.map(zone => Math.max(5, Math.min(500, (Number(zone.heightMm) || 2700) * 150 / 3000))));
    const materialColor = (material, fallback) => {
      const value=String(material||'').toLowerCase();
      if(value.includes('стекл'))return [133,190,207];
      if(value.includes('газоблок')||value.includes('пеноблок'))return [218,211,185];
      if(value.includes('кирпич'))return [190,126,99];
      if(value.includes('гипс')||value.includes('гкл'))return [215,207,190];
      if(value.includes('бетон'))return [175,184,185];
      return fallback;
    };
    this.openingCount = 0;
    walls.forEach(w => {
      const height=wallHeight(w);
      const length = Math.hypot(w.x2 - w.x1, w.y2 - w.y1); if (length < .01) return;
      const u = {x: (w.x2 - w.x1) / length, y: (w.y2 - w.y1) / length};
      const at = t => ({x: w.x1 + u.x * t, y: w.y1 + u.y * t});
      const openings = [...geometry.doors.map(d => ({...d, kind: 'door'})), ...(geometry.windows || []).map(d => ({...d, kind: 'window'}))]
        .filter(d => d.wallId === w.id).map(d => {
          const t = (d.x - w.x1) * u.x + (d.y - w.y1) * u.y;
          return {...d, start: Math.max(0, t - d.width / 2), end: Math.min(length, t + d.width / 2), low: d.kind === 'door' ? 0 : sill, high: d.kind === 'door' ? doorHeight : windowTop};
        }).filter(d => d.end > d.start);
      const cuts = [...new Set([0, length, ...openings.flatMap(d => [d.start, d.end])])].sort((a,b) => a-b);
      const color = w.type === 'partition' ? [203, 222, 220] : [228, 231, 228];
      const bands=(Array.isArray(w.materialBands)?w.materialBands:[]).map(band=>({low:Math.max(0,Number(band.fromMm)||0)*zScale,high:Math.min(height,(Number(band.toMm)||0)*zScale),color:materialColor(band.material,color)})).filter(band=>band.high>band.low);
      const fillSpan=(a,b,low,high)=>{
        const verticalCuts=[...new Set([low,high,...bands.flatMap(band=>[Math.max(low,band.low),Math.min(high,band.high)])])].filter(value=>value>=low&&value<=high).sort((left,right)=>left-right);
        for(let index=0;index<verticalCuts.length-1;index++){
          const bandLow=verticalCuts[index],bandHigh=verticalCuts[index+1],mid=(bandLow+bandHigh)/2;
          const band=bands.find(candidate=>candidate.low<=mid&&candidate.high>=mid);
          this.box(at(a),at(b),w.thickness,bandLow,bandHigh,band?.color||color);
        }
      };
      // Split wall volumes at opening edges; remove only the opening's vertical interval.
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i], b = cuts[i+1], mid = (a+b)/2;
        const holes = openings.filter(d => d.start <= mid && d.end >= mid).sort((a,b) => a.low-b.low);
        let z = 0;
        for (const hole of holes) { const low=Math.min(height,hole.low),high=Math.min(height,hole.high);if (low > z) fillSpan(a,b,z,low); z = Math.max(z,high); }
        if (z < height) fillSpan(a,b,z,height);
      }
      openings.forEach(d => {
        this.openingCount++;
        const a = at(d.start), b = at(d.end), width = d.end - d.start, frame = 3, openingLow=Math.min(height,d.low),openingHigh=Math.min(height,d.high);
        const frameColor = d.kind === 'window' ? [85, 122, 139] : [118, 134, 139];
        this.box(a, at(Math.min(d.end, d.start+frame)), w.thickness+2, openingLow, openingHigh, frameColor);
        this.box(at(Math.max(d.start, d.end-frame)), b, w.thickness+2, openingLow, openingHigh, frameColor);
        this.box(a, b, w.thickness+2, Math.max(openingLow,openingHigh-frame), openingHigh, frameColor);
        if (d.kind === 'window') {
          this.box(a, b, w.thickness+2, openingLow, Math.min(openingHigh,openingLow+frame), frameColor);
          this.box(at((d.start+d.end)/2-1), at((d.start+d.end)/2+1), w.thickness, openingLow, openingHigh, frameColor);
          this.box(a, b, 2, openingLow+frame, openingHigh-frame, [171, 211, 225]);
        } else {
          const leaf = (hinge, direction, size) => {
            // Retain the editor's hinge side and local negative-side opening.
            const angle = Math.PI / 3;
            const side = d.openingSide === 1 ? -1 : 1;
            const end = {x: hinge.x + u.x*direction*size*Math.cos(angle) + side*u.y*size*Math.sin(angle), y: hinge.y + u.y*direction*size*Math.cos(angle) - side*u.x*size*Math.sin(angle)};
            this.box(hinge, end, 3, 1, Math.min(height,doorHeight-frame), [161, 178, 187]);
            const handle = {x: hinge.x+(end.x-hinge.x)*.83, y: hinge.y+(end.y-hinge.y)*.83};
            this.box(handle, {x:handle.x+u.x*5,y:handle.y+u.y*5}, 5, 48, 51, [70, 84, 91]);
          };
          if (d.leafCount === 2) { leaf(a, 1, width/2-frame); leaf(b, -1, width/2-frame); }
          else leaf(d.swing === 'right' ? b : a, d.swing === 'right' ? -1 : 1, Math.max(1,width-frame*2));
        }
      });
    });
    columns.forEach(column=>{
      const heightMm=Math.max(100,Math.min(10000,Number(column.heightMm)||3000));
      const high=Math.max(5,Math.min(500,heightMm*zScale)),half=Math.max(4,Number(column.size||36)/2),color=[171,166,158];
      if(column.shape==='round'){
        this.cylinder({x:column.x,y:column.y},half,0,high,color);
      } else {
        this.box({x:column.x-half,y:column.y},{x:column.x+half,y:column.y},column.size,0,high,color);
      }
    });
    const height = this.height;
    const equipmentStyle = {
      access_point:{width:110,height:110,depth:45,color:[22,141,138]},
      controller:{width:360,height:300,depth:90,color:[23,111,159]},
      reader:{width:55,height:120,depth:30,color:[22,141,138]},
      exit_button:{width:86,height:86,depth:28,color:[62,155,98]},
      emergency_release:{width:88,height:88,depth:32,color:[197,75,70]},
      lock:{width:350,height:58,depth:55,color:[104,122,128]},
      lock_strike:{width:190,height:45,depth:22,color:[104,122,128]},
      door_contact:{width:65,height:28,depth:22,color:[104,122,128]},
      door_closer:{width:260,height:55,depth:45,color:[104,122,128]},
      power_supply:{width:400,height:320,depth:120,color:[215,139,36]},
      battery:{width:300,height:220,depth:100,color:[215,139,36]},
      junction_box:{width:120,height:120,depth:60,color:[104,122,128]},
      intercom_panel:{width:90,height:210,depth:35,color:[117,87,183]},
      intercom_monitor:{width:210,height:150,depth:40,color:[117,87,183]},
      camera_ceiling:{width:150,height:85,depth:150,color:[63,111,181]},
      camera_ceiling_bracket:{width:190,height:90,depth:90,color:[49,88,144]},
    };
    const accessPointIds=new Set(accessPoints.map(point=>point.id));
    const accessPointDoorIds=new Set(accessPoints.map(point=>point.doorId));
    const controllerAnchors=new Map(),powerSupplyAnchors=[],accessPointAnchors=new Map();
    const shownEquipment=equipment.filter(item=>!(item.accessPointId&&accessPointIds.has(item.accessPointId))&&!(item.hostDoorId&&accessPointDoorIds.has(item.hostDoorId)));
    shownEquipment.forEach(item => {
      if(item.doorMount && typeof DoorMount!=='undefined') item=DoorMount.resolve(item,geometry,true);
      // A wall-mounted or above-ceiling controller stays visually attached to its host wall.
      // A cabinet controller keeps its specified position inside the cabinet.
      if(item.type==='controller'&&item.mount!=='cabinet') {
        const hostWall=geometry.walls.find(wall=>wall.id===item.hostWallId)||geometry.walls.reduce((best,wall)=>{
          const dx=wall.x2-wall.x1,dy=wall.y2-wall.y1,lengthSq=dx*dx+dy*dy;
          const t=lengthSq?Math.max(0,Math.min(1,((item.x-wall.x1)*dx+(item.y-wall.y1)*dy)/lengthSq)):0;
          const px=wall.x1+dx*t,py=wall.y1+dy*t,distance=(item.x-px)**2+(item.y-py)**2;
          return !best||distance<best.distance?{wall,distance}:best;
        },null)?.wall;
        if(hostWall) {
          const dx=hostWall.x2-hostWall.x1,dy=hostWall.y2-hostWall.y1,lengthSq=dx*dx+dy*dy;
          const t=lengthSq?Math.max(0,Math.min(1,((item.x-hostWall.x1)*dx+(item.y-hostWall.y1)*dy)/lengthSq)):0;
          item={...item,x:hostWall.x1+dx*t,y:hostWall.y1+dy*t,rotation:Math.atan2(dy,dx)};
        }
      }
      let style=equipmentStyle[item.type];
      if(item.type==='controller'&&item.formFactor==='din_rail')style={width:220,height:125,depth:72,color:[23,111,159]};
      if(!style || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return;
      if(item.type==='camera_ceiling'||item.type==='camera_ceiling_bracket'){const coverage=cameraCoverage25D(item,geometry);this.cameraCoverage.push({x:item.x,y:item.y,rotation:Number(item.rotation)||0,angle:cameraPlanAngle25D(item),range:Math.max(40,Math.min(3000,Number(item.viewRange)||420)),points:coverage.polygon,center:coverage.center,centerStart:coverage.centerStart,blindZone:coverage.blindZone,code:item.code||item.id});}
      const width=Math.max(3,style.width*zScale), deviceHeight=Math.max(2,style.height*zScale);
      const rotation=Number.isFinite(item.rotation)?item.rotation:0, u={x:Math.cos(rotation),y:Math.sin(rotation)};
      const a={x:item.x-u.x*width/2,y:item.y-u.y*width/2}, b={x:item.x+u.x*width/2,y:item.y+u.y*width/2};
      let center=Math.max(deviceHeight/2,Math.min(height-deviceHeight/2,(Number(item.mountingHeight)||1200)*zScale));
      if(item.mount==='ceiling'){
        const bracketDrop=item.type==='camera_ceiling_bracket'?Math.max(3,(Number(item.bracketLengthMm)||200)*zScale):0;
        center=height-deviceHeight/2-2-bracketDrop;
      }
      const low=Math.max(1,center-deviceHeight/2), high=Math.min(height-1,center+deviceHeight/2);
      this.box(a,b,Math.max(2,style.depth*zScale),low,high,style.color);
      if(item.mount==='ceiling'&&item.type!=='camera_ceiling') {
        const n={x:-u.y*.5,y:u.x*.5};
        this.box({x:item.x-n.x,y:item.y-n.y},{x:item.x+n.x,y:item.y+n.y},1,high,height,style.color);
      }
      this.equipmentLabels.push({point:[item.x,item.y,high],code:item.code||item.id,color:style.color});
      if(item.type==='controller')controllerAnchors.set(item.id,{point:[item.x,item.y,high],servedDoorIds:item.servedDoorIds||[]});
      if(item.type==='power_supply'&&item.servedControllerId)powerSupplyAnchors.push({point:[item.x,item.y,high],controllerId:item.servedControllerId});
      this.equipmentCount++;
    });
    accessPoints.forEach(point=>{
      const door=geometry.doors.find(item=>item.id===point.doorId);
      if(!door)return;
      const wall=geometry.walls.find(item=>item.id===door.wallId);
      const rotation=wall?Math.atan2(wall.y2-wall.y1,wall.x2-wall.x1):(door.rotation||0);
      const u={x:Math.cos(rotation),y:Math.sin(rotation)},side=point.corridorSide===-1?-1:1;
      const offset=(wall?.thickness||7)/2+7;
      const center={x:door.x-u.y*side*offset,y:door.y+u.x*side*offset};
      const half=8,a={x:center.x-u.x*half,y:center.y-u.y*half},b={x:center.x+u.x*half,y:center.y+u.y*half};
      // The marker belongs to the door, but lives in the lintel zone so it never covers the leaf or door hardware.
      const low=doorHeight+9,high=Math.min(height-5,low+20),color=[23,111,159];
      this.box(a,b,6,low,high,color);
      this.equipmentLabels.push({point:[center.x,center.y,high],code:point.code||point.id,color});
      accessPointAnchors.set(point.doorId,[center.x,center.y,high]);
      this.equipmentCount++;
    });
    controllerAnchors.forEach(controller=>controller.servedDoorIds.forEach(doorId=>{
      const target=accessPointAnchors.get(doorId);
      if(target)this.connectionLines.push({from:controller.point,to:target,color:[22,141,138],width:1.35});
    }));
    powerSupplyAnchors.forEach(powerSupply=>{
      const controller=controllerAnchors.get(powerSupply.controllerId);
      if(controller)this.connectionLines.push({from:powerSupply.point,to:controller.point,color:[215,139,36],width:1.8});
    });
    if (floorPlan.backgroundImage && this.image?.src !== new URL(floorPlan.backgroundImage, location.href).href) {
      this.image = new Image(); this.image.onload = () => this.render(); this.image.src = floorPlan.backgroundImage;
    }
    this.fit();
  }
  box(a, b, thickness, low, high, color) {
    const len = Math.hypot(b.x-a.x,b.y-a.y); if (len < .001 || high <= low) return;
    // Small sections keep depth ordering stable where long walls cross the camera view.
    if (len > 45) {
      const count = Math.ceil(len / 45);
      for (let i=0;i<count;i++) this.box({x:a.x+(b.x-a.x)*i/count,y:a.y+(b.y-a.y)*i/count}, {x:a.x+(b.x-a.x)*(i+1)/count,y:a.y+(b.y-a.y)*(i+1)/count}, thickness, low, high, color);
      return;
    }
    const nx = -(b.y-a.y)/len*thickness/2, ny = (b.x-a.x)/len*thickness/2;
    const xy = [[a.x+nx,a.y+ny],[b.x+nx,b.y+ny],[b.x-nx,b.y-ny],[a.x-nx,a.y-ny]];
    const bottom = xy.map(([x,y]) => [x,y,low]), top = xy.map(([x,y]) => [x,y,high]);
    this.faces.push({p:top,color,light:1.06});
    for (let i=0;i<4;i++) { const j=(i+1)%4; this.faces.push({p:[bottom[i],bottom[j],top[j],top[i]],color,light:[.84,.72,.94,.78][i]}); }
  }
  cylinder(center, radius, low, high, color, sides = 32) {
    if (radius <= 0 || high <= low) return;
    const ring = Array.from({length:sides}, (_, index) => {
      const angle = index * Math.PI * 2 / sides;
      return [center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius];
    });
    this.faces.push({p:ring.map(([x,y])=>[x,y,high]), color, light:1.08});
    for (let index=0; index<sides; index++) {
      const next=(index+1)%sides;
      this.faces.push({p:[
        [ring[index][0],ring[index][1],low],
        [ring[next][0],ring[next][1],low],
        [ring[next][0],ring[next][1],high],
        [ring[index][0],ring[index][1],high],
      ],color,light:.88});
    }
  }
  project([x,y,z]) {
    const r=this.rotation*Math.PI/180, t=this.tilt*Math.PI/180;
    const dx=x-this.center.x, dy=y-this.center.y;
    const a=dx*Math.cos(r)-dy*Math.sin(r), b=dx*Math.sin(r)+dy*Math.cos(r);
    return {x:a,y:b*Math.cos(t)-z*Math.sin(t),depth:b*Math.sin(t)+z*Math.cos(t)};
  }
  fit() { this.zoom=1; this.pan={x:0,y:0}; this.render(); }
  zoomBy(factor) { this.zoom=Math.max(.25,Math.min(8,this.zoom*factor)); this.render(); }
  setCamera(tilt,rotation) { this.tilt=Math.max(0,Math.min(70,tilt)); this.rotation=(rotation+360)%360; this.render(); }
  render() {
    if (!this.active || !this.bounds) return;
    const rect=this.canvas.parentElement.getBoundingClientRect(), w=rect.width,h=rect.height;
    if (!w || !h) return;
    const dpr=Math.min(window.devicePixelRatio||1,2), ctx=this.ctx;
    if (this.canvas.width!==Math.round(w*dpr) || this.canvas.height!==Math.round(h*dpr)) { this.canvas.width=Math.round(w*dpr); this.canvas.height=Math.round(h*dpr); }
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
    const bg=ctx.createLinearGradient(0,0,0,h); bg.addColorStop(0,'#edf2f2'); bg.addColorStop(1,'#cdd7d9'); ctx.fillStyle=bg; ctx.fillRect(0,0,w,h);
    const b=this.bounds;
    const floor=[[b.minX,b.minY,0],[b.maxX,b.minY,0],[b.maxX,b.maxY,0],[b.minX,b.maxY,0]];
    const ext=[...floor,...floor.map(p=>[p[0],p[1],this.height])].map(p=>this.project(p));
    const minX=Math.min(...ext.map(p=>p.x)), maxX=Math.max(...ext.map(p=>p.x)), minY=Math.min(...ext.map(p=>p.y)),maxY=Math.max(...ext.map(p=>p.y));
    const scale=Math.min((w-65)/(maxX-minX),(h-115)/(maxY-minY))*this.zoom;
    const ox=w/2-(minX+maxX)/2*scale+this.pan.x, oy=h/2+20-(minY+maxY)/2*scale+this.pan.y;
    const screen=p=>{const q=this.project(p);return {x:ox+q.x*scale,y:oy+q.y*scale};};
    const path=points=>{ctx.beginPath();points.map(screen).forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();};
    path(floor);ctx.shadowColor='#263c4d40';ctx.shadowBlur=25;ctx.shadowOffsetY=14;ctx.fillStyle='#e1e6e3';ctx.fill();ctx.shadowBlur=0;ctx.shadowOffsetY=0;
    if(this.showSource && this.image?.complete && this.image.naturalWidth) {
      ctx.save();path(floor);ctx.clip();
      const p0=screen([0,0,0]),px=screen([this.floorPlan.width,0,0]),py=screen([0,this.floorPlan.height,0]);
      ctx.transform((px.x-p0.x)/this.image.width,(px.y-p0.y)/this.image.width,(py.x-p0.x)/this.image.height,(py.y-p0.y)/this.image.height,p0.x,p0.y);
      ctx.globalAlpha=.65;ctx.drawImage(this.image,0,0);ctx.restore();
    }
    if(this.showCameraCoverage)this.cameraCoverage.forEach(camera=>{
      const points=camera.points.map(point=>[point.x,point.y,1.5]);
      ctx.save();path(points);ctx.fillStyle=`rgba(190,128,166,${this.cameraCoverageOpacity})`;ctx.fill();ctx.setLineDash([7,5]);ctx.strokeStyle=`rgba(150,82,123,${Math.min(.82,this.cameraCoverageOpacity*2.8)})`;ctx.lineWidth=1.3;ctx.stroke();
      const centerPoint=camera.centerStart,tipPoint=camera.center,center=screen([centerPoint.x,centerPoint.y,1.7]),tip=screen([tipPoint.x,tipPoint.y,1.7]);
      ctx.beginPath();ctx.moveTo(center.x,center.y);ctx.lineTo(tip.x,tip.y);ctx.stroke();ctx.restore();
    });
    const faces=this.faces.map(f=>({...f,depth:f.p.reduce((sum,p)=>sum+this.project(p).depth,0)/f.p.length})).sort((a,b)=>a.depth-b.depth);
    faces.forEach(f=>{path(f.p);ctx.fillStyle=`rgb(${f.color.map(c=>Math.min(255,Math.round(c*f.light))).join(',')})`;ctx.fill();ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=.4;ctx.stroke();});
    this.ceilingZones.forEach(zone=>{
      const z=Math.max(5,Math.min(this.height,(Number(zone.heightMm)||2700)*150/3000));
      const points=ceilingPoints(zone).map(point=>[point.x,point.y,z]);
      ctx.save();path(points);ctx.fillStyle='rgba(143,166,168,.08)';ctx.fill();ctx.setLineDash([6,5]);ctx.strokeStyle='rgba(84,111,114,.85)';ctx.lineWidth=1.4;ctx.stroke();ctx.restore();
    });
    ctx.save();ctx.setLineDash([5,4]);
    this.connectionLines.forEach(line=>{
      const from=screen(line.from),to=screen(line.to);
      ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);
      ctx.strokeStyle=`rgba(${line.color.join(',')},.78)`;ctx.lineWidth=line.width;ctx.stroke();
    });
    ctx.restore();
    const occupied=[];
    this.equipmentLabels.map(label=>({...label,anchor:screen(label.point)})).sort((a,b)=>a.anchor.y-b.anchor.y).forEach(label=>{
      ctx.font='600 11px Manrope, sans-serif';const width=ctx.measureText(label.code).width+10;
      let x=label.anchor.x+8,y=label.anchor.y-17;
      for(let attempts=0;attempts<16&&occupied.some(r=>x<r.x+r.w&&x+width>r.x&&y<r.y+r.h&&y+16>r.y);attempts++)y+=17;
      occupied.push({x,y,w:width,h:16});
      ctx.beginPath();ctx.moveTo(label.anchor.x,label.anchor.y);ctx.lineTo(x,y+8);ctx.strokeStyle='rgba(26,61,67,.55)';ctx.lineWidth=.8;ctx.stroke();
      ctx.fillStyle='rgba(248,250,249,.92)';ctx.fillRect(x,y,width,16);
      ctx.strokeStyle=`rgb(${label.color.join(',')})`;ctx.strokeRect(x,y,width,16);
      ctx.fillStyle='#173238';ctx.textBaseline='middle';ctx.fillText(label.code,x+5,y+8);
    });
    this.onCamera?.(this.tilt,this.rotation,this.zoom);
  }
}
window.Plan25D = Plan25D;
