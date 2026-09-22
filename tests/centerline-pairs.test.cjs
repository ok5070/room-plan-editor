const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepare } = require('../static/centerline-pairs.js');

const wall = (id, y, x1=0, x2=30) => ({id, type:'wall',x1,y1:y,x2,y2:y,thickness:13,layer:'План',confidence:'generic_plan_lineweight',reviewHint:'thin_parallel_pair'});
const input = {walls:[wall('A',0),wall('B',1),wall('C',4,0,20),wall('D',5,3,20),{...wall('E',10),confidence:'explicit_architecture_layer',reviewHint:undefined}],doors:[],windows:[],metadata:{k:.1,wall_detection:{thin_parallel_pair_candidates:4}}};
const before = JSON.stringify(input);
const result = prepare(input);
assert.equal(JSON.stringify(input),before,'Preparing centerlines must not mutate the source export');
assert.equal(result.mergedPairs,1,'Only the end-aligned pair is safe to merge');
assert.equal(result.compoundGroups,1,'A mostly matching partial face is reduced to its shared axis');
assert.equal(result.remainingHints,0);
assert.equal(result.payload.walls.length,4);
assert.deepEqual([result.payload.walls[0].x1,result.payload.walls[0].y1,result.payload.walls[0].x2,result.payload.walls[0].y2],[0,.5,30,.5]);
assert.equal(result.payload.walls[0].pairedGapMm,100);
assert.equal(result.payload.walls[0].type,'wall','A pair of faces does not prove partition classification');
assert.deepEqual([result.payload.walls[1].id,result.payload.walls[2].id],['C-TAIL-1','C-CL-1'],'An unpaired terminal portion is retained without contouring the shared portion');
assert.equal(result.payload.metadata.wall_detection.centerline_merged_pairs,1);

const ambiguous = prepare({...input,walls:[wall('A',0),wall('B',1),wall('C',-1)]});
assert.equal(ambiguous.mergedPairs,0,'A contour with two equally plausible partners must not be guessed');
const unsupported = prepare({...input,metadata:{}});
assert.equal(unsupported.mergedPairs,0,'Uncalibrated exports are left unchanged');

const segmented = prepare({...input,walls:[wall('HOST',0,0,35.5),wall('LEFT',5.5,0,15),wall('RIGHT',5.5,20.5,35.5),
  {...wall('OPENING-CAP-L',0,15,15),x2:15,y2:5.5},
  {...wall('OPENING-CAP-R',0,20.5,20.5),x2:20.5,y2:5.5},
  {...wall('REAL-CROSS-WALL',0,30,30),x2:30,y2:20}
]});
assert.equal(segmented.compoundGroups,1,'Two shortened faces opposite one host become one compound wall');
assert.deepEqual(segmented.payload.walls.map(w => w.id),['HOST-CL-1-OPENING-HOST','REAL-CROSS-WALL']);
assert.deepEqual([segmented.payload.walls[0].x1,segmented.payload.walls[0].y1,segmented.payload.walls[0].x2,segmented.payload.walls[0].y2],[0,2.75,35.5,2.75],'The recognized opening receives one continuous host wall');
assert.deepEqual(segmented.payload.doors.map(d=>[d.wallId,d.x,d.y,d.width,d.swing]),[['HOST-CL-1-OPENING-HOST',17.75,2.75,5.5,'unknown']],'The gap becomes a neutral door opening without invented hinges');
assert.equal(segmented.payload.metadata.wall_detection.removed_opening_boundary_segments,2,'Opening boundary caps remain evidence only');
assert.ok(segmented.payload.walls.some(w=>w.id==='REAL-CROSS-WALL'),'A genuine longer perpendicular wall remains geometry');
const competing = prepare({...input,walls:[wall('HOST',0,0,35.5),wall('LEFT',5.5,0,15),wall('RIGHT',5.5,20.5,35.5),wall('LEFT-ALT',-5.5,0,15),wall('RIGHT-ALT',-5.5,20.5,35.5)]});
assert.equal(competing.compoundGroups,0,'Competing contours on both sides of one host remain for review');
const variableWidth = prepare({...input,walls:[wall('HOST',0,0,77.4),wall('A',6.3,0,15.4),wall('B',5.2,20.9,77.2)]});
assert.equal(variableWidth.compoundGroups,1,'A left wall with slightly varying face offset still has one axis per covered span');
assert.equal(variableWidth.recognizedOpenings,1);
assert.deepEqual(variableWidth.payload.doors.map(d=>d.width),[5.5]);

