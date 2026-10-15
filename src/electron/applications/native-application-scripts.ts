import { z } from "zod";
import path from "node:path";

const text = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\x00-\x1f|]+$/);
const cellText = text.refine(
  (v) => !/^[=+@-]/.test(v.trimStart()),
  "Spreadsheet labels cannot be formulas",
);
const file = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => path.isAbsolute(v) && path.resolve(v) === v && !/[\x00-\x1f]/.test(v));
export const ExcelPlanSchema = z
  .object({
    app: z.literal("excel"),
    path: file.refine((v) => v.endsWith(".xlsx")),
    title: cellText,
    months: z.tuple([cellText, cellText, cellText]),
    units: z.tuple([
      z.number().int().min(0).max(1e6),
      z.number().int().min(0).max(1e6),
      z.number().int().min(0).max(1e6),
    ]),
    price: z.number().min(0).max(1e6),
    unitCost: z.number().min(0).max(1e6),
  })
  .strict();
export const PhotoshopBannerSchema = z
  .object({
    app: z.literal("photoshop"),
    path: file.refine((v) => v.endsWith(".psd")),
    exportPath: file.refine((v) => v.endsWith(".png")),
    title: text,
    subtitle: text,
    width: z.number().int().min(800).max(2400),
    height: z.number().int().min(450).max(1600),
    background: z.string().regex(/^[0-9a-fA-F]{6}$/),
    accent: z.string().regex(/^[0-9a-fA-F]{6}$/),
  })
  .strict();
export const NativeCreateSchema = z.discriminatedUnion("app", [
  ExcelPlanSchema,
  PhotoshopBannerSchema,
]);
export type NativeCreateInput = z.infer<typeof NativeCreateSchema>;
export const NativeInspectSchema = z
  .object({
    app: z.enum(["excel", "photoshop"]),
    action: z.enum(["readiness", "document"]),
    path: file.optional(),
    exportPath: file.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action === "document" && !v.path)
      ctx.addIssue({ code: "custom", message: "Document path is required" });
    if (v.exportPath && (v.app !== "photoshop" || !v.exportPath.endsWith(".png")))
      ctx.addIssue({
        code: "custom",
        message: "Only Photoshop PNG exports are supported",
      });
  });
export const appIds = {
  excel: "com.microsoft.Excel",
  photoshop: "com.adobe.Photoshop",
} as const;
// JSON quoting is AppleScript-compatible for these bounded strings; no shell is involved.
export const appleString = (value: string): string => JSON.stringify(value);
export const photoshopScript = (js: string): string =>
  `tell application id "com.adobe.Photoshop" to do javascript ${appleString(js)}`;

export function readinessScript(app: "excel" | "photoshop"): string {
  // Version queries alone are exempt from macOS Automation consent. Exercise the
  // same app API read-only before readiness can admit a mutating job.
  const probe =
    app === "photoshop"
      ? photoshopScript("app.version;")
      : `tell application id "${appIds.excel}"
count workbooks
return version
end tell`;
  return `if application id "${appIds[app]}" is not running then return "NOT_RUNNING"
${probe}`;
}

export function excelCreateScript(input: z.infer<typeof ExcelPlanSchema>): string {
  const rows: (string | number)[][] = [
    ["Month", "Units", "Unit price", "Revenue", "Unit cost", "Cost", "Profit", "Margin"],
  ];
  for (let i = 0; i < 3; i++) {
    const row = i + 5;
    rows.push([
      input.months[i],
      input.units[i],
      input.price,
      `=B${row}*C${row}`,
      input.unitCost,
      `=B${row}*E${row}`,
      `=D${row}-F${row}`,
      `=IFERROR(G${row}/D${row},0)`,
    ]);
  }
  rows.push(Array(8).fill(""));
  rows.push([
    "Total",
    "=SUM(B5:B7)",
    "",
    "=SUM(D5:D7)",
    "",
    "=SUM(F5:F7)",
    "=SUM(G5:G7)",
    "=IFERROR(G9/D9,0)",
  ]);
  const matrix = `{${rows.map((row) => `{${row.map((value) => (typeof value === "number" ? value : appleString(value))).join(", ")}}`).join(", ")}}`;
  return `tell application id "com.microsoft.Excel"
set wb to make new workbook
set ws to worksheet 1 of wb
set name of ws to "Operating plan"
set value of range "A1" of ws to ${appleString(input.title)}
set value of range "A2" of ws to "Operating plan | illustrative inputs | EUR"
set formula of range "A4:H9" of ws to ${matrix}
set column width of range "A:A" of ws to 22
set column width of range "B:H" of ws to 16
set bold of font object of range "A4:H4" of ws to true
set bold of font object of range "A9:H9" of ws to true
set font size of font object of range "A1" of ws to 20
set number format of range "C5:G9" of ws to "#,##0.00"
set number format of range "H5:H9" of ws to "0.0%"
calculate ws
save workbook as wb filename ${appleString(input.path)} file format Excel XML file format
return ${appleString(input.path)}
end tell`;
}

