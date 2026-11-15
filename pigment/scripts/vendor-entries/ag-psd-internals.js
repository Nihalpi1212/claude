// ag-psd internals Pigment's mappers and preset-file readers use (ARCHITECTURE.md "0.5 features", S4.5), skeleton
// file: re-exported through the bundle entry (ag-psd.js), so renderer modules and Node tests import them from
// '#ag-psd'. A package needing another internal names it in its report and the integrator adds it here.
//
// parseBrushDescriptor below is a copy of ag-psd's private brush descriptor parsing in dist/abr.js (parseBrushShape,
// parseDynamics and the body of readAbr's 'desc' loop), so a .tpl tool preset's brush reads the way an .abr brush does.
// ag-psd: Copyright (c) 2016 Agamnentzar, MIT License (node_modules/ag-psd/LICENSE): "Permission is hereby granted,
// free of charge, to any person obtaining a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom
// the Software is furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software."
import { parsePercent, parseAngle, parseUnitsToNumber, BlnM } from 'ag-psd/dist/descriptor.js';

export { readAbr } from 'ag-psd/dist/abr.js';
export { readCsh } from 'ag-psd/dist/csh.js';
export { readAse } from 'ag-psd/dist/ase.js';
export { readPattern, createReader } from 'ag-psd/dist/psdReader.js';
export { writePattern, createWriter } from 'ag-psd/dist/psdWriter.js';
export { readVersionAndDescriptor, writeVersionAndDescriptor, parseEffects, serializeEffects, parseVectorContent } from 'ag-psd/dist/descriptor.js';

const dynamicsControl = ['off', 'fade', 'pen pressure', 'pen tilt', 'stylus wheel', 'initial direction', 'direction', 'initial rotation', 'rotation'];
const dynamicBrushShapeShapes = ['round point', 'round blunt', 'round curve', 'round angle', 'round fan', 'flat point', 'flat blunt', 'flat curve', 'flat angle', 'flat fan'];
const tipsBrushShapeShapes = ['erodible point', 'erodible flat', 'erodible round', 'erodible square', 'erodible triangle', 'custom'];
const toBrushType = { _: 'brush', MixB: 'mixer brush', SmTl: 'smudge brush' };

function parseDynamics(desc) {
  return { control: dynamicsControl[desc?.bVTy], steps: desc?.fStp, jitter: parsePercent(desc?.jitter), minimum: parsePercent(desc?.['Mnm ']) };
}

function parseHeightmap(array) {
  const result = [];
  for (let i = 0; i < array.byteLength; i++) result.push(array[i]);
  return result;
}

function parseBrushShape(desc) {
  switch (desc._classID) {
    case 'computedBrush':
      return { type: 'computed', size: parseUnitsToNumber(desc.Dmtr, 'Pixels'), angle: parseAngle(desc.Angl), roundness: parsePercent(desc.Rndn), spacingOn: desc.Intr, spacing: parsePercent(desc.Spcn), flipX: desc.flipX, flipY: desc.flipY, hardness: parsePercent(desc.Hrdn) };
    case 'sampledBrush':
      return { type: 'sampled', size: parseUnitsToNumber(desc.Dmtr, 'Pixels'), angle: parseAngle(desc.Angl), roundness: parsePercent(desc.Rndn), spacingOn: desc.Intr, spacing: parsePercent(desc.Spcn), flipX: desc.flipX, flipY: desc.flipY, name: desc['Nm  '], sampledData: desc.sampledData };
    case 'dBrush':
      return { type: 'dynamic', shape: dynamicBrushShapeShapes[desc['Shp ']], angle: parseAngle(desc.Angl), size: parseUnitsToNumber(desc.Dmtr, 'Pixels'), density: parsePercent(desc.Dnst), length: parsePercent(desc.Lngt), clumping: parsePercent(desc.clumping), thickness: parsePercent(desc.thickness), stiffness: parsePercent(desc.stiffness), physics: desc.physics, spacing: parsePercent(desc.Spcn), spacingOn: desc.Intr, flipX: desc.flipX, flipY: desc.flipY };
    case 'dTips':
      return {
        type: 'tips', angle: parseAngle(desc.Angl), size: parseUnitsToNumber(desc.Dmtr, 'Pixels'), shape: dynamicBrushShapeShapes[desc['Shp ']], physics: desc.physics, spacing: parsePercent(desc.Spcn), spacingOn: desc.Intr, flipX: desc.flipX, flipY: desc.flipY,
        tipsType: tipsBrushShapeShapes[desc.dtipsType], tipsLengthRatio: parsePercent(desc.dtipsLengthRatio), tipsHardness: parsePercent(desc.dtipsHardness),
        ...(desc.dtipsGridSize && desc.dtipsErodibleTipHeightMap ? { tipsGridSize: desc.dtipsGridSize, tipsErodibleTipHeightMap: parseHeightmap(desc.dtipsErodibleTipHeightMap) } : {}),
        tipsAirbrushCutoffAngle: desc.dtipsAirbrushCutoffAngle, tipsAirbrushGranularity: parsePercent(desc.dtipsAirbrushGranularity), tipsAirbrushStreakiness: parsePercent(desc.dtipsAirbrushStreakiness), tipsAirbrushSplatSize: parsePercent(desc.dtipsAirbrushSplatSize), tipsAirbrushSplatCount: desc.dtipsAirbrushSplatCount,
      };
    default:
      throw new Error(`Unknown brush classId: ${desc._classID}`);
  }
}

