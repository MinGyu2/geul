"""Independent XML preservation oracle for native HWPX acceptance tests.

It mirrors the documented contract of geul's production comparator
(src-tauri/src/document/xml.rs ``Canonical``) without reusing its code:

* meaningful: element order, namespace URI + local name, every attribute
  (namespace-qualified, compared as a set), character data exactly as written
  inside the root element (leading/trailing/whitespace-only text and text after
  a child element, i.e. ElementTree ``tail``), comments and processing
  instructions with their content;
* not meaningful: namespace prefixes, attribute order, ``xmlns`` declarations,
  the XML declaration, whitespace outside the root element, and the lexical
  form of text (CDATA, character and predefined entity references are the same
  characters);
* refused: a document type declaration (the production comparator rejects
  DTDs, so the oracle never compares such input as equal).

``canonical_events`` returns a flat event list in which adjacent text pieces
are merged, so text segmentation cannot hide or fabricate differences.
"""
import xml.etree.ElementTree as ET
from xml.parsers import expat
import re


class DoctypeRefused(ValueError):
    """The input declares a DTD, which the preservation contract refuses."""


class Document:
    """Ordered document children, with a mutable root for narrow edit checks."""

    def __init__(self, root, children):
        self.root, self.children = root, children

    def find(self, path):
        return self.root.find(path)

    def iter(self, tag=None):
        return self.root.iter(tag)


def parse(data):
    """Use Expat's document callbacks, not a root-only ElementTree parse.

    DefaultHandler supplies raw character data/comments/PI, retaining literal
    CR and CRLF which the ordinary text/comment callbacks normalize to LF.
    It also keeps PI target/data separator whitespace. Expat validates XML;
    only the five predefined entities and numeric references are decoded here.
    Expat validates namespaces, references, attributes and the single root.
    """
    parser = expat.ParserCreate(namespace_separator='}')
    builder = ET.TreeBuilder(insert_comments=True, insert_pis=True)
    children, depth, cdata = [], 0, False

    def name(value):
        return '{' + value if '}' in value else value

    def start(tag, attributes):
        nonlocal depth
        node = builder.start(name(tag), {name(k): v for k, v in attributes.items()})
        if depth == 0:
            children.append(node)
        depth += 1

    def end(tag):
        nonlocal depth
        builder.end(name(tag))
        depth -= 1

    def reference(match):
        token = match[1]
        if token.startswith('#x'):
            return chr(int(token[2:], 16))
        if token.startswith('#'):
            return chr(int(token[1:], 10))
        return {'lt': '<', 'gt': '>', 'amp': '&', 'apos': "'", 'quot': '"'}[token]

    def cdata_state(value):
        nonlocal cdata
        cdata = value

    def default(value):
        if cdata:
            builder.data(value)
        elif value.startswith('<!--'):
            node = builder.comment(value[4:-3])
            if depth == 0:
                children.append(node)
        elif value.startswith('<?'):
            node = builder.pi(value[2:-2])
            if depth == 0:
                children.append(node)
        elif depth:
            builder.data(re.sub(r'&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|apos|quot);', reference, value))

    def doctype(*_):
        raise DoctypeRefused('DTD')

    parser.StartElementHandler, parser.EndElementHandler = start, end
    parser.DefaultHandler = default
    parser.StartCdataSectionHandler = lambda: cdata_state(True)
    parser.EndCdataSectionHandler = lambda: cdata_state(False)
    parser.XmlDeclHandler = lambda *_: None
    parser.StartDoctypeDeclHandler = doctype
    parser.Parse(data, True)
    return Document(builder.close(), children)


def _events(element, out):
    if element.tag is ET.Comment:
        out.append(('comment', element.text or ''))
    elif element.tag is ET.ProcessingInstruction:
        out.append(('pi', element.text or ''))
    else:
        out.append(('start', element.tag, tuple(sorted(element.attrib.items()))))
        if element.text:
            out.append(('text', element.text))
        for child in element:
            _events(child, out)
            if child.tail:
                out.append(('text', child.tail))
        out.append(('end',))


def canonical_events(root):
    """Events of the whole document, or an explicitly selected subtree."""
    raw = []
    for node in root.children if isinstance(root, Document) else (root,):
        _events(node, raw)
    merged = []
    for event in raw:
        if event[0] == 'text' and merged and merged[-1][0] == 'text':
            merged[-1] = ('text', merged[-1][1] + event[1])
        else:
            merged.append(event)
    return merged


def equal(before, after):
    """True when two XML byte strings are equal under the contract above."""
    return canonical_events(parse(before)) == canonical_events(parse(after))


def first_difference(x, y):
    """Index and events of the first difference between two parsed trees."""
    a, b = canonical_events(x), canonical_events(y)
    for index, (left, right) in enumerate(zip(a, b)):
        if left != right:
            return index, left, right
    if len(a) != len(b):
        return min(len(a), len(b)), a[len(b):len(b) + 1], b[len(a):len(a) + 1]
    return None
