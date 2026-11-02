"""The native acceptance exception permits one prefix at one owned text slot."""
import copy
import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native', ROOT / 'scripts/tests/native-external-hwpx-save.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
HP = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'


def paragraph(body):
    return ET.fromstring(f'<p xmlns="{HP[1:-1]}" id="1">{body}</p>')


def accepts(before, after):
    expected, saved = copy.deepcopy(before), copy.deepcopy(after)
    native.apply_intentional_edit(expected, saved, HP)
    for p in (expected, saved):
        native.omit_edited_line_layout(p, HP)
    assert native.oracle.canonical_events(expected) == native.oracle.canonical_events(saved)


class NarrowPrefix(unittest.TestCase):
    def setUp(self):
        self.original = paragraph('<run charPrIDRef="1"><t> AB한😀<tab width="1"/> 뒤 </t>'
                                  '<t/><t>둘</t></run><run charPrIDRef="2"><t>CD </t></run>'
                                  '<linesegarray><lineseg textpos="0"/></linesegarray>')
        self.saved = copy.deepcopy(self.original)
        next(self.saved.iter(HP+'t')).text = '한글 AB한😀'

    def test_intended_prefix_and_recalculated_direct_layout(self):
        accepts(self.original, self.saved)
        self.saved.find(HP+'linesegarray')[0].set('textpos', '2')
        accepts(self.original, self.saved)

    def test_empty_first_slot_is_supported(self):
        original = paragraph('<run><secPr/><ctrl/></run><run charPrIDRef="1"><t/><t>가</t></run>')
        saved = copy.deepcopy(original)
        next(saved.iter(HP+'t')).text = '한글'
        accepts(original, saved)

    def test_old_normalizer_copied_existing_characters_between_runs(self):
        original = paragraph('<run charPrIDRef="1"><t>AB</t></run><run charPrIDRef="2"><t>CD</t></run>')
        saved = paragraph('<run charPrIDRef="1"><t>한글ABC</t></run><run charPrIDRef="2"><t>D</t></run>')
        legacy = copy.deepcopy(original)
        for t, s in zip(legacy.iter(HP+'t'), saved.iter(HP+'t')):
            t.text = s.text
            for k, sk in zip(t, s):
                k.tail = sk.tail
        self.assertEqual(native.oracle.canonical_events(legacy), native.oracle.canonical_events(saved))
        with self.assertRaises(AssertionError):
            accepts(original, saved)

    def test_negative_mutations(self):
        def text_at(p, i):
            return list(p.iter(HP+'t'))[i]

        def move_tail(p):
            t = text_at(p, 0)
            text_at(p, 1).text, t[0].tail = t[0].tail, None

        mutations = {
            'first leading whitespace': lambda p: setattr(text_at(p, 0), 'text', '한글AB한😀'),
            'trailing whitespace': lambda p: setattr(text_at(p, 3), 'text', 'CD'),
            'unrelated text': lambda p: setattr(text_at(p, 2), 'text', '다른글'),
            'empty node text': lambda p: setattr(text_at(p, 1), 'text', 'x'),
            'tail whitespace': lambda p: setattr(text_at(p, 0)[0], 'tail', ' 뒤'),
            'tail movement': move_tail,
            'format reference': lambda p: p.findall(HP+'run')[1].set('charPrIDRef', '1'),
            'inline control': lambda p: text_at(p, 0)[0].set('width', '2'),
            'nested structure': lambda p: text_at(p, 0)[0].append(ET.Element(HP+'t')),
            'paragraph attribute': lambda p: p.set('id', '2'),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                saved = copy.deepcopy(self.saved)
                mutate(saved)
                with self.assertRaises(AssertionError):
                    accepts(self.original, saved)

    def test_nested_paragraph_layout_and_layout_tail_stay_meaningful(self):
        original = paragraph('<run><t>A<inline><p><linesegarray x="1"/></p></inline>B</t></run>'
                             '<linesegarray/> tail ')
        saved = copy.deepcopy(original)
        next(saved.iter(HP+'t')).text = '한글A'
        accepts(original, saved)
        saved.find('.//'+HP+'p')[0].set('x', '2')
        with self.assertRaises(AssertionError):
            accepts(original, saved)
        saved = copy.deepcopy(original)
        next(saved.iter(HP+'t')).text = '한글A'
        saved.find(HP+'linesegarray').tail = 'tail'
        with self.assertRaises(AssertionError):
            accepts(original, saved)

    def test_ambiguous_insertion_point_refused(self):
        for body in ('<inline><p><run><t>A</t></run></p></inline>',
                     '<run/><t>A</t>'):
            with self.subTest(body=body), self.assertRaises(AssertionError):
                accepts(paragraph(body), paragraph(body))


if __name__ == '__main__':
    unittest.main()
