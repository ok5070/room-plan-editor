/* CAD face-pair conversion: one axis for two aligned sides of the same wall. */
(function (root) {
  function compoundFaces(walls, k) {
    const minHost = 1.5 / k, minPartner = .5 / k, minGap = .06 / k, maxGap = .8 / k;
    const hosts = walls.map((w, index) => ({ w, index })).filter(({ w }) => w.confidence === 'generic_plan_lineweight' && w.source !== 'cad_face_pair_centerline');
    const groups = [];
    for (const { w: host, index: hi } of hosts) {
      const hx = Number(host.x1), hy = Number(host.y1);
      const length = Math.hypot(Number(host.x2) - hx, Number(host.y2) - hy);
      if (length < minHost) continue;
      const ux = (Number(host.x2) - hx) / length, uy = (Number(host.y2) - hy) / length;
      const eligible = [];
      for (const { w: other, index: oi } of hosts) {
        if (oi === hi || other.layer !== host.layer || other.type !== host.type) continue;
        const ox = Number(other.x1), oy = Number(other.y1);
        const ol = Math.hypot(Number(other.x2) - ox, Number(other.y2) - oy);
        if (ol < minPartner || ol >= .95 * length) continue;
        const vx = (Number(other.x2) - ox) / ol, vy = (Number(other.y2) - oy) / ol;
        if (Math.abs(Math.abs(ux * vx + uy * vy) - 1) > .002) continue;
        const gap = (ox - hx) * -uy + (oy - hy) * ux;
        if (Math.abs(gap) < minGap || Math.abs(gap) > maxGap) continue;
        const a = (ox - hx) * ux + (oy - hy) * uy;
        const b = (Number(other.x2) - hx) * ux + (Number(other.y2) - hy) * uy;
        const start = Math.min(a, b), end = Math.max(a, b);
        if (start < -.05 / k || end > length + .05 / k || Math.min(length, end) - Math.max(0, start) < .95 * ol) continue;
        eligible.push({ oi, start: Math.max(0, start), end: Math.min(length, end), gap });
      }
      const seen = new Set();
      for (const seed of eligible) {
        const partners = eligible.filter(p => Math.sign(p.gap) === Math.sign(seed.gap) && Math.abs(p.gap - seed.gap) <= .12 / k).sort((a, b) => a.start - b.start);
        const key = partners.map(p => p.oi).sort((a, b) => a - b).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        if (Math.max(...partners.map(p => p.gap)) - Math.min(...partners.map(p => p.gap)) > .12 / k) continue;
        if (partners.some((p, i) => i && p.start < partners[i - 1].end - .02 / k)) continue;
        const covered = partners.reduce((sum, p) => sum + p.end - p.start, 0);
        const shortSymmetricEnds = partners.length === 1 && partners[0].start > 0 && length - partners[0].end > 0
          && partners[0].start <= .4 / k && length - partners[0].end <= .4 / k;
        const minimumCoverage = shortSymmetricEnds ? .65 : length < 2 / k ? .85 : .75;
        if (covered < minimumCoverage * length || (partners.length === 1 && partners[0].end - partners[0].start < 1.5 / k)) continue;
        groups.push({ hi, host, ux, uy, length, partners, covered });
      }
    }
    // A face may be in only one accepted group. Competing geometries stay unchanged for review.
    const memberships = new Map();
    for (const g of groups) for (const i of [g.hi, ...g.partners.map(p => p.oi)]) memberships.set(i, (memberships.get(i) || 0) + 1);
    const selected = groups.filter(g => [g.hi, ...g.partners.map(p => p.oi)].every(i => memberships.get(i) === 1));
    const replacements = new Map(), removed = new Set();
    const rounded = n => +n.toFixed(3);
    for (const g of selected) {
      const hostAt = t => [Number(g.host.x1) + g.ux * t, Number(g.host.y1) + g.uy * t];
      const pieces = [];
      const addTail = (start, end, n) => {
        if (end - start <= .05 / k) return;
        const a = hostAt(start), b = hostAt(end);
        pieces.push({ ...g.host, id: `${g.host.id}-TAIL-${n}`, x1: rounded(a[0]), y1: rounded(a[1]), x2: rounded(b[0]), y2: rounded(b[1]), source: 'cad_unpaired_face_tail', reviewHint: 'unpaired_wall_face' });
      };
      addTail(0, g.partners[0].start, 1);
      g.partners.forEach((p, n) => {
        const a = hostAt(p.start), b = hostAt(p.end);
        const offset = [-g.uy * p.gap / 2, g.ux * p.gap / 2];
        pieces.push({ ...g.host, id: `${g.host.id}-CL-${n + 1}`, x1: rounded(a[0] + offset[0]), y1: rounded(a[1] + offset[1]), x2: rounded(b[0] + offset[0]), y2: rounded(b[1] + offset[1]), source: 'cad_face_pair_centerline', pairedGapMm: Math.round(Math.abs(p.gap) * k * 1000), reviewHint: undefined });
        removed.add(p.oi);
      });
      addTail(g.partners[g.partners.length - 1].end, g.length, 2);
      replacements.set(g.hi, pieces);
    }
    return { walls: walls.flatMap((w, i) => removed.has(i) ? [] : replacements.get(i) || [w]), groups: selected.length };
  }
  function collapseResidualDoubleWalls(walls,k){
    // CAD exports can encode a visible line as a close pair and then encode a
    // thick wall as two such pairs.  The first pass removes the line width;
    // this pass safely reduces the remaining two wall faces to one axis.
    const candidates=[];
    for(let i=0;i<walls.length;i++){
      const a=walls[i],ax=Number(a.x1),ay=Number(a.y1),adx=Number(a.x2)-ax,ady=Number(a.y2)-ay,al=Math.hypot(adx,ady);
      if(al<.35/k)continue;
      const ux=adx/al,uy=ady/al;
      for(let j=i+1;j<walls.length;j++){
        const b=walls[j];if(a.layer!==b.layer||a.type!==b.type)continue;
        const bx=Number(b.x1),by=Number(b.y1),bdx=Number(b.x2)-bx,bdy=Number(b.y2)-by,bl=Math.hypot(bdx,bdy);
        if(bl<.35/k)continue;
        const parallelError=Math.abs(Math.abs((bdx*ux+bdy*uy)/bl)-1);if(parallelError>.02)continue;
        const signedGap=(bx-ax)*-uy+(by-ay)*ux,gap=Math.abs(signedGap);
        const p1=(bx-ax)*ux+(by-ay)*uy,p2=(Number(b.x2)-ax)*ux+(Number(b.y2)-ay)*uy;
        const start=Math.min(p1,p2),end=Math.max(p1,p2),overlap=Math.max(0,Math.min(al,end)-Math.max(0,start));
        const nearDuplicate=gap>=.02/k&&gap<=.14/k&&Math.min(al,bl)/Math.max(al,bl)>=.88
          &&overlap/Math.max(al,bl)>=.72&&Math.max(Math.abs(start),Math.abs(end-al))<=.25/k;
        const pairedAxes=a.source==='cad_face_pair_centerline'&&b.source==='cad_face_pair_centerline'
          &&gap>=.15/k&&gap<=.8/k&&overlap/Math.min(al,bl)>=.9
          &&Math.max(0,-start,end-al)<=.2/k;
        if(nearDuplicate||pairedAxes)candidates.push({i,j,gap,signedGap,start,end,al,bl,ux,uy,kind:pairedAxes?'wall_faces':'line_duplicate'});
      }
    }
    const degree=new Map();candidates.forEach(c=>{degree.set(c.i,(degree.get(c.i)||0)+1);degree.set(c.j,(degree.get(c.j)||0)+1);});
    const safe=candidates.filter(c=>degree.get(c.i)===1&&degree.get(c.j)===1),removed=new Set(),replacements=new Map(),shifts=new Map();
    const rounded=n=>+n.toFixed(3);
    for(const c of safe){
      const a=walls[c.i],b=walls[c.j],hostIndex=c.al>=c.bl?c.i:c.j,host=walls[hostIndex];
      const hx=Number(host.x1),hy=Number(host.y1),hdx=Number(host.x2)-hx,hdy=Number(host.y2)-hy,hl=Math.hypot(hdx,hdy),ux=hdx/hl,uy=hdy/hl;
      const other=hostIndex===c.i?b:a,ox=Number(other.x1),oy=Number(other.y1);
      const signedGap=(ox-hx)*-uy+(oy-hy)*ux,shift=signedGap/2;
      const projections=[[Number(host.x1),Number(host.y1)],[Number(host.x2),Number(host.y2)],[Number(other.x1),Number(other.y1)],[Number(other.x2),Number(other.y2)]].map(([x,y])=>(x-hx)*ux+(y-hy)*uy);
      const start=Math.min(...projections),end=Math.max(...projections),id=`${host.id}-AXIS`;
      const replacement={...host,id,x1:rounded(hx+ux*start-uy*shift),y1:rounded(hy+uy*start+ux*shift),x2:rounded(hx+ux*end-uy*shift),y2:rounded(hy+uy*end+ux*shift),reviewHint:undefined};
      if(c.kind==='wall_faces'){
        replacement.source='cad_face_pair_centerline';replacement.pairedGapMm=Math.round(c.gap*k*1000);
        // Preserve door-sized gaps on the host face.  Adjacent collinear
        // pieces belong to the same face and must move to the new axis too;
        // otherwise merging the long piece would erase the opening.
        for(let index=0;index<walls.length;index++){
          if(index===c.i||index===c.j)continue;
          const wall=walls[index],wx=Number(wall.x1),wy=Number(wall.y1),wdx=Number(wall.x2)-wx,wdy=Number(wall.y2)-wy,wl=Math.hypot(wdx,wdy);
          if(!wl||wall.source!=='cad_face_pair_centerline'||Math.abs(Math.abs((wdx*ux+wdy*uy)/wl)-1)>.006)continue;
          if(Math.abs((wx-hx)*-uy+(wy-hy)*ux)>.03/k)continue;
          const values=[[Number(wall.x1),Number(wall.y1)],[Number(wall.x2),Number(wall.y2)]].map(([x,y])=>(x-hx)*ux+(y-hy)*uy).sort((a,b)=>a-b);
          const gap=values[1]<0?-values[1]:values[0]>hl?values[0]-hl:0;
          if(gap>0&&gap<=1.2/k)shifts.set(index,{x:-uy*shift,y:ux*shift});
        }
      }
      replacements.set(Math.min(c.i,c.j),replacement);
      removed.add(c.i);removed.add(c.j);
    }
    return {walls:walls.flatMap((wall,index)=>replacements.has(index)?[replacements.get(index)]:removed.has(index)?[]:shifts.has(index)?[{...wall,x1:rounded(Number(wall.x1)+shifts.get(index).x),y1:rounded(Number(wall.y1)+shifts.get(index).y),x2:rounded(Number(wall.x2)+shifts.get(index).x),y2:rounded(Number(wall.y2)+shifts.get(index).y)}]:[wall]),merged:safe.length,pairs:safe.map(c=>[walls[c.i].id,walls[c.j].id])};
  }
  function openingGaps(walls, existingDoors, k) {
    if ((existingDoors || []).length) return { walls, doors: existingDoors, openings: 0 };
    const axes = walls.map((w, index) => ({ w, index })).filter(({ w }) => w.source === 'cad_face_pair_centerline');
    const candidates = [];
    for (let i = 0; i < axes.length; i++) {
      const {w:a,index:ai}=axes[i], ax=Number(a.x1), ay=Number(a.y1), al=Math.hypot(Number(a.x2)-ax,Number(a.y2)-ay);
      if (al < .5/k) continue;
      const ux=(Number(a.x2)-ax)/al,uy=(Number(a.y2)-ay)/al;
      for(let j=i+1;j<axes.length;j++){
        const {w:b,index:bi}=axes[j]; if(a.layer!==b.layer||a.type!==b.type)continue;
        const bx=Number(b.x1),by=Number(b.y1),bl=Math.hypot(Number(b.x2)-bx,Number(b.y2)-by);if(bl<.5/k)continue;
        const vx=(Number(b.x2)-bx)/bl,vy=(Number(b.y2)-by)/bl;
        if(Math.abs(Math.abs(ux*vx+uy*vy)-1)>.002)continue;
        const dx=bx-ax,dy=by-ay,lateral=Math.abs(dx*-uy+dy*ux);if(lateral>.06/k)continue;
        const ts=dx*ux+dy*uy,te=(Number(b.x2)-ax)*ux+(Number(b.y2)-ay)*uy;
        const bs=Math.min(ts,te),be=Math.max(ts,te);
        let left,right,start,end;
        if(bs>=al){left={index:ai,w:a,t:al};right={index:bi,w:b,t:bs};start=al;end=bs;}
        else if(be<=0){left={index:bi,w:b,t:be};right={index:ai,w:a,t:0};start=be;end=0;}
        else continue;
        const gap=end-start;if(gap<.5/k||gap>1.2/k)continue;
        const aEnds=[[Number(a.x1),Number(a.y1)],[Number(a.x2),Number(a.y2)]],bEnds=[[Number(b.x1),Number(b.y1)],[Number(b.x2),Number(b.y2)]];
        let closest=null;
        aEnds.forEach((pa,ia)=>bEnds.forEach((pb,ib)=>{const distance=Math.hypot(pb[0]-pa[0],pb[1]-pa[1]);if(!closest||distance<closest.distance)closest={pa,pb,ia,ib,distance};}));
        const endpointA=`${ai}:${closest.ia}`,endpointB=`${bi}:${closest.ib}`;
        candidates.push({left,right,gap,endpointA,endpointB,pa:closest.pa,pb:closest.pb});
      }
    }
    const endpointDegree=new Map();
    candidates.forEach(c=>[c.endpointA,c.endpointB].forEach(key=>endpointDegree.set(key,(endpointDegree.get(key)||0)+1)));
    const edges=candidates.filter(c=>endpointDegree.get(c.endpointA)===1&&endpointDegree.get(c.endpointB)===1);
    const parent=new Map(),find=x=>{if(!parent.has(x))parent.set(x,x);if(parent.get(x)!==x)parent.set(x,find(parent.get(x)));return parent.get(x);},join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(b,a);};
    edges.forEach(c=>join(c.left.index,c.right.index));
    const components=new Map();
    edges.forEach(c=>{const root=find(c.left.index),entry=components.get(root)||{indexes:new Set(),edges:[]};entry.indexes.add(c.left.index);entry.indexes.add(c.right.index);entry.edges.push(c);components.set(root,entry);});
    const removed=new Set(),replacements=new Map(),doors=[];let doorNumber=1;
    const rounded=n=>+n.toFixed(3);
    for(const component of components.values()){
      const items=[...component.indexes].map(index=>({index,w:walls[index]}));
      const base=items[0].w,bx=Number(base.x1),by=Number(base.y1),bl=Math.hypot(Number(base.x2)-bx,Number(base.y2)-by);
      let ux=(Number(base.x2)-bx)/bl,uy=(Number(base.y2)-by)/bl;if(ux<-.0001||(Math.abs(ux)<.0001&&uy<0)){ux=-ux;uy=-uy;}
      const spans=items.map(item=>{const values=[[Number(item.w.x1),Number(item.w.y1)],[Number(item.w.x2),Number(item.w.y2)]].map(([x,y])=>(x-bx)*ux+(y-by)*uy);return {...item,start:Math.min(...values),end:Math.max(...values)};}).sort((a,b)=>a.start-b.start);
      const first=spans[0],last=spans[spans.length-1],hostId=`${first.w.id}-OPENING-HOST`;
      const at=t=>[bx+ux*t,by+uy*t],p1=at(first.start),p2=at(last.end);
      const gapValues=items.map(item=>Number(item.w.pairedGapMm)).filter(Number.isFinite).sort((a,b)=>a-b);
      const host={...first.w,id:hostId,x1:rounded(p1[0]),y1:rounded(p1[1]),x2:rounded(p2[0]),y2:rounded(p2[1]),source:'cad_face_pair_centerline',pairedGapMm:gapValues[Math.floor(gapValues.length/2)]||100,recognizedOpenings:component.edges.length};
      replacements.set(first.index,[host]);items.forEach(item=>{if(item.index!==first.index)removed.add(item.index);});
      component.edges.sort((a,b)=>(((a.pa[0]+a.pb[0])/2-bx)*ux+((a.pa[1]+a.pb[1])/2-by)*uy)-(((b.pa[0]+b.pb[0])/2-bx)*ux+((b.pa[1]+b.pb[1])/2-by)*uy)).forEach(edge=>{
        const center=[(edge.pa[0]+edge.pb[0])/2,(edge.pa[1]+edge.pb[1])/2];
        doors.push({id:`D-AUTO-${String(doorNumber++).padStart(3,'0')}`,wallId:hostId,x:rounded(center[0]),y:rounded(center[1]),width:rounded(edge.gap),rotation:Math.atan2(uy,ux),swing:'unknown',leafCount:1,openingSide:-1,readerCount:1,accessPointId:null,accessPointCode:null,confidence:'cad_wall_gap',reviewHint:'confirm_hinge_and_opening_side'});
      });
    }
    return {walls:walls.flatMap((w,index)=>removed.has(index)?[]:replacements.get(index)||[w]),doors,openings:doors.length};
  }
  function removeOpeningBoundarySegments(walls, doors, k) {
    // Short perpendicular lines at both sides of a CAD opening are evidence
    // used to locate the gap, not additional walls.  Keep that evidence in
    // the untouched CAD underlay and never promote it into editable geometry.
    const hosts = new Map(walls.map(w => [String(w.id), w]));
    const removed = new Set();
    for (const door of doors || []) {
      const host = hosts.get(String(door.wallId));
      if (!host) continue;
      const hx = Number(host.x2) - Number(host.x1), hy = Number(host.y2) - Number(host.y1);
      const hostLength = Math.hypot(hx, hy);
      const width = Number(door.width);
      if (!hostLength || !Number.isFinite(width) || width <= 0) continue;
      const ux = hx / hostLength, uy = hy / hostLength;
      for (let index = 0; index < walls.length; index++) {
        const wall = walls[index];
        if (wall === host || removed.has(index)) continue;
        const dx = Number(wall.x2) - Number(wall.x1), dy = Number(wall.y2) - Number(wall.y1);
        const length = Math.hypot(dx, dy);
        if (!length || length > width * 1.25) continue;
        if (Math.abs((dx * ux + dy * uy) / length) > .15) continue;
        const mx = (Number(wall.x1) + Number(wall.x2)) / 2;
        const my = (Number(wall.y1) + Number(wall.y2)) / 2;
        const rx = mx - Number(door.x), ry = my - Number(door.y);
        const along = rx * ux + ry * uy;
        const normal = Math.abs(rx * -uy + ry * ux);
        const edgeError = Math.abs(Math.abs(along) - width / 2);
        if (edgeError <= Math.max(.02 / k, width * .15)
            && normal <= Math.max(.02 / k, length * .2)) removed.add(index);
      }
    }
    return { walls: walls.filter((_wall, index) => !removed.has(index)), removed: removed.size };
  }
  function removeCenterlineEndCaps(walls, k) {
    // A CAD wall end is often drawn as a tiny three-sided cap around the
    // actual wall axis. Once the paired faces have become a centerline, those
    // fragments are evidence only; extruding them creates the white U-shaped
    // brackets seen in 2.5D.
    const key = (x, y) => `${Number(x).toFixed(3)}:${Number(y).toFixed(3)}`;
    const adjacency = new Map();
    const connect = (a, b, index) => {
      if (!adjacency.has(a)) adjacency.set(a, []);
      adjacency.get(a).push({key:b,index});
    };
    walls.forEach((wall,index) => {
      const a=key(wall.x1,wall.y1),b=key(wall.x2,wall.y2);
      connect(a,b,index);connect(b,a,index);
    });
    // Preserve closed four-edge contours: these are square columns, not caps.
    const protectedIndexes = new Set();
    for (const start of adjacency.keys()) {
      const stack=[{current:start,points:[start],edges:[]}];
      while(stack.length){
        const state=stack.pop();
        if(state.edges.length===4){
          if(state.current===start&&new Set(state.points.slice(0,-1)).size===4) state.edges.forEach(index=>protectedIndexes.add(index));
          continue;
        }
        for(const edge of adjacency.get(state.current)||[]){
          if(state.edges.includes(edge.index))continue;
          if(edge.key===start||!state.points.includes(edge.key)) stack.push({current:edge.key,points:[...state.points,edge.key],edges:[...state.edges,edge.index]});
        }
      }
    }
    const maxLength=1.5/k,maxDistance=.8/k,removed=new Set();
    const centers=walls.filter(wall=>wall.source==='cad_face_pair_centerline'||String(wall.id).includes('-CL'));
    for(const center of centers){
      for(const point of [[Number(center.x1),Number(center.y1)],[Number(center.x2),Number(center.y2)]]){
        walls.forEach((wall,index)=>{
          if(removed.has(index)||protectedIndexes.has(index)||wall===center||wall.source==='cad_face_pair_centerline'||wall.source==='cad_unpaired_face_tail'||String(wall.id).includes('-CL')||String(wall.id).includes('-AXIS'))return;
          if(wall.type!==center.type||(wall.layer!=null&&center.layer!=null&&wall.layer!==center.layer))return;
          const length=Math.hypot(Number(wall.x2)-Number(wall.x1),Number(wall.y2)-Number(wall.y1));
          if(!length||length>maxLength)return;
          const distances=[[Number(wall.x1),Number(wall.y1)],[Number(wall.x2),Number(wall.y2)]].map(([x,y])=>Math.hypot(x-point[0],y-point[1]));
          if(Math.max(...distances)<=maxDistance)removed.add(index);
        });
      }
    }
    return {walls:walls.filter((_wall,index)=>!removed.has(index)),removed:removed.size,ids:[...removed].map(index=>walls[index].id)};
  }
  function removeShortOpenCapClusters(walls, k) {
    // Some caps survive as two-to-five connected short edges beside an axis.
    // Remove only open clusters; a closed short loop is a real column contour.
    const maxEdge=2/k,maxBox=2.5/k,maxAxisDistance=1.5/k;
    const key=(x,y)=>`${Number(x).toFixed(3)}:${Number(y).toFixed(3)}`;
    const candidates=new Set(),pointEdges=new Map();
    const add=(point,index)=>{if(!pointEdges.has(point))pointEdges.set(point,[]);pointEdges.get(point).push(index);};
    walls.forEach((wall,index)=>{
      const length=Math.hypot(Number(wall.x2)-Number(wall.x1),Number(wall.y2)-Number(wall.y1));
      if(length>0&&length<=maxEdge&&wall.source!=='cad_face_pair_centerline'&&!String(wall.id).includes('-CL')&&!String(wall.id).includes('-AXIS')){
        candidates.add(index);add(key(wall.x1,wall.y1),index);add(key(wall.x2,wall.y2),index);
      }
    });
    const neighbors=new Map([...candidates].map(index=>[index,new Set()]));
    pointEdges.forEach(indexes => indexes.forEach(index => indexes.forEach(other => {
      if (index !== other) neighbors.get(index)?.add(other);
    })));
    const axes=walls.filter(wall=>wall.source==='cad_face_pair_centerline'||String(wall.id).includes('-CL')||String(wall.id).includes('-AXIS'));
    const distanceToSegment=(point,wall)=>{
      const ax=Number(wall.x1),ay=Number(wall.y1),dx=Number(wall.x2)-ax,dy=Number(wall.y2)-ay,length2=dx*dx+dy*dy;
      const t=length2?Math.max(0,Math.min(1,((point[0]-ax)*dx+(point[1]-ay)*dy)/length2)):0;
      return Math.hypot(point[0]-(ax+t*dx),point[1]-(ay+t*dy));
    };
    const visited=new Set(),removed=new Set();
    for(const seed of candidates){
      if(visited.has(seed))continue;
      const component=[],stack=[seed];visited.add(seed);
      while(stack.length){const index=stack.pop();component.push(index);for(const other of neighbors.get(index)||[])if(!visited.has(other)){visited.add(other);stack.push(other);}}
      if(component.length<2||component.length>6)continue;
      const points=component.flatMap(index=>[[Number(walls[index].x1),Number(walls[index].y1)],[Number(walls[index].x2),Number(walls[index].y2)]]);
      const width=Math.max(...points.map(point=>point[0]))-Math.min(...points.map(point=>point[0]));
      const height=Math.max(...points.map(point=>point[1]))-Math.min(...points.map(point=>point[1]));
      if(width>maxBox||height>maxBox)continue;
      const localDegree=new Map();
      component.forEach(index=>[key(walls[index].x1,walls[index].y1),key(walls[index].x2,walls[index].y2)].forEach(point=>localDegree.set(point,(localDegree.get(point)||0)+1)));
      const closed=[...localDegree.values()].every(degree=>degree===2)&&localDegree.size===component.length;
      if(closed)continue;
      const nearAxis=axes.some(axis=>points.some(point=>distanceToSegment(point,axis)<=maxAxisDistance));
      if(nearAxis)component.forEach(index=>removed.add(index));
    }
    return {walls:walls.filter((_wall,index)=>!removed.has(index)),removed:removed.size,ids:[...removed].map(index=>walls[index].id)};
  }
  function prepare(payload, options = {}) {
    const walls = payload.walls || [];
    const k = Number(payload.metadata?.k);
    if (!Number.isFinite(k) || k <= 0) return { payload, mergedPairs: 0, remainingHints: walls.filter(w => w.reviewHint === 'thin_parallel_pair').length };
    const hinted = walls.map((w, index) => ({ w, index })).filter(({ w }) => w.confidence === 'generic_plan_lineweight');
    // Exact long face pairs may be wider than 450 mm in the source CAD.
    const minLength = .5 / k, minGap = .06 / k, maxGap = .8 / k;
    const candidates = [];
    for (let i = 0; i < hinted.length; i++) {
      const { w: a, index: ai } = hinted[i];
      const ax = Number(a.x1), ay = Number(a.y1), bx = Number(a.x2), by = Number(a.y2);
      const al = Math.hypot(bx - ax, by - ay);
      if (al < minLength) continue;
      const ux = (bx - ax) / al, uy = (by - ay) / al;
      for (let j = i + 1; j < hinted.length; j++) {
        const { w: b, index: bi } = hinted[j];
        if (a.layer !== b.layer || a.type !== b.type) continue;
        const cx = Number(b.x1), cy = Number(b.y1), dx = Number(b.x2), dy = Number(b.y2);
        const bl = Math.hypot(dx - cx, dy - cy);
        if (bl < minLength || Math.abs(Math.abs(((dx-cx)*ux + (dy-cy)*uy) / bl) - 1) > .002) continue;
        const gap = Math.abs((cx - ax) * -uy + (cy - ay) * ux);
        if (gap < minGap || gap > maxGap) continue;
        const ts = (cx - ax) * ux + (cy - ay) * uy, te = (dx - ax) * ux + (dy - ay) * uy;
        const start = Math.min(ts, te), end = Math.max(ts, te);
        const endpointError = Math.max(Math.abs(start), Math.abs(end - al));
        // Wide pairs must agree almost exactly; short wide parallels can be separate objects.
        const widePair = gap > .45 / k;
        const endpointTolerance = widePair ? .05 / k : Math.min(al, bl) >= 3 / k ? .25 / k : .15 / k;
        if (endpointError > endpointTolerance) continue;
        const overlap = Math.min(al, end) - Math.max(0, start);
        if (widePair && (Math.min(al, bl) < 1.5 / k || Math.abs(al - bl) > .05 / k)) continue;
        if (overlap < (widePair ? .98 : .85) * Math.max(al, bl)) continue;
        candidates.push({ ai, bi, gap, score: endpointError + Math.abs(al - bl) });
      }
    }
    const degree = new Map();
    candidates.forEach(({ ai, bi }) => { degree.set(ai, (degree.get(ai) || 0) + 1); degree.set(bi, (degree.get(bi) || 0) + 1); });
    const pairs = candidates.filter(({ ai, bi }) => degree.get(ai) === 1 && degree.get(bi) === 1);
    const replaced = new Map(), removed = new Set(), removedCaps = new Set();
    const pairedIndexes = new Set(pairs.flatMap(pair => [pair.ai, pair.bi]));
    const distance = (first, second) => Math.hypot(first[0]-second[0],first[1]-second[1]);
    for (const { ai, bi, gap } of pairs) {
      const a = walls[ai], b = walls[bi];
      const aligned = (Number(a.x2) - Number(a.x1)) * (Number(b.x2) - Number(b.x1)) + (Number(a.y2) - Number(a.y1)) * (Number(b.y2) - Number(b.y1)) >= 0;
      const bStart = aligned ? [Number(b.x1), Number(b.y1)] : [Number(b.x2), Number(b.y2)];
      const bEnd = aligned ? [Number(b.x2), Number(b.y2)] : [Number(b.x1), Number(b.y1)];
      replaced.set(ai, { ...a, id: `${a.id}-CL`, x1: +((Number(a.x1) + bStart[0]) / 2).toFixed(3), y1: +((Number(a.y1) + bStart[1]) / 2).toFixed(3), x2: +((Number(a.x2) + bEnd[0]) / 2).toFixed(3), y2: +((Number(a.y2) + bEnd[1]) / 2).toFixed(3), source: 'cad_face_pair_centerline', pairedGapMm: Math.round(gap * k * 1000), reviewHint: undefined });
      removed.add(bi);
      const aStart=[Number(a.x1),Number(a.y1)],aEnd=[Number(a.x2),Number(a.y2)],tolerance=Math.max(.02/k,gap*.12);
      walls.forEach((candidate,index)=>{
        if(pairedIndexes.has(index)||removedCaps.has(index)||candidate.layer!==a.layer||candidate.type!==a.type)return;
        const c1=[Number(candidate.x1),Number(candidate.y1)],c2=[Number(candidate.x2),Number(candidate.y2)];
        const closesStart=(distance(c1,aStart)<=tolerance&&distance(c2,bStart)<=tolerance)||(distance(c2,aStart)<=tolerance&&distance(c1,bStart)<=tolerance);
        const closesEnd=(distance(c1,aEnd)<=tolerance&&distance(c2,bEnd)<=tolerance)||(distance(c2,aEnd)<=tolerance&&distance(c1,bEnd)<=tolerance);
        if(closesStart||closesEnd){removed.add(index);removedCaps.add(index);}
      });
    }
    const alignedWalls = walls.flatMap((w, index) => removed.has(index) ? [] : [replaced.get(index) || w]);
    const residual = options.collapseResidualDoubleWalls===false
      ? {walls:alignedWalls,merged:0,pairs:[]}
      : collapseResidualDoubleWalls(alignedWalls,k);
    const compound = compoundFaces(residual.walls, k);
    const openings = options.recognizeOpenings === false
      ? {walls:compound.walls,doors:payload.doors || [],openings:0}
      : openingGaps(compound.walls, payload.doors || [], k);
    const withoutHelpers = removeOpeningBoundarySegments(openings.walls, openings.doors, k);
    const withoutEndCaps = removeCenterlineEndCaps(withoutHelpers.walls, k);
    const withoutCapClusters = removeShortOpenCapClusters(withoutEndCaps.walls, k);
    const outputWalls = withoutCapClusters.walls;
    const remainingHints = outputWalls.filter(w => w.reviewHint === 'thin_parallel_pair').length;
    return {
      payload: { ...payload, walls: outputWalls, doors: openings.doors, metadata: { ...(payload.metadata || {}), wall_detection: { ...(payload.metadata?.wall_detection || {}), centerline_merged_pairs: pairs.length, removed_wall_face_caps: removedCaps.size, removed_wall_face_cap_ids: [...removedCaps].map(index=>walls[index].id), residual_double_wall_pairs: residual.merged, residual_double_wall_pair_ids: residual.pairs, centerline_compound_groups: compound.groups, recognized_opening_gaps: openings.openings, removed_opening_boundary_segments: withoutHelpers.removed, removed_centerline_end_caps: withoutEndCaps.removed, removed_centerline_end_cap_ids: withoutEndCaps.ids, removed_short_open_cap_clusters: withoutCapClusters.removed, removed_short_open_cap_cluster_ids: withoutCapClusters.ids, thin_parallel_pair_candidates: remainingHints, thin_parallel_pair_policy: 'aligned_and_compound_faces_merged;_wall_face_caps_evidence_only;_residual_double_faces_merged;_opening_boundaries_evidence_only;_centerline_end_caps_evidence_only;_short_open_cap_clusters_evidence_only;_ambiguous_faces_review_only' } } },
      mergedPairs: pairs.length, compoundGroups: compound.groups, recognizedOpenings: openings.openings, remainingHints,
    };
  }
  root.CenterlinePairs = { prepare };
  if (typeof module !== 'undefined') module.exports = { prepare };
})(typeof window !== 'undefined' ? window : globalThis);