/**
 * ag-psd's Brush (the shape `readAbr` returns in `brushes`) for one brush descriptor: an entry of an .abr 'desc'
 * section's `Brsh` list, or a tool preset's brush descriptor (.tpl).
 */
export function parseBrushDescriptor(brush) {
  const b = { name: brush['Nm  '], shape: parseBrushShape(brush.Brsh), spacing: parsePercent(brush.Spcn), wetEdges: brush.Wtdg, noise: brush.Nose, useBrushSize: brush.useBrushSize };
  if (brush.interpretation != null) b.interpretation = brush.interpretation;
  if (brush.protectTexture != null) b.protectTexture = brush.protectTexture;
  if (brush.useTipDynamics) b.shapeDynamics = { tiltScale: parsePercent(brush.tiltScale), sizeDynamics: parseDynamics(brush.szVr), angleDynamics: parseDynamics(brush.angleDynamics), roundnessDynamics: parseDynamics(brush.roundnessDynamics), flipX: brush.flipX, flipY: brush.flipY, brushProjection: brush.brushProjection, minimumDiameter: parsePercent(brush.minimumDiameter), minimumRoundness: parsePercent(brush.minimumRoundness) };
  if (brush.useScatter) b.scatter = { count: brush['Cnt '], bothAxes: brush.bothAxes, countDynamics: parseDynamics(brush.countDynamics), scatterDynamics: parseDynamics(brush.scatterDynamics) };
  if (brush.useTexture && brush.Txtr) b.texture = { id: brush.Txtr.Idnt, name: brush.Txtr['Nm  '], blendMode: BlnM.decode(brush.textureBlendMode), depth: parsePercent(brush.textureDepth), depthMinimum: parsePercent(brush.minimumDepth), depthDynamics: parseDynamics(brush.textureDepthDynamics), scale: parsePercent(brush.textureScale), invert: brush.InvT, brightness: brush.textureBrightness, contrast: brush.textureContrast, textureEachTip: !!brush.TxtC };
  const db = brush.dualBrush;
  if (db && db.useDualBrush) b.dualBrush = { flip: db.Flip, shape: parseBrushShape(db.Brsh), blendMode: BlnM.decode(db.BlnM), useScatter: db.useScatter, spacing: parsePercent(db.Spcn), count: db['Cnt '], bothAxes: db.bothAxes, countDynamics: parseDynamics(db.countDynamics), scatterDynamics: parseDynamics(db.scatterDynamics) };
  if (brush.useColorDynamics) b.colorDynamics = { foregroundBackground: parseDynamics(brush.clVr), hue: parsePercent(brush['H   ']), saturation: parsePercent(brush.Strt), brightness: parsePercent(brush.Brgh), purity: parsePercent(brush.purity), perTip: brush.colorDynamicsPerTip };
  if (brush.usePaintDynamics) b.transfer = { flowDynamics: parseDynamics(brush.prVr), opacityDynamics: parseDynamics(brush.opVr), wetnessDynamics: parseDynamics(brush.wtVr), mixDynamics: parseDynamics(brush.mxVr) };
  if (brush.useBrushPose) b.brushPose = { overrideAngle: brush.overridePoseAngle, overrideTiltX: brush.overridePoseTiltX, overrideTiltY: brush.overridePoseTiltY, overridePressure: brush.overridePosePressure, pressure: parsePercent(brush.brushPosePressure), tiltX: brush.brushPoseTiltX, tiltY: brush.brushPoseTiltY, angle: brush.brushPoseAngle };
  const to = brush.toolOptions;
  if (to) {
    b.toolOptions = {
      type: toBrushType[to._classID] || 'brush', brushPreset: to.brushPreset, flow: to.flow ?? 100, smooth: to.Smoo ?? 0, mode: BlnM.decode(to['Md  '] || 'BlnM.Nrml'), opacity: to.Opct ?? 100,
      smoothing: !!to.smoothing, smoothingValue: to.smoothingValue || 0, smoothingRadiusMode: !!to.smoothingRadiusMode, smoothingCatchup: !!to.smoothingCatchup, smoothingCatchupAtEnd: !!to.smoothingCatchupAtEnd, smoothingZoomCompensation: !!to.smoothingZoomCompensation,
      pressureSmoothing: !!to.pressureSmoothing, usePressureOverridesSize: !!to.usePressureOverridesSize, usePressureOverridesOpacity: !!to.usePressureOverridesOpacity, useLegacy: !!to.useLegacy,
    };
    if (to.prVr) b.toolOptions.flowDynamics = parseDynamics(to.prVr);
    if (to.opVr) b.toolOptions.opacityDynamics = parseDynamics(to.opVr);
    if (to.szVr) b.toolOptions.sizeDynamics = parseDynamics(to.szVr);
    for (const [k, out] of [['wetness', 'wetness'], ['dryness', 'dryness'], ['mix', 'mix'], ['autoFill', 'autoFill'], ['autoClean', 'autoClean'], ['loadSolidColorOnly', 'loadSolidColorOnly'], ['sampleAllLayers', 'sampleAllLayers'], ['SmdF', 'smudgeFingerPainting'], ['SmdS', 'smudgeSampleAllLayers'], ['Prs ', 'strength']]) if (k in to) b.toolOptions[out] = to[k];
  }
  return b;
}
