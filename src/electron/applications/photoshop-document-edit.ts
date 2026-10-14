import { z } from "zod";
import path from "node:path";
import { photoshopScript } from "./native-application-scripts";

const file = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => path.isAbsolute(v) && path.resolve(v) === v && !/[\x00-\x1f]/.test(v));
const layerPath = z.array(z.string().min(1).max(512)).min(1).max(32);
const hex = z.string().regex(/^[0-9a-fA-F]{6}$/);
export const PhotoshopChangeSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set_text"),
      layerPath,
      contents: z.string().max(10000).optional(),
      fontSize: z.number().min(1).max(1000).optional(),
      color: hex.optional(),
    })
    .strict()
    .refine(
      (v) => v.contents !== undefined || v.fontSize !== undefined || v.color !== undefined,
      "A text change is required",
    ),
  z
    .object({
      op: z.literal("set_visibility"),
      layerPath,
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_opacity"),
      layerPath,
      opacity: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      op: z.literal("rename_layer"),
      layerPath,
      name: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      op: z.literal("translate_layer"),
      layerPath,
      x: z.number().min(-10000).max(10000),
      y: z.number().min(-10000).max(10000),
    })
    .strict(),
]);
export const PhotoshopEditSchema = z
  .object({
    app: z.literal("photoshop"),
    sourcePath: file.refine((v) => v.endsWith(".psd")),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    path: file.refine((v) => v.endsWith(".psd")),
    exportPath: file.refine((v) => v.endsWith(".png")),
    changes: z.array(PhotoshopChangeSchema).min(1).max(50),
  })
  .strict()
  .refine(
    (v) => new Set([v.sourcePath, v.path, v.exportPath]).size === 3,
    "Source and outputs must be distinct",
  );
export const PhotoshopReadSchema = z
  .object({
    app: z.literal("photoshop"),
    path: file.refine((v) => v.endsWith(".psd")),
    exportPath: file.refine((v) => v.endsWith(".png")).optional(),
  })
  .strict();
export type PhotoshopEditInput = z.infer<typeof PhotoshopEditSchema>;
export interface PhotoshopLayer {
  path: string[];
  kind: "group" | "text" | "raster" | "other";
  visible: boolean;
  opacity: number;
  bounds: number[];
  locked: boolean;
  stackIndex?: number;
  text?: {
    contents: string;
    font: string;
    size: number;
    color: string;
    position: number[];
  };
}
export interface PhotoshopModel {
  width: number;
  height: number;
  resolution: number;
  mode: string;
  layers: PhotoshopLayer[];
}

// ExtendScript has no guaranteed JSON implementation. Fixed serializer handles
// arbitrary existing names and multiline text without delimiter ambiguity.
const helpers = `
function json(v){if(v===null)return "null";if(typeof v==="string")return '"'+v.replace(/[\\\\"\\u0000-\\u001f]/g,function(c){var h=c.charCodeAt(0).toString(16);return "\\\\u"+("0000"+h).slice(-4);})+'"';if(typeof v==="number"||typeof v==="boolean")return String(v);var a=[],k;if(v instanceof Array){for(k=0;k<v.length;k++)a.push(json(v[k]));return "["+a.join(",")+"]";}for(k in v)if(v.hasOwnProperty(k))a.push(json(k)+":"+json(v[k]));return "{"+a.join(",")+"}";}
function guardSource(p){for(var i=0;i<app.documents.length;i++){var d=app.documents[i];try{if(d.fullName.fsName===p&&!d.saved)throw new Error("SOURCE_UNSAVED: Save or discard changes in the source document first");}catch(e){if(String(e).indexOf("SOURCE_UNSAVED")>=0)throw e;}}}
function isText(l){try{return typeof l.textItem.contents==="string";}catch(e){return false;}}
function stackIndex(l){try{var r=new ActionReference();r.putIdentifier(charIDToTypeID("Lyr "),l.id);return executeActionGet(r).getInteger(stringIDToTypeID("itemIndex"));}catch(e){return null;}}
function model(d){var rows=[];function add(l,p,group){var q=p.concat([l.name]),b=l.bounds,r={path:q,kind:"other",visible:l.visible,opacity:l.opacity,bounds:[b[0].as("px"),b[1].as("px"),b[2].as("px"),b[3].as("px")],locked:l.allLocked},index=stackIndex(l);if(group)r.kind="group";else if(isText(l))r.kind="text";else if(String(l.kind)===String(LayerKind.NORMAL))r.kind="raster";if(index!==null)r.stackIndex=index;if(r.kind==="text"){var t=l.textItem;r.text={contents:t.contents,font:t.font,size:t.size.as("pt"),color:t.color.rgb.hexValue.toUpperCase(),position:[t.position[0].as("px"),t.position[1].as("px")]};}rows.push(r);if(rows.length>500)throw new Error("Document has too many layers");if(group)walk(l,q);}function walk(parent,p){for(var i=0;i<parent.artLayers.length;i++)add(parent.artLayers[i],p,false);for(var j=0;j<parent.layerSets.length;j++)add(parent.layerSets[j],p,true);}walk(d,[]);return {width:d.width.as("px"),height:d.height.as("px"),resolution:d.resolution,mode:String(d.mode),layers:rows};}
function findLayer(d,p){var parent=d,l=null;for(var i=0;i<p.length;i++){var count=0;for(var a=0;a<parent.artLayers.length;a++)if(parent.artLayers[a].name===p[i]){l=parent.artLayers[a];count++;}for(var g=0;g<parent.layerSets.length;g++)if(parent.layerSets[g].name===p[i]){l=parent.layerSets[g];count++;}if(count!==1)throw new Error("Missing or ambiguous layer path: "+p.join(" / "));if(i<p.length-1){if(l.typename!=="LayerSet")throw new Error("Layer path is not a group");parent=l;}}return l;}

`;

