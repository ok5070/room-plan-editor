/* Typical access point from project sheet 6. Side is selected by the user as corridor. */
const Sheet6DoorTemplate = {
  source: 'СБСТ-2026-03-Р-СКУД, лист 6',
  placements(door, corridorSide) {
    const jamb = door.width / 2 + 7.5;
    const protectedSide = -corridorSide;
    const hingeOffset = door.swing === 'right' ? door.width / 2 - 8 : -door.width / 2 + 8;
    return [
      {type:'reader', side:corridorSide, surface:'wall', offset:corridorSide*jamb, height:1100},
      {type:'lock', side:protectedSide, surface:'frame', offset:protectedSide*10, height:2050},
      {type:'door_contact', side:protectedSide, surface:'frame', offset:protectedSide*-14, height:2080},
      {type:'door_closer', side:protectedSide, surface:'leaf', offset:hingeOffset, height:1980},
      {type:'emergency_release', side:protectedSide, surface:'wall', offset:protectedSide*jamb, height:1750},
      {type:'exit_button', side:protectedSide, surface:'wall', offset:protectedSide*jamb, height:1100},
      {type:'junction_box', side:protectedSide, surface:'wall', offset:0, height:2350},
    ];
  },
  apply(items, door, corridorSide, create) {
    const touched=[];
    this.placements(door,corridorSide).forEach(placement=>{
      let item=items.find(e=>e.hostDoorId===door.id&&e.type===placement.type);
      if(!item){item=create(placement.type);items.push(item);}
      item.hostDoorId=door.id;item.hostWallId=door.wallId;
      item.mount=placement.surface==='wall'?'wall':'door';item.mountingHeight=placement.height;
      item.doorMount={side:placement.side,surface:placement.surface,offset:placement.offset};
      item.templateSource=this.source;touched.push(item);
    });
    return touched;
  }
};
if(typeof module!=='undefined')module.exports=Sheet6DoorTemplate;
