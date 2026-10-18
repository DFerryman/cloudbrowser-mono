/**
 * Just enough XML for EC2 Query API responses: elements, text and entities. Attributes,
 * comments, CDATA and processing instructions are skipped. Workers have no DOMParser.
 */
export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', children: [], text: '' };
  const stack: XmlNode[] = [root];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m[2]) {
      const [, closing, name, , selfClosing] = m;
      if (closing) {
        if (stack.length > 1) stack.pop();
      } else {
        const node: XmlNode = { name: name!.includes(':') ? name!.split(':').pop()! : name!, children: [], text: '' };
        top.children.push(node);
        if (!selfClosing) stack.push(node);
      }
    } else if (m[5] !== undefined) {
      top.text += m[5];
    } else if (m[6] !== undefined) {
      top.text += decode(m[6]);
    }
  }
  return root;
}

/** The first descendant reached by following child names, e.g. `child(n, 'instanceState', 'name')`. */
export function child(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let cur = node;
  for (const name of path) {
    cur = cur?.children.find((c) => c.name === name);
    if (!cur) return undefined;
  }
  return cur;
}

export function text(node: XmlNode | undefined, ...path: string[]): string | undefined {
  const n = child(node, ...path);
  return n ? n.text.trim() : undefined;
}

/** The `<item>` children of a set element, e.g. `items(res, 'reservationSet')`. */
export function items(node: XmlNode | undefined, ...path: string[]): XmlNode[] {
  return child(node, ...path)?.children.filter((c) => c.name === 'item') ?? [];
}

/** `<tagSet><item><key/><value/></item></tagSet>` as a record. */
export function tags(node: XmlNode | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of items(node, 'tagSet')) {
    const k = text(t, 'key');
    if (k !== undefined) out[k] = text(t, 'value') ?? '';
  }
  return out;
}
