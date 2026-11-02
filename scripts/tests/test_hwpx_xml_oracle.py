"""Mutation tests for the independent HWPX XML preservation oracle.

``legacy_xml_tree`` is the comparison previously used by
native-external-hwpx-save.py, kept verbatim to demonstrate its false
negatives. Run: python3 -m unittest scripts/tests/test_hwpx_xml_oracle.py
"""
import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET
import zipfile
from xml.parsers.expat import ExpatError

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("hwpx_xml_oracle", ROOT / "scripts/tests/hwpx_xml_oracle.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)

HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"
SAMPLE = ROOT / "external/rhwp/samples/issue7418/list_marker_head_synthetic.hwpx"


def legacy_xml_tree(e):
    return (e.tag, sorted(e.attrib.items()), e.text.strip() if e.text and e.text.strip() else '', [legacy_xml_tree(c) for c in e])


def legacy_equal(a, b):
    return legacy_xml_tree(ET.fromstring(a)) == legacy_xml_tree(ET.fromstring(b))


def doc(body, decl='<?xml version="1.0" encoding="UTF-8"?>', prefix='hp'):
    return (f'{decl}<{prefix}:sec xmlns:{prefix}="{HP}"><{prefix}:p id="0"><{prefix}:run charPrIDRef="0">'
            f'{body}</{prefix}:run></{prefix}:p></{prefix}:sec>').encode()


def t(text, prefix='hp'):
    return f'<{prefix}:t>{text}</{prefix}:t>'


class MeaningfulMutations(unittest.TestCase):
    """Each mutation loses or changes document content and must be detected."""

    CASES = {
        'trailing whitespace removed': (t('안녕하세요 '), t('안녕하세요')),
        'leading whitespace removed': (t(' 안녕하세요'), t('안녕하세요')),
        'whitespace-only text removed': (t(' '), t('')),
        'whitespace-only text changed': (t(' '), t('　')),
        'tail text removed': (t('가<hp:tab width="1"/>나'), t('가<hp:tab width="1"/>')),
        'tail text added': (t('가<hp:tab width="1"/>'), t('가<hp:tab width="1"/>나')),
        'tail whitespace removed': (t('가<hp:tab width="1"/> '), t('가<hp:tab width="1"/>')),
        'text around nested element changed': (t('가<hp:tab width="1"/>나'), t('가<hp:tab width="1"/>다')),
        'comment removed': (t('가') + '<!-- keep -->', t('가')),
        'comment changed': (t('가') + '<!-- a -->', t('가') + '<!-- b -->'),
        'processing instruction removed': (t('가') + '<?app data?>', t('가')),
    }

    def test_legacy_verifier_misses_and_oracle_detects(self):
        for name, (before, after) in self.CASES.items():
            with self.subTest(name):
                a, b = doc(before), doc(after)
                self.assertTrue(legacy_equal(a, b), f'legacy should have missed: {name}')
                self.assertFalse(oracle.equal(a, b), f'oracle must detect: {name}')

    def test_structural_changes_detected_by_both(self):
        cases = {
            'attribute value': (t('가'), t('가').replace('<hp:t>', '<hp:t x="1">')),
            'namespaced attribute': ('<hp:tab xmlns:z="urn:z" z:a="1"/>', '<hp:tab xmlns:z="urn:z" z:a="2"/>'),
            'attribute namespace': ('<hp:tab xmlns:z="urn:z" z:a="1"/>', '<hp:tab xmlns:z="urn:y" z:a="1"/>'),
            'element order': (t('가') + '<hp:tab/>', '<hp:tab/>' + t('가')),
            'element removed': (t('가') + '<hp:tab/>', t('가')),
            'element namespace': ('<hp:tab/>', '<z:tab xmlns:z="urn:z"/>'),
            'text changed': (t('가'), t('나')),
        }
        for name, (before, after) in cases.items():
            with self.subTest(name):
                a, b = doc(before), doc(after)
                self.assertFalse(legacy_equal(a, b))
                self.assertFalse(oracle.equal(a, b))

    def test_inter_element_whitespace_follows_production_contract(self):
        # geul's comparator keeps every text event inside the root, so
        # indentation changes are differences there too; the oracle agrees.
        self.assertFalse(oracle.equal(doc(t('가') + '<hp:tab/>'), doc(t('가') + '\n  <hp:tab/>')))


class RepresentationOnly(unittest.TestCase):
    """Lexical differences that the production comparator also ignores."""

    def test_equal(self):
        base = doc(t('가 &lt;b&gt; ') + '<hp:tab a="1" b="2"/>')
        variants = {
            'prefix': doc(t('가 &lt;b&gt; ', 'p0') + '<p0:tab a="1" b="2"/>', prefix='p0'),
            'attribute order': doc(t('가 &lt;b&gt; ') + '<hp:tab b="2" a="1"/>'),
            'xml declaration': doc(t('가 &lt;b&gt; ') + '<hp:tab a="1" b="2"/>', decl=''),
            'cdata': doc(t('가 <![CDATA[<b>]]> ') + '<hp:tab a="1" b="2"/>'),
            'character reference': doc(t('&#xAC00; &#60;b&gt; ') + '<hp:tab a="1" b="2"/>'),
            'whitespace outside root': doc(t('가 &lt;b&gt; ') + '<hp:tab a="1" b="2"/>') + b'\n\n',
            'namespace declared later': (f'<?xml version="1.0"?><a:sec xmlns:a="{HP}"><b:p xmlns:b="{HP}" id="0">'
                                         f'<b:run charPrIDRef="0"><b:t>가 &lt;b&gt; </b:t><b:tab a="1" b="2"/>'
                                         f'</b:run></b:p></a:sec>').encode(),
        }
        for name, other in variants.items():
            with self.subTest(name):
                self.assertTrue(oracle.equal(base, other), oracle.first_difference(oracle.parse(base), oracle.parse(other)))

    def test_doctype_refused(self):
        with self.assertRaises(oracle.DoctypeRefused):
            oracle.parse(b'<!DOCTYPE sec [<!ENTITY x "y">]><sec>&x;</sec>')


class RealSection(unittest.TestCase):
    """The same false negative on the accepted external document's real XML."""

    def test_trailing_space_in_real_paragraph(self):
        data = zipfile.ZipFile(SAMPLE).read('Contents/section0.xml')
        self.assertTrue(oracle.equal(data, data))
        root = ET.fromstring(data)
        target = next(e for e in root.iter('{%s}t' % HP) if e.text and e.text.strip())
        target.text += ' '
        mutated = ET.tostring(root, encoding='utf-8')
        self.assertTrue(legacy_equal(data, mutated))
        self.assertFalse(oracle.equal(data, mutated))


class DocumentEvents(unittest.TestCase):
    def test_root_only_predecessor_misses_external_events(self):
        def old(data):
            return ET.fromstring(data, parser=ET.XMLParser(
                target=ET.TreeBuilder(insert_comments=True, insert_pis=True)))

        for event in (b'<!-- before -->', b'<?app data?>'):
            for before, after in ((event + b'<r/>', b'<r/>'),
                                  (b'<r/>' + event, b'<r/>')):
                with self.subTest(before=before):
                    self.assertEqual(oracle.canonical_events(old(before)), oracle.canonical_events(old(after)))
                    self.assertFalse(oracle.equal(before, after))

    def test_content_and_order(self):
        base = b'<!--a--><?app data?><r/><?end keep?><!--z-->'
        for other in (base.replace(b'<!--a-->', b'<!--b-->'),
                      base.replace(b'<!--z-->', b'<!--x-->'),
                      base.replace(b'<?end keep?>', b''),
                      base.replace(b'<?app data?>', b'<?other data?>'),
                      base.replace(b'<?app data?>', b'<?app  data?>'),
                      b'<?app data?><!--a--><r/><?end keep?><!--z-->'):
            with self.subTest(other=other):
                self.assertFalse(oracle.equal(base, other))
        self.assertTrue(oracle.equal(base, b'<?xml version="1.0"?>\n' +
                                     base.replace(b'<r/>', b'\n<r></r>\n') + b'\n'))
        self.assertFalse(oracle.equal(b'<?xml-stylesheet href="a"?><r/>', b'<r/>'))

    def test_invalid_documents(self):
        for data in (b'<r/><r/>', b'<r>', b'<r a="1" a="2"/>', b'<p:r/>',
                     b'outside<r/>', b'<r/><?xml version="1.0"?>',
                     b'<r>&unknown;</r>', b'<r>&#0;</r>', b'<!-- bad -- comment --><r/>'):
            with self.subTest(data=data), self.assertRaises(ExpatError):
                oracle.parse(data)

    def test_literal_line_endings_match_raw_production_events(self):
        # Expat's usual callbacks normalize these to LF. Rust keeps the raw
        # text/comment/PI payload, so a CR/CRLF loss must remain visible.
        for template in (b'<!--a%sb--><r/>', b'<r/><!--a%sb-->',
                         b'<?app a%sb?><r/>', b'<r/><?app a%sb?>',
                         b'<r>a%sb</r>', b'<r><![CDATA[a%sb]]></r>'):
            for newline in (b'\r', b'\r\n'):
                with self.subTest(template=template, newline=newline):
                    self.assertFalse(oracle.equal(template % newline, template % b'\n'))
        self.assertTrue(oracle.equal(b'<r>a\r\nb</r>', b'<r>a&#13;&#10;b</r>'))
        self.assertTrue(oracle.equal(b'<r><![CDATA[a\r\nb]]></r>', b'<r>a&#xD;\nb</r>'))
        self.assertTrue(oracle.equal(b'<r>&lt;!--literal--&gt;&amp;#13;</r>',
                                     b'<r><![CDATA[<!--literal-->&#13;]]></r>'))


if __name__ == '__main__':
    unittest.main()
