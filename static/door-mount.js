/* Door-local coordinates: offset in plan units along the closed opening, height in mm. */
const DoorMount = {
  resolve(item, geometry, opened = false) {
    const m = item.doorMount, d = geometry.doors.find(d => d.id === item.hostDoorId);
    if (!m || !d) return item;
    const w = geometry.walls.find(w => w.id === d.wallId);
    if (!w) return item;
    const angle = Math.atan2(w.y2-w.y1,w.x2-w.x1);
    let ux=Math.cos(angle), uy=Math.sin(angle), x=d.x+ux*m.offset, y=d.y+uy*m.offset;
    let rotation=angle;
    if (opened && m.surface==='leaf') {
      const right=d.leafCount===2 ? m.offset>0 : d.swing==='right';
      const direction=right?-1:1, hinge=right?d.width/2:-d.width/2;
      const distance=Math.abs(m.offset-hinge), side=d.openingSide===1?-1:1;
      const vx=ux*direction*.5+side*uy*Math.sin(Math.PI/3);
      const vy=uy*direction*.5-side*ux*Math.sin(Math.PI/3);
      x=d.x+ux*hinge+vx*distance;y=d.y+uy*hinge+vy*distance;
      rotation=Math.atan2(vy*direction,vx*direction);ux=Math.cos(rotation);uy=Math.sin(rotation);
    }
    const thickness=m.surface==='leaf'?3:(w.thickness||7)+ (m.surface==='frame'?2:0);
    const depth={controller:90,power_supply:120,battery:100,reader:30,exit_button:28,emergency_release:32,lock:55,door_contact:22,junction_box:60,intercom_panel:35,intercom_monitor:40}[item.type]||40;
    const gap=thickness/2+Math.max(2,depth*.05)/2+.3;
    return {...item,x:x-uy*m.side*gap,y:y+ux*m.side*gap,rotation};
  }
};
if(typeof module!=='undefined')module.exports=DoorMount;