const wideFaces = prepare({...input,walls:[wall('TOP',382.497,158.781,225.281),wall('BOTTOM',375.597,158.781,225.281)]});
assert.equal(wideFaces.mergedPairs,1,'Two exactly aligned 690 mm faces form one wall axis');
assert.equal(wideFaces.payload.walls[0].pairedGapMm,690);
assert.equal(wideFaces.payload.walls[0].y1,379.047);
const wideShort = prepare({...input,walls:[wall('TOP',382.497,0,10),wall('BOTTOM',375.597,0,10)]});
assert.equal(wideShort.mergedPairs,0,'Short wide parallels may be unrelated symbols');
const wideOffset = prepare({...input,walls:[wall('TOP',382.497,0,30),wall('BOTTOM',375.597,.6,30.6)]});
assert.equal(wideOffset.mergedPairs,0,'Wide pairs need matching ends within 50 mm');
const twoStage = prepare({...input,walls:[
  wall('FACE-A-1',0,0,80),wall('FACE-A-2',1,0,80),
  wall('FACE-B-1',6,18,81),wall('FACE-B-2',7,18,81)
]});
assert.equal(twoStage.payload.metadata.wall_detection.residual_double_wall_pairs,1,'Two line-width pairs become one physical wall axis');
assert.equal(twoStage.payload.walls.length,1);
assert.equal(twoStage.payload.walls[0].pairedGapMm,600);
const closeDuplicate = prepare({...input,walls:[wall('DUP-A',0,0,20),{...wall('DUP-B',1.1,.2,20.2),y2:3.1}]});
assert.equal(closeDuplicate.payload.metadata.wall_detection.residual_double_wall_pairs,1,'A slightly skewed duplicate line becomes one axis');
assert.equal(closeDuplicate.payload.walls.length,1);

const projectExport = path.resolve(__dirname,'../../../elv-auditor-room-plan-integration-2/outputs/fly-pine-wall-partition-review.json');
if (fs.existsSync(projectExport)) {
  const source = JSON.parse(fs.readFileSync(projectExport,'utf8'));
  const merged = prepare(source);
  assert.equal(merged.mergedPairs,106);
  assert.equal(merged.remainingHints,0);
  assert.equal(merged.compoundGroups,13);
  assert.equal(merged.recognizedOpenings,35);
  assert.equal(merged.payload.doors.length,35);
  assert.ok(merged.payload.walls.length < 311);
  assert.ok(merged.payload.metadata.wall_detection.residual_double_wall_pairs >= 5);
  assert.ok(merged.payload.metadata.wall_detection.removed_wall_face_caps>=59);
  assert.ok(merged.payload.metadata.wall_detection.removed_centerline_end_caps>=90);
  assert.ok(merged.payload.metadata.wall_detection.removed_short_open_cap_clusters>=25);
  assert.ok(merged.payload.metadata.wall_detection.removed_wall_face_caps+merged.payload.metadata.wall_detection.removed_opening_boundary_segments>=60);
  assert.ok(merged.payload.walls.some(w => w.id === 'W-0012-CL-OPENING-HOST' && w.y1 === 379.047),'Pictured corridor segments share one door host wall');
}
console.log('PASS: safe CAD centerline pairs, 690 mm pictured wall, ambiguous/offset rejection, source preservation');
