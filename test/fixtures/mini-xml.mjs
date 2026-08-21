/**
 * Test-only XML parser exposing the handful of DOM methods parseMPD uses:
 * `documentElement`, `getElementsByTagName`, `getAttribute` and `parentNode`.
 *
 * Node has no DOMParser, and Magpie takes no dependencies, so the DASH fixtures
 * are parsed with this instead. It handles elements, quoted attributes,
 * namespaced names and self-closing tags — enough for a manifest, and
 * deliberately not a general-purpose XML parser.
 */

const TAG_RE = /<(\/)?([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/)?>/g;
const ATTR_RE = /([\w.:-]+)\s*=\s*"([^"]*)"/g;

export function parseXml(text) {
  const stack = [];
  const all = [];
  let root = null;
  let match;

  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(text)) !== null) {
    const [, closing, name, attrText, selfClosing] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    const attributes = {};
    ATTR_RE.lastIndex = 0;
    let attr;
    while ((attr = ATTR_RE.exec(attrText || '')) !== null) attributes[attr[1]] = attr[2];

    const node = {
      nodeName: name,
      attributes,
      children: [],
      parentNode: stack.length ? stack[stack.length - 1] : null,
      getAttribute(key) {
        return Object.prototype.hasOwnProperty.call(this.attributes, key)
          ? this.attributes[key]
          : null;
      },
    };
    if (node.parentNode) node.parentNode.children.push(node);
    all.push(node);
    if (!root) root = node;
    if (!selfClosing) stack.push(node);
  }

  return {
    documentElement: root,
    getElementsByTagName: (tag) => all.filter((n) => n.nodeName === tag),
  };
}

/** Drop-in stand-in for DOMParser, for injection into parseMPD. */
export class MiniDOMParser {
  parseFromString(text) {
    return parseXml(text);
  }
}
