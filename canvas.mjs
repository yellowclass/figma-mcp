// A small data-only canvas language. Tenant callers never send JavaScript to
// Figma: this fixed interpreter is the only code the shared proxy executes.
const nodeId = /^\d+[:-]\d+$/;
const reference = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const numeric = new Set([
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "strokeWeight",
  "cornerRadius",
  "fontSize",
  "itemSpacing",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
]);
const enums = {
  layoutMode: ["NONE", "HORIZONTAL", "VERTICAL"],
  primaryAxisSizingMode: ["FIXED", "AUTO"],
  counterAxisSizingMode: ["FIXED", "AUTO"],
  primaryAxisAlignItems: ["MIN", "MAX", "CENTER", "SPACE_BETWEEN"],
  counterAxisAlignItems: ["MIN", "MAX", "CENTER", "BASELINE"],
  textAlignHorizontal: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"],
  textAutoResize: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"],
};
const own = (object, key) => Object.hasOwn(object, key);
function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function target(value) {
  return (
    typeof value === "string" && (nodeId.test(value) || reference.test(value))
  );
}
function paints(value) {
  if (!Array.isArray(value) || value.length > 10) return false;
  return value.every(
    (paint) =>
      object(paint) &&
      paint.type === "SOLID" &&
      Object.keys(paint).every((key) =>
        ["type", "color", "opacity", "visible"].includes(key),
      ) &&
      object(paint.color) &&
      Object.keys(paint.color).every((key) => ["r", "g", "b"].includes(key)) &&
      ["r", "g", "b"].every(
        (key) =>
          Number.isFinite(paint.color[key]) &&
          paint.color[key] >= 0 &&
          paint.color[key] <= 1,
      ) &&
      (!own(paint, "opacity") ||
        (Number.isFinite(paint.opacity) &&
          paint.opacity >= 0 &&
          paint.opacity <= 1)) &&
      (!own(paint, "visible") || typeof paint.visible === "boolean"),
  );
}
export function validateOperations(operations) {
  if (
    !Array.isArray(operations) ||
    operations.length < 1 ||
    operations.length > 200
  )
    throw new Error("Provide 1–200 canvas operations");
  const seen = new Set();
  for (const op of operations) {
    if (
      !object(op) ||
      ![
        "createFrame",
        "createRectangle",
        "createEllipse",
        "createText",
        "setProperties",
        "setText",
        "appendChild",
        "removeNode",
      ].includes(op.action)
    )
      throw new Error("Unsupported canvas operation");
    if (
      Object.keys(op).some(
        (key) =>
          !["action", "ref", "target", "parent", "properties", "text"].includes(
            key,
          ),
      )
    )
      throw new Error("Unsupported canvas operation field");
    const creating = op.action.startsWith("create");
    if (creating) {
      if (!reference.test(op.ref || "") || seen.has(op.ref))
        throw new Error("New nodes require a unique reference");
      seen.add(op.ref);
    } else if (!target(op.target))
      throw new Error("An existing node ID or reference is required");
    if (op.parent !== undefined && !target(op.parent))
      throw new Error("Invalid parent");
    if (op.action === "appendChild" && !op.parent)
      throw new Error("Parent is required");
    if (
      op.text !== undefined &&
      (typeof op.text !== "string" || op.text.length > 20000)
    )
      throw new Error("Invalid text");
    if (op.action === "setText" && op.text === undefined)
      throw new Error("Text is required");
    if (op.properties !== undefined) {
      if (!object(op.properties)) throw new Error("Invalid node properties");
      for (const [key, value] of Object.entries(op.properties)) {
        let valid = false;
        if (numeric.has(key))
          valid =
            typeof value === "number" &&
            Number.isFinite(value) &&
            Math.abs(value) <= 100000 &&
            (!["width", "height", "fontSize"].includes(key) || value > 0) &&
            (key !== "opacity" || (value >= 0 && value <= 1));
        else if (own(enums, key)) valid = enums[key].includes(value);
        else if (["name"].includes(key))
          valid = typeof value === "string" && value.length <= 500;
        else if (["visible", "clipsContent"].includes(key))
          valid = typeof value === "boolean";
        else if (["fills", "strokes"].includes(key)) valid = paints(value);
        if (!valid)
          throw new Error(`Unsupported or invalid node property: ${key}`);
      }
    }
  }
  return operations;
}

export function canvasCode(operations) {
  validateOperations(operations);
  const code = `const operations = ${JSON.stringify(operations)};
const references = new Map();
async function resolve(value) {
  if (references.has(value)) return references.get(value);
  const node = await figma.getNodeByIdAsync(value.replace('-', ':'));
  if (!node || node.type === 'DOCUMENT') throw new Error('Node is not in the current file');
  return node;
}
async function text(node, value) {
  if (node.type !== 'TEXT' || typeof node.fontName !== 'object') throw new Error('Text requires a node with a single font');
  await figma.loadFontAsync(node.fontName);
  node.characters = value;
}
for (const operation of operations) {
  let node;
  if (operation.action === 'createFrame') node = figma.createFrame();
  else if (operation.action === 'createRectangle') node = figma.createRectangle();
  else if (operation.action === 'createEllipse') node = figma.createEllipse();
  else if (operation.action === 'createText') {
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    node = figma.createText();
    node.fontName = { family: 'Inter', style: 'Regular' };
  } else node = await resolve(operation.target);
  if (operation.ref) references.set(operation.ref, node);
  if (operation.action === 'removeNode') {
    if (node.type === 'PAGE') throw new Error('Removing pages is not supported');
    node.remove(); continue;
  }
  if (operation.parent) {
    const parent = await resolve(operation.parent);
    if (typeof parent.appendChild !== 'function') throw new Error('Parent cannot contain children');
    parent.appendChild(node);
  }
  if (operation.text !== undefined) await text(node, operation.text);
  const properties = operation.properties || {};
  if (properties.width !== undefined || properties.height !== undefined) node.resize(properties.width ?? node.width, properties.height ?? node.height);
  if (node.type === 'TEXT' && properties.fontSize !== undefined && typeof node.fontName === 'object') await figma.loadFontAsync(node.fontName);
  for (const [key, value] of Object.entries(properties)) if (key !== 'width' && key !== 'height') node[key] = value;
}
return { nodes: Array.from(references, ([ref,node]) => ({ref,id:node.id,name:node.name})) };`;
  if (code.length > 50000) throw new Error("Canvas operation payload is too large; split it into smaller calls");
  return code;
}

export const canvasTool = {
  name: "edit_canvas",
  title: "Edit Figma Canvas",
  description:
    "Create and edit frames, shapes, text and auto layout in an approved Figma file. Use unique refs for newly created nodes and their parent/target references in the same call. Existing targets use node IDs. Each operation may partially apply before a later failure; inspect before retrying. JavaScript, external libraries, images and account operations are not accepted.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fileKey", "operations"],
    properties: {
      fileKey: { type: "string" },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: [
                "createFrame",
                "createRectangle",
                "createEllipse",
                "createText",
                "setProperties",
                "setText",
                "appendChild",
                "removeNode",
              ],
            },
            ref: { type: "string" },
            target: { type: "string" },
            parent: { type: "string" },
            text: { type: "string" },
            properties: {
              type: "object",
              description:
                "Supported: name, x, y, width, height, rotation, opacity, visible, SOLID fills/strokes, strokeWeight, cornerRadius, fontSize, textAlignHorizontal, textAutoResize, clipsContent and auto-layout properties.",
            },
          },
        },
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
};
