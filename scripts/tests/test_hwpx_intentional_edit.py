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
    native.normalize_edited_line_layout(expected, saved, HP)
    assert native.oracle.canonical_events(expected) == native.oracle.canonical_events(saved)


def legacy_omit_edited_line_layout(para, hp):
    """Former exception, kept verbatim as false-negative evidence."""
    for child in list(para):
        if child.tag == hp+'linesegarray':
            index = list(para).index(child)
            if child.tail:
                if index:
                    previous = para[index - 1]
                    previous.tail = (previous.tail or '') + child.tail
                else:
                    para.text = (para.text or '') + child.tail
            para.remove(child)


def legacy_accepts(before, after):
    expected, saved = copy.deepcopy(before), copy.deepcopy(after)
    native.apply_intentional_edit(expected, saved, HP)
    for p in (expected, saved):
        legacy_omit_edited_line_layout(p, HP)
    return native.oracle.canonical_events(expected) == native.oracle.canonical_events(saved)


class NarrowPrefix(unittest.TestCase):
    def setUp(self):
        self.original = paragraph('<run charPrIDRef="1"><t> AB한😀<tab width="1"/> 뒤 </t>'
                                  '<t/><t>둘</t></run><run charPrIDRef="2"><t>CD </t></run>'
                                  f'<linesegarray>{seg()}</linesegarray>')
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
                             f'<linesegarray>{seg()}</linesegarray> tail ')
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


SEG = '<lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/>'
RUNS = '<run charPrIDRef="1"><t>{}AB</t></run><run charPrIDRef="2"><t>CD</t></run>'


def layout_paragraph(layout, prefix=''):
    return paragraph(RUNS.format(prefix) + layout)


class LineLayoutContract(unittest.TestCase):
    """Only rhwp's own recalculation transitions of the edited paragraph pass."""

    ORIGINAL = f'<linesegarray>{SEG}</linesegarray>'

    def test_supported_recalculation(self):
        cases = {
            'unchanged cache (actual native result)': self.ORIGINAL,
            'recalculated values': f'<linesegarray>{seg(vertsize="1100", horzsize="40000", flags="0")}</linesegarray>',
            'reflow to two lines': f'<linesegarray>{seg()}{seg(textpos="3", vertpos="1600")}</linesegarray>',
            'cache omitted for the consumer (1 -> 0)': '',
        }
        for name, layout in cases.items():
            with self.subTest(name):
                accepts(layout_paragraph(self.ORIGINAL), layout_paragraph(layout, '한글'))
        # Paragraph without cache stays without cache (0 -> 0).
        accepts(layout_paragraph(''), layout_paragraph('', '한글'))

    def test_structural_changes_refused_and_missed_by_legacy(self):
        moved = paragraph('<run charPrIDRef="1"><t>한글AB</t></run>' + self.ORIGINAL +
                          '<run charPrIDRef="2"><t>CD</t></run>')
        cases = {
            'extra container': layout_paragraph(self.ORIGINAL * 2, '한글'),
            'duplicate empty container': layout_paragraph(self.ORIGINAL + '<linesegarray/>', '한글'),
            'container moved between runs': moved,
            'non-lineseg child': layout_paragraph(f'<linesegarray>{SEG}<t>x</t></linesegarray>', '한글'),
            'text inside container': layout_paragraph(f'<linesegarray>{SEG}leak</linesegarray>', '한글'),
            'container attribute': layout_paragraph(f'<linesegarray x="1">{SEG}</linesegarray>', '한글'),
            'empty container': layout_paragraph('<linesegarray/>', '한글'),
            'unknown lineseg attribute': layout_paragraph(f'<linesegarray>{seg(extra="1")}</linesegarray>', '한글'),
            'non-integer lineseg value': layout_paragraph(f'<linesegarray>{seg(vertpos="a")}</linesegarray>', '한글'),
            'decreasing textpos': layout_paragraph(f'<linesegarray>{seg(textpos="4")}{seg(textpos="1")}</linesegarray>', '한글'),
            'nested element in lineseg': layout_paragraph(f'<linesegarray>{seg()[:-2]}><t/></lineseg></linesegarray>', '한글'),
        }
        for name, saved in cases.items():
            with self.subTest(name):
                self.assertTrue(legacy_accepts(layout_paragraph(self.ORIGINAL), saved), f'legacy should miss: {name}')
                with self.assertRaises(AssertionError):
                    accepts(layout_paragraph(self.ORIGINAL), saved)

    def test_layout_created_where_original_had_none(self):
        original, saved = layout_paragraph(''), layout_paragraph(self.ORIGINAL, '한글')
        self.assertTrue(legacy_accepts(original, saved))
        with self.assertRaises(AssertionError):
            accepts(original, saved)

    def test_unverifiable_original_layout_fails_explicitly(self):
        for layout in (self.ORIGINAL * 2, '<linesegarray/>', f'<linesegarray x="1">{SEG}</linesegarray>'):
            with self.subTest(layout), self.assertRaises(AssertionError):
                accepts(layout_paragraph(layout), layout_paragraph(self.ORIGINAL, '한글'))

    def test_layout_tail_kept_on_omission(self):
        original = layout_paragraph(self.ORIGINAL + ' tail ')
        accepts(original, layout_paragraph(' tail ', '한글'))
        with self.assertRaises(AssertionError):
            accepts(original, layout_paragraph(' tail', '한글'))

    def test_unrelated_paragraph_layout_stays_compared(self):
        section = f'<sec xmlns="{HP[1:-1]}"><p id="1">{RUNS.format("")}{self.ORIGINAL}</p><p id="0">{RUNS.format("")}{self.ORIGINAL}</p></sec>'
        original, saved = ET.fromstring(section), ET.fromstring(section)
        first, edited = original.find(HP+'p'), saved.find(HP+'p')
        next(edited.iter(HP+'t')).text = '한글AB'
        saved.findall(HP+'p')[1].find(HP+'linesegarray')[0].set('vertsize', '1')
        native.apply_intentional_edit(first, edited, HP)
        native.normalize_edited_line_layout(first, edited, HP)
        self.assertNotEqual(native.oracle.canonical_events(original), native.oracle.canonical_events(saved))