export function photoshopReadSnapshotScript(sourcePath: string, snapshotPath: string): string {
  return photoshopScript(`(function(){${helpers}
var oldDialogs=app.displayDialogs,oldUnits=app.preferences.rulerUnits,oldDoc=app.documents.length?app.activeDocument:null,d=null;
try{app.displayDialogs=DialogModes.NO;app.preferences.rulerUnits=Units.PIXELS;guardSource(${JSON.stringify(sourcePath)});d=app.open(new File(${JSON.stringify(snapshotPath)}),OpenDocumentType.PHOTOSHOP);return json({appVersion:app.version,model:model(d)});}
finally{if(d)d.close(SaveOptions.DONOTSAVECHANGES);app.displayDialogs=oldDialogs;app.preferences.rulerUnits=oldUnits;if(oldDoc)app.activeDocument=oldDoc;}})();`);
}

export function photoshopEditSnapshotScript(
  input: PhotoshopEditInput,
  snapshotPath: string,
): string {
  return photoshopScript(`(function(){${helpers}
var oldDialogs=app.displayDialogs,oldUnits=app.preferences.rulerUnits,oldDoc=app.documents.length?app.activeDocument:null,d=null;
try{app.displayDialogs=DialogModes.NO;app.preferences.rulerUnits=Units.PIXELS;guardSource(${JSON.stringify(input.sourcePath)});
var target=new File(${JSON.stringify(input.path)}),exported=new File(${JSON.stringify(input.exportPath)});if(target.exists||exported.exists)throw new Error("Output already exists");
d=app.open(new File(${JSON.stringify(snapshotPath)}),OpenDocumentType.PHOTOSHOP);var changes=${JSON.stringify(input.changes)};
for(var i=0;i<changes.length;i++){var c=changes[i],l=findLayer(d,c.layerPath);if(l.allLocked)throw new Error("Target layer is locked");
if(c.op==="set_text"){if(l.typename!=="ArtLayer"||!isText(l))throw new Error("Target is not an editable text layer");if(c.contents!==undefined)l.textItem.contents=c.contents.replace(/\\r?\\n/g,"\\r");if(c.fontSize!==undefined)l.textItem.size=new UnitValue(c.fontSize,"pt");if(c.color!==undefined){var color=new SolidColor();color.rgb.hexValue=c.color;l.textItem.color=color;}}
else if(c.op==="set_visibility")l.visible=c.visible;
else if(c.op==="set_opacity")l.opacity=c.opacity;
else if(c.op==="rename_layer"){var peers=l.parent.layers;for(var j=0;j<peers.length;j++)if(peers[j]!==l&&peers[j].name===c.name)throw new Error("Rename would create an ambiguous path");l.name=c.name;}
else if(c.op==="translate_layer"){if(l.typename==="LayerSet")throw new Error("Group translation is not supported");l.translate(new UnitValue(c.x,"px"),new UnitValue(c.y,"px"));}}
var options=new PhotoshopSaveOptions();options.layers=true;d.saveAs(target,options,false,Extension.LOWERCASE);d.saveAs(exported,new PNGSaveOptions(),true,Extension.LOWERCASE);return d.fullName.fsName;}
finally{if(d)d.close(SaveOptions.DONOTSAVECHANGES);app.displayDialogs=oldDialogs;app.preferences.rulerUnits=oldUnits;if(oldDoc)app.activeDocument=oldDoc;}})();`);
}

