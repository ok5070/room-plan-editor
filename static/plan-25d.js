/* Deterministic orthographic 2.5D renderer. All lengths use the plan coordinate system. */
class Plan25D {
  constructor(canvas, onCamera) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onCamera = onCamera;
    this.tilt = 45; this.rotation = 0; this.zoom = 1; this.pan = {x: 0, y: 0};
    this.faces = []; this.showSource = false; this.active = false;
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
  findSquareColumns(walls, geometry) {
    const attached = new Set([...(geometry.doors || []), ...(geometry.windows || [])].map(item => String(item.wallId)));
    const endpointKey = (x, y) => `${Math.round(Number(x) * 20)},${Math.round(Number(y) * 20)}`;
    const points = new Map(), adjacency = new Map();
    const edges = walls.map((wall, index) => {
      const length = Math.hypot(Number(wall.x2)-Number(wall.x1), Number(wall.y2)-Number(wall.y1));
      if (length < 2 || length > 24 || attached.has(String(wall.id))) return null;
      const a=endpointKey(wall.x1,wall.y1),b=endpointKey(wall.x2,wall.y2);
      points.set(a,{x:Number(wall.x1),y:Number(wall.y1)});points.set(b,{x:Number(wall.x2),y:Number(wall.y2)});
      const edge={wall,index,a,b,length};
      adjacency.set(a,[...(adjacency.get(a)||[]),edge]);adjacency.set(b,[...(adjacency.get(b)||[]),edge]);
      return edge;
    }).filter(Boolean);
    const found=new Map();
    const walk=(start,current,path,used)=>{
      if(used.length===4){
        if(current!==start)return;
        const ids=used.map(edge=>String(edge.wall.id)).sort();
        const uniquePoints=path.slice(0,-1);
        if(new Set(uniquePoints).size!==4)return;
        const polygon=uniquePoints.map(key=>points.get(key));
        const lengths=polygon.map((point,index)=>Math.hypot(polygon[(index+1)%4].x-point.x,polygon[(index+1)%4].y-point.y));
        if(Math.max(...lengths)/Math.min(...lengths)>1.35)return;
        for(let i=0;i<4;i++){
          const previous=polygon[(i+3)%4],point=polygon[i],next=polygon[(i+1)%4];
          const ax=previous.x-point.x,ay=previous.y-point.y,bx=next.x-point.x,by=next.y-point.y;
          if(Math.abs((ax*bx+ay*by)/(Math.hypot(ax,ay)*Math.hypot(bx,by)))>.2)return;
        }
        const area=Math.abs(polygon.reduce((sum,p,i)=>sum+p.x*polygon[(i+1)%4].y-p.y*polygon[(i+1)%4].x,0))/2;
        if(area<4||area>600)return;
        found.set(ids.join('|'),{wallIds:ids,points:polygon,type:'square'});
        return;
      }
      for(const edge of adjacency.get(current)||[]){
        if(used.includes(edge))continue;
        const next=edge.a===current?edge.b:edge.a;
        if(path.includes(next)&&next!==start)continue;
        walk(start,next,[...path,next],[...used,edge]);
      }
    };
    for(const key of adjacency.keys())walk(key,key,[key],[]);
    const claimed=new Set(),columns=[];
    for(const column of found.values()){
      if(column.wallIds.some(id=>claimed.has(id)))continue;
      column.wallIds.forEach(id=>claimed.add(id));columns.push(column);
    }
    return {columns,wallIds:claimed};
  }
  setModel(geometry, floorPlan, equipment = []) {
    this.faces = []; this.equipmentLabels = []; this.equipmentCount = 0; this.geometry = geometry; this.floorPlan = floorPlan;
    const walls = geometry.walls;
    const xs = walls.flatMap(w => [w.x1, w.x2]), ys = walls.flatMap(w => [w.y1, w.y2]);
    this.bounds = walls.length ? {minX: Math.min(...xs) - 20, maxX: Math.max(...xs) + 20, minY: Math.min(...ys) - 20, maxY: Math.max(...ys) + 20} : {minX: 0, maxX: floorPlan.width, minY: 0, maxY: floorPlan.height};
    this.center = {x: (this.bounds.minX + this.bounds.maxX) / 2, y: (this.bounds.minY + this.bounds.maxY) / 2};
    // Until metric calibration exists: a 48-unit single door is the visual reference.
    const height = 150, doorHeight = 104, sill = 45, windowTop = 118;
    this.height = height;
    this.openingCount = 0;
    const recognizedColumns=this.findSquareColumns(walls,geometry);
    this.columnCount=recognizedColumns.columns.length;
    recognizedColumns.columns.forEach(column=>this.prism(column.points,0,height,[212,216,213]));
    walls.forEach(w => {
      if(recognizedColumns.wallIds.has(String(w.id)))return;
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
      // One centerline becomes one restrained solid wall, regardless of how wide
      // the two source CAD outlines were drawn.
      const visualThickness = String(w.id).endsWith('-CL')
        ? Math.max(2, Math.min(4, Number(w.thickness) || 2))
        : Math.max(2, Math.min(4, (Number(w.thickness) || 13) / 4));
      // Split wall volumes at opening edges; remove only the opening's vertical interval.
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i], b = cuts[i+1], mid = (a+b)/2;
        const holes = openings.filter(d => d.start <= mid && d.end >= mid).sort((a,b) => a.low-b.low);
        let z = 0;
        for (const hole of holes) { if (hole.low > z) this.box(at(a), at(b), visualThickness, z, hole.low, color, true); z = Math.max(z, hole.high); }
        if (z < height) this.box(at(a), at(b), visualThickness, z, height, color, true);
      }
      openings.forEach(d => {
        this.openingCount++;
        const a = at(d.start), b = at(d.end), width = d.end - d.start, frame = 3;
        const frameColor = d.kind === 'window' ? [85, 122, 139] : [118, 134, 139];
        this.box(a, at(Math.min(d.end, d.start+frame)), visualThickness+2, d.low, d.high, frameColor);
        this.box(at(Math.max(d.start, d.end-frame)), b, visualThickness+2, d.low, d.high, frameColor);
        this.box(a, b, visualThickness+2, d.high-frame, d.high, frameColor);
        if (d.kind === 'window') {
          this.box(a, b, visualThickness+2, d.low, d.low+frame, frameColor);
          this.box(at((d.start+d.end)/2-1), at((d.start+d.end)/2+1), visualThickness, d.low, d.high, frameColor);
          this.box(a, b, 2, d.low+frame, d.high-frame, [171, 211, 225]);
        } else if (d.swing !== 'unknown') {
          const leaf = (hinge, direction, size) => {
            // Retain the editor's hinge side and local negative-side opening.
            const angle = Math.PI / 3;
            const side = d.openingSide === 1 ? -1 : 1;
            const end = {x: hinge.x + u.x*direction*size*Math.cos(angle) + side*u.y*size*Math.sin(angle), y: hinge.y + u.y*direction*size*Math.cos(angle) - side*u.x*size*Math.sin(angle)};
            this.box(hinge, end, 3, 1, doorHeight-frame, [161, 178, 187]);
            const handle = {x: hinge.x+(end.x-hinge.x)*.83, y: hinge.y+(end.y-hinge.y)*.83};
            this.box(handle, {x:handle.x+u.x*5,y:handle.y+u.y*5}, 5, 48, 51, [70, 84, 91]);
          };
          if (d.leafCount === 2) { leaf(a, 1, width/2-frame); leaf(b, -1, width/2-frame); }
          else leaf(d.swing === 'right' ? b : a, d.swing === 'right' ? -1 : 1, Math.max(1,width-frame*2));
        }
      });
    });
    const zScale = height / 3000;
    const equipmentStyle = {
      access_point:{width:110,height:110,depth:45,color:[22,141,138]},
      controller:{width:360,height:300,depth:90,color:[23,111,159]},
      reader:{width:55,height:120,depth:30,color:[22,141,138]},
      camera:{width:120,height:90,depth:120,color:[177,77,104]},
      data_outlet:{width:86,height:86,depth:25,color:[57,118,168]},
      wifi_access_point:{width:180,height:45,depth:180,color:[57,118,168]},
      network_switch:{width:440,height:45,depth:220,color:[57,118,168]},
      patch_panel:{width:440,height:45,depth:90,color:[57,118,168]},
      rack:{width:600,height:2000,depth:800,color:[82,99,109]},
      exit_button:{width:86,height:86,depth:28,color:[62,155,98]},
      emergency_release:{width:88,height:88,depth:32,color:[197,75,70]},
      lock:{width:350,height:58,depth:55,color:[104,122,128]},
      door_contact:{width:65,height:28,depth:22,color:[104,122,128]},
      door_closer:{width:260,height:55,depth:45,color:[104,122,128]},
      power_supply:{width:400,height:320,depth:120,color:[215,139,36]},
      battery:{width:300,height:220,depth:100,color:[215,139,36]},
      junction_box:{width:120,height:120,depth:60,color:[104,122,128]},
      intercom_panel:{width:90,height:210,depth:35,color:[117,87,183]},
      intercom_monitor:{width:210,height:150,depth:40,color:[117,87,183]},
    };
    equipment.forEach(item => {
      if(item.doorMount && typeof DoorMount!=='undefined') item=DoorMount.resolve(item,geometry,true);
      let style=equipmentStyle[item.type];
      if(item.type==='controller'&&item.formFactor==='din_rail')style={width:220,height:125,depth:72,color:[23,111,159]};
      if(!style || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return;
      const width=Math.max(3,style.width*zScale), deviceHeight=Math.max(2,style.height*zScale);
      const rotation=Number.isFinite(item.rotation)?item.rotation:0, u={x:Math.cos(rotation),y:Math.sin(rotation)};
      const a={x:item.x-u.x*width/2,y:item.y-u.y*width/2}, b={x:item.x+u.x*width/2,y:item.y+u.y*width/2};
      let center=Math.max(deviceHeight/2,Math.min(height-deviceHeight/2,(Number(item.mountingHeight)||1200)*zScale));
      if(item.mount==='ceiling') center=height-deviceHeight/2-2;
      const low=Math.max(1,center-deviceHeight/2), high=Math.min(height-1,center+deviceHeight/2);
      this.box(a,b,Math.max(2,style.depth*zScale),low,high,style.color);
      if(item.mount==='ceiling') {
        const n={x:-u.y*.5,y:u.x*.5};
        this.box({x:item.x-n.x,y:item.y-n.y},{x:item.x+n.x,y:item.y+n.y},1,high,height,style.color);
      }
      this.equipmentLabels.push({point:[item.x,item.y,high],code:item.code||item.id,color:style.color});
      this.equipmentCount++;
    });
    if (floorPlan.backgroundImage && this.image?.src !== new URL(floorPlan.backgroundImage, location.href).href) {
      this.image = new Image(); this.image.onload = () => this.render(); this.image.src = floorPlan.backgroundImage;
    }
    this.fit();
  }
  box(a, b, thickness, low, high, color, hideEndFaces = false) {
    const len = Math.hypot(b.x-a.x,b.y-a.y); if (len < .001 || high <= low) return;
    // Small sections keep depth ordering stable where long walls cross the camera view.
    if (len > 45) {
      const count = Math.ceil(len / 45);
      for (let i=0;i<count;i++) this.box({x:a.x+(b.x-a.x)*i/count,y:a.y+(b.y-a.y)*i/count}, {x:a.x+(b.x-a.x)*(i+1)/count,y:a.y+(b.y-a.y)*(i+1)/count}, thickness, low, high, color, hideEndFaces);
      return;
    }
    const nx = -(b.y-a.y)/len*thickness/2, ny = (b.x-a.x)/len*thickness/2;
    const xy = [[a.x+nx,a.y+ny],[b.x+nx,b.y+ny],[b.x-nx,b.y-ny],[a.x-nx,a.y-ny]];
    const bottom = xy.map(([x,y]) => [x,y,low]), top = xy.map(([x,y]) => [x,y,high]);
    this.faces.push({p:top,color,light:1.06});
    for (let i=0;i<4;i++) {
      // i=1 and i=3 are the short end faces. CAD walls are assembled from
      // many consecutive pieces; drawing every cap creates false white
      // brackets and boxes at otherwise continuous wall junctions.
      if (hideEndFaces && (i === 1 || i === 3)) continue;
      const j=(i+1)%4;
      this.faces.push({p:[bottom[i],bottom[j],top[j],top[i]],color,light:[.84,.72,.94,.78][i]});
    }
  }
  prism(points,low,high,color){
    if(!Array.isArray(points)||points.length<3||high<=low)return;
    const bottom=points.map(point=>[point.x,point.y,low]),top=points.map(point=>[point.x,point.y,high]);
    this.faces.push({p:top,color,light:1.06});
    for(let i=0;i<points.length;i++){
      const j=(i+1)%points.length;
      this.faces.push({p:[bottom[i],bottom[j],top[j],top[i]],color,light:[.84,.72,.94,.78][i%4]});
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
    // The source drawing does not contain a verified floor contour. Do not
    // present the model bounds as an invented slab under the detected walls.
    if(this.showSource && this.image?.complete && this.image.naturalWidth) {
      ctx.save();path(floor);ctx.clip();
      const p0=screen([0,0,0]),px=screen([this.floorPlan.width,0,0]),py=screen([0,this.floorPlan.height,0]);
      ctx.transform((px.x-p0.x)/this.image.width,(px.y-p0.y)/this.image.width,(py.x-p0.x)/this.image.height,(py.y-p0.y)/this.image.height,p0.x,p0.y);
      ctx.globalAlpha=.65;ctx.drawImage(this.image,0,0);ctx.restore();
    }
    const faces=this.faces.map(f=>({...f,depth:f.p.reduce((sum,p)=>sum+this.project(p).depth,0)/f.p.length})).sort((a,b)=>a.depth-b.depth);
    faces.forEach(f=>{path(f.p);ctx.fillStyle=`rgb(${f.color.map(c=>Math.min(255,Math.round(c*f.light))).join(',')})`;ctx.fill();ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=.4;ctx.stroke();});
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