# rhwp render_one_lineseg writes all nine attributes; types from model LineSeg.
U32_FIELDS = ('textpos', 'flags')
I32_FIELDS = ('vertpos', 'vertsize', 'textheight', 'baseline', 'spacing', 'horzpos', 'horzsize')
FULL = dict(textpos='0', vertpos='0', vertsize='1000', textheight='1000', baseline='850',
            spacing='600', horzpos='0', horzsize='42520', flags='393216')


def seg(drop=(), **values):
    attrs = {**FULL, **values}
    for name in drop:
        attrs.pop(name)
    return '<lineseg ' + ' '.join(f'{k}="{v}"' for k, v in attrs.items()) + '/>'


class LinesegFieldContract(unittest.TestCase):
    """Saved line segments must be exactly what the rhwp serializer can write."""

    ORIGINAL = f'<linesegarray>{seg()}</linesegarray>'

    def saved(self, *segments):
        return layout_paragraph('<linesegarray>' + ''.join(segments) + '</linesegarray>', '한글')

    def test_type_boundaries_and_reflow_accepted(self):
        cases = {f'{f} {v}': seg(**{f: v}) for f in U32_FIELDS for v in ('0', '4294967295')}
        cases.update({f'{f} {v}': seg(**{f: v}) for f in I32_FIELDS for v in ('-2147483648', '2147483647')})
        for name, segment in cases.items():
            with self.subTest(name):
                accepts(layout_paragraph(self.ORIGINAL), self.saved(segment))
        accepts(layout_paragraph(self.ORIGINAL), self.saved(seg(), seg(textpos='0'), seg(textpos='7', vertpos='1600')))

    INVALID = {
        'empty lineseg': '<lineseg/>',
        'missing textpos': seg(drop=('textpos',)),
        'missing flags': seg(drop=('flags',)),
        'missing several': seg(drop=('vertsize', 'baseline', 'horzsize')),
        'unknown extra attribute': seg(extra='1'),
        'textpos above u32': seg(textpos='4294967296'),
        'negative textpos': seg(textpos='-1'),
        'flags above u32': seg(flags='4294967296'),
        'negative flags': seg(flags='-1'),
        'vertpos above i32': seg(vertpos='2147483648'),
        'vertsize below i32': seg(vertsize='-2147483649'),
        'horzsize far beyond i32': seg(horzsize='99999999999999999999'),
        'leading zero': seg(vertpos='007'),
        'plus sign': seg(spacing='+1'),
        'negative zero': seg(horzpos='-0'),
        'decimal': seg(baseline='850.0'),
        'whitespace': seg(textheight=' 1000'),
        'empty value': seg(vertsize=''),
    }

    def test_invalid_segments_refused(self):
        for name, segment in self.INVALID.items():
            with self.subTest(name), self.assertRaises(AssertionError):
                accepts(layout_paragraph(self.ORIGINAL), self.saved(segment))

    def test_decreasing_textpos_refused(self):
        with self.assertRaises(AssertionError):
            accepts(layout_paragraph(self.ORIGINAL), self.saved(seg(textpos='5'), seg(textpos='4')))

    def test_invalid_original_segments_fail_explicitly(self):
        for name in ('empty lineseg', 'missing textpos', 'textpos above u32'):
            with self.subTest(name), self.assertRaises(AssertionError):
                accepts(layout_paragraph(f'<linesegarray>{self.INVALID[name]}</linesegarray>'),
                        self.saved(seg()))


if __name__ == '__main__':
    unittest.main()