export function expectedPhotoshopEdit(
  baseline: PhotoshopModel,
  changes: PhotoshopEditInput["changes"],
): PhotoshopModel {
  const model = structuredClone(baseline);
  for (const c of changes) {
    const matches = model.layers.filter(
      (l) => JSON.stringify(l.path) === JSON.stringify(c.layerPath),
    );
    if (matches.length !== 1) throw new Error("Missing or ambiguous layer path");
    const l = matches[0];
    if (l.locked) throw new Error("Target layer is locked");
    if (c.op === "set_text") {
      if (!l.text) throw new Error("Target is not an editable text layer");
      if (c.contents !== undefined) l.text.contents = c.contents.replace(/\r?\n/g, "\r");
      if (c.fontSize !== undefined) l.text.size = c.fontSize;
      if (c.color !== undefined) l.text.color = c.color.toUpperCase();
    } else if (c.op === "set_visibility") l.visible = c.visible;
    else if (c.op === "set_opacity") l.opacity = c.opacity;
    else if (c.op === "translate_layer") {
      if (l.kind === "group") throw new Error("Group translation is not supported");
      l.bounds = l.bounds.map((v, i) => v + (i % 2 ? c.y : c.x));
      if (l.text) l.text.position = l.text.position.map((v, i) => v + (i ? c.y : c.x));
    } else {
      if (
        model.layers.some(
          (other) =>
            other !== l &&
            JSON.stringify(other.path.slice(0, -1)) === JSON.stringify(l.path.slice(0, -1)) &&
            other.path.at(-1) === c.name,
        )
      )
        throw new Error("Rename would create an ambiguous path");
      const old = [...l.path];
      for (const other of model.layers)
        if (old.every((v, i) => other.path[i] === v)) other.path[old.length - 1] = c.name;
    }
  }
  return model;
}

export function photoshopEditUnmet(
  input: PhotoshopEditInput,
  source: { model: PhotoshopModel; persisted: { sha256: string } },
  output: {
    model: PhotoshopModel;
    persisted: {
      width?: number;
      height?: number;
      export?: { width?: number; height?: number; sha256?: string } | null;
    };
  },
): string[] {
  const unmet: string[] = [];
  if (source.persisted.sha256 !== input.sourceSha256)
    unmet.push("Source PSD changed since planning");
  const expected = expectedPhotoshopEdit(source.model, input.changes);
  const actual = output.model;
  if (
    actual.width !== expected.width ||
    actual.height !== expected.height ||
    actual.mode !== expected.mode ||
    actual.resolution !== expected.resolution
  )
    unmet.push("Document properties changed unexpectedly");
  if (output.persisted.width !== expected.width || output.persisted.height !== expected.height)
    unmet.push("Saved PSD dimensions differ");
  if (
    !output.persisted.export?.sha256 ||
    output.persisted.export.width !== expected.width ||
    output.persisted.export.height !== expected.height
  )
    unmet.push("PNG export is missing or has incorrect dimensions");
  // Text replacement changes its glyph bounds. Verify text styling and baseline
  // position instead; preserve bounds on all other leaf layers.
  const normalize = (m: PhotoshopModel) =>
    m.layers.map((l) => ({
      ...l,
      bounds: l.kind === "group" || l.text ? undefined : l.bounds,
    }));
  const compare = (a: unknown, b: unknown, key?: string): boolean => {
    if (typeof a === "number" && typeof b === "number")
      // PSD opacity is stored in one byte; saving may round by half a step.
      return Math.abs(a - b) <= (key === "opacity" ? 100 / 510 + 0.001 : 0.1);
    if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = Object.keys(a);
      return (
        keys.length === Object.keys(b).length &&
        keys.every((k) =>
          compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], k),
        )
      );
    }
    return a === b;
  };
  if (!compare(normalize(expected), normalize(actual)))
    unmet.push("Requested layer edits or preserved layer structure differ");
  return unmet;
}