export function photoshopCreateScript(input: z.infer<typeof PhotoshopBannerSchema>): string {
  const js = `(function(){
var oldDialogs=app.displayDialogs, oldUnits=app.preferences.rulerUnits, oldDoc=app.documents.length?app.activeDocument:null;
try {
app.displayDialogs=DialogModes.NO; app.preferences.rulerUnits=Units.PIXELS;
var target=new File(${JSON.stringify(input.path)}), exported=new File(${JSON.stringify(input.exportPath)});
if(target.exists||exported.exists) throw new Error("Output already exists");
var d=app.documents.add(${input.width},${input.height},72,${JSON.stringify(path.basename(input.path, ".psd"))},NewDocumentMode.RGB,DocumentFill.TRANSPARENT);
var initialLayer=d.artLayers[0];
function color(hex){var c=new SolidColor();c.rgb.hexValue=hex;return c;}
function block(name,hex,x,y,w,h){var l=d.artLayers.add();l.name=name;d.selection.select([[x,y],[x+w,y],[x+w,y+h],[x,y+h]]);d.selection.fill(color(hex));d.selection.deselect();return l;}
block("Background",${JSON.stringify(input.background)},0,0,${input.width},${input.height});
block("Accent",${JSON.stringify(input.accent)},64,96,8,${input.height - 192});
function textLayer(name,contents,size,x,y){var l=d.artLayers.add();l.kind=LayerKind.TEXT;l.name=name;l.textItem.contents=contents;l.textItem.font="ArialMT";l.textItem.size=size;l.textItem.color=color("FFFFFF");l.textItem.position=[x,y];return l;}
textLayer("Title",${JSON.stringify(input.title)},48,112,${Math.round(input.height * 0.42)});
textLayer("Subtitle",${JSON.stringify(input.subtitle)},24,112,${Math.round(input.height * 0.58)});
textLayer("Brand","COWORK OS",18,112,${input.height - 96});
// The initial transparent layer is empty and owned by this newly created document.
initialLayer.remove();
var opts=new PhotoshopSaveOptions();opts.layers=true;d.saveAs(target,opts,false,Extension.LOWERCASE);
var png=new PNGSaveOptions();d.saveAs(exported,png,true,Extension.LOWERCASE);
return d.fullName.fsName;
} finally { app.displayDialogs=oldDialogs; app.preferences.rulerUnits=oldUnits; if(oldDoc) app.activeDocument=oldDoc; }
})();`;
  return photoshopScript(js);
}

export function nativeInspectScript(app: "excel" | "photoshop", filePath: string): string {
  if (app === "excel") {
    const fields = [
      "version",
      "candidatePath",
      "saved of wb",
      'value of range "A1" of ws',
      'formula of range "D5" of ws',
      'formula of range "G9" of ws',
      'value of range "D9" of ws',
      'value of range "F9" of ws',
      'value of range "G9" of ws',
      'value of range "H9" of ws',
    ];
    return `tell application id "com.microsoft.Excel"
set wb to workbook ${appleString(path.basename(filePath))}
set candidatePath to full name of wb
try
set candidatePath to POSIX path of (candidatePath as alias)
end try
if candidatePath is not ${appleString(filePath)} then error "The exact saved workbook is not open"
set ws to worksheet "Operating plan" of wb
return ${fields.map((f) => `(${f} as text)`).join(" & linefeed & ")}
end tell`;
  }
  return photoshopScript(`(function(){
for(var i=0;i<app.documents.length;i++){var d=app.documents[i];try{if(d.fullName.fsName!==${JSON.stringify(filePath)})continue;}catch(e){continue;}
var names=[],texts=[];for(var j=0;j<d.artLayers.length;j++){var l=d.artLayers[j];names.push(l.name);if(l.kind===LayerKind.TEXT)texts.push(l.textItem.contents);}
return [app.version,d.fullName.fsName,d.saved,d.width.as("px"),d.height.as("px"),names.join("|"),texts.join("|")].join("\\n");}
throw new Error("The exact saved Photoshop document is not open");})();`);
}

export function parseNativeInspection(
  app: "excel" | "photoshop",
  raw: string,
): Record<string, unknown> {
  const fields = raw.trim().split(/\r?\n/);
  const numeric = (s: string) => Number(s.replace(",", "."));
  if (app === "excel" && fields.length === 10)
    return {
      appVersion: fields[0],
      path: fields[1],
      saved: fields[2] === "true",
      title: fields[3],
      revenueFormula: fields[4],
      profitFormula: fields[5],
      revenue: numeric(fields[6]),
      cost: numeric(fields[7]),
      profit: numeric(fields[8]),
      margin: numeric(fields[9]),
    };
  if (app === "photoshop" && fields.length === 7)
    return {
      appVersion: fields[0],
      path: fields[1],
      saved: fields[2] === "true",
      width: numeric(fields[3]),
      height: numeric(fields[4]),
      layers: fields[5].split("|"),
      text: fields[6].split("|"),
    };
  throw new Error("Unexpected native application inspection response");
}
