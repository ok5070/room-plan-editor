/* Deterministic orthographic 2.5D renderer. All lengths use the plan coordinate system. */
class Plan25D {
  constructor(canvas, onCamera) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onCamera = onCamera;
    this.tilt = 45; this.rotation = 0; this.zoom = 1; this.pan = {x: 0, y: 0};
    this.faces = []; this.showSource = false; this.active = false;
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }, {passive: false});
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      this.drag = {x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2};
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
  setModel(geometry, floorPlan) {
    this.faces = []; this.geometry = geometry; this.floorPlan = floorPlan;
    const walls = geometry.walls;
    const xs = walls.flatMap(w => [w.x1, w.x2]), ys = walls.flatMap(w => [w.y1, w.y2]);
    this.bounds = walls.length ? {minX: Math.min(...xs) - 20, maxX: Math.max(...xs) + 20, minY: Math.min(...ys) - 20, maxY: Math.max(...ys) + 20} : {minX: 0, maxX: floorPlan.width, minY: 0, maxY: floorPlan.height};
    this.center = {x: (this.bounds.minX + this.bounds.maxX) / 2, y: (this.bounds.minY + this.bounds.maxY) / 2};
    // Until metric calibration exists: a 48-unit single door is the visual reference.
    const height = 150, doorHeight = 104, sill = 45, windowTop = 118;
    this.height = height;
    this.openingCount = 0;
    walls.forEach(w => {
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
      // Split wall volumes at opening edges; remove only the opening's vertical interval.
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i], b = cuts[i+1], mid = (a+b)/2;
        const holes = openings.filter(d => d.start <= mid && d.end >= mid).sort((a,b) => a.low-b.low);
        let z = 0;
        for (const hole of holes) { if (hole.low > z) this.box(at(a), at(b), w.thickness, z, hole.low, color); z = Math.max(z, hole.high); }
        if (z < height) this.box(at(a), at(b), w.thickness, z, height, color);
      }
      openings.forEach(d => {
        this.openingCount++;
        const a = at(d.start), b = at(d.end), width = d.end - d.start, frame = 3;
        const frameColor = d.kind === 'window' ? [85, 122, 139] : [118, 134, 139];
        this.box(a, at(Math.min(d.end, d.start+frame)), w.thickness+2, d.low, d.high, frameColor);
        this.box(at(Math.max(d.start, d.end-frame)), b, w.thickness+2, d.low, d.high, frameColor);
        this.box(a, b, w.thickness+2, d.high-frame, d.high, frameColor);
        if (d.kind === 'window') {
          this.box(a, b, w.thickness+2, d.low, d.low+frame, frameColor);
          this.box(at((d.start+d.end)/2-1), at((d.start+d.end)/2+1), w.thickness, d.low, d.high, frameColor);
          this.box(a, b, 2, d.low+frame, d.high-frame, [171, 211, 225]);
        } else {
          const leaf = (hinge, direction, size) => {
            // Retain the editor's hinge side and local negative-side opening.
            const angle = Math.PI / 3;
            const end = {x: hinge.x + u.x*direction*size*Math.cos(angle) + u.y*size*Math.sin(angle), y: hinge.y + u.y*direction*size*Math.cos(angle) - u.x*size*Math.sin(angle)};
            this.box(hinge, end, 3, 1, doorHeight-frame, [161, 178, 187]);
            const handle = {x: hinge.x+(end.x-hinge.x)*.83, y: hinge.y+(end.y-hinge.y)*.83};
            this.box(handle, {x:handle.x+u.x*5,y:handle.y+u.y*5}, 5, 48, 51, [70, 84, 91]);
          };
          if (d.leafCount === 2) { leaf(a, 1, width/2-frame); leaf(b, -1, width/2-frame); }
          else leaf(d.swing === 'right' ? b : a, d.swing === 'right' ? -1 : 1, Math.max(1,width-frame*2));
        }
      });
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
    const faces=this.faces.map(f=>({...f,depth:f.p.reduce((sum,p)=>sum+this.project(p).depth,0)/f.p.length})).sort((a,b)=>a.depth-b.depth);
    faces.forEach(f=>{path(f.p);ctx.fillStyle=`rgb(${f.color.map(c=>Math.min(255,Math.round(c*f.light))).join(',')})`;ctx.fill();ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=.4;ctx.stroke();});
    this.onCamera?.(this.tilt,this.rotation,this.zoom);
  }
}
window.Plan25D = Plan25D;
