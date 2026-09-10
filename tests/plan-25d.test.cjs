const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const context = {window: {}};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/plan-25d.js'), 'utf8'), context);
const scene = Object.create(context.window.Plan25D.prototype);
scene.fit = () => {};
const volumes = [];
scene.box = (a,b,thickness,low,high,color) => volumes.push({a,b,low,high,color});
const model = {walls:[{id:'W',x1:0,y1:0,x2:400,y2:0,thickness:13,type:'wall'}],doors:[{id:'D',wallId:'W',x:80,y:0,width:48,swing:'left',leafCount:1}],windows:[{id:'WIN',wallId:'W',x:260,y:0,width:72}]};
const before = JSON.stringify(model);
scene.setModel(model,{width:400,height:300});
assert.equal(JSON.stringify(model), before, 'Building volume must not mutate saved geometry');
assert.equal(scene.openingCount, 2);
const walls = volumes.filter(v => v.color[0] === 228);
const covers = (x,z) => walls.some(v => v.a.x<x && v.b.x>x && v.low<z && v.high>z);
assert.equal(covers(80,50),false,'Door must have a real empty opening');
assert.equal(covers(80,130),true,'Door header remains');
assert.equal(covers(260,80),false,'Window opening remains empty');
assert.equal(covers(260,20),true,'Window sill wall remains');
assert.equal(covers(260,135),true,'Window header remains');
assert.equal(covers(180,50),true,'Wall between openings remains');
volumes.length=0;
const layeredPartition={walls:[{id:'P',x1:0,y1:0,x2:200,y2:0,thickness:7,type:'partition',topMode:'fixed',heightMm:2400,materialBands:[{fromMm:0,toMm:1200,material:'Газоблок'},{fromMm:1200,toMm:2400,material:'Стеклоблок'}]}],doors:[],windows:[]};
const layeredBefore=JSON.stringify(layeredPartition);
scene.setModel(layeredPartition,{width:400,height:300});
assert.equal(JSON.stringify(layeredPartition),layeredBefore,'Layered partition rendering must not mutate geometry');
assert.ok(volumes.some(v=>v.color[0]===218&&v.low===0&&v.high===60),'Gas-block band uses its real 0–1200 mm height');
assert.ok(volumes.some(v=>v.color[0]===133&&v.low===60&&v.high===120),'Glass-block band uses its real 1200–2400 mm height');
assert.ok(!volumes.some(v=>v.high>120),'2400 mm partition must stop below the 3000 mm default wall height');
console.log('PASS: variable wall height and vertical material bands');
volumes.length=0;
const realProjectHeights={walls:[
  {id:'W-4100',x1:0,y1:0,x2:160,y2:0,thickness:13,type:'wall',topMode:'ceiling',heightMm:4100,materialBands:[]},
  {id:'P-2700',x1:0,y1:40,x2:160,y2:40,thickness:7,type:'partition',topMode:'ceiling',heightMm:2700,materialBands:[]},
  {id:'P-2500',x1:0,y1:80,x2:160,y2:80,thickness:7,type:'partition',topMode:'ceiling',heightMm:2500,materialBands:[]},
  {id:'P-2400',x1:0,y1:120,x2:160,y2:120,thickness:7,type:'partition',topMode:'fixed',heightMm:2400,materialBands:[{fromMm:0,toMm:1200,material:'Газоблок'},{fromMm:1200,toMm:2400,material:'Стеклоблок'}]},
],doors:[],windows:[]};
scene.setModel(realProjectHeights,{width:400,height:300});
const topAt=y=>Math.max(...volumes.filter(volume=>volume.a.y===y).map(volume=>volume.high));
assert.equal(scene.height,205,'4100 mm ceiling zone determines the scene extent');
assert.equal(topAt(0),205);assert.equal(topAt(40),135);assert.equal(topAt(80),125);assert.equal(topAt(120),120);
assert.ok(volumes.some(volume=>volume.a.y===120&&volume.color[0]===218&&volume.high===60));
assert.ok(volumes.some(volume=>volume.a.y===120&&volume.color[0]===133&&volume.low===60));
console.log('PASS: real project heights 4100/2700/2500 and composite 2400 mm partition');
volumes.length=0;
const ceilingModel={walls:[],doors:[],windows:[],columns:[],ceilingZones:[{id:'CZ-1',x:10,y:20,width:180,height:120,heightMm:2800,type:'suspended',points:[{x:10,y:20},{x:190,y:20},{x:150,y:80},{x:190,y:140},{x:10,y:140}]}]};
scene.setModel(ceilingModel,{width:400,height:300});
assert.equal(scene.ceilingZones.length,1);
assert.equal(scene.height,150,'Ceiling contour participates in the 2.5D scene extent');
assert.equal(scene.ceilingZones[0].points.length,5,'Irregular ceiling contour is preserved in 2.5D');
console.log('PASS: polygon ceiling zone 2.5D contour model');
const occlusionModel={walls:[{id:'BLOCK',x1:100,y1:-100,x2:100,y2:100,thickness:10,type:'wall'}],doors:[],windows:[],columns:[],ceilingZones:[]};
scene.setModel(occlusionModel,{width:400,height:300},[{id:'CAM-BLOCK',type:'camera_ceiling',code:'КМ.1',x:0,y:0,rotation:0,mount:'ceiling',mountingHeight:2700,viewAngleDeg:20,viewRange:300}]);
const centerRay=scene.cameraCoverage[0].center;
assert.ok(Math.abs(centerRay.x-100)<.001,'2.5D camera coverage stops at a wall');
assert.ok(Math.abs(scene.cameraCoverage[0].centerStart.x-70)<.001,'2.5D coverage starts after the blind zone');
console.log('PASS: 2.5D camera coverage respects architectural obstacles');
scene.tilt=0;scene.rotation=0;
const point=scene.project([100,60,0]);
assert.equal(point.x,100-scene.center.x);
assert.equal(point.y,60-scene.center.y);
const saved=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/geometry.json'),'utf8'));
const original=JSON.stringify(saved);
scene.setModel(saved,{width:2650,height:1850});
assert.equal(JSON.stringify(saved),original);
assert.equal(scene.openingCount,saved.doors.length+(saved.windows||[]).length);
console.log('PASS: door/window cutouts, headers, source preservation, top view, project opening count');
for (const leafCount of [1,2]) for (const swing of ['left','right']) {
  const tips=[];
  for (const openingSide of [-1,1]) {
    volumes.length=0;
    scene.setModel({...model,doors:[{...model.doors[0],leafCount,swing,openingSide}]},{width:400,height:300});
    tips.push(volumes.filter(v=>v.color[0]===161).map(v=>v.b.y));
  }
  assert.equal(tips[0].length,leafCount);
  tips[0].forEach((y,i)=>assert.equal(y,-tips[1][i],'Opening side mirrors each leaf'));
}
console.log('PASS: both opening sides for both hinges and double doors');
const equipment=[
  {id:'EQ1',type:'reader',code:'YK1.1',x:80,y:0,rotation:0,mount:'wall',mountingHeight:1200},
  {id:'EQ2',type:'power_supply',code:'R1',x:160,y:0,rotation:0,mount:'ceiling',mountingHeight:2200},
  {id:'EQ3',type:'controller',code:'КНТ.1',x:220,y:80,rotation:0,mount:'ceiling',mountingHeight:2800,formFactor:'din_rail',hostWallId:'W'},
  {id:'CAM1',type:'camera_ceiling',code:'КМ.1',x:110,y:70,rotation:0,mount:'ceiling',mountingHeight:2700,viewAngleDeg:90,viewRange:420},
  {id:'CAM2',type:'camera_ceiling_bracket',code:'КК.1',x:270,y:70,rotation:1.2,mount:'ceiling',mountingHeight:2500,viewAngleDeg:70,viewRange:500,bracketLengthMm:300},
];
const equipmentBefore=JSON.stringify(equipment);volumes.length=0;
scene.setModel(model,{width:400,height:300},equipment);
assert.equal(scene.equipmentCount,5);
assert.equal(scene.equipmentLabels.length,5);
assert.equal(scene.cameraCoverage.length,2);
assert.equal(scene.cameraCoverage[1].range,500);
assert.ok(Math.abs(scene.cameraCoverage[1].angle-70*Math.PI/180)<.001);
assert.equal(JSON.stringify(equipment),equipmentBefore,'2.5D equipment rendering must not mutate project data');
assert.ok(volumes.some(v=>v.color[0]===22),'Reader has its own small volume');
assert.ok(volumes.some(v=>v.color[0]===215&&v.high===scene.height),'Ceiling mount includes a short suspension');
assert.ok(volumes.some(v=>v.color[0]===23&&v.a.y===0&&v.b.y===0),'Wall or above-ceiling controller projects onto its host wall');
assert.ok(volumes.some(v=>v.color[0]===63),'Flush-mounted ceiling camera has its own 2.5D body');
assert.ok(volumes.some(v=>v.color[0]===49),'Bracket camera has its own 2.5D body');
console.log('PASS: wall and ceiling equipment, two camera mounts, labels and source preservation');
const accessPoints=[{id:'AP-D',code:'ТД.2.4',doorId:'D',corridorSide:1}];
const doorEquipment=[
  {id:'EQ-D1',accessPointId:'AP-D',hostDoorId:'D',type:'reader',code:'СЧТ.2.4',x:80,y:5,rotation:0,mount:'wall',mountingHeight:1200},
  {id:'EQ-D2',accessPointId:'AP-D',hostDoorId:'D',type:'lock',code:'ЗМК.2.4',x:80,y:-5,rotation:0,mount:'door',mountingHeight:2050},
  equipment[1],
];
const accessBefore=JSON.stringify(accessPoints),doorEquipmentBefore=JSON.stringify(doorEquipment);volumes.length=0;
scene.setModel(model,{width:400,height:300},doorEquipment,accessPoints);
assert.equal(scene.equipmentCount,2,'Door devices collapse to one access-point symbol while standalone equipment remains');
assert.equal(JSON.stringify(scene.equipmentLabels.map(item=>item.code).sort()),JSON.stringify(['R1','ТД.2.4']));
assert.equal(JSON.stringify(accessPoints),accessBefore,'2.5D access-point rendering must not mutate project data');
assert.equal(JSON.stringify(doorEquipment),doorEquipmentBefore,'Collapsed door equipment must not be mutated');
assert.ok(volumes.some(v=>v.color[0]===23&&v.low===113&&v.high===133),'Access point marker is mounted on the wall above its door');
console.log('PASS: compact 2.5D access-point symbol is mounted above the door');
const linkedEquipment=[
  {id:'KNT-5',type:'controller',code:'КНТ.5',x:180,y:50,rotation:0,mount:'wall',mountingHeight:2200,hostWallId:'W',servedDoorIds:['D']},
  {id:'BP-5',type:'power_supply',code:'БП.5',x:300,y:50,rotation:0,mount:'wall',mountingHeight:2200,hostWallId:'W',servedControllerId:'KNT-5'},
];
scene.setModel(model,{width:400,height:300},linkedEquipment,accessPoints);
assert.equal(scene.connectionLines.length,2,'Controller-to-access-point and power-to-controller logical links are rendered');
assert.ok(scene.connectionLines.some(line=>line.color[0]===22),'Controller-to-access-point link uses the control color');
assert.ok(scene.connectionLines.some(line=>line.color[0]===215),'Power-to-controller link uses the power color');
console.log('PASS: 2.5D logical controller and power links');
