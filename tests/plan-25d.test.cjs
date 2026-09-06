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
  {id:'EQ3',type:'controller',code:'AR.1',x:220,y:0,rotation:0,mount:'ceiling',mountingHeight:2800,formFactor:'din_rail'},
];
const equipmentBefore=JSON.stringify(equipment);volumes.length=0;
scene.setModel(model,{width:400,height:300},equipment);
assert.equal(scene.equipmentCount,3);
assert.equal(scene.equipmentLabels.length,3);
assert.equal(JSON.stringify(equipment),equipmentBefore,'2.5D equipment rendering must not mutate project data');
assert.ok(volumes.some(v=>v.color[0]===22),'Reader has its own small volume');
assert.ok(volumes.some(v=>v.color[0]===215&&v.high===scene.height),'Ceiling mount includes a short suspension');
console.log('PASS: wall and ceiling equipment volumes, labels and source preservation');
